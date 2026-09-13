---
title: 'One handler for every transport'
slug: one-handler-for-every-transport
spec: a-reader-learns-when-the-state-moved
blockedBy:
  [a-tab-learns-the-state-moved-across-the-port, a-reader-tab-learns-from-the-indexing-tab, a-remote-client-learns-the-state-moved]
covers: [7, 14]
---

## What to build

The claim that there is ONE notification model, made checkable rather than asserted, plus the app-facing shape that makes it true in practice.

Three transports now carry the signal: a port from a worker, a channel between tabs, a stream from a server. Each was built against the same decided shape, which is necessary and not sufficient: three independently-correct adapters drift into three semantics unless something runs the same case over all of them and compares the app-visible outcome. That suite is the deliverable.

Beside it, the small piece that makes story 7 real: the signal has to fit how a GraphQL client's cache actually invalidates. The handler SHAPE was defined by the root task so that each transport adapted to one shape rather than inventing its own; what is left here is the wiring an app copies. Every client library's invalidation API is a plain callback — `invalidateQueries`, `refetchQueries`, `reexecuteOperation` — so the two-line rule composes with all of them in a few lines: token unchanged, invalidate the entities named; token changed, invalidate everything. Ship it as documentation, not as a dependency on any client library. Etherfold does not pick urql, Apollo or Houdini on an app's behalf.

This task also carries the housekeeping that the ADR format says must be pinned to a named task rather than left to whoever is last: **remove ADR-0083's `accepted, not yet implemented` status line**, since this is the task by which the decision is fully implemented.

## Acceptance criteria

