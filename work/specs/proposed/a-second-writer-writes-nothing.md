---
title: 'A second writer writes nothing'
slug: a-second-writer-writes-nothing
humanOnly: true
needsAnswers: true
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
-->

## Open questions

> The two that governed the shape are CLOSED, and their answers are in Implementation Decisions below: the write surface splits at construction (`openForWriting` / `openForReading`), and the claim is scoped to the store's own storage identity because it lives inside it. Three remain, none of which changes that shape.

1. **Do `MemoryStateStore` and `@etherfold/state-store-patch` carry the guard, or declare its absence?** The check is trivial in one heap, and uniformity is what the conformance suite is for; against that, a memory store's second writer is a second object in one process, which is a different hazard from a second tab. A backend that declares the guard absent creates a second variant of the seam contract, which is the cost to weigh.
2. **Should `applyBlock` also refuse a height that is not ABOVE the recorded tip?** A single writer maintains that invariant, but it must be checked against the paths that apply out of order by design if any exist: a replay, a rebuild chunk, a seeded generation installing below its own position. Not investigated; this needs reading those paths rather than reasoning about them.
3. **Opaque token or monotonic counter?** ADR-0054 rejected a counter because `remote-sql` reports no affected-row count, so a loser reading `expected + 1` could not tell a win from a loss. That reason does not apply on IndexedDB, where the check is a read inside the writing transaction. Uniformity across the two backends argues for the opaque token anyway.

<!-- /open-questions -->

## Problem Statement

Two instances of one indexer writing to one state store corrupt it, and today only one of the five mutating paths would notice. A user with the app open in two tabs is not an exotic deployment, a browser tab that was backgrounded resumes with a stale cursor, and an app following the documented `createState` example puts two generations of one indexer into one database inside a single tab. What they hit is recorded in `work/notes/observations/a-second-writer-is-guarded-only-where-a-block-record-happens-to-sit.md`: a duplicate-height refusal in the best case, a cursor silently moved backwards in the common case, and a `revertTo` deleting versions under a writer that is still folding in the worst.

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

- **`humanOnly: true`.** Splitting the store's construction into a writing and a reading factory is a breaking change to `StateStore`, every backend, the conformance suite and `@etherfold/processor-entities`. The decision is taken (below) and the rationale is recorded, but accepting that blast radius on the project's central seam is a human's call, not an auto-tasker's.
- **`needsAnswers: true`.** Three open questions remain. None blocks the shape, and question 2 is the one that actually blocks tasking: whether any path legitimately applies a block below the recorded tip is a fact about the replay, rebuild and seeding code that nobody has read yet, and cutting an acceptance criterion for a monotonicity check before reading them would pin the wrong behaviour.

## Implementation Decisions

**The claim is a token, and it is checked in the transaction that writes.** Not before it, not in a wrapper, not by a caller. The rule the seam states is: a mutating call carries the token its writer believes it holds, and a store refuses a token it does not hold, having read the stored token inside the same atomic unit as the write it is about to perform.

**The write surface splits at CONSTRUCTION, not by an argument.** A store is opened for reading or for writing, and only the writing one has the mutating methods. So "a reader cannot write" is a fact of the type rather than a rule to remember, which is the same structural move ADR-0044 already makes for streams ("the writer is handed the keeper, every follower is handed a read-only stream view"), and the ability to write is obtainable ONLY by claiming, so a token cannot be forged or forgotten.

```ts
type WriterToken = string;

type ReadableStateStore = {
  /* getCurrent / getAsOf / listCurrent / listAsOf / readCursor / capabilities */
};

type WritableStateStore = ReadableStateStore & {
  readonly token: WriterToken;
  migrate(): Promise<void>;
  applyBlock(block, mutations, cursor?): Promise<void>;
  revertTo(blockNumber): Promise<void>;
  writeCursor(key, value): Promise<void>;
  clearCursor(key): Promise<void>;
  prune(): Promise<void>;
};

// opening for writing SWAPS the stored token for a fresh unique one, so an
// earlier writer's next mutation is refused. It does not block and it takes
// nothing: a loser is not waiting, it has simply lost.
declare function openForWriting(...): Promise<WritableStateStore>;
declare function openForReading(...): Promise<ReadableStateStore>;
```

**Why construction rather than a `claim()` on an already-open store.** Three things stop being questions. `migrate` WRITES, so under a separate lease there would be a write outside the guard on day one and the rule would be dented before it shipped; here it simply belongs to the writable store. Bootstrap writes too (`openSnapshotAware`, `bootstrapFromSnapshot`), and is likewise just a writer rather than more surface to re-home. And losing the claim needs no lease-renewal semantics: a demoted writer constructs a fresh store, which forces exactly the re-read that correctness wants anyway, so the mid-fold-dead-lease question never has to be answered.

**Two alternatives, recorded because they will be proposed again.** An OPTIONAL token argument on the existing methods is compatible, tiny and rejected: it leaves every caller unguarded until they read the docs, which is precisely the "read-then-write that merely LOOKS atomic" ADR-0054 refuses, and it passes every single-writer test. A REQUIRED token argument on the five mutating methods is the honest fallback if the blast radius above prices out: it closes the default-unguarded hole for a much smaller change, and its weakness is that a token is just a string, so the type forces PRESENCE but not PROVENANCE, and nothing expresses reader-ness.

