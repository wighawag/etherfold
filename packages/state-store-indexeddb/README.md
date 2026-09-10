# @etherfold/state-store-indexeddb

The **browser** state store: versioned rows in IndexedDB. The same processor that runs on a server against `@etherfold/state-store-sqlite` runs in a tab against this, and the tab gets history, reorg revert, a cold start that reads only what it asks for, and a write cost proportional to what CHANGED rather than to total state.

```ts
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';

const store = new IndexedDBStateStore(processor.entities, {databaseName: 'my-app'});
await store.migrate();

// the same processor as on the server
await applyEventStream(store, processor, eventStream, config);

await store.getCurrent('token', {id: '1'}); // one `get`
await store.getAsOf('token', {id: '1'}, 18_000_123); // one backwards cursor
await store.listCurrent('placement', {epoch: 7}, 8); // one IDBKeyRange cursor
await store.revertTo(18_000_120); // a reorg: two index range scans
await store.prune(); // drop what the declared retention no longer covers
```

Most browser applications reach it through [`@etherfold/browser`](https://github.com/wighawag/etherfold/tree/main/packages/browser), where it is the DEFAULT and where choosing something else is a line of configuration:

```ts
const store = await createBrowserStateStore(processor.entities); // this backend
const other = await createBrowserStateStore(processor.entities, {backend: (e) => new PatchStateStore(e)});
```

## Why IndexedDB, and what would change the answer

Measured, not preferred. On the real workload (the launched stratagems game on Base: 31,332 events, 1,042 event-bearing blocks, 4,072 live rows) IndexedDB beat wasm SQLite on writes by **1.6x to 6.9x** and on reads by **4x to 14x**, on every engine that can run both; WebKit cannot run the SQLite route at all (`Missing required OPFS APIs`, or a `:memory:` database that loses everything on reload); and **three of four tabs fail AT OPEN** on both SQLite VFSs.

**ADR-0024** records that as a CONDITION rather than a preference: the four things that would all have to be true for wasm SQLite to win, and the five things that would overturn the choice. The evidence is `work/notes/findings/sqlite-in-the-browser.md`, with raw output in `docs/spikes/sqlite-in-the-browser/results/`.

**It is not a speed-up over the incumbent.** The whole-state blob (`keepStateOnIndexedDB`) is the fastest writer at today's sizes: 2.0 ms/block on Chromium against 45.6 for row-level writes. What it cannot do at any speed is answer an as-of read, revert a reorg, or stop its per-write cost growing with total state.

## The layout

Four object stores, and the entity name lives in the KEY:

```
current   [entity, ...id]         -> {lower, values}          the tip read, one `get`
versions  [entity, ...id, lower]  -> {lower, upper, values}   the history, for as-of and for revert
blocks    number                  -> {number, hash, timestamp}
cursors   key                     -> the opaque string a caller wrote (the sync cursor)
```

- **A version is a complete row** with a half-open block-validity range (`lower` inclusive, `upper` exclusive, `null` meaning live), which is what `@etherfold/state-store-sqlite` keeps as columns. A `set` writes a whole row, so a declared field the write did not list becomes NULL; a `delete` closes the live version without opening a new one.
- **A store per entity was rejected.** Creating an object store needs a version change, and an upgrade transaction can be BLOCKED by another open tab, so a store per entity would make "the processor declares one more entity" a migration a second tab can stall. The schema version is this PACKAGE's and never a processor's: declaring another entity is not a migration, and every access path a table would have given is still a key range. (It moved to 2 when `cursors` was added and to 3 when `writer` was; each upgrade is additive, so an existing database keeps every row.)
- **One block is one transaction**, and the SYNC CURSOR is in it. A block applies whole or not at all, two tabs writing one database serialise instead of interleaving, and the cursor that says "I have reached this block" commits with the block or not at all (ADR-0027). A cursor kept outside the store would be a second write, and a crash between them wedges an indexer.
- **`revertTo` does not touch `cursors`.** How far the CALLER got is not entity state; the caller moves it when it applies the canonical branch.

### The access paths, which are the reason for the seam's shapes

| operation | what it does |
| --- | --- |
| `getCurrent` | one `get` on `current` |
| `getAsOf` | one cursor over `[entity, ...id, ..at]`, walked BACKWARDS: the first hit is the version live then |
| `listCurrent` / `listAsOf` | one cursor over `IDBKeyRange.bound([entity, ...prefix], [entity, ...prefix, []])` |
| `revertTo` | two index range scans: drop what the fork opened (`lower`), reopen what it closed (`upper`) |
| `prune` | one range scan of the `upper` index, oldest close first |
| `readCursor` / `writeCursor` / `clearCursor` | one `get` / `put` / `delete` on `cursors`; a cursor handed to `applyBlock` rides the block's own transaction |

The listing bound is the interesting one: `[]` sorts after every string in IndexedDB's key order, so `bound([prefix], [prefix, []])` is exactly "the prefix and its descendants". That is why the handler seam's only set read is an id PREFIX plus a REQUIRED limit and never a predicate or a caller-supplied ordering (ADR-0021) — it has to be one indexed range scan on a substrate with no query planner. `test/listing-access-path.test.ts` asserts the range and the number of records walked, because a scan-and-filter would return the same rows.

`prune` deserves the same note. A live version's `upper` is `null`, which is not a valid IndexedDB key, so a live version has no entry in the `upper` index at all: the row that IS the current state, however old, cannot be reached by the prune. The prototype these measurements came from scanned every version and tested a predicate (6.3 s at 62,553 versions); this walks a range. Neither the prune nor anything else drops a block record — that is what makes re-applying a height raise, and dropping it would turn "outside what I keep" into "no such block".

## Retention

`retention` is `'revert-only'`, `{blocks: N}` or `'unbounded'` (the default), in BLOCK NUMBERS and no other unit (ADR-0019), validated at construction against `finalityDepth`. Whatever is set is REPORTED, because this store enforces both halves: an as-of read outside the window throws `BlockNotRetainedError` (never the tip value), and `prune` drops the versions the window no longer covers.

The window is measured against the tip **read from the database**, not one the instance remembers, which is what makes it right after a reload and right when another tab has moved the tip.

Note the trap: a window of N BLOCKS is not N updates of history. On the real measured stream, event-bearing blocks are median **429 blocks apart**.

## Multi-tab

Several tabs of one app share one database by construction (that is what a database name IS), and that is the case both wasm-SQLite VFSs fail at open. `browser/multi-tab.spec.ts` runs four tabs against one database, each writing its own block heights, and audits from a fifth connection that every row is there: four of four, zero mismatches, on all three engines.

Two tabs both INDEXING into one database is the other half of that, and it is guarded rather than tolerated: every mutating path carries a **writer token** in the `writer` store, read and checked in the same `readwrite` transaction that writes (ADR-0075). A tab claims by writing; a second tab's first write claims in turn, so the first tab's next mutation is refused with `StoreWriterChangedError` and writes nothing. Because the transaction is the atomic unit, there is no window between the check and the write for a second tab to land in -- the fencing is exact, not best-effort, and nothing here assumes anything about timing. The claim is scoped to the `databaseName` and nothing else, so two unrelated indexers on one origin, and two generations of one indexer named apart, never contend. `migrate` never claims: opening is not writing, and every tab opens.

## Tests

```bash
pnpm --filter @etherfold/state-store-indexeddb test          # node, under fake-indexeddb
pnpm --filter @etherfold/state-store-indexeddb test:browser  # Chromium, Firefox and WebKit
```

`test/conformance.test.ts` runs [`@etherfold/state-store-conformance`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-conformance) under all three retention claims. The rest of `test/` is what only this backend can be asked: the access paths above, what a prune cannot reach, the cold start, and two connections to one database.

The browser run is the same shared suite in a real engine, plus the four-tab case, plus persistence across a real reload, plus the same processor producing the same rows in a tab as in node. It is not in the acceptance gate (it needs three browser binaries); its output is kept in `docs/spikes/indexeddb-row-backend-browser-default/results/`.
