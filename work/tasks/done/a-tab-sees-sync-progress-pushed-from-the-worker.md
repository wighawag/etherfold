---
title: 'A tab sees sync progress pushed from the worker'
slug: a-tab-sees-sync-progress-pushed-from-the-worker
spec: the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
blockedBy: [a-tab-reads-the-store-across-the-port]
covers: [4]
---

## What to build

"Syncing, 400 blocks behind" rendered in a tab whose worker is doing the folding.

`createIndexerState` publishes three reactive stores today, and reproducing that triple across a port would mean either polling on a timer someone invented or duplicating state in every tab. That is what a surface designed for same-thread use — where a getter is free and a round trip is not — turns into when it crosses a boundary. So the control surface NARROWS: the host PUSHES progress, and an app builds whatever reactive wrapper its framework wants from that signal. ADR-0082 records the decision.

What the tab needs in order to render a useful first visit: how far the fold has got, how far it has to go, and which of the coarse phases it is in (loading, catching up, at the tip, waiting on a provider, refusing). The existing `SyncingState` and `StatusState` are the vocabulary to draw from — they already model this for the main-thread case, including the parts an app actually renders. Take what is renderable and leave behind the parts that only made sense to a same-thread holder of the container.

Ship the small helper for the common case beside it, so an app that just wants a progress bar is not obliged to write the wrapper itself. The helper is a convenience over the signal, never a second source of truth.

A push arrives on the same envelope as everything else, as a message the tab does not have to have asked for. Pushes must not be so chatty that they become the cost they were meant to avoid: one per applied batch is the natural cadence, not one per block or one per timer tick.

## Acceptance criteria

