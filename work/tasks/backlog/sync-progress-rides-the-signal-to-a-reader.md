---
title: 'Sync progress rides the signal to a reader tab'
slug: sync-progress-rides-the-signal-to-a-reader
spec: a-reader-learns-when-the-state-moved
blockedBy: [a-reader-tab-learns-from-the-indexing-tab]
covers: [8]
---

## What to build

"Syncing, 400 blocks behind", renderable in a tab that is not the one doing the folding.

A tab that hosts the fold already gets this: the host pushes progress over its port, and a small readable helper binds it to a progress bar. A tab that is merely READING has no host to ask, cannot compute it, and must not try — the cursor is opaque behind the storage seam by ADR-0027, and deserialising it in a reader would breach that. So progress has to be PUBLISHED to it, by the side that knows.

**The scope of this task is the CROSS-TAB stream, and it adds no new mechanism to the port.** The cross-NETWORK half of the same story (an app reading from a hosted indexer rendering the same thing) belongs to `a-remote-client-learns-the-state-moved`, which carries it on the server stream; the two together are what make the story true everywhere.

 The existing `progress` push stays exactly as ADR-0082 decided and as it shipped. What "progress rides the same stream" means here is that a reader tab learns progress over the ONE cross-tab channel it already listens to, rather than a second cross-tab mechanism with its own lifetime and its own failure mode. One channel, two things a reader can be told.

The value published is the same progress value the host already reports. Not a recomputation, not a reader-side derivation, not a second vocabulary for how far the fold has got: a reader tab and a hosting tab should render the same words from the same numbers.

Best-effort, like everything else on this channel: a reader that missed one is corrected by the next, and nothing is buffered for a tab that was not listening.

## Acceptance criteria

- [ ] A reader tab can render how far behind the fold is and which coarse phase it is in, sourced from the indexing tab, with no polling and no cursor deserialisation in the reader.
- [ ] The value a reader tab renders is the host's own progress report, identical in shape and meaning to what a hosting tab receives over its port.
- [ ] Progress travels on the same cross-tab channel as the state-moved signal, not on a second channel.
- [ ] The port's existing `progress` push is untouched in shape, cadence and subscription behaviour.
- [ ] A reader tab that attaches part-way through a fold is not stuck with nothing to render until the next push; whatever rule is chosen is stated and tested.
- [ ] Nothing is buffered per listening tab.
- [ ] Tested with real tabs in the browser package's real-browser suite, in the own-host-per-tab case the previous task added, asserting on values rather than on elapsed time.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-reader-tab-learns-from-the-indexing-tab`, which creates the cross-tab channel this rides and settles how it is scoped.

## Prompt

The goal is that "syncing, 400 blocks behind" is renderable in every tab, not only in the one doing the work.

Read `work/specs/tasked/a-reader-learns-when-the-state-moved.md` (the decision that sync progress rides the same stream, because a reader cannot compute it and a second channel would be two mechanisms for one question), **ADR-0083**, **ADR-0082** (status is pushed, and the control surface narrows), and **ADR-0027** for why the cursor is opaque and must not be deserialised by a reader.

Where to look: `@etherfold/browser`. The progress vocabulary already exists and was chosen deliberately — read the host's progress type and its phases, including the reasons recorded there for what was carried over from the main thread's finer state types and what was deliberately left behind. In particular the distance to the tip has its own name because the bare word already means something else for a non-canonical generation; reuse the existing name rather than coining a second one. The small readable helper beside the progress push is the precedent for how an app binds this, and its rule is that a wrapper is a VIEW and never a second source of truth. The previous task's cross-tab channel is what you are adding to.

The trap this task exists to avoid: it looks like an invitation to unify the port's progress push with the state-moved signal into one message. It is not. ADR-0082 decided progress is its own push and it shipped that way; this is about a READER TAB, which has no port to a host, needing the same facts over the channel it does have.

Terminology: `CONTEXT.md` reserves **consumer** for a reader of the FEED, so this is a reader tab or an app.

The seam to test at is the browser package's real-browser suite (`packages/browser/browser/`), reusing the own-host-per-tab case the previous task added, with one indexing tab and several readers, asserting each reader renders the same progress the indexing tab does.

Done means: every tab can show how far behind the sync is, sourced from the one tab that knows, over one channel.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. What a newly-attached reader tab is told before the next push, and the publication cadence you chose for progress on a channel that is otherwise driven by applied blocks, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
