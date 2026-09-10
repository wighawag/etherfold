# @etherfold/state-store

The **seam**: what a store must do for a processor to run on it, and the vocabulary both sides speak. Zero dependencies, no SQL, no chain access, no platform.

```ts
import {MemoryStateStore, createMutationContext, type StateStore} from '@etherfold/state-store';

const store: StateStore = new MemoryStateStore([{name: 'token', id: ['id'], fields: {owner: 'text'}}]);
await store.migrate();

const {state, mutations} = createMutationContext(store); // one staging area per block
state.set('token', {id: '1'}, {owner: '0xalice'});
await store.applyBlock({number: 100, hash: '0xa', timestamp: 1_700_000_000}, mutations());

await store.getCurrent('token', {id: '1'}); // at the tip
await store.getAsOf('token', {id: '1'}, 99); // as of a block number: undefined, it did not exist yet
await store.listCurrent('placement', {epoch: 7}, 8); // the children of a key, bounded: {rows, truncated}
await store.revertTo(99); // a reorg: the write above is undone, counters go back DOWN
await store.prune(); // enforce the declared retention against storage; a no-op when there is none
await store.readRetentionEnforcement(); // and whether anything ever has: no-floor / never-pruned / pruned

// how far the caller has got, as an opaque string, written WITH the block it describes
await store.applyBlock(block, mutations(), {key: 'lastSync', value: cursor});
await store.readCursor('lastSync');
```

## Reading it back, typed off the same declarations

The declarations that drive the storage also GENERATE the read surface, so a consumer never writes (and never maintains) a second description of the data:

```ts
import {createReadSurface, declareEntities, MemoryStateStore} from '@etherfold/state-store';

const entities = declareEntities([
	{name: 'token', id: 'id', fields: {owner: 'text', transferCount: 'integer'}},
	{name: 'placement', id: ['epoch', 'position'], fields: {player: 'text'}},
]);

const store = new MemoryStateStore(entities); // the SAME array: one description, both halves
const surface = createReadSurface(store, entities);

const token = await surface.token.getCurrent({id: '1'}); // {id: string; owner: string | null; ...} | undefined
await surface.token.getAsOf({id: '1'}, 100); // as of a block
await surface.placement.listCurrent({epoch: 7}, 8); // the children of a key, bounded
```

No table name, no column string, no hand-written row type. Rename `owner` in the declaration and the consumer stops COMPILING, rather than reading `undefined` in production, which is the whole reason the surface is generated rather than written.

- **`declareEntities` is an identity function**, there only to keep the literal types. An annotated declaration (`const TOKEN: EntityDeclaration = ...`) widens `'owner'` to `string`, after which nothing can be derived from it.
- **Rows are the DECLARED columns only**, with an unlisted field as `null` (a version is a whole row) and the version columns dropped: they are storage, not state, and a projected row cannot be spread back into a write. It decodes nothing further, so a `uint256` stored as decimal `text` comes back as the string it is (ADR-0025).
- **The as-of parameter is whatever the STORE takes.** At the seam that is a block number; a backend with an addressing layer above it (`@etherfold/state-store-sqlite`) also takes `{hash}` and `{timestamp}`, and the surface accepts them because it reads the parameter off the store it was handed. A hash passed to a store that cannot resolve one does not compile.
- **Refusals travel through untouched**: `NoSuchBlockError` and `BlockNotRetainedError` are thrown, never folded into `undefined`.
- **This tier is the BOUNDED one.** The richer form that takes predicates is a backend's own (`createQuerySurface` in `@etherfold/state-store-sqlite`), for the same reason the listing is bounded here: a handler runs once per event on every backend, a server-side reader does not.
- **A GraphQL layer is an addition over this, not a refactor of it.** The decided stack (Hono, then Yoga, then Pothos, built programmatically, no SDL and no deploy-time codegen) walks the same `declareEntities` array for its object types (a field per declared column, `FieldValue` giving the scalar) and resolves them through this surface: `getCurrent` for a node, `listCurrent` for a `@derivedFrom`-style child collection, `getAsOf` / `listAsOf` for a block argument. Nothing here ships it.

## The vocabulary