- [ ] A tab can render how far behind the fold is, and the number advances as the worker folds, without the tab polling.
- [ ] The coarse phase (loading, catching up, at the tip, waiting, refused) is available and correct at each transition.
- [ ] An app can subscribe from a tab and unsubscribe, and an unsubscribed tab stops receiving pushes.
- [ ] The helper produces something an app can bind directly to a progress display, and is demonstrably a view over the signal rather than state of its own.
- [ ] Push cadence is tied to applied work, not to a timer, and the case asserting progress does not depend on timing.
- [ ] A tab that attaches part-way through a fold learns the current progress without waiting for the next push.
- [ ] It is tested in a real browser with a real worker.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-tab-reads-the-store-across-the-port`, to serialise the edits: both tasks add cases and types to the same boundary modules, and this one is the second.

## Prompt

The goal is that a first visit shows progress instead of a blank screen, with the fold in a worker.

Read `work/specs/tasked/the-indexer-runs-in-a-worker-and-the-tab-talks-to-it.md`, **ADR-0082** (particularly "Status is PUSHED, and the control surface NARROWS", which is the decision you are implementing and the one most likely to be undone by accident: the temptation is to mirror the three reactive stores across the port because that is what `createIndexerState` has), and the **indexer host** entry in `CONTEXT.md` for the vocabulary.

Where to look: `SyncingState` and `StatusState` in `@etherfold/browser` are the existing vocabulary, including `catchingUp`, `waitingForProvider`, the loading states and the generation progress shape. Read them for WHAT is worth reporting; do not take their reactive-store packaging across the boundary. `createIndexerState` also computes the derived numbers an app renders (blocks processed so far, percentages) — those derivations are worth keeping, wherever they end up living.

Scope boundary that matters: this is the worker telling ITS OWN tab how it is doing. How a READER tab in another window learns that state moved is `a-reader-learns-when-the-state-moved`'s decision and is not yours to make here. Do not build a cross-tab mechanism.

The seam to test at is a real worker host folding a real workload in the browser harness, with the tab collecting pushes. Assert on the sequence of pushes and the values in them rather than on elapsed time.

Done means: a tab can render "syncing, N blocks behind" and a phase, it updates as the fold advances, and nothing polls.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. What you carried over from the existing state types and what you deliberately left behind is exactly such a decision. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**What I carried over from `SyncingState`/`StatusState`, and what I left behind.** Carried: `waitingForProvider` (as the `waiting` phase, cleared at the same moment - when the container opens), the catching-up/at-the-tip distinction, the loading state, and `ExtendedLastSync`'s `numBlocksProcessedSoFar` and `syncPercentage` under their existing names and rules, so an app moving between the main-thread hook and a port binds the same words to the same meanings. Left behind: the load's sub-steps (`fetchingLogs`, `processingFetchedLogs`, `FetchingEventStream`, `ProcessingEventStream`, `InstallingStreamSeed`), because across a port each would be a message and none of them is a thing an app changes its screen for; `numRequests`, `autoIndexing`, `error`, `nonCanonicalGenerations`, `streamSeed` and `demotion`, which are other surfaces' (generation control, demotion, seeding) and not this channel's; and `totalPercentage`, which divides by the whole chain height, so a deployment starting at block 20,000,000 reads 99.9% from its first fetch. Alternative considered: mirror the whole triple - rejected, that is exactly what ADR-0082 refuses. Touches `createindexerstate-becomes-the-main-thread-host`, which will have to decide whether the hook's finer fields survive as the main-thread host's extras.

**The distance to the chain tip is `blocksBehindTip`, not `blocksBehind`.** `GenerationProgress.blocksBehind` already means how far a non-canonical generation is behind the CANONICAL one; reusing the bare word would give one term two meanings across one package. Alternative: reuse `blocksBehind` and disambiguate by context - rejected on the coherence rule, and the previous task's envelope note had already flagged this exact collision. Touches nothing else, but it is the name apps will render, so it is hard to change later.

**`at-tip` is the driver's own rest condition (`lastToBlock >= latestBlock` on an ADVANCE), and `createIndexerState`'s 20-block `catchupThreshold` did not come across.** It is literally the same expression the loop rests on, so a phase claiming the tip while the driver went on fetching is unexpressible. The threshold exists on the main thread to stop a UI flickering a few blocks from the tip; an app can apply its own from `blocksBehindTip`, which it has. Alternative: carry the threshold as a `HostedIndexerSpec` knob - rejected as a user-visible default that would make two rules for one question. Touches the main-thread host task, which inherits `catchupThreshold` and must decide whether it keeps it.

**The phase only reaches `at-tip` from an ADVANCE, never from the cursor alone.** A container that has loaded and not yet fetched publishes `0` of `0`, so equality is true before a single log is asked for. After the load the phase is `catching-up` (behind by an unknown amount) until an advance says otherwise. Alternative: compare the cursors wherever they update - rejected, it is the trap the envelope's own docstring names and it would render "live" over an empty database.

**The derived figures are computed in the HOST and are absent until a tip has been learnt.** Same placement as `declaredRow` (the previous task's "the host projects the rows, the tab does not"): one implementation rather than two that agree by inspection, and no fourth block number on the wire whose name would collide with `fromBlock`/`startBlock`. They are absent together below `latestBlock > 0` rather than computed from numbers that do not mean what they look like; `syncPercentage` answers `100` where there is no span rather than dividing by zero. This is the port-side half of `work/notes/observations/a-pre-fetch-cursor-publishes-a-nonsense-percentage.md`; I deliberately did NOT touch `createIndexerState`'s `NaN`, because that is the main-thread host task's surface.

**A push is a CHANGE, not a heartbeat.** A report identical to the last one posted is not posted. Without it, a driver resting at the tip would emit a push per rest interval, which is the polling this channel replaced with the cost moved to the other end of the wire. The consequence an app must know: an idle tab receives nothing, which is why attaching answers with the current value. Alternative: post every advance - rejected as a timer wearing a signal's clothes. Asserted directly (the host fetches more ranges while pushing nothing).

**Two named cases (`subscribeToProgress` / `unsubscribeFromProgress`) rather than one `subscribe` case taking a topic.** The same reason the four reads are four cases: the envelope's dispatch already is that narrowing, and a topic argument would make one case's response type depend on its request's contents. `a-reader-learns-when-the-state-moved` adds its own pair beside them if it wants one. Touches every later task that adds a push.

**Subscribing ANSWERS with the current progress, rather than triggering an immediate push.** It removes the window in which a fresh subscriber holds nothing and the race between that push and a concurrent `progress()` answer. The port caches the host's last word so a SECOND listener on an open subscription is served too (asynchronously, so no listener fires before the call that added it returned). Alternative: push-on-subscribe - rejected for the ordering ambiguity.

**`HostProgress` GREW rather than a second, richer pushed type.** One progress value, two deliveries: `progress()` pulls it, `onProgress` is pushed it. Two types would be two things to keep in step and "what did I miss" would answer differently from "where are we now". Consequence: the existing `progress` case's response now carries the phase and the derived figures too, which is additive.

**`onProgress` is a SUBSCRIPTION returning a detach, not an assignable slot.** It reads like the container's `onLastSyncUpdated` and is deliberately not the same contract (several listeners, each releasing its own), because a port is held by app code in several places while the container's callbacks are the host's private wiring. Documented at the type. Alternative: `subscribeToProgress(fn)` on the tab surface - rejected as noisier for the thing an app writes most.

**The fixture worker entry gained a `fetch` URL parameter.** `browser/indexer.worker.ts` now reads an optional fetch width from its own URL, as it already does for the database name, so the progress case can watch the fixture's five blocks arrive in more than one advance. Unset by default, so `hosted-in-a-worker` and `reads-across-the-port` fetch exactly as before. Alternative: a third worker entry - rejected as a whole file for one number.
