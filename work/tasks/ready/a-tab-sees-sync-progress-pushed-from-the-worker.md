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
