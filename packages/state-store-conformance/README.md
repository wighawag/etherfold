# @etherfold/state-store-conformance

The suite a **state store** must pass to earn its place behind the seam. Adding a backend is providing a factory and running it:

```ts
import {describeStateStoreConformance} from '@etherfold/state-store-conformance';
import {MyStore} from '../src/index.js';

await describeStateStoreConformance('MyStore', (declarations) => new MyStore(declarations));
```

That is the whole integration. The suite creates a fresh store per case, calls `migrate` itself, and registers each case as its own vitest test, so a failure names the behaviour that broke.

One thing a factory cannot express, because it is documented as a fresh database per call: TWO handles on one storage. A backend that claims `singleWriter` supplies them separately, and one that does not omit the option:

```ts
await describeStateStoreConformance('MyStore', factory, {
	twoWriters: {
		// two handles on ONE storage identity: what two tabs of one app have
		sharingStorage: (declarations) => [new MyStore(declarations, {at: 'x'}), new MyStore(declarations, {at: 'x'})],
		// and the CLOSEST two separate identities this substrate has
		addressedApart: (declarations) => [new MyStore(declarations, {at: 'x'}), new MyStore(declarations, {at: 'y'})],
	},
});
```

## What it asserts

External behaviour only: what a read returns after a write, after a revert, as of a block. Never a table, never a statement, never a version column. A versioned-rows backend and a patch-log backend must both be able to pass the parts they claim, so a case that reaches for an internal is a defect in the case.

- **Versioned reads.** Write, overwrite, delete; a version is a COMPLETE row (a declared field a write leaves out becomes `NULL`) with a half-open validity range (live AT the block that opened it, not at the block that closed it); a deleted entity is absent from its delete block onward and fully readable as of any earlier block.
- **As-of reads, against what the store CLAIMS.** The suite reads the capability report and tests behaviour against it: `unbounded` answers at any depth, a WINDOW answers at its oldest retained block and refuses below it with a `BlockNotRetainedError` naming what was asked and what is kept, and a store that answers no historical read refuses every one of them. What none of them may do is serve a historical read from the tip.
- **Reorg revert, with a counter that must go back DOWN.** The load-bearing case. A stored counter that does not decrease when its block is reverted is the canonical bug this design exists to make impossible, and it is not hypothetical: `work/notes/findings/sqlite-in-the-browser.md` records the real instance, an accumulated `computedPoints` going from 12 back to 6. The counter is accumulated through the mutation context (read, add, write), because the read is where the bug bites.
- **Read-your-writes within a block.** Two events in one block that touch one counter compose; `update` carries a field it does not mention and `set` clears it; and a LISTING made later in the block sees exactly the children the block has written and not the one it deleted, which is the part a listing cannot get by falling through to the store.
- **The bounded id-prefix listing.** The children of a prefix, ascending in the declared id's own order, never more than the limit, and `truncated` when the limit cut the answer off (a set that exactly fills the limit must NOT claim it). A prefix that is not a leading run of the id columns is refused, an as-of listing answers about the block it was asked about, and a revert un-derives the collection. This is what a one-to-many is modelled on, so a backend that gets it subtly wrong makes an idiomatic model quietly incorrect rather than obviously broken.
- **A block is one atomic unit, and its height is above the tip.** A block whose mutations include a rejected one applies none of them and does not take its height; applying one block twice raises; and so does a height the store has already moved past, even one nothing was ever recorded at, because a caller reverts to the fork before it applies the branch replacing it. An EMPTY store has no tip and admits whatever height its caller starts at, and a revert makes a height applicable again.
- **The sync cursor, and that it is never AHEAD of the last applied block.** The round trip and the clear are the easy half (an opaque string under a key, byte for byte); the case that matters is atomicity, because a caller cannot get it from outside. A block handed a cursor moves both or neither, so a REFUSED block leaves the cursor exactly where it was — a cursor describing a block the store does not hold sends the next run silently past it, and one left behind wedges the run instead, since the replay hands `applyBlock` a block it already holds. Installing rows and a cursor together is the same verb, which is what a snapshot bootstrap needs (ADR-0027).

- **Pruning, and whether retention is actually ENFORCED.** What a prune must never take is the same on every substrate and is asserted as a survival property rather than as a deletion: the LIVE version of an entity written once far below any floor is the current state and survives, a read at the oldest block inside the window is still answered, one below it is still refused, and a revert to the full depth of the window still works. Retention's second half is then asked of the store itself (`readRetentionEnforcement`), because a floor that is in force while nothing ever drops below it is the one configuration nothing could previously detect — the refusals of a bounded store with the footprint of an unbounded one. The suite cannot hold a fixed expectation there (only the store knows whether it has a floor at all: a `revert-only` store with a declared depth has one and the capability report does not carry it), so it CROSS-CHECKS instead — a pass with a floor must leave the store reporting `pruned` AT that floor, a pass with none must leave it reporting `no-floor` — and, where a backend can open two handles on one storage, that the second reads back what the first pruned, since a reload must not report never. See ADR-0022 and ADR-0076.

