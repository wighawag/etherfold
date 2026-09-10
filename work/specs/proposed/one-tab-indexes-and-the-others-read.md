---
title: 'One tab indexes and the others read'
slug: one-tab-indexes-and-the-others-read
needsAnswers: true
taskedAfter: [a-second-writer-writes-nothing]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
-->

## Open questions

1. **Is a SharedWorker the primary mechanism, or the Web Locks election?** A SharedWorker is a singleton by construction, so there is no election at all and no lease to reason about, but it PRESUMES a worker-hosted indexer, and nothing in this repository puts one there yet (see Out of Scope). Web Locks works with the indexer wherever it already is. Picking SharedWorker first makes this spec depend on work that does not exist; picking Web Locks first means building an election that a later SharedWorker would make redundant.
2. **How does a reader learn that the leader advanced?** OWNED BY `a-reader-learns-when-the-state-moved`, which exists because this question belonged to neither of the two specs that needed it. Recorded here because the leader is the PRODUCER in that model, and `BroadcastChannel` between tabs is one of the transports it has to work over. Do not answer it here.
3. **What does a demoted leader do with work in flight?** The writer guard makes its next mutation fail safely, so this is about tidiness rather than correctness: whether it abandons the batch silently, reports it, or keeps its fetched logs warm in case it wins the lease back.
4. **Does a reader tab report sync progress, and from where?** An app renders "syncing, 400 blocks behind" from `IndexerState`. A reader computes nothing itself and must read the leader's cursor, which is behind the storage seam as an opaque string. Either the leader publishes progress alongside its block notification, or a reader deserialises a cursor the seam says is opaque, and only the first of those is allowed.

<!-- /open-questions -->

## Problem Statement

Nothing decides which tab indexes. Every tab that opens an app runs its own indexer against the same store, so they duplicate every `eth_getLogs` call, they compete for the same block heights, and (before the writer guard) they corrupt each other.

The writer guard fixes the corruption and deliberately does not fix the waste. Two tabs still both fetch the whole chain, both fold it, and one of them then discovers that everything it wrote was refused. On a rate-limited browser provider that is the expensive half: the user pays for N times the RPC calls, N times the bandwidth and N times the CPU to produce one store's worth of state.

What is missing is agreement about who does the work. And what must NOT happen while adding it is that correctness starts depending on that agreement being reached, because the browser will not cooperate: background tabs have their timers throttled hard and frozen after minutes, so a leader can be alive and doing nothing while looking healthy to any heartbeat; a lease handoff has a window where the previous holder has not noticed; and some runtimes will lack whichever primitive is chosen.

## Solution

**One tab holds the write duty. Every other tab reads the store it is writing. Correctness does not depend on either of those being true.**

That last clause is what `a-second-writer-writes-nothing` buys and it is why this spec comes second. With the writer guard in place, a failed election, a zombie leader waking from a throttled tab, a browser without the primitive, and two tabs that both believe they won all produce the same outcome: some wasted RPC calls until the loser's next write is refused and it demotes itself. Election is therefore an **optimisation for cost**, and when it breaks the app gets slower and noisier rather than wrong.

The structural half is that a non-leader is not a leader that declines to write. It is **handed a reader**: `openForReading` from the writer-guard spec, which is the same move ADR-0044 already makes for streams, where a follower is handed a `readOnlyStream` rather than asked to behave.

The mechanism is a ladder, because runtimes differ and the best answer needs work that does not exist yet:

1. **A SharedWorker**, where available: one instance per origin and script, so there is no election, no lease, no heartbeat and no dual-leader window. Tabs attach by `MessagePort`, which is exactly the query spec's `workerExecutor(port)`. Safari removed SharedWorker for years and restored it in 16.4, so it is now broadly viable rather than Chrome-only.
2. **Web Locks** (`navigator.locks.request`), when the indexer is in a dedicated worker per tab or on the main thread: acquisition is ATOMIC so there is no read-check-write race and no dual-leader window to reconcile afterwards, and the lock is released automatically when the tab dies or crashes, so there is no heartbeat, no stale threshold and no timeout to tune. Safari 15.4+.
3. **A `localStorage` lock plus `BroadcastChannel` with heartbeats**, the portable floor. Written and tested next door in `jolly-roger` (`web/src/lib/core/tab-leader/`), and its own comments are honest about the cost of that substrate: the read-check-write "is not atomic (TOCTOU race)... all could briefly become leaders", resolved afterwards by channel messages, plus a heartbeat, a stale threshold and an election debounce. Four moving parts because `localStorage` cannot do better.

Whichever rung is used, the lock's identity is **the store's storage identity**, not the origin and not the app. Two tabs running unrelated indexers must never contend, and two correctly separated generations of one indexer must be able to write at once, which is the same scoping rule the writer guard already settles by putting its token inside the storage it guards.

## User Stories

