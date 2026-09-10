---
title: 'A second writer writes nothing'
slug: a-second-writer-writes-nothing
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

Two instances of one indexer writing to one state store corrupt it, and today only one of the five mutating paths would notice. A user with the app open in two tabs is not an exotic deployment, a browser tab that was backgrounded resumes with a stale cursor, and an app following the documented `createState` example puts two generations of one indexer into one database inside a single tab.

### What is unguarded today

ADR-0054's opening line already records the primitive: "IndexedDB gives that for free (`readwrite` transactions serialise across tabs)". `applyBlock` uses it correctly, for exactly one thing. Inside the one `readwrite` transaction it opens, it reads `blocks.get(block.number)` and the hash index and refuses on either. That is a genuine compare-and-swap and it holds against a concurrent writer. **Nothing else on the mutating surface has a precondition of any kind**, in increasing severity:

1. **The cursor write inside `applyBlock` is unconditional.** It `put`s over whatever is there. The block half of that one transaction is guarded and the cursor half is not.
2. **`applyBlock` refuses a DUPLICATE height, not a non-monotonic one.** The invariant a single writer actually maintains is "above the recorded tip"; what is enforced is "not exactly this height, and not this hash".
3. **`writeCursor` / `clearCursor`** are the no-block paths, so no block record incidentally protects them. These are how a writer holding a stale in-memory `LastSync` moves the recorded position BACKWARDS, silently. On the next load the cursor disagrees with the data, the indexer re-fetches, and every re-application hits (2), which presents as a wedged store rather than as the lost update it is.
4. **`prune`** drops versions against a retention floor computed from a tip another writer may have moved.
5. **`revertTo` has no precondition at all**, and it is the destructive one: it deletes versions above a fork point while another writer may be folding above it. It is the only path here that can leave a WRONG state rather than an exception.

Two things that look like coverage and are not. **Nothing elects a writer**: no `navigator.locks`, no `BroadcastChannel`, no lease anywhere in `@etherfold/browser`, so the refusal in (2) correctly names the caller as the bug and no caller is in a position to avoid it. And **the four-tab browser case does not test this and says so itself** (`browser/multi-tab.spec.ts`: "Each tab owns its own block heights (a block is applied once, by definition), writes its own rows"): it proves the substrate tolerates four concurrent connections, which is the claim ADR-0024 needs from it, and was never evidence that two indexers can share a database.

The failure that matters is the quiet one. A wedged store is annoying and visible. A cursor that went backwards produces a state that is internally consistent, reproducible on reload, and wrong, which is precisely the class ADR-0054 refuses elsewhere: "a read-then-write that merely LOOKS atomic... passes every single-writer test, and the state it corrupts is invisible afterwards".

Electing a single writer is the right thing to do and is specified separately. It is not sufficient on its own, and should not be what correctness rests on: a leader can be alive but asleep (background tabs have their timers throttled hard and frozen after minutes, so a heartbeat cannot distinguish a healthy leader from a comatose one), any lease handoff has a window where the previous holder has not noticed, and some runtimes will not have the primitive the election is built on.

## Solution

**A writer claims the store, and every mutation it makes is checked against that claim inside the same transaction that performs the write.** A second writer's mutation is refused whole: not partially applied, not applied late, not applied to a state it did not read. It writes nothing.

This is ADR-0054's guarded batch with a revision token, applied one level down, and it is strictly easier here than in the case that ADR was written for. There, `RemoteSQL` cannot read, run JS and write inside one transaction, so the guard has to be smuggled into a pre-built statement list. Here the browser gives what ADR-0054's own opening line already records: `readwrite` transactions serialise across tabs. So the check and the write are in one serialisable transaction and there is no window between them at all. That is worth stating precisely because it is stronger than the usual fencing-token guarantee: in the distributed-lock story the token is needed *because* the check and the write are on different machines and fencing is therefore best-effort. Here a stale writer's mutation lands **never**, not "almost never", and no timing assumption is made anywhere.

The consequence to design for, and the reason this spec comes before the election one: **leader election demotes from a correctness requirement to an optimisation.** With the guard in place, a failed election, a browser without the primitive, a zombie leader waking from a throttled tab, and two tabs that both believe they won all produce the same outcome: some wasted RPC calls until the loser is refused and demotes itself, and zero corruption. Election then exists to stop the waste, and when it breaks the system gets slow and noisy rather than wrong.

A refused writer is not an application error. It is a writer learning it lost, and the correct response is to drop the in-memory `LastSync` that is now a lie, stop fetching, and become a reader.

## User Stories

