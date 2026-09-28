---
title: 'A visible tab takes the indexing lease from a backgrounded leader'
slug: a-visible-tab-takes-the-lease-from-a-backgrounded-leader
spec: one-tab-indexes-and-the-others-read
blockedBy: [a-remaining-tab-takes-over-when-the-indexing-tab-closes]
covers: [7]
---

## What to build

The spec `one-tab-indexes-and-the-others-read`'s decision D4 deferred this, and ADR-0097 ("D4: a foreground tab does not take the lease from a backgrounded one, yet") records it. The tab that indexes keeps the Web Lock until it closes. Browsers throttle a tab the user is not looking at (timers clamped, and a long-hidden tab frozen), and the lock does not notice: a backgrounded leader keeps the write duty while indexing slowly or not at all, and the tab the user IS looking at is a reader whose data falls behind. Decided with the maintainer on 2026-09-28: build the handover now.

When a tab running the election becomes VISIBLE while the leader is HIDDEN, the visible tab takes the lease and the hidden leader becomes a reader. Requirements:

- **No ping-pong.** Switching tabs quickly must not bounce the lease: only take it when the current leader is hidden (the leader publishes its visibility on the election's existing channel, beside its progress) and the asking tab has stayed visible for a short settle time; a visible leader is never displaced. Record the settle time and why.
- **The mechanism.** ADR-0097 says `steal` is never used; decide between a cooperative step-down (the visible tab asks on the channel, the hidden leader releases and demotes, with a bound after which the asker takes the lock anyway, since a FROZEN tab cannot answer) and `navigator.locks.request(name, {steal: true})`, or a combination. Whatever is chosen, a taken-over leader stops cleanly: it abandons its in-flight batch (the spec's "a demoted leader abandons its in-flight batch, reports it, and keeps nothing") and becomes a reader through the existing demotion, and the new leader makes ADR-0078's fresh start. The writer claim stays the correctness guarantee: if both write for a moment, the loser's writes are refused and it demotes, as today.
- **Visibility lives in the tab.** For a dedicated-worker host the tab reports its visibility to its host over the port; the host acts on it. A SharedWorker host is one indexer for its tabs and is not a background tab: decide whether it takes part (for example, it counts as visible while any of its tabs is) and record it.
- **Opt-out.** An app can turn the handover off and keep D4's behaviour; decide the default (the maintainer's preference is on by default when the election is on) and record it.
- **Reported** on the existing status surface (a takeover's reason names the backgrounded leader), over the port for worker hosts.
- Amend ADR-0097's D4 section in place (it is no longer deferred, and `steal` if used) and update the guide's election section.

If it is cheap, record as a finding how far a backgrounded leader actually falls behind on a main-thread host and on a dedicated-worker host (worker timers are throttled less than a page's), since that sizes the problem; do not block on it.

## Acceptance criteria

- [ ] Real tabs (the Playwright multi-tab harness, which CI now runs on Chromium, Firefox and WebKit): with the leader hidden and a reader made visible past the settle time, the reader becomes the leader and indexes forward with no gap in the recorded blocks; the old leader becomes a reader and fetches nothing afterwards. Visibility may be driven by emulating `document.visibilityState` and dispatching `visibilitychange` where the harness cannot background a tab.
- [ ] A frozen leader (one that never answers) is still displaced within the stated bound.
- [ ] Switching visibility faster than the settle time does not move the lease; a visible leader is never displaced.
- [ ] The same with a dedicated-worker host per tab.
- [ ] Both writing for a moment leaves the store correct (asserted explicitly).
- [ ] With the opt-out, behaviour is exactly #234's; without the election, exactly today's.
- [ ] ADR-0097 and the guide updated; changesets for every published package changed (0.x: patch or minor).

## Blocked by

- `a-remaining-tab-takes-over-when-the-indexing-tab-closes` (landed).

## Prompt

> Goal: a visible tab takes the indexing lease from a backgrounded leader (see What to build). Look at `packages/browser/src/tabElection.ts`, `packages/browser/src/IndexerState.ts` (demotion, the reader factory), `packages/browser/src/host/` (`serve.ts`, `port.ts`, `dedicatedWorker.ts`, `sharedWorker.ts`), the multi-tab specs `packages/browser/browser/oneTabIndexesAndTheOthersRead.spec.ts` and `election.ts`, ADR-0078 and ADR-0097, and the spec `one-tab-indexes-and-the-others-read`.
>
> FIRST, check this task against current reality: if a visibility handover exists, route to needs-attention naming it.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **Mechanism: `steal` only, no cooperative step-down message.** A frozen tab cannot answer, so a cooperative protocol needs `steal` as its fallback anyway, and `steal` alone does the whole job. It releases the lock at once, hands it to the visible tab ahead of any queue (a cooperative release would go to whoever queued first, often another hidden tab), and rejects the holder's own request, which is how a live leader learns it lost. The window where both write is covered by the writer claim, and a test asserts it. The alternative was an ask/answer step-down on the channel with a timeout. Touches ADR-0097 D1 and D4.
- **Settle time 2000 ms (`DEFAULT_FOREGROUND_SETTLE_MS`), overridable with `foregroundTakeover: {settleMs}`.** It counts how long the whole condition (reader visible and leader hidden or silent) has held without a break. It is longer than a keyboard or mouse sweep across tabs, short beside timer clamping and freezing, and it is also the bound for displacing a frozen leader.
- **A leader that has never been heard counts as displaceable; one that publishes no visibility does not.** Silence is how a frozen leader appears to a tab opened after it froze, which is the main case this task exists for. To stop a leader that is still starting up being mistaken for a frozen one, a new leader announces its seat on the channel the moment it holds the lock (`leaderAnnouncement`), before its container opens. Leaders that publish no visibility (opt-out, SharedWorker, a worker no tab has reported to) are never displaced.
- **Visibility travels as `TabElectionState.visibility` inside the existing progress report, not as a new channel message kind.** `sameProgress` now compares it (and `takeoverReason` and `displaced`), so a change is published. Touches the `HostProgress.election` wire shape.
- **A displaced leader queues for the lock again.** It becomes a full reader seat rather than a permanently demoted container, so a lone tab left behind after the displacing tab closes still takes over. `syncing.demotion` reads `lease-lost` while it reads and is cleared when it takes over again, since the takeover makes a new claim through `createState` (ADR-0077). The alternative, demote and resign as a refused write does, would leave nobody indexing in that case.
- **A SharedWorker host does not take part.** It ignores the `visibility` case, publishes no visibility, is never displaced and never takes the lease: it is one indexer for all its tabs and is not throttled like a page. Considered and not built: counting it visible while any of its tabs is. Recorded in ADR-0097 D4.
- **The default is on whenever the election is on; `foregroundTakeover: false` is the opt-out.** This was the maintainer's stated preference. It sets a user-visible default on `TabElection`.
- **The tab reports visibility automatically from `connectToIndexerHost`** in any scope that has a `document`: after connect, on every `visibilitychange`, and again after a restart. Hosts that do not take part ignore it. This adds a new port case, `visibility`, and an optional `HostBacking.reportVisibility`.
- **New public names:** `ForegroundTakeover`, `TabVisibility`, `TakeoverReason`, `DEFAULT_FOREGROUND_SETTLE_MS`, and the seat fields `takeoverReason`, `displaced` and `visibility`. They reuse the existing "takeover" vocabulary (`tookOver`) and the spec's "foreground" wording. I checked them against `CONTEXT.md` and they re-mean nothing.
- **Residual, recorded in the ADR:** two visible windows side by side, while the leader has not yet been heard, can move the lease once to the other visible tab. Neither is displaceable afterwards, so it does not bounce, and the writer claim keeps the store correct.