1. As a user with the app open in several tabs, I want the chain fetched once, so that I am not paying for the same logs N times on a rate-limited provider.
2. As a user, I want every tab to show the same state, so that two windows of one app do not disagree.
3. As a user, I want a non-indexing tab to be fully usable, so that a second tab is not a degraded tab.
4. As a user, I want closing the indexing tab to hand the work to another one, so that the app does not stop syncing because I closed the wrong window.
5. As a user, I want that handover to need no action from me, so that I never see "please close your other tabs".
6. As a user whose indexing tab crashes, I want another tab to take over without waiting out a timeout, so that a crash is not a stall.
7. As a user, I want a backgrounded indexing tab to yield to a foreground one, so that browser throttling does not make the app I am looking at the slow one.
8. As an app developer, I want a reader tab to be handed a reader, so that "this tab does not write" is a fact of the type rather than a rule I have to keep.
9. As an app developer, I want election failure to cost RPC calls and never correctness, so that I am not shipping a consistency model that depends on `BroadcastChannel` timing.
10. As an app developer, I want a demoted leader to become a reader by itself, so that losing a race is not an error I have to handle in the UI.
11. As an app developer, I want to know which tab is indexing, so that I can show it if I want and ignore it if I do not.
12. As an app developer, I want reader tabs to learn when new data landed, so that my UI updates without polling on a timer I invented.
13. As an app developer, I want sync progress in a reader tab, so that "syncing, 400 blocks behind" is renderable everywhere rather than only in the tab doing the work.
14. As an app developer on a runtime without the primitive, I want the app to work anyway, so that the mechanism is an optimisation and not a requirement.
15. As an app developer running two DIFFERENT indexers on one origin, I want them never to contend, so that one app's leader is not another app's blocker.
16. As a maintainer, I want the election tested by observing outcomes across real tabs, so that the claim is about behaviour rather than about a mocked lock.
17. As a maintainer, I want the case where two tabs both believe they lead asserted explicitly, so that the "correctness does not depend on this" claim is tested rather than stated.
18. As a maintainer, I want ADR-0024 amended when this lands, because its criterion 3 for wasm SQLite is "the app is single-tab by construction, or is willing to build leader election", and building this satisfies one of the four conditions it rests on.

### Autonomy notes

- **No `humanOnly`.** Nothing here changes a public seam or a default. It adds a mechanism whose failure mode is cost, and the shape is constrained by the writer-guard spec that precedes it.
- **`needsAnswers: true`.** Question 1 decides whether this spec depends on a worker-hosted indexer that does not exist yet, which changes what the tasks are rather than how they are built. Question 2 must be answered jointly with the query spec's transport question or the two will disagree.

## Implementation Decisions

**Election is for cost, never for correctness**, and every task in this spec must hold that line. If a change here would make a wrong answer possible when election fails, the change is wrong: the writer guard is the correctness mechanism and this is the thing that stops the work being done twice.

**A non-leader is handed `openForReading`.** Not a leader with writes disabled, not a store with no-op mutations. The one existing precedent that swallows writes (`readOnlyStream`) does so for a documented reason that does not apply here: there, read and write share one seam and the engine's save is unconditional, so declining to write was not expressible. Here it is expressible, so it is expressed.

**A leader publishes; it is not polled.** Readers learn of a new block from the leader rather than by watching the store, because a store that has to be watched means either polling or a change feed nothing has asked for. What that publication carries is settled with the query spec's transport question (open question 2), and it must include enough for a reader to render sync progress without deserialising the cursor, which the seam says is opaque (ADR-0027).

**Losing is a demotion, not an error.** A tab that loses the lease, or whose write is refused by the guard, drops its in-memory `LastSync` (now a lie), stops fetching, and continues as a reader. That is the same demotion the writer-guard spec already specifies for a refused write, and there should be one code path for both.

**A foreground tab may take the lease from a backgrounded one.** This is the case that a lock alone does not solve, because a throttled tab holds its lock perfectly well while doing almost nothing. Whatever mechanism is chosen needs a way for a visible tab to ask, and the fallback if it is not built is simply the status quo: the backgrounded leader keeps indexing slowly, which is a cost problem and not a correctness one.

## Testing Decisions

- **Real tabs, real outcomes.** The existing `browser/multi-tab.spec.ts` harness already mounts four tabs of one app against one database; the case here is that under N indexing tabs, exactly one fetches, all N answer reads identically, and closing the leader results in another tab fetching without a gap in the recorded blocks.
- **The dual-leader case asserted explicitly**, by forcing two tabs to believe they lead: the store must remain correct, which is the writer guard's claim being re-tested from this side rather than a new claim.
- **Handover on a crash**, not just on a clean close, since the automatic-release property is the main reason to prefer Web Locks over a heartbeat.
- **Not asserted by mocking the lock.** A mocked election tests the code that calls it, and every real failure here is about what the browser does to a tab it is not showing.

## Out of Scope

- **The writer guard** (`a-second-writer-writes-nothing`), which this depends on and which carries correctness.
- **Putting the indexer in a worker at all**, which is `the-indexer-runs-in-a-worker-and-the-tab-talks-to-it`. Nothing in this repository does it yet: `createIndexerState` is a main-thread reactive hook. Rung 1 presumes that spec has landed, which is what open question 1 is really about. Deliberately NOT a `taskedAfter`, because the Web Locks rung needs no worker, and making it one would decide question 1 by the back door.
- **The query transport** (`the-same-query-runs-against-a-worker-and-a-server`).
- **How a reader is notified**, which is `a-reader-learns-when-the-state-moved`. Open question 2 here is that spec's to answer; it is recorded on both sides because a leader publishing block notifications is the same mechanism seen from the producer's end.
- **Cross-DEVICE coordination.** This is about tabs of one browser profile sharing one origin's storage, and nothing here is a distributed-systems mechanism.
- **Amending ADR-0024.** It should be amended when this lands, not before, since its criterion 3 becomes satisfied by the existence of this work rather than by the decision to do it.

## Further Notes

The reason this spec is small is that the expensive part was moved out of it. Written first, it would have had to carry consistency, and every question about throttling, lease expiry and handover windows would have been a question about whether the store could be corrupted. Written second, all of those are questions about how many RPC calls get wasted before the loser notices, and a wrong answer to any of them costs money rather than data.

Worth stating for whoever takes it: `jolly-roger`'s implementation is good prior art and should be read, but its substrate is the reason for most of its complexity. If Web Locks is available, roughly three of its four moving parts (the TOCTOU reconciliation, the heartbeat, the stale threshold) have no counterpart, because the platform provides atomicity and release-on-death directly.
