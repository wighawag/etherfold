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

## Decisions

**The port's `reconfigure` is the BESIDE path only (`Indexer.add({source})`); the in-place `updateIndexer` did NOT cross.** The task's acceptance criterion pins the beside behaviour ("state is not discarded, the new generation is built beside the live one, promotion follows the policy"), and the in-place verb is the outage-shaped discard the generation model replaced. Alternatives considered: carry both verbs (rejected — one word would mean two things across one boundary, and the hook's two names would both have to cross); carry only the in-place one (rejected — it discards state). **The consequence a reviewer should weigh:** the criterion's other half, "a reconfigure that ... invalidates the source", has no home on the port, because the beside path asks no source question of an existing fold and so produces no `SourceInvalidation` verdict — I deliberately did NOT re-derive one (`CONTEXT.md`: the verdict is reported, never re-derived). What a tab gets instead is `follows` (did the stream survive: no refetch) and `added` (did anything get created). The cost is real and worth naming: an ABI entry appended ABOVE the cursor is FREE through `updateIndexer` (ADR-0034) and, through this verb, moves the stream digest and pays for a full refetch in a new generation. Adding an `updateSource` case later is cheap by design (a key on `PortCases`). Touches `createindexerstate-becomes-the-main-thread-host`, which keeps both verbs on the hook and must decide whether the two surfaces stay asymmetric.

**No `promote` case: the port carries generation VISIBILITY, not pointer control.** The task's "Done means" is start, stop, reconfigure and visibility; `promote` is an operator affordance the server exposes behind its own admin token (ADR-0057). Consequence: an app running `manual` can see a successor catch up from a tab but cannot move the pointer from one. Alternative: add `promote(GenerationId)` — rejected as scope, and reversible as one case. Touches any later task that wants manual promotion or revert from a tab.

**`PortError` grew `details`, and `errorFromPort` re-attaches those fields onto the rebuilt error.** "Refusals keep their type" is unsatisfiable on name alone for the refusal a reconfigure actually meets: `GenerationCapReachedError`'s actionable half is `candidates`/`candidateStreams`, and a name-plus-sentence crossing would leave a tab parsing prose for the list it needs. Fields are clone-filtered per key and dropped individually rather than taking the refusal down. The narrowing axis stays the NAME (a prototype cannot cross), as `errors.ts` already predicted. Touches every later case that can refuse.

**`startIndexing`/`stopIndexing`, not the hook's `startAutoIndexing`/`stopAutoIndexing`, and no per-step advance case.** On a port there is only one kind of indexing — the host's driver — so the hook's "auto" (which distinguishes the timer loop from manual `indexMore`) has nothing to distinguish from. A `indexMore` case was deliberately not added: a round trip per cycle is the polling ADR-0082 replaced. Touches the main-thread-host task, which must reconcile the hook's four verbs with these two.

**Start and stop are idempotent ANSWERS, and a start racing a stop WAITS for it.** They name a state a caller wants, not an edge, so asking twice is not a refusal (this also sets a user-visible convention for every later lifecycle verb). The race matters: `startIndexing` awaiting an in-flight stop is what stops "asked to index, sitting there not indexing" when a stop unwinds after a start looked. Asserted directly.

**A stopped host keeps its PHASE and reports `indexing: false`; no `stopped` phase was added.** `SyncPhase` is a closed set describing where the FOLD is; `indexing` already says whether a driver is advancing it. Adding a sixth member would have made one question two.

**The container is opened once and stays open across a stop.** Stopping the driver is not closing the container: a settings screen switching indexing off must not take the app's data down with the fold. Consequence: `dispose()` remains the only thing that ends a host.

**A request payload that cannot cross now REJECTS instead of throwing synchronously** (`port.ts`). `assertClonable` ran before the promise existed, so `await port.call(x).catch(...)` did not catch the one input it refuses — and the function's own docstring already claimed it rejected. The reads that shipped first carry only strings and numbers, so nothing had reached it; a source is the first structured payload. Small, in-scope, and noted in the changeset.

**The fixture worker keys state per generation behind a `generations` URL parameter rather than by default.** An app that reconfigures must key on `context.stream` unconditionally, and the control case asks for it; the parameter exists only because the cases that predate the control surface read the worker's database back BY NAME from the page and cannot guess a digest. Same precedent as the previous task's `fetch` parameter, and it leaves those cases byte-identical.