**The claim is scoped to the store's own storage identity, because it lives inside that storage.** No new scoping concept is introduced and the guard does not need to know what a generation is. On IndexedDB the identity is the `databaseName`; on SQLite it is the database plus ADR-0053's table namespace, which that backend already validates in its constructor. That gives the four cases the right answers by construction: two tabs on one generation contend and one wins; two tabs running unrelated indexers never contend, because their identities differ; two correctly separated generations never contend; and two generations sharing one database by MISCONFIGURATION contend and are refused loudly, where today they corrupt each other silently. The last case is a feature of this design rather than a limitation of it.

**Per substrate, the same rule realised two ways.** On IndexedDB the token record is read inside the existing `readwrite` transaction and the mutation is abandoned by aborting it, which is what `applyBlock` already does for a duplicate height. On SQLite over `RemoteSQL` it is ADR-0054's mechanism unchanged: guard every statement on the token, swap the token as the last write of the same batch, read it back inside that batch to learn whether it won. Nothing new is invented on the SQL side; the existing pattern is applied to a second set of writes.

**The guard is on the token, never on the cursor value.** The cursor is an opaque string at the seam (ADR-0027) and the store must not begin comparing or parsing it. Guarding the token gives the cursor write its protection without the store learning anything about what it holds.

**The error is its own.** `StoreWriterChangedError`, distinct from the existing duplicate-height refusal, because they mean opposite things and a caller responds to them differently. It says nothing was written and that the caller no longer holds the claim.

**Losing is not throwing at the app.** The generation that catches it drops its in-memory `LastSync`, stops fetching, and becomes a reader. That demotion already has a precedent in the shape a follower takes.

**Two invariants worth adding while the transaction is open**, both cheap because the transaction already exists: `applyBlock` refusing a height not above the recorded tip (subject to open question 4), and the cursor write inside `applyBlock` being guarded with the block rather than beside it.

## Testing Decisions

External behaviour only, as everywhere behind this seam: what a read returns after a contended write, never which statement ran.

- **Conformance, parameterised by the factory**, so every backend answers it: a second claim invalidates the first; each of the five mutating paths is refused under a stale token; a refused call leaves the store byte-identical to how it found it; a winner's writes are unaffected by a loser's attempts.
- **The no-timing race case**, ADR-0054's shape reused: wrap the handle, land a rival's write in the exact window between the writer's read and its write, assert the refusal. Removing the guard must turn it red, which a `setTimeout` race would not guarantee.
- **The browser contention case**, extending `browser/multi-tab.spec.ts` from tabs that own disjoint heights to tabs that contend for the same ones: exactly one wins, the losers are refused by name, and the fifth-connection audit finds no torn state. Three engines, the harness already exists.
- **Explicitly not provable under `fake-indexeddb`**, which cannot demonstrate cross-tab serialisation. The unit suite can assert the refusal logic; only the browser run is evidence for the concurrency claim, and the distinction should be stated where the results are kept rather than left for a reader to assume.
- **The demotion**, at the generation level: a refused writer stops fetching and answers reads, rather than propagating an exception.

## Out of Scope

- **Electing a single writer.** Its own spec (`one-tab-indexes-and-the-others-read`): SharedWorker where available, Web Locks as the fallback, and the `localStorage` plus `BroadcastChannel` scheme in `../jolly-roger` as the portable floor. This spec deliberately lands first so that election is an optimisation over a store that is already safe.
- **Read consistency within one query.** A reader in another tab can still see the store move under a multi-read query; that is the block-pinning question and it belongs with the query surface spec. The two compose and neither replaces the other.
- **The query executor seam** (`the-same-query-runs-against-a-worker-and-a-server`).
- **Amending ADR-0024.** Building election satisfies its criterion 3 ("the app is single-tab by construction, or is willing to build leader election"), which removes one of the four barriers to wasm SQLite. That amendment belongs with the election spec that actually makes it true, not here.
- **Making concurrency USEFUL.** The guard makes a second writer safe, not productive: it burns RPC calls until its next write is refused. Reducing that waste is what election is for.
- **The `createState` addressing defect.** `createState` is handed a `GenerationContext` and the documented example ignores it, so an app following the docs puts every generation into the default `etherfold-state` database. That is a real defect and it is captured in the observation this spec came from, but it is NOT a dependency: with the claim scoped as above, the misconfiguration becomes a loud refusal instead of silent corruption. Its own task, and note when writing it that `context.stream` alone is not a sufficient address either, since a follower shares its writer's stream by definition and the processor half of a generation's identity provably cannot be known at `createState` time.

## Further Notes

The relationship to ADR-0054 is the main thing a reader should leave with: this is not a second concurrency mechanism, it is the same one on a substrate that makes it easier. Recording that explicitly is what stops the next person treating them as separate inventions and giving them separate shapes.

The scoping requirement in user stories 4 and 5 looked like the hardest part of this spec and turned out to dissolve. "One writer" is not a statement about an origin or a tab, and it does not need to be a statement about a generation either: it is a statement about one unit of STORAGE, and putting the token inside that storage makes the scope follow automatically from an identity every backend already has. Two tabs running unrelated indexers never contend because their storage identities differ, and two generations of one indexer can write at once for the same reason, provided the host addressed them apart. What is worth keeping from the earlier framing is only the warning: anyone tempted to scope the claim to an origin, a tab, a connection or a lock name outside the database will break story 4, story 5, or both.
