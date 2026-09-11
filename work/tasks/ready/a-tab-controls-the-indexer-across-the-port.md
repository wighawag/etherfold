---
title: 'A tab starts, stops and reconfigures the indexer across the port'
slug: a-tab-controls-the-indexer-across-the-port
spec: the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
blockedBy: [a-tab-sees-sync-progress-pushed-from-the-worker]
covers: [6, 7]
---

## What to build

The lifecycle calls, from the tab: start indexing, stop indexing, reconfigure the source without losing state, and reach the generation machinery.

Start and stop are what a settings screen or a backgrounded tab needs so it stops burning a user's rate limit. They must be honest: after a stop returns, no further provider calls are made, and a stop landing mid-cycle leaves the store in the same consistent state a stop between cycles does.

Reconfigure is the one with weight. The generation machinery already exists and already does the hard part — a reconfigure adds a generation beside the live one, indexes it, and promotes it when policy says to, so a source change is not an outage and state is not thrown away. All of that stays in the host. What this task adds is the ability to ASK for it from the tab and to see what happened: which generations exist, how far each has got, and which one is answering reads. An app that cannot reconfigure from where its UI lives cannot offer the feature at all, which is why it is in scope rather than deferred.

These are requests with answers, not fire-and-forget messages: a caller in the tab learns whether the reconfigure was accepted, refused, or resulted in an invalidation that needs a reset. The refusals that exist today must survive the crossing by TYPE, not be flattened into a string.

## Acceptance criteria

- [ ] A tab can start and stop indexing; after a stop resolves, no further chain requests are made.
- [ ] A stop that lands mid-cycle leaves the store consistent and the cursor where a completed cycle would have left it — a stopped indexer resumes without re-indexing or skipping.
- [ ] A tab can reconfigure the source and the existing generation behaviour is unchanged: state is not discarded, the new generation is built beside the live one, and promotion follows the configured policy.
- [ ] A tab can see which generations exist, their progress, and which one answers reads.
- [ ] A reconfigure that is refused or that invalidates the source reports that to the tab as a typed outcome an app can branch on, not as a message it has to parse.
- [ ] Starting an already-started indexer, or stopping a stopped one, is well defined and does not wedge anything.
- [ ] It is tested in a real browser with a real worker, including a reconfigure that promotes.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-tab-sees-sync-progress-pushed-from-the-worker`, to serialise the edits on the boundary modules and because a reconfigure's progress is reported through the channel that task creates.

## Prompt

The goal is that the generation machinery is reachable from where an app's UI actually runs.

Read `work/specs/tasked/the-indexer-runs-in-a-worker-and-the-tab-talks-to-it.md`, **ADR-0082**, and the **indexer host** entry in `CONTEXT.md` for the vocabulary. Then read the generation and reconfigure behaviour as it exists: `work/specs/tasked/a-reconfigure-is-not-an-outage.md` is the spec that built it.

Where to look, and get this right because it is NOT where you might assume. The generation machinery lives in `@etherfold/core`, not in the browser package: the CONTAINER is `container.ts` (the `Indexer` that holds generations and owns the canonical pointer), with the registry and the promotion policy under `generation/`. `@etherfold/browser` holds only the browser-side wiring — `IndexerState.ts`, which drives the container, and `storage/generation/OnIndexedDB.ts`, which is where the registry is persisted. `packages/browser/src` has ten files in total and none of them is a container; looking for one there will waste your time.

`createIndexerState`'s current control functions are the reference for what a caller can ask for today (indexing control, reconfigure, the generation registry and the promotion policy). The `PromotionConfig` pass-through is deliberately un-defaulted in the browser and there is a comment explaining why — do not add a default while crossing the boundary. `CONTEXT.md`'s **canonical pointer** entry states the same rule and is worth reading before you touch promotion.

Domain vocabulary: a GENERATION is one stream, one processor, one state; a RECONFIGURE adds one beside the live one rather than resetting; PROMOTION moves the canonical pointer, `on-catch-up` by default, `immediate` on request; an INVALIDATION verdict says whether a reset is needed. Each of these has a type already — carry the types across rather than stringifying them.

The seam to test at is the browser harness with a real worker host: index, reconfigure to a changed source, watch the second generation catch up, and assert the promoted generation answers reads. The existing main-thread reconfigure and promotion tests are the behaviour you must not change; use them as the oracle.

Done means: start, stop, reconfigure and generation visibility all work from a tab, with refusals that keep their type.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
