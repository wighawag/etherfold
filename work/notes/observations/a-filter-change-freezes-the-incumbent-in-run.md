---
title: 'A filter-change reconfigure freezes the incumbent in `run`, because one fetcher serves one source while two contexts are live'
slug: a-filter-change-freezes-the-incumbent-in-run
observed: 2026-09-13
---

2026-09-13 — Noticed while scoping multi-tenant `run`. The combined deployment cannot keep the incumbent CURRENT across a filter-change reconfigure. Reads never fail, so this is not an availability outage; the incumbent simply stops advancing and answers steadily staler data until the successor is promoted.

**2026-09-13, REVERSED by the author, and the reversal is probably right.** The first reading was that this is a defect and the incumbent must keep advancing until the new source catches up. On reflection the author's position is that it should probably NOT advance on a source change, and the argument is strong: a source change usually means the old fold's answers are WRONG rather than merely stale, so keeping it current is keeping it wrongly-current, and it spends a second fetcher plus node budget on a generation that is about to be discarded.

So the freeze may be CORRECT behaviour, and today's behaviour may need no change at all. What follows below is retained as the mechanism and the fix shape IF the wait path is ever wanted, not as work that should be done.

**The sub-case that decides it, because "a source change" is not one thing.** A change that REPLACES a contract (an upgrade to a new deployment address) leaves the old fold describing a contract that is no longer the source of truth: wrong, so do not keep it current. A change that ADDS a contract, or otherwise widens the filter, leaves the old fold a correct fold of a SUBSET: right but incomplete, so keeping it current is genuinely useful while the successor backfills. The system cannot tell these apart, which is exactly story 5 of `a-reconfigure-is-not-an-outage`: "only I know whether my reconfigure made the old answers wrong or merely incomplete". So this belongs on the same axis as the promotion policy rather than being a fixed behaviour.

**What may genuinely remain is an honesty question rather than a fetching one.** If the incumbent is deliberately frozen, a developer should be able to SEE that it is frozen rather than infer it from a cursor that stops moving. Progress reporting answers how far the successor has caught up; nothing states that the generation currently answering reads has stopped advancing on purpose. That is a much smaller piece of work than the one below, and it is the part that survives the reversal.

## The mechanism

A reconfigure splits in two by ADR-0044, and the split is the whole of this:

- **A processor-only change shares the stream**, so the successor is a FOLLOWER that "fetches nothing at all" and re-folds the stored stream. The incumbent remains the stream's writer and keeps advancing off the wire. **No gap: this case is free, and it is the common one.**
- **A genuine filter change makes a NEW STREAM** (the spec `a-reconfigure-is-not-an-outage` says so, and prefix-sharing between two streams is explicitly out of scope), so the successor is "an ordinary indexer at a different address" and must fetch its own history from the node.

In the second case two wire contexts are live at once: the incumbent's old filter, which must keep being fetched for the incumbent to stay current, and the successor's new filter, which must be fetched from the source start for it to catch up.

`run` cannot fetch both. Its `FetcherHost` builds ONE `LogFetcher` over `config.source`, which is scalar (`--deployments` / `--processor` are single-valued by ADR-0048's "ONE name per input"), and the host never consults `liveIngestions()`. So after the configuration changes, the single fetcher serves the NEW filter, the old stream gets no writer feeding it, and the incumbent freezes at whatever block it had reached. It goes on answering every read from its own state, which is why this is easy to miss.

## The architecture already solves it, over the wire

The HTTP wire is context-aware and plural. `POST /{indexer}/ingest/expected-from-block` answers a LIST:

```ts
const contexts: {context: WireContext; expectedFromBlock: number}[] = [];
for (const ingestion of await resolved.entry.liveIngestions()) {
  contexts.push({context: ingestion.context, expectedFromBlock: await ingestion.expectedFromBlock()});
}
```

That is "here are the N filters I need fed, and where each is up to", and batches are routed to the matching fold. So a SPLIT deployment runs a fetcher per filter, both generations advance concurrently, and the reconfigure is genuinely not an outage even for a filter change. This is what `index`'s comment means by "a filter-change successor is fed beside the incumbent". `run` is the one shape that cannot express it, because it wires its fetcher straight to one stream builder instead of negotiating contexts.

## Fix shape

Make `run`'s in-process wire context-aware in the same way the HTTP wire already is: drive N `LogFetcher`s from `liveIngestions()` rather than one from `config.source`.

The rate budget has an existing answer and should NOT be reinvented: the requests-per-second limit lives on the provider (`createJSONRPCProvider(nodeUrl, {requestsPerSecond})`), and `FetcherHostDependencies.provider` already accepts an injected one ("Supply a provider instead of building one from `nodeUrl`"). The provider is pure transport, since the source lives on `LogFetcher`. So build ONE rate-limited provider and share it across the N fetchers, and the budget is shared by construction. Each host keeps its own learned range, which is correct because ranges are per source (ADR-0074). Letting each context construct its own provider is the footgun: the process would then hit the node at N times the configured rate.

## Its relationship to two other items, because they will be confused

- **It is NOT the missing-trigger defect** (`a-reconfigure-cannot-reach-a-running-run`). That one is about nothing being able to INTRODUCE a successor without a restart. This one bites after the successor exists, however it got there, so adding a trigger does not fix it and fixing this does not add a trigger.
- **It is the requirement of the WAIT path, not of every path.** A filter change may also want to promote IMMEDIATELY, because the incumbent folded a different event set and its answers can be wrong rather than merely stale (`the-promotion-policy-is-unreachable-from-the-cli`). If the successor becomes canonical at once, the incumbent stops answering almost immediately and its freshness barely matters. So these two are ALTERNATIVES rather than duplicates, and both are needed: "wait for catch-up" stays legitimate whenever an operator wants to inspect a successor before it answers anybody, and that path is the one that requires this fix.
- **It IS the same mechanism as two thirds of multi-tenant `run`** (N fetchers, one shared provider), arriving for a different and more pressing reason: there, N fetchers because there are N indexers; here, N fetchers because ONE indexer has N live contexts mid-reconfigure. Notably this version does NOT need the config-grammar decision that is the expensive part of multi-tenancy, because the contexts come from the registry at runtime rather than from flags. So this is the cheaper and more valuable half, and it can land first.
