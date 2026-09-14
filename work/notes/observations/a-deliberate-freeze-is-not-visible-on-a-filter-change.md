---
title: 'A deliberate freeze is not visible: on a filter change the incumbent stops advancing and nothing says so'
slug: a-deliberate-freeze-is-not-visible-on-a-filter-change
observed: 2026-09-13
---

2026-09-13, narrowed 2026-09-14. This note began as "the incumbent freezing across a filter change is a defect". That framing was withdrawn by the author and the withdrawal is the better position, so what is recorded here now is the part that survives it.

## What happens, and why it is probably right

On a filter change the successor is on its own stream and must fetch its own history, while the incumbent's stream is the old filter. `run` builds ONE log fetcher over one scalar source and never consults the container for which contexts are live, so after the change the single fetcher serves the NEW filter, the old stream gets no writer feeding it, and the incumbent stops advancing. It goes on answering every read from the state it already has.

That was first read as a defect. It probably is not. A source change usually means the old fold's answers are WRONG rather than merely stale (after a contract upgrade it describes a contract that is no longer the source of truth), so keeping it current would be keeping it wrongly-current, and it would spend a second fetcher plus node budget on a generation about to be discarded. The task written to "fix" it is cancelled (`the-combined-run-feeds-every-live-wire-context`), and its body keeps the mechanism in case the deliberate WAIT path is ever wanted.

## The live signal: the freeze is INVISIBLE

If the incumbent is deliberately frozen, a developer should be able to SEE that, and cannot. Progress reporting answers how far the SUCCESSOR has caught up. Nothing states that the generation currently answering reads has stopped advancing on purpose, so the only way to notice is to watch a cursor and infer it from the fact that it stopped, which is indistinguishable from a stalled fold, a wedged follower or a quiet chain.

That matters more here than it would elsewhere, because every other stall in this system is a fault and this one is a choice. A reader that cannot tell them apart learns to ignore the signal that would have told it about a real one.

## What would close it

A deployment should be able to say that a held generation is not being fed, and why, in the same shape it already reports what it is doing. The facts are all present already: which contexts are live is exactly what `liveIngestions()` answers, and which generation answers reads is the canonical pointer. What is missing is that nothing joins them and reports "this generation answers reads and nothing is feeding its stream".

Two things worth deciding when it is picked up. Whether this is a field on the existing progress or cursor report, or a phase of its own, and whether the right statement is about the generation (it is frozen) or about the stream (it has no writer being fed), which are the same fact from two ends and the second is the more honest one, because a stream with no feed is what is actually true.

## Not to be confused with

- **The sub-case where the incumbent is right but incomplete.** A filter change that only ADDS a contract leaves the old fold a correct fold of a SUBSET, and there keeping it current is genuinely useful. The system cannot tell that apart from a replacement, which is story 5 of `a-reconfigure-is-not-an-outage`: "only I know whether my reconfigure made the old answers wrong or merely incomplete". So if the wait path is ever built it belongs on the same axis as the promotion policy, not as a fixed behaviour.
- **`rapid-change-succession-hits-the-generation-cap`**, which is about the count of generations under churn rather than about whether any of them is being fed.