- **Bootstrapping from a snapshot, and the floor it must then report.** A store loaded from state somebody else computed inherits a trap every backend would otherwise meet for the first time in somebody's browser tab: a snapshot carries nothing below its own block, and a freshly migrated store of any backend reports `unbounded`, because that is true of a store that has been indexing since genesis and it has no way to know it is not one. So the cases assert that rows and their cursor install as one unit, that the origin survives a FRESH HANDLE over the same storage (a floor held in a closure is gone on reload), that a revert reaching below the snapshot is refused and changes nothing while a wipe still works, and -- selected on the claim, like every other as-of case -- that a read below the floor is refused and one at or above it is answered. See ADR-0028.

- **A second writer writes nothing, on a backend that CLAIMS it can enforce one.** Selected on `capabilities.singleWriter`, because a backend whose storage is an instance field cannot be beaten by a second writer and a token there would only ever be compared with itself. Both halves are asserted: a writer whose claim was taken is refused on EVERY mutating path with `StoreWriterChangedError` and leaves the store exactly as the holder left it (and can still READ, which is what demoting to a reader needs), while two stores ADDRESSED APART write concurrently and neither is refused. See ADR-0075.

- **A writer claims by OPENING.** `openForWriting` takes the store there and then, so a writer that has opened and not yet applied a block already holds it and the writer it displaced is refused from that instant. The mechanism runs through the seam rather than through a claim verb the concrete classes would have had to grow: the claim is a `clearCursor` of a key nothing ever writes, so a backend whose `clearCursor` took a short cut when there was nothing to delete would skip it, and these cases are what notices. Asked of every backend: opening changes no byte a caller can observe, and a second open on one instance is the SAME claim (the shipped `createState: () => store` pattern hands one store to every generation, so independent claims would have a process refuse itself). See ADR-0077.

Every factory-driven chapter above is asked TWICE, once of the store your factory returns and once of the handle `openForWriting` hands back, because a consumer now holds one or the other and a handle that delegated a verb wrongly would be a store that behaves differently depending on how its holder obtained it. Your factory and options are unchanged; the chapters driven by `twoWriters` are asked once, since a second HANDLE is not a second shape.

What is NOT here: any access path. That a listing is one indexed range scan rather than a scan-and-sort is a property of a particular backend, and it is pinned in that backend's own tests (`state-store-sqlite/test/listing.test.ts` reads it back out of `EXPLAIN QUERY PLAN`).

## Why the claim is read first

Testing a backend against a capability it never claimed fails honest backends. Testing it against LESS than it claimed is what lets a claim become fiction. So the suite reads `store.capabilities` once, from a probe store, and asks each backend exactly what it said it could do.

That the capability cases are real is itself a test: `test/the-suite-catches.test.ts` runs the suite against backends with one lie each (claiming a window it does not honour, answering an as-of read from the tip, accepting a revert without undoing it, moving the sync cursor before the block instead of with it, claiming a single writer while letting a second one write, pruning while reporting that it never has, claiming a prune on a store with no floor, rewinding to make room for a block the tip has passed) and asserts which cases go red. Without that, the capability tests would be decoration.

The single-writer claim is the one place the suite REFUSES to fall silent: a backend that claims it and hands over no `twoWriters` fails a case saying so, because skipping the only cases that could catch a fiction is how the report stops meaning anything.

## Running the cases directly

The cases are data, not registered tests, which is what makes the above possible: a suite that has already reported itself to a runner can be run but cannot be asserted on.

```ts
const {passed, failures} = await runStateStoreConformance(factory);
```

`stateStoreConformanceCases(factory)` gives the list itself, for driving it from another runner or from a browser harness. (The assertions are vitest's `expect`, which is why vitest is a peer dependency; the `describe`/`it` registration is the only part that needs a vitest RUN.)

## Backends that run it

- [`@etherfold/state-store`](https://github.com/wighawag/etherfold/tree/main/packages/state-store)'s `MemoryStateStore`, under three retention claims (here, because that package cannot depend on this one).
- [`@etherfold/state-store-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-sqlite)'s `VersionedStateStore`, on a real libSQL database, under the same three.
- [`@etherfold/state-store-indexeddb`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-indexeddb)'s `IndexedDBStateStore`, and [`@etherfold/state-store-patch`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-patch)'s `PatchStateStore`, each under the claims it can honestly make.

The workload here is deliberately small and hand-written. The heavy one, [`@etherfold/conformance-workload-stratagems`](https://github.com/wighawag/etherfold/tree/main/packages/conformance-workload-stratagems), replays 31,332 real logs from a launched game on Base through the same backends and compares against the state that game's ORIGINAL processor computed. It is a second SUBJECT for the same backends and not a replacement: a case that fails on 31,332 real events is a bug report nobody can read, so these small cases go first and that one asks the question they are too small to ask.

## Tests

`pnpm --filter @etherfold/state-store-conformance test`, vitest.