- **entity declaration** — `{name, id, fields}`, and nothing else. The store owns the layout, the versions, the as-of read and the revert.
- **version** — a COMPLETE row with a half-open block-validity range. `set` writes a whole row, so a declared field it does not list becomes `NULL`; `delete` closes the live version without opening a new one, so the entity is absent from that block on and readable before it.
- **mutation context** — the write surface a handler gets for ONE block, with read-your-writes inside that block. `update` is sugar over get-then-spread-then-set, so the storage model stays visible.
- **listing** — the one SET read: the rows whose declared id starts with a PREFIX (a leading run of its id columns), ascending in the id's own order, bounded by a REQUIRED limit. No predicate, no caller-supplied ordering, no offset, so an accidental full scan cannot be expressed and the operation stays one indexed range scan on every backend. `truncated` says whether more matched, because a set that exactly fills the limit is otherwise indistinguishable from a cut-off one.
- **retention** — how far back superseded versions are kept, in BLOCK NUMBERS. Never in updates (on the real measured stream event-bearing blocks are median 429 apart, so a 64-block window holds one of them), never in time (that prunes on wall-clock rather than chain progress).
- **prune** — the enforcement of retention against STORAGE, as opposed to against answers. A window bounds what a read may ask about from the moment it is configured; `prune` is what drops the versions it no longer covers. It is an explicit call the host schedules, never a side effect of a write, because it costs time proportional to what it drops and a store is the wrong place to pick a maintenance cadence (ADR-0022). The LIVE version of an entity survives it however old it is: that row is the current state.
- **retention enforcement** (`readRetentionEnforcement()`) — whether the retention this store reports is actually being enforced against its storage, as data: `{kind: 'no-floor'}` (nothing to enforce — `unbounded`, or `revert-only` with no declared depth), `{kind: 'never-pruned', floor}` (a floor, and no pass has ever run), `{kind: 'pruned', floor, prunedTo}` (a floor, and a pass ran at `prunedTo`). It exists because the second half of retention only happens if a host schedules it, so a host that never does gets the refusals of a bounded store and the footprint of an unbounded one, and the capability report cannot say so: that report is about the CLAIM. It is ASYNCHRONOUS and separate from `capabilities` because the answer is durable — a store pruned before the process died must not come back saying never — so it lives in storage, under a cursor-port key, and a synchronous getter readable before the database is open cannot produce it. `floor` (as it stands now) and `prunedTo` (the last pass) are kept apart because the distance between them is the diagnostic. See ADR-0076.
- **the scheduled pass** (`pruneMore(states, {maxVersions})`) — the HOST's side of that call, written once so every host schedules it the same way: one bounded pass over every state a host holds, spending ONE budget across them, reporting `{passes, versionsDeleted, complete}`. The budget is a parameter and never a constant, because the number belongs to the caller's schedule — a Worker's is its per-invocation query allowance (`d1PruneBudget`), a tab's is responsiveness, a CLI's is the gap between poll cycles — and `complete` is what the host loops on. It decides no cadence and no failure policy: those are the host's, which is the point of ADR-0022.
- **capabilities** — what a store declares about itself, readable before `migrate` and before any read, so a caller discovers a missing capability at startup instead of from a wrong answer. Two claims today: what history it keeps, and whether it enforces a single WRITER.
- **writer token** — one record INSIDE the storage it guards, read and checked in the SAME atomic unit as every mutation. A writer CLAIMS on its first write; a second writer's first write claims in turn, so the earlier one's next mutation is refused whole with `StoreWriterChangedError` and writes nothing. Claiming is implicit (a guard available and unused passes every single-writer test), does not block and does not expire, so a writer killed mid-block leaves a store the next claim takes over with no clear and no waiting. It is scoped to one unit of STORAGE, because it lives in it: two generations addressed apart both keep writing, and two sharing one storage by misconfiguration are refused rather than corrupting each other. A store that cannot hold a meaningful guard says so (`singleWriter: false` — `MemoryStateStore`'s storage is an instance field, so a token there could only compare with itself), and the conformance suite selects its contention cases on the claim. It is ADR-0054's guarded batch one level down, not a second mechanism; see ADR-0075.
- **snapshot / bootstrap** — state somebody ELSE computed, installed instead of replaying the chain. A `StateSnapshot` is `{format, processor, savedAt, takenAt, cursor, rows}` where `rows` are the rows LIVE at `takenAt`, and it installs as ONE `applyBlock` so a client that crashed mid-install cannot come up holding rows it cannot account for. The point of `openSnapshotAware` is the honesty a blob-shaped snapshot never needed: a snapshot carries NOTHING below its own block, so the store reports a window floored there instead of the `unbounded` a fresh store would claim, refuses an as-of read below it (`BlockNotRetainedError`) rather than reporting the entity as absent, and refuses a revert reaching under it (`RevertBeyondSnapshotError`) rather than half-undoing a reorg. The floor is persisted under a second cursor-port key, so a RELOAD is as honest as the first run. See ADR-0028; the client side (mirrors, most-advanced-wins, prefer-local) is `@etherfold/processor-entities`.
- **sync cursor** — how far the CALLER has got, as an OPAQUE STRING under a key it chooses (`readCursor` / `writeCursor` / `clearCursor`, and `applyBlock`'s third argument). The store persists a string and never learns what it means: a typed cursor would be a `@etherfold/core` type and would drag viem into a storage primitive. It is here, rather than in something the deployment wires beside the store, because only the store holds the transaction the block write happens in, and a cursor written in a second round trip can be left behind the state by a crash — which is not a retry, because the replay hands `applyBlock` a block it already holds and is rightly refused. It is NOT versioned, NOT reverted and NOT pruned: how far the caller got is not entity state. See ADR-0027.

## Why the seam is here and not lower

A processor could have been written against raw SQL, forcing wasm SQLite into every browser. It is written against this instead, because `MutationContext` is the MORE CONSTRAINED surface: a freer substrate can implement it, while backing arbitrary nested object mutation with versioned rows cannot be done without materialising the store. Two independent routes reached this boundary (`research/browser-embedded-indexer`, and the measured port in `work/notes/findings/sqlite-in-the-browser.md`, where a launched 13-handler processor produced state byte-identical to the original on 31,332 real events).

## What is deliberately NOT here

- **Any richer read.** The listing above is the whole of the set-read surface, and the generated read surface offers exactly the same four reads. A predicate, a sort or a page belongs to a backend that has a query planner under it (`queryCurrent` / `queryAsOf` in `@etherfold/state-store-sqlite`), because a handler runs once per event on every backend including the ones that have none. See ADR-0021.
- **Block addressing by hash or time**, and the refusal for an address that resolves to nothing. `getAsOf` takes a resolved block NUMBER; addressing is the read layer above (`@etherfold/state-store-sqlite`, ADR-0015). The generated surface does not add one either: it takes whatever address ITS store takes.
- **What the sync cursor MEANS.** The port above stores a string; the codec that makes it a `LastSync`, and the one fixed key an indexer writes it under, are `@etherfold/processor-entities`. ADR-0016's direction is intact — the store still cannot tell an indexer from any other caller — and ADR-0027 records why the STORAGE nonetheless had to come here.
- **A snapshot PRODUCER.** This package installs a snapshot and cannot make one, and that is structural rather than an omission: enumerating a whole state needs either a ledger of the ids a run wrote or a backend's own query surface, because the listing is anchored at a key prefix by construction (ADR-0021) and an unanchored scan is not expressible. `createSnapshot` in `@etherfold/processor-entities` is the minimal producer the tests need; publishing snapshots as a first-class artifact is a design of its own (`work/notes/ideas/publishing-snapshots-of-versioned-state.md`).
- **Anything ABI-shaped.** The `on<EventName>` handler map is `@etherfold/processor-entities`, which depends on this package and on `@etherfold/core`. Keeping it out is what lets a storage backend depend on this package without inheriting the whole indexer. See ADR-0018.

## Implementations

- `MemoryStateStore`, here: versioned rows in a Map. The reference implementation, so the contract has an executable definition, and the second backend a portability test needs. It matches the SQL store down to the sharp edges (a re-applied block raises, an unlisted field goes to `NULL`) because a lenient reference implementation would let caller bugs through.
- [`@etherfold/state-store-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-sqlite): versioned rows over `remote-sql`.
- [`@etherfold/state-store-indexeddb`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-indexeddb): versioned rows in IndexedDB, and the browser default (ADR-0024).

## Tests

`pnpm --filter @etherfold/state-store test`, vitest.

What the CONTRACT is, rather than what this package's reference store happens to do, is asserted by [`@etherfold/state-store-conformance`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-conformance): one suite, parameterised by a backend factory, asserting external behaviour only. `MemoryStateStore` is run through it under three retention claims, and that run lives in THAT package because it depends on this one and cannot be depended on back. A new backend earns its place behind this seam by passing the same suite.
