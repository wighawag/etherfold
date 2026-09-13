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
