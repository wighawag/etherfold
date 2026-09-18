# @etherfold/processor-entities

Write a processor **once**, run it wherever its state has to live. Declare entities, write `on<EventName>` handlers against a `MutationContext`, and hand the result to any [`@etherfold/state-store`](https://github.com/wighawag/etherfold/tree/main/packages/state-store) backend.

```ts
import {applyEventStream, type EntityProcessor} from '@etherfold/processor-entities';

const processor: EntityProcessor<typeof abi> = {
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text', transferCount: 'integer'}}],
	async onTransfer(state, event) {
		const id = event.args.id.toString();
		const token = await state.get<{transferCount: number}>('token', {id});
		state.set('token', {id}, {owner: event.args.to, transferCount: (token?.transferCount ?? 0) + 1});
	},
};

// the same object, against versioned SQL rows on a server or a Map in a test
await applyEventStream(store, processor, eventStream, undefined);
```

Nothing in that object names a backend, which is the whole point: where the state physically lives is a deployment choice the processor neither sees nor encodes. `test/two-backends.test.ts` runs this exact processor against `@etherfold/state-store-sqlite` and against `MemoryStateStore` and asserts the resulting state is the same.

## Running it as an indexer

`applyEventStream` is the engine. `EntityEventProcessor` is the `EventProcessor` the core actually drives, and it takes the store, so choosing a backend is choosing the argument:

```ts
import {EntityEventProcessor} from '@etherfold/processor-entities';

const store = await createBrowserStateStore(processor.entities); // a tab, on IndexedDB
const store = new VersionedStateStore(db, processor.entities); //    a server, on SQLite

const indexed = new EntityEventProcessor(store, processor);
const view = await indexed.process(eventStream, lastSync);
await view.getCurrent('token', {id: '1'});
```

It owns the whole lifecycle the core expects (`load` / `process` / `reset` / `clear`, plus the code fingerprint that names a module arrival) and `prune`, which a host schedules between `process` calls. `test/entity-event-processor.test.ts` runs one processor definition through it against all four shipped backends and asserts the same state, a reorg that takes a counter back DOWN, and a sync cursor that survives a restart on each of them.

**The sync cursor lives in the store**, as an opaque string written in the same transaction as the block it describes (ADR-0027). That is what makes a restart safe on every backend rather than only on the one with a SQL table to write into; `serializeLastSync` / `deserializeLastSync` are here, and the store never learns what the string means.

**The handle `process` returns is the seam tier.** `EntityStateView` has `getCurrent` / `getAsOf` / `listCurrent` / `listAsOf` and the capability report, and deliberately no `queryCurrent` / `queryAsOf`: those take caller-supplied SQL, so asking a backend-neutral handle for them is a compile error rather than a runtime throw in a tab. Choose [`@etherfold/processor-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/processor-sqlite) for that tier.

## What you get, and what it costs

- **`set` writes a WHOLE row.** A version is a complete row, not a delta, so a declared field `set` does not list becomes `NULL`. `update(entity, id, partial)` is sugar over get-then-spread-then-set for the counter case; it is spelled as sugar so the storage model stays visible.
- **Read-your-writes within the block.** `get` answers from the mutations already staged for the block being processed. It is load-bearing, not theoretical: on the real measured stream, 16,871 of 66,113 reads were served from the block's own staging area.
- **Handlers are uniformly async.** Typing reads as `T | Promise<T>` instead would be infectious at every call site, to save a microtask on a path dominated by fetching logs.
- **Model a one-to-many as children keyed by their parent**, the way a subgraph's `@derivedFrom` does, and read the collection back with a bounded listing:

  ```ts
  // entity: {name: 'placement', id: ['window', 'ordinal'], fields: {epoch: 'integer'}}
  const {rows, truncated} = await state.list('placement', {window: 'global'}, 8);
  ```

  The prefix is a LEADING run of the declared id columns, the limit is REQUIRED, the order is the id's own ascending order, and there is no `where`, no `orderBy` and no offset: that is what keeps it one indexed range scan on every backend a handler might run on (ADR-0021). Nothing is maintained at write time, so appending a child costs one row.
- **Key ordered children by something naturally unique** (an event ordinal, or `(blockNumber, logIndex)`) rather than by a dense array position, and make a key that must sort numerically FIXED-WIDTH, because a listing is ordered lexicographically over the stringified id. The measured port that validated this model paid for ignoring the first rule with three entities and a hand-maintained CSV index; see `work/notes/findings/sqlite-in-the-browser.md` and `test/ordered-children.test.ts`, which models the same window of seven with no index, no count and no stored array.

## Reading the state back

The declarations are the ONE description of the data, so the read surface is generated from them rather than hand-written beside them:

```ts
import {createReadSurface, declareEntities} from '@etherfold/processor-entities';

const entities = declareEntities([{name: 'token', id: 'id', fields: {owner: 'text', transferCount: 'integer'}}]);
const processor: EntityProcessor<typeof abi> = {entities /* handlers... */};

const surface = createReadSurface(store, entities);
await surface.token.getCurrent({id: '1'}); // {id: string; owner: string | null; transferCount: number | null}
```

The same four reads the seam has (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`), typed off the declaration, so renaming a field breaks the consumer at COMPILE time; `declareEntities` is an identity function that exists only to keep the literal types an annotation would widen away. `test/read-surface.test.ts` runs one reader, unchanged, against all three backends. See [`@etherfold/state-store`](https://github.com/wighawag/etherfold/tree/main/packages/state-store) for the details, and `createQuerySurface` in [`@etherfold/state-store-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-sqlite) for the server-side tier that also takes predicates.

## Starting from a published snapshot

A client does not have to replay the chain from the start block. `openAndBootstrap` installs state another indexer already computed and then resumes from its cursor:

```ts
import {openAndBootstrap} from '@etherfold/processor-entities';

const {store, outcome} = await openAndBootstrap(await createBrowserStateStore(processor.entities), [
	'https://mirror-a.example/state.json',
	{url: 'https://mirror-b.example/state.json', head: 'https://mirror-b.example/head.json'},
], {processor: processorIdentity, finalityDepth: 64}); // the identity this fold's ARRIVAL derived
```

The selection is the free-form path's, point for point (`keepStateOnIndexedDB(name, remote)` in `@etherfold/browser`): every location is asked how far it has got, the furthest wins, local state that is already ahead is KEPT, and an unreachable mirror is logged and skipped rather than fatal. Two differences on purpose: failover walks every remaining candidate rather than the winner plus one, and a snapshot computed by another processor identity is not a candidate at all.

What has no free-form counterpart is the honesty, because a blob has no history to lie about. A snapshot carries only the rows that are LIVE at its block, so the store it lands in reports a retention window floored THERE rather than the `unbounded` a freshly migrated store would claim, refuses an as-of read below it with `BlockNotRetainedError`, and refuses a reorg reaching under it with `RevertBeyondSnapshotError` (declining a snapshot taken inside the reorg window is the other half, which is what `finalityDepth` above buys). That mechanism is at the seam, so every backend inherits it; ADR-0028 records why, and what a snapshot contains, with the measurement behind it in `docs/spikes/bootstrap-an-entity-store-from-a-snapshot/`.

`createSnapshot` is the MINIMAL producer, for tests and for a host that already knows which ids it wrote. Publishing snapshots as a first-class artifact -- who produces one and when, format versioning, mirror layout, pruning old ones -- is a design of its own and is deliberately not here.

## Where the pieces live

| | |
| --- | --- |
| `EntityProcessor`, `EventHandlers` | here: the ABI-typed authoring surface |
| `applyEventStream`, `runBlockHandlers`, `forkPoint`, `groupByBlock` | here: revert-then-apply, once, for every backend |
| `EntityEventProcessor`, `EntityStateView`, the `LastSync` codec | here: the `EventProcessor` shell, once, for every backend |
| `bootstrapFromSnapshot`, `openAndBootstrap`, `createSnapshot` | here: choosing between mirrors needs the cursor's codec |
| `StateSnapshot`, `openSnapshotAware`, the history floor | [`@etherfold/state-store`](https://github.com/wighawag/etherfold/tree/main/packages/state-store): a floor is a fact about a store |
| `MutationContext`, `EntityDeclaration`, `StateStore`, capabilities, the cursor port | [`@etherfold/state-store`](https://github.com/wighawag/etherfold/tree/main/packages/state-store): what a store must understand |
| a `RemoteSQL`-flavoured wrapper and the SQL read tier | [`@etherfold/processor-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/processor-sqlite) |

ADR-0018 records why this is a separate package from `@etherfold/state-store` rather than one: a storage backend must be able to depend on the seam without inheriting `@etherfold/core`.

## Tests

`pnpm --filter @etherfold/processor-entities test`, vitest.
