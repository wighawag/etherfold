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

## Decisions

**A newly-attached reader is handed the last report this tab HEARD, and if it holds none it ASKS on the channel.** The port's rule is that progress is a STATE whose subscribe answers with the current value, so the channel end keeps the last report another tab published and hands it to a listener attaching later. That alone is not enough for a tab that just OPENED: a host at the tip pushes nothing, so a window opened into a quiet chain would be blank until the chain moved (hours). So attaching with nothing held posts a `progressAsk`, and a tab holding a report of its own re-posts it. Alternatives considered: (a) tell a late listener nothing until the next push, which fails the criterion in exactly the quiet-chain case; (b) have the reader ask its own host, which it may not have, and whose answer is wrong when it does. It is an ask and not a request — nothing awaited, retried or correlated, no reply address, and an ask nobody can answer is silence. Touches: the analogue on the network transport is the server's connect-time `progress` frame, deliberately the same promise by a different mechanism (a remote client has a connection to answer on; a broadcast has none).

**Only what THIS tab published is re-posted in answer; a tab does not gossip on a report it merely heard.** Re-posting a heard report would keep a departed indexer's last number alive on the channel indefinitely. Cost, stated: if the only publisher's tab is gone, a newcomer renders nothing until a tab starts folding again, which is the honest answer.

**A report identical to the one a tab already holds is not delivered.** This is the rule the host already follows on the port (it posts nothing where the report would repeat), applied at the receiving end so several tabs asking at once cost one render rather than one per ask. It is suppression, never composition: what is held is one report, by reference, replaced wholesale — the wrapper-is-a-VIEW rule. It reuses `sameProgress` rather than a second notion of sameness, which is why that function moved to `envelope.ts`.

**Cadence is INHERITED from the port and no timer is introduced.** A report is posted when the host pushes one at the tab holding the port (batch applied or phase changed), not at the cadence of the applied blocks this channel otherwise carries, and not on an interval. The app wiring is one line beside the one it already wrote: `indexer.onProgress(tabs.publishProgress)`.

**The value crosses WHOLE, including `host` and `scope`, which describe the publishing tab's host.** The criterion is "identical in shape and meaning to what a hosting tab receives over its port", so narrowing it to a reader-flavoured subset would have been a second vocabulary. A hosting SHAPE is not a publisher identity (nothing can be addressed, counted or elected from `'dedicated-worker'`), so the previous task's "nothing on the wire names the publisher" property is not weakened. Touches: `one-handler-for-every-transport`, which compares payloads across the three transports — the cross-tab progress frame is `HostProgress`, while the server's is `StateMovedProgress` (three shared block-figure names plus a coherence token a tab does not need, because a tab can re-read).

**Before an election exists, several tabs holding hosts may publish progress, and a receiver renders the LAST report rather than a merge.** This is the same residue the notification has ("every indexing tab publishes, every tab listens"), but with a sharper edge: two reports are contradictory where two notifications were merely redundant. I did not add a filter, because any filter here (prefer the higher block, prefer the writer) would be the receiver inventing policy and a second source of truth, and picking the writer is precisely `one-tab-indexes-and-the-others-read`'s job. It is documented at the site, tested as noise rather than an error, and is why the browser fixture publishes progress only from the tab whose fold is moving.

**`sameProgress` moved from `host/cases.ts` to `host/envelope.ts`.** One definition of "the same report" for both transports, and it keeps a reader tab that imports only `openStateMovedAcrossTabs` from being tied to the module that serves every port case. No behaviour change; `cases.ts` imports it from its new home.

**ADR-0083's status line records this transport half; `CONTEXT.md` is left alone.** Keeping a claim about the code true in the same change, on the precedent the remote-transport task set. The glossary entry for the cross-tab channel belongs to `one-handler-for-every-transport`, which has it as an acceptance criterion.
