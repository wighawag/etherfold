---
title: 'The combined run feeds EVERY live wire context, so a filter change does not freeze the incumbent'
slug: the-combined-run-feeds-every-live-wire-context
blockedBy: []
covers: []
---

## What to build

The property "a reconfigure is not an outage" made true on the combined deployment for the case that currently breaks it.

A reconfigure splits in two. A processor-only change shares the stream, so the successor is a follower that fetches nothing and re-folds what is stored, while the incumbent stays the stream's writer and keeps advancing off the wire. That case is already free. A genuine FILTER change makes a new stream, so the successor is an ordinary indexer at a different address and must fetch its own history, and now TWO wire contexts are live at once: the incumbent's old filter, which has to keep being fetched for the incumbent to stay current, and the successor's new filter, fetched from the source start so it can catch up.

`run` cannot fetch both. It builds one log fetcher over one scalar source and never consults the container for which contexts are live. So after a filter change the single fetcher serves the new filter, the old stream gets no writer feeding it, and the incumbent FREEZES at whatever block it had reached. It goes on answering every read, which is why this is easy to miss, and the answers get staler until the successor is promoted.

The architecture already solves this over the wire. The ingest negotiation is plural: a host answers "here are the N filters I need fed, and where each one is up to", and batches are routed to the matching fold. That is why a split deployment can run a fetcher per filter and keep both generations advancing. So this task does not invent a mechanism; it gives the in-process wire the same shape the HTTP wire already has.

**Share ONE rate-limited provider across the fetchers.** The requests-per-second limit lives on the provider, not on the fetcher, and there is already an injection point for supplying one rather than building it from a URL. The provider is pure transport, since the source lives on the fetcher. Letting each context construct its own is the footgun: the process would hit the node at N times the configured rate, which is how a deployment gets rate-limited or billed unexpectedly.

Note what this is NOT. It does not make `run` multi-tenant (that needs a config grammar for N indexers, which is a separate and larger decision), and it does not change which generation answers reads.

## Acceptance criteria

- [ ] After a filter-change reconfigure on `run`, the incumbent KEEPS ADVANCING while the successor catches up, rather than freezing at the block it had reached.
- [ ] The successor catches up at the same time, from the source start, on its own stream.
- [ ] The set of contexts fetched is derived from what the container reports as live, so a context that appears or retires is picked up without the process being restarted or reconfigured.
- [ ] All fetching shares ONE rate-limited provider, so the node sees the configured request rate rather than a multiple of it. Asserted by counting requests against the budget with more than one context live, not by reading the construction.
- [ ] Each context keeps its own learned range, since a range is a fact about a source rather than about the process.
- [ ] A single-context deployment is unchanged in behaviour and in request rate, so the ordinary case pays nothing for this.
- [ ] The one-writer rule is unaffected: a follower still fetches nothing, and only the generation that writes a stream appends to it.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None. It can start immediately.

## Prompt

The goal is that changing the contracts an indexer watches does not make it serve stale answers for the whole time the new fold is catching up.

Read `work/notes/observations/a-filter-change-freezes-the-incumbent-in-run.md` for the mechanism and the existing hooks. Then read **ADR-0044**, which decides that how a successor advances is determined by its stream and never configured: it is the reason the processor-only case is already free and the filter case is not. Read `@etherfold/fetcher-host`'s host for how a fetcher is built today and where a provider can be injected, the CLI's in-process wire for how it is currently bound to one source, and `@etherfold/server`'s ingest route for how the HTTP wire negotiates several contexts, which is the shape being mirrored.

The decision most likely to be got wrong: this is about which CONTEXTS are fetched, not about fetching a superset. It is tempting to notice that the new filter often contains the old one and fetch a single union, then route the logs to both folds. That would make one fold's state a function of another fold's fetch, which is precisely the coupling ADR-0044 refuses, and it breaks down entirely when the filters are disjoint (a contract replaced rather than added).

The second: contexts come from the container at RUNTIME and must not be captured once. A context appears when a successor is registered and retires when its generation is deleted, and a fetcher set frozen at start-up would go on fetching for a generation that no longer exists while missing one that just appeared.

The third: resist giving each context its own provider, however natural it looks when each has its own fetcher. The rate limit is a property of the process's relationship with the node, not of a fetcher, and the injection point exists precisely so one can be shared.

The seam to test at is a `run`-shaped deployment driven through a filter-change reconfigure, asserting that the incumbent's cursor keeps moving while the successor's catches up, and asserting the request rate against the configured budget with two contexts live.

Done means: a filter change on the combined deployment leaves both generations advancing, one node budget is respected, and a single-context deployment behaves exactly as it did.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. How the fetcher set is kept in step with the live contexts, and how the shared budget is divided between them when they compete, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