1. As an app developer, I want a user with my app open in two tabs to end up with correct state, so that I do not have to make single-tab-ness a deployment constraint.
2. As an app developer, I want the second tab to be refused rather than to silently win, so that the failure is a condition I can handle instead of a corruption I discover later.
3. As an app developer, I want a distinct, named error when my writer has lost its claim, so that I can tell it apart from the existing "applying the same block twice is a caller bug" (which means the opposite: that one is my bug, this one is a lost race with a correct response).
4. As an app developer, I want two tabs running genuinely DIFFERENT indexers on one origin to keep working independently, so that an origin hosting more than one indexed app is not a supported-in-theory case that breaks in practice.
5. As an app developer, I want two generations of ONE indexer (a canonical generation and a follower rebuilding) to keep writing concurrently, so that the guard does not refuse the one form of concurrent writing the design requires.
6. As an app developer, I want a writer that lost its claim to demote itself to a reader, so that the losing tab keeps showing correct data instead of erroring or going blank.
7. As an app developer, I want a demoted writer to drop its in-memory cursor, so that it cannot resume later from a position that stopped being true.
8. As a user, I want a tab I backgrounded for an hour and came back to to show correct state, so that browser timer throttling is not a data-loss mechanism.
9. As a user, I want a tab that crashed or was killed mid-block to leave a store the next tab can use, so that recovery is not a manual clear.
10. As an operator of a server deployment, I want the same guarantee from the SQLite backend, so that the rule is a property of the storage seam rather than a browser-only precaution.
11. As a maintainer, I want the guard to be one mechanism satisfied two ways rather than two mechanisms, so that the conformance suite can ask both backends the same question.
12. As a maintainer, I want the guard asserted by the conformance suite, so that a new backend arriving behind the seam inherits the obligation rather than rediscovering the hazard.
13. As a maintainer, I want a test that does not depend on timing, so that the case cannot rot into a flaky one that gets skipped. ADR-0054 already demonstrates the shape: wrap the handle and land a rival's write just before the write under test reaches the database, and removing the guard turns it red.
14. As a maintainer, I want the browser contention case run against three real engines, so that a claim about cross-tab serialisation is not made on `fake-indexeddb`, which cannot demonstrate it.
15. As a maintainer, I want `browser/multi-tab.spec.ts` to gain the case it currently avoids by construction (two tabs contending for the SAME heights, exactly one winning), so that the file stops being read as evidence for something it does not test.
16. As a maintainer, I want the cursor write inside `applyBlock` to be guarded by the same claim as the block, so that one transaction does not have a guarded half and an unguarded half.
17. As a maintainer, I want `revertTo` guarded, because it is the only path that can produce a wrong state rather than an exception.
18. As a maintainer, I want `writeCursor` and `clearCursor` guarded, because they have no block record incidentally protecting them and are how a position moves backwards.
19. As a maintainer, I want `prune` guarded, so that a retention floor is never computed against a tip another writer has moved.
20. As a maintainer, I want the store to stay ignorant of what a cursor STRING means (ADR-0027), so that adding this guard does not quietly turn the cursor into something the store parses.
21. As a maintainer, I want a refused mutation to cost a re-fold rather than a partial apply, so that recovery from contention is a known, bounded action.
22. As a reviewer, I want the rationale recorded as an ADR that names its relationship to ADR-0054, so that the next person meeting two guard mechanisms can see they are one mechanism on two substrates.

### Autonomy notes

- **No flags.** This carried `humanOnly` while the sequencing of a breaking change was an open judgement. That judgement is now written down as **Task order** below, which converts it from something a person had to decide into something a tasker follows, so the flag has nothing left to buy. The property it exists to protect is stated there as an acceptance condition rather than left to care: `main` builds and `pnpm test` passes after every step, which matters more than usual because there is no CI to catch a bad sequence afterwards.
- **No `needsAnswers`.** All three are answered in Implementation Decisions below. Two were preferences with a clear argument; the third was a question about existing code, and it was settled by reading `applyEventStream` rather than by choosing.


> **Tasked.** The technical detail this spec launched with (Implementation Decisions, Testing Decisions, and the Task order) now lives in the tasks it produced, which is where it can go stale against code rather than beside it. Durable rationale is relocated to an ADR by the task that lands it. What remains here is the durable framing: Problem, Solution, User Stories, Out of Scope.

## Out of Scope

- **Electing a single writer.** Its own spec (`one-tab-indexes-and-the-others-read`): SharedWorker where available, Web Locks as the fallback, and the `localStorage` plus `BroadcastChannel` scheme in `../jolly-roger` as the portable floor. This spec deliberately lands first so that election is an optimisation over a store that is already safe.
- **Read consistency within one query.** A reader in another tab can still see the store move under a multi-read query; that is the block-pinning question and it belongs with the query surface spec. The two compose and neither replaces the other.
- **The query executor seam** (`the-same-query-runs-against-a-worker-and-a-server`).
- **Amending ADR-0024.** Building election satisfies its criterion 3 ("the app is single-tab by construction, or is willing to build leader election"), which removes one of the four barriers to wasm SQLite. That amendment belongs with the election spec that actually makes it true, not here.
- **Making concurrency USEFUL.** The guard makes a second writer safe, not productive: it burns RPC calls until its next write is refused. Reducing that waste is what election is for.
- **The `createState` addressing defect.** `createState` is handed a `GenerationContext` and the documented example (`createState: () => createBrowserStateStore(myProcessor.entities)`) ignores it, so an app following the docs puts every generation into the default `etherfold-state` database, sharing one `BLOCKS` store. That is why a second writer is reachable INSIDE one tab and not only across tabs, and it is worth checking against ADR-0053 ("a generation is a table namespace and a named indexer is a database"), which suggests the namespace is meant to be part of the addressing here and does not appear to be. It is a real defect and it is NOT a dependency of this spec: with the claim scoped as above, the misconfiguration becomes a loud refusal instead of silent corruption. Its own task, and note when writing it that `context.stream` alone is not a sufficient address either, since a follower shares its writer's stream by definition and the processor half of a generation's identity provably cannot be known at `createState` time.

## Further Notes

The relationship to ADR-0054 is the main thing a reader should leave with: this is not a second concurrency mechanism, it is the same one on a substrate that makes it easier. Recording that explicitly is what stops the next person treating them as separate inventions and giving them separate shapes.

The scoping requirement in user stories 4 and 5 looked like the hardest part of this spec and turned out to dissolve. "One writer" is not a statement about an origin or a tab, and it does not need to be a statement about a generation either: it is a statement about one unit of STORAGE, and putting the token inside that storage makes the scope follow automatically from an identity every backend already has. Two tabs running unrelated indexers never contend because their storage identities differ, and two generations of one indexer can write at once for the same reason, provided the host addressed them apart. What is worth keeping from the earlier framing is only the warning: anyone tempted to scope the claim to an origin, a tab, a connection or a lock name outside the database will break story 4, story 5, or both.
