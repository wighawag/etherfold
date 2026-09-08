# @etherfold/processor-sqlite

An `EventProcessor` whose derived state is versioned rows in [`@etherfold/state-store-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-sqlite) rather than an object in memory. Indexing a chain normally leaves the state readable **as of any earlier block**, on the hash, height or time axis, without the processor author doing anything beyond declaring entities and writing handlers.

The processor object below is **not** a SQLite thing. The authoring API (`EntityProcessor`, the `on<EventName>` handler map, `MutationContext`) is defined in [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) and re-exported here, so the same object runs unchanged against any other `StateStore` backend; `SQLProcessor` remains as a deprecated alias. See ADR-0018.

So is the indexing. `VersionedStateEventProcessor` is a thin SQLite flavour of `EntityEventProcessor`: it builds the store from your `RemoteSQL` handle and hands back the SQL read tier, and everything else -- revert-then-apply, the block grouping, the version hash, the sync cursor -- lives once, in `@etherfold/processor-entities`, written against the seam. If you already have a `StateStore`, use `EntityEventProcessor` directly and skip this package.

```ts
import {VersionedStateEventProcessor} from '@etherfold/processor-sqlite';

const processor = new VersionedStateEventProcessor(db, {
	version: '1.0.0',
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
	},
});

// driven by the core indexer, exactly like any other EventProcessor
const view = await processor.process(eventStream, lastSync);
await view.getAsOf('token', {id: '1'}, {hash: '0x...'}); // state as it was at that block
```

## What is different from the in-memory path

The retired free-form processor path reverted a reorg with immer reverse-patches, because reverting by replay needs the state as of the fork block and the in-browser path could not get it. ADR-0001 records that and names the condition for revisiting it: a store that can answer "state as of block N". This is that store. Reverting here is a single `revertTo(forkPoint)`, two SQL moves per table over the validity ranges, with no patch history and no replay.

The observable behaviour is meant to be identical, and that is checked rather than claimed. `test/reorg.test.ts` runs the same scenarios as the in-memory package's characterization tests, and `test/equivalence.test.ts` runs both processors over the same streams and compares the resulting states directly, so divergence is a test failure rather than a discovery in production.

## Two things worth knowing before you wire it up

**Timestamps cost nothing, but your node has to serve them.** `blockTimestamp` is on the log itself under `execution-apis#639`, served by geth (>= 1.16.0), reth, besu, erigon, anvil and `@nomicfoundation/edr >= 0.20.0`, so the time axis is populated with no extra request. That is now a REQUIREMENT rather than a preference: there is no fallback that fetches the block instead (ADR-0073), so a node that does not serve the field is refused at the fetch boundary, naming the node. On Hardhat, whose released versions still bundle an older EDR, pull it forward with a package-manager override rather than waiting for a Hardhat release. A block is never recorded without a real timestamp: `process` throws instead of guessing, because `getAsOf({timestamp})` has no way to tell a caller it was lied to.

**A handler's `set` writes the whole row.** A version is a complete row rather than a delta, mirroring the store's close-then-insert, so unlisted declared fields become `NULL`. To change one field, use `update(entity, id, partial)`, which is sugar over get-then-spread-then-set; `get` is read-your-writes within the block being processed.

## What `process` returns

A `VersionedStateView`: a read-only query handle, not the state. It is the SQL TIER -- the seam's four reads plus `queryCurrent` / `queryAsOf` (caller-supplied predicates) and block addressing by hash and by time -- and that is the reason to choose this class over the backend-neutral one, whose `EntityStateView` deliberately does not have them so that asking for SQL is a compile error rather than a runtime throw in a browser tab. Materialising a versioned store into an object would defeat its purpose, and the core never inspects the value anyway (it forwards the outcome of `process` and the `state` from `load` to the optional `onStateUpdated` callback and nothing else). The handle is read-only on purpose: handing back the store itself would put `applyBlock` and `revertTo` in reach of a UI callback. The processor is the only writer.

## Design notes

- ADR-0016 for the package name, ADR-0014 for the scope, ADR-0018 for why the authoring API is not defined here.
- ADR-0001 for why the in-memory path uses reverse-patches and what justified revisiting it here.
- ADR-0015 for why an unresolvable block address throws instead of answering `undefined`.
- `docs/design/historical-state-database.md` §2 and §5 for the versioned-row model and the revert.
- ADR-0027, and `src/sync.ts`, for why the sync cursor moved out of this package's `_sync` table and behind the storage seam, where it is written in the same transaction as the block it describes.