- [ ] One parameterised suite runs the same cases over all three transports and asserts the app-visible outcome is identical: an append, a retraction, a promotion, and a dropped notification followed by convergence.
- [ ] The suite is parameterised by transport the way the store conformance suite is parameterised by factory, so a fourth transport joins by supplying an adapter rather than by copying cases.
- [ ] The app-facing handler shape defined by the root task is confirmed to work unchanged against all three transports, demonstrated by ONE handler used across all three in the suite. If a transport forced a variation, that is a finding to surface rather than a second shape to document.
- [ ] The documented cache wiring shows the two-line rule against a real client library's invalidation callback, without etherfold depending on that library.
- [ ] A coherence case ties this to the read path on the BROWSER transports, where a read surface exists: after a notification naming block N, a read does not answer from below N. The server has no state query surface yet (status, ingest, feed and admin only; the query layer is deferred to `the-same-query-runs-against-a-worker-and-a-server`), so the remote case asserts the connect-time position instead, and the pinned-read version of it arrives with that spec.
- [ ] ADR-0083's `accepted, not yet implemented` status line is removed in this change.
- [ ] `CONTEXT.md` gains the vocabulary this work introduces — the signal itself, the coherence token, a retraction as a notification, and the cross-tab channel — so the next author cannot re-fork the terms. Four of these tasks send a builder to that glossary as the terminology authority; this is the change that makes it true.
- [ ] The guide covering browser app development mentions how an app learns the state moved, since it currently describes reactive state without it.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-tab-learns-the-state-moved-across-the-port`, `a-reader-tab-learns-from-the-indexing-tab` and `a-remote-client-learns-the-state-moved`. This is the fan-in that judges all three; it cannot start until every transport exists.

## Prompt

The goal is to turn "one notification model across every transport" from a sentence in a spec into something that fails a test when it stops being true.

Read `work/specs/tasked/a-reader-learns-when-the-state-moved.md` and **ADR-0083**. Then read the three transport tasks in `work/tasks/done/` and what they actually built, because your job is partly adversarial: find where they diverge. Differences in when a subscriber is attached, in what a late joiner is told, in what an empty block does, and in how the payload is serialised are the four places three correct adapters usually stop agreeing.

Where to look: `@etherfold/state-store-conformance` is the model for a suite parameterised over implementations, and the browser package's parameterised hosting-shapes suite is the model for running one behaviour suite against several real substrates. Use whichever shape fits; do not invent a third convention. The guide lives under the browser-app documentation, which today describes a reactive state without saying how a reader learns it moved.

Terminology: `CONTEXT.md` reserves **consumer** for a reader of the FEED. The thing attaching a handler here is an app, a caller or a reader.

On the cache wiring: the point is that the signal composes with what apps already use, so the deliverable is a short documented example, not an integration package. If writing it reveals that the payload does NOT compose cleanly with a normalised cache's invalidation, that is a real finding about the model and should be surfaced rather than smoothed over in prose.

Do not forget the ADR status line. `ADR-FORMAT.md` explains at length why that removal is assigned to a specific task: every task in a chain can see it is not the last, while the actual last one has no way to know that it is. You are the one it is assigned to.

Done means: one suite, three transports, identical outcomes, one handler, the glossary pinned, and an ADR whose status line no longer claims the decision is unimplemented.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Any divergence you found between the three transports and how you resolved it is exactly such a decision, and is the most valuable thing this task can record. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**A new published package rather than a module inside one package.** The three transports live in two packages (`@etherfold/browser` × 2, `@etherfold/server` × 1) and nothing depends on both. `packages/browser/browser/hostingShapes.ts` (the other model the task named) is an in-package module because its three substrates are in one package; that shape cannot span two without inventing a browser↔server dependency edge. So I took the `@etherfold/state-store-conformance` shape instead: a package depending only on `@etherfold/core`, dev-depended by the two packages that own transports. Alternative considered: a private package dev-depending on browser *and* server so all three run in one file, which would make "identical outcomes" one run rather than two. Rejected because it forks the convention the repo already has for exactly this, and because a published suite is what lets the anticipated GraphQL subscription adapter — explicitly out of this repo's scope in ADR-0083 — check itself. Touches: the workspace, the release plan, `CONTEXT.md`'s glossary.

**The glossary name is "transport conformance suite", not "conformance suite".** `CONTEXT.md` already reserves **conformance suite** for the storage one and **conformance workload** for its subject. This is the same *shape* at a different *seam*, so it reuses the concept under a qualified name rather than re-meaning the bare term, and its entry says in as many words not to call it *the* conformance suite. Touches: every future artifact that says "the conformance suite".

**The adapter drives a REAL world; it is not a pipe over a synthetic publisher.** A pipe adapter (hand the transport a bare `StateMovedPublisher`) would be far cheaper and would give exact control over payloads, but acceptance criterion 5 needs a real read path on the browser transports, and a suite whose producer is synthetic cannot assert "a read does not answer from below the block you were told about". The cost is that each adapter carries a small world (chain/fold/port, or ingest/receiving container/SSE). Stated in `StateMovedTransport`'s docstring: an adapter that posts a value of its own passes every case while demonstrating nothing.

**The last chapter is claim-driven, and answering NEITHER question is a FAILURE, not a skip.** A transport whose reader has a state surface implements `readsUpTo` and is asked the coherence question; one with none (the server, whose query layer is deferred to `the-same-query-runs-against-a-worker-and-a-server`) implements `positionOnConnect` and is asked how a connecting reader converges. A transport offering neither fails a case saying so. This mirrors the store suite's rule for a backend that claims `singleWriter` and hands the suite no way to contend for it; a capability-driven selection that can select *nothing* is how a suite becomes decoration. Touches: whoever adds a fourth transport.

**The ADR's status line was not the literal string the task names, and I removed the whole frontmatter rather than editing it.** ADR-0083 no longer said `accepted, not yet implemented`: each task in the chain had amended it into a long "as built" narrative ending "The GraphQL subscription adapter is still not built". `ADR-FORMAT.md` says absence means accepted and current and that a status is added only when the plain reading would mislead, so the correct act is deletion. Because that line carried real as-built facts that were *not* in the body (the cross-tab naming rule, the SSE endpoint, `holdsStreamsAcrossRequests`, `coherenceNow`), I moved them into a body section rather than deleting them. Alternative considered: leave a `> **Built.**` marker as ADR-0073 does — rejected, since that ADR says itself it marks the exception, not the norm. Touches: anyone reading ADR-0083 for the built state.

**The guide attaches the handler to a PORT, and says the main-thread hook deliberately has none.** While writing it I found that `createIndexerState(...)` does not expose `onStateMoved` at all — the signal is on `IndexerPort`. That is correct rather than a gap (an app holding the hook has the indexer in its own heap and already has `state`), but it is not obvious, so the guide states who needs the signal and who does not, and shows `connectToIndexerHost(indexer.mainThreadHost(), {watch: false})` for the main-thread case. Touches: any future doc or example that reaches for `indexer.onStateMoved`.

**The cache wiring surfaced a real limit, and I wrote it down instead of smoothing it.** The two-line rule composes: the coarse line (`token changed → invalidate everything`) is one call in TanStack Query, Apollo and urql as they stand. The narrow line does **not** come free: `entities` carries entity *names*, which is the processor's vocabulary, and no cache library knows it — TanStack matches only if the app keyed queries by entity name (and silently no-ops if not), Apollo has no type-level invalidation primitive, urql needs the operations named. So the narrow half costs an app-declared mapping from entity name to that library's invalidation unit. That is a finding about the model, recorded in `work/notes/findings/what-the-state-moved-payload-costs-a-normalised-cache.md` and stated in the guide, with the reasons it is *not* an argument for shipping ids. What I checked is the libraries' documented invalidation surfaces; I did not build an app against any of them, and the note says so.

**Divergences found between the three transports.** No semantic divergence: the same handler produced the same decisions everywhere, and every case passes on all three. Three *legitimate* differences are now pinned as such rather than being allowed to become a second handler shape: (1) the server sends a `progress` frame on connect where the browser transports send nothing — that is ADR-0082's state-versus-notification split, and it is expressed as the claim-driven last chapter, not as a variation in `onStateMoved`; (2) only the browser transports have a read surface, same treatment; (3) *attaching* is synchronous in-heap and asynchronous over the network, so `StateMovedTransport.onStateMoved` admits a `Promise<Detach>` while `StateMovedHandler` itself is untouched — the handler is identical, the attach is not. One difference outside the signal, worth knowing: after a promotion the receiving container needs `rebuildMore` scheduled by the host before the fold that answers applies anything, where the browser container advances followers inside `indexMore`; the two adapters differ there and the notifications do not.

**A deliberate gap: no case for a block that is APPLIED but touches NO entity.** The prompt names "what an empty block does" as one of the four drift points. I did not build it. Both worlds' folds mutate on every event they carry, so producing one needs an event the processor has no handler for, which means a second ABI event — cheap in the browser fixture (mine, isolated) and not cheap on the server, where it means adding an event to `packages/server/test/utils/feedHarness.ts`'s shared ABI, used by 24 test files. Making it a case only two of three transports answer is exactly the capability fiction I refused one decision above, so I left it out entirely rather than half in. What is covered instead: the exact key set on both cases of the union, `entities` asserted as an array of strings (empty is legal), and the retraction — which carries no entity set at all — asserted whole. What is *not* covered by a test is a transport that swallowed a notification because it judged it empty; I verified by reading that none of the three does (the port forwards the value by reference, the channel posts it verbatim, the route `JSON.stringify`s it). A reviewer who wants this closed should say so: the honest fix is a second event on the server's shared harness ABI.
