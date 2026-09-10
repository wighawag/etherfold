# @etherfold/state-store-sqlite

Entity state kept as **versioned rows with a half-open block-validity range**, on the [`remote-sql`](https://github.com/wighawag/remote-sql) interface and nothing else, so the same code runs on a local SQLite file, on libSQL/Turso, and on hosted SQLite reached over HTTP.

The design, with the rejected alternatives and the measured performance shapes, is `docs/design/historical-state-database.md` in this repo. This package is the storage layer that design rests on.

## The model

Every version of every entity is a row carrying `_lower` (valid from, inclusive) and `_upper` (valid until, exclusive; `NULL` means live). The current value is never stored on its own.

- **Write** is close-then-insert: `UPDATE ... SET _upper = N` on the live version, then `INSERT ... (_lower = N)`. A delete is just the close.
- **Read as of block N** is one predicate: `_lower <= N AND (_upper IS NULL OR N < _upper)`.
- **Current state** is the open-row special case `_upper IS NULL`, kept fast by a partial unique index that also enforces "exactly one live version per business key" — the invariant SQLite cannot express as a real constraint.
- **`revertTo(N)`** is `DELETE` versions opened above the fork, **then** re-open versions closed above it.

An author declares only `{name, id, fields}`; the store owns the DDL, the version columns, the as-of rewrite and the revert. History falls out of a declaration instead of being re-implemented by every processor.

## One implementation of the seam

This is a `StateStore` ([`@etherfold/state-store`](https://github.com/wighawag/etherfold/tree/main/packages/state-store)), which is the backend-neutral contract a processor is written against: `migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `listCurrent` / `listAsOf` / `revertTo` / `prune`, plus the capabilities it declares. The declaration, mutation and block-pointer types are the seam's and are re-exported here, so a processor hands this store exactly what it would hand any other backend.

Everything below those verbs is this backend's own and deliberately NOT at the seam: block addressing by hash and by time, and the `queryCurrent` / `queryAsOf` surface that takes caller-supplied SQL. A server has a query planner; a handler, running once per event on every backend, does not.

The seam's `listCurrent` / `listAsOf` are the other side of that line, and they are cheap here for a reason a test pins rather than asserts by hand: an equality on the LEADING id columns plus `ORDER BY` the declared id is a key-prefix range, so SQLite seeks into the entity's id index and walks it in order, with no sort and no table scan whatever the table holds. `test/listing.test.ts` reads the access path back out of `EXPLAIN QUERY PLAN`, because no behavioural assertion can tell a range scan from a table scan that returns the same rows.

## Retention

`store.capabilities` reports what the deployment configured, because this store enforces all of it. The default is `{retention: {kind: 'unbounded'}, asOf: true}`: keep everything, answer at any depth.

```ts
new VersionedStateStore(db, declarations, {retention: {blocks: 128}, finalityDepth: 64});
```

A window is measured in BLOCK NUMBERS and in no other unit, and it may not go below the finality depth it protects (refused at construction, naming both numbers) because reorg revert reopens versions closed after the fork point. Note the trap before sizing one: a window of N blocks is **not** N updates of history. On the real measured stream event-bearing blocks are median 429 apart, so 64 blocks holds exactly one of them.

Enforcement has two halves and they are separate on purpose:

- **Answers** are bounded immediately. An as-of read outside the window throws `BlockNotRetainedError` (naming the block asked for and the range kept) on every read surface, including this backend's own `queryAsOf` and the hash and timestamp address axes. It is never served from the tip.
- **Storage** is bounded when `store.prune()` runs, which the host schedules. It deletes the versions closed at or below `tip - blocks` and reports what went (`{tip, floor, versionsDeleted, complete}`). The LIVE version of an entity survives however old it is; the block table is kept, so an old hash still resolves and is REFUSED rather than reported unknown; and it does not `VACUUM` (SQLite reuses the freed pages, so the file stops growing without shrinking).

Pruning is not in the write path because it costs time proportional to what it drops (1.1 s at 62,553 versions, measured) while a block carries a median of 7 mutations. `prune({maxVersions: n})` is how an amortised policy is expressed, and one statement never names more rows than `bounds.maxRowsPerStatement`, so one request never carries unbounded work. See ADR-0019 and ADR-0022.

`retention: 'revert-only'` refuses every historical read while `revertTo` keeps working, and prunes to the declared `finalityDepth` (its whole retention) when one is given.

## Several generations in one database

A **generation** is a stream plus a fold over it; an indexer holds several and one is canonical, so a successor can rebuild while the incumbent keeps answering. A generation's state is a **table-name namespace** inside ONE database (ADR-0053; a generation column and a database-per-generation were both rejected there), and a store takes the name:

```ts
const incumbent = new VersionedStateStore(db, declarations, {tableNamespace: 'genA'});
const successor = new VersionedStateStore(db, declarations, {tableNamespace: 'genB'});
```

The two are as separate as two databases: separate entity tables, separate `_blocks`, separate `_cursor`, separate derived indexes. Writing in one changes nothing readable in the other, a `revertTo` in one touches none of the other's blocks or rows, and `await successor.drop()` removes exactly the successor's tables (with their indexes) and leaves the incumbent complete and readable. `drop()` is what a host wires into the generation registry's `dropState` (`@etherfold/server`), which owns no naming convention of its own.

**`_blocks` and `_cursor` are in the namespace, not just the entity tables.** Two generations on one chain would otherwise share one block table, where one generation's `revertTo` deletes rows the other still needs, and one fixed cursor key (`lastSync`, the same string for every fold), where the second fold silently resumes on the first's position.

**The namespace covers what this store owns and nothing else.** `_meta`, `_emissions` and the generation registry belong to `@etherfold/server`, are per NAMED INDEXER and are deliberately SHARED across its generations: a processor-only change re-folds the SAME stored stream, which is what makes it free.

A namespace is `[A-Za-z0-9]+` and is checked when the store is constructed. The underscore is the SEPARATOR, so one inside a namespace is refused: it would make `a_b` + `c` and `a` + `b_c` the same table, which is two generations silently sharing rows. A rendered generation digest (`generationDigestOf`, `@etherfold/core`) is a valid namespace as it comes, leading digit and all, because every name this package emits is either quoted or begins with `_`. `sqlite` is refused for the same reason a `sqlite_` entity name is.

The namespace goes INSIDE the reserved `_` prefix (`token` becomes `genA_token`, and `_blocks` becomes `_genA_blocks`), so everything this store owns still starts with `_` and is still recognisable as a fixed table on the one database a combined deployment shares with the server. **With no namespace configured, the names are exactly what they have always been, byte for byte.**

`_writer` is in the namespace too, and that is what scopes the **writer token**: every mutating statement this store emits is guarded on the token in its own `_writer` row, and the same batch reads the token back, because `remote-sql` reports no affected-row count and a read-back is therefore the only evidence a writer has (ADR-0054's mechanism, applied here by ADR-0075). A writer claims on its first write; a second writer's first write claims in turn, so the first one's next mutation matches zero rows everywhere and is reported as `StoreWriterChangedError` with nothing written. Two generations with different namespaces never contend, which is the concurrency the generation model requires; two stores on ONE namespace are one store, and the second writer takes it. `applyBlocks` is many batches, so the guard is per batch: a refusal mid-sequence leaves the batches that already committed applied and every later one unwritten. `drop` is DDL and cannot carry a predicate, so it compare-and-swaps the claim's RELEASE first and drops nothing if that fails. `migrate` never claims.

## Usage

```ts
import {VersionedStateStore} from '@etherfold/state-store-sqlite';

const store = new VersionedStateStore(db /* a RemoteSQL */, [
	{name: 'token', id: ['id'], fields: {owner: 'text', transferCount: 'integer'}},
]);

await store.migrate();

// one block is one atomic batch
await store.applyBlock({number: 100, hash: '0xaa', timestamp: 1_700_000_000}, [
	{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xAlice', transferCount: 1}},
]);

await store.getAsOf('token', {id: '1'}, 100); // who owned it at block 100
await store.getAsOf('token', {id: '1'}, {hash: '0xaa'}); // ...at that block hash
await store.getAsOf('token', {id: '1'}, {timestamp: 1_700_000_000}); // ...at that instant
await store.getCurrent('token', {id: '1'}); // who owns it at the tip
await store.revertTo(99); // a reorg forked at 99
```

## The generated read surface, both tiers

The entity declarations type the reads as well as the writes, so a consumer names an entity and its declared columns rather than a table and a column string:

```ts
import {declareEntities} from '@etherfold/state-store';
import {createQuerySurface, VersionedStateStore} from '@etherfold/state-store-sqlite';

const entities = declareEntities([{name: 'token', id: 'id', fields: {owner: 'text', transferCount: 'integer'}}]);
const surface = createQuerySurface(new VersionedStateStore(db, entities), entities);

await surface.token.getCurrent({id: '1'}); // the bounded tier, identical on every backend
await surface.token.getAsOf({id: '1'}, {hash: '0xaa'}); // ...on any of the three address axes, here
await surface.token.queryCurrent({where: 'transferCount > ?', args: [1]}); // this tier, here only
```

`createQuerySurface` is `createReadSurface` (`@etherfold/state-store`, the four seam reads, typed off the declaration) plus the two reads that need a query planner. **The asymmetry is placement, not caution**: the bounded tier is what a HANDLER is held to and a handler runs once per event on every backend, so it gets the one shape that is an indexed range scan everywhere (ADR-0021); a server-side reader runs per request with SQLite underneath it, so it may take predicates. Both tiers project rows to the declared columns and type them off the same declarations, so renaming a field breaks a `queryCurrent` consumer exactly as it breaks a `getCurrent` one. The predicate text is the one part no type can check, because it is SQL: pass values through `args`, never by interpolation.

## Addressing state: hash, height, or time

All three axes resolve to a block number through the canonical `_blocks` table, and then run the one as-of predicate, so they answer identically when they identify the same block. There is one addressing mechanism, not three.

- **hash** is the reorg-proof identifier, and **the one consumers should store**. Pin a *height* and a reorg silently changes what "state at 18,000,123" means: the read still succeeds and quietly answers about a different chain. Pin the *hash* and the same reorg answers "no such block", which is itself the signal that whatever was derived from it is invalid.
- **height** resolves to itself, with no lookup.
- **timestamp** is the latest recorded block with `timestamp <= T`; before the first recorded block it resolves to nothing, never to the first block.

**"No such block" is a distinct answer from "block known, entity absent."** `undefined` keeps its ordinary meaning (the block is known, the entity was not there), and an address that identifies no block throws `NoSuchBlockError` carrying a `reason`. `resolveBlockNumber(address)` is the soft form for callers that want to branch instead of catch, and `getBlock(address)` hands back the recorded row so a consumer can turn a time or a height into the hash it should pin. The reasoning and the rejected alternatives are `docs/adr/0015`.

**`_blocks` holds rows only for blocks that carry our logs**, not every chain header: state only changes at blocks where our events occur, so the latest recorded block at or before T holds exactly the state the true block at T held, and a consumer only ever pins a hash it saw on a log we delivered. Storing every header would be tens of millions of rows for no additional answer. Which blocks those are is **the caller's judgement**: every block handed to `applyBlock` gets a row, including one with no mutations, because "carries our logs" is not "produces a state mutation" and the hash of a log that changed nothing is still pinnable.

`blockTimestamp` comes off the log itself (standardised in `execution-apis#639`), so time addressing needs no extra round-trip. It arrives 0x-prefixed hex from most clients and decimal from at least one, so ingestion normalises it once with `normalizeBlockTimestamp`; the prefix is the only signal, since `'1705375936'` is a valid hex string too and the two readings are millennia apart.

## Things that are load-bearing

**`revertTo` deletes before it re-opens, and the order is not interchangeable.** SQLite enforces the partial unique index per statement, with no deferred mode. Re-opening first makes the re-opened row and the still-present dead-branch row both open for the same business key, which is a `SQLITE_CONSTRAINT_UNIQUE`. `test/revert-order.test.ts` asserts both directions, against a real SQLite engine, so that the failing order stays documented by an executable test rather than by a comment someone can delete.

**Applying a block is exactly one `batch([...])`.** `remote-sql` exposes a transaction only as a batch, so that one call is both the atomicity boundary (a failure anywhere leaves no part of the block applied) and the round-trip boundary (on a remote backend, latency dominates, not SQLite work). `applyBlocks` packs several blocks into one batch for backfill, and never splits a block across two.

**The sync cursor is in that batch.** `applyBlock(block, mutations, {key, value})` appends one upsert into the fixed `_cursor (key, value)` table, so a caller's "I have reached this block" commits with the block or not at all (ADR-0027). It was a second round trip from `@etherfold/processor-sqlite`, and a crash between the two left state ahead of the cursor, which the restart could not clear: the replay handed `applyBlock` a block the store already held, and it was rightly refused. The table is neutral in its names as well as its dependencies — there is no `lastSync` column in a storage primitive — and `revertTo` does not touch it, because how far the caller got is not entity state.

**Backend limits are configuration, not constants.** Backends reached over the network cap statements, payload size and bound parameters per request, differently per backend and per plan. `DEFAULT_BATCH_BOUNDS` is set by the TIGHTEST documented limits, on the FREE tier, of any hosted backend this store is expected to run behind (50 statements, ~90 KB, 100 rows per statement), so a deployment that configures nothing works everywhere; raise all three via `{bounds}` on a local database or a paid tier. A single block that alone exceeds the bound is still sent as one batch, with a warning: splitting it would trade a correctness property for a tuning parameter.

`maxRowsPerStatement` is the one bound that is a CORRECTNESS setting rather than a throughput knob: it caps how many row ids `prune` names in a single `DELETE ... IN (...)`, and each id is a bound parameter, so a value above the backend's per-query parameter limit makes retention enforcement fail on that backend alone. Do not raise it without checking that limit.

**Fixed schema vs dynamic schema.** The repo's convention is static `.sql` schema files. That holds for fixed tables, and `_blocks` and `_cursor` are the two of them. It cannot hold for entity tables, whose columns are whatever a processor declares at run time, so their DDL is generated. The exception is contained in `src/ddl.ts`, which is the only module that emits DDL, and every interpolated identifier is validated first, since SQL cannot bind an identifier as a parameter. That validation now lives at the seam (`normalizeEntity` in `@etherfold/state-store`) and applies to every backend, so "this declaration is valid" is a fact about the declaration rather than about the deployment.

## Deviations from the reference prototype

This package ports a verified prototype (`~/dev/github/wighawag/research/ethereum-indexer-historical-state-db`, `example/src/historical-store.ts`) rather than inventing a model. The model is unchanged; these are the deliberate differences.

- **Named `VersionedStateStore`, not `HistoricalStore`.** "Versioned state" is the vocabulary the ADRs and `CONTEXT.md` use for the thing this stores; "historical state" names the whole feature, spec and design.
- **Declarations are validated, and then QUOTED.** The prototype interpolated table and field names straight into SQL, which was safe for its own hand-written declaration. Here they arrive from whatever a processor declares, so identifiers are checked once, at declaration time (at the seam, for every backend), and the `_` namespace is reserved for the store. A validated SHAPE is not enough on its own, because a SQL keyword has an ordinary identifier shape, so every identifier that came from a declaration is emitted double-quoted (`src/identifiers.ts`). That is what lets an entity declare a column named `index` or `order` and get the same answer here as on a backend with no SQL in it.
- **Statements are built as data, then prepared.** The prototype prepared statements as it went. Building `{sql, args}` first is what lets the batch bound count and size a batch before sending it, and lets a test assert the ordering inside `revertTo` instead of trusting a comment.
- **The batch bound and `applyBlocks` are new.** The prototype was one block per batch with no limits; the design calls for packing many blocks per batch under a configurable bound.
- **An unresolvable address throws, and hashes are case-folded.** The prototype's `resolveBlock` returned a number or nothing, and the caller decided what that meant. Here "no such block" is a `NoSuchBlockError` on the read path so it cannot be mistaken for an absent entity (`docs/adr/0015`), and block hashes are stored and looked up lower-cased so an echoed-back upper-case hash cannot masquerade as a reorg.
- **`id` may be a single string.** `{id: 'id'}` and `{id: ['id']}` both work; composite keys behave as in the prototype.

## Tests

`pnpm --filter @etherfold/state-store-sqlite test`, vitest, against a real in-memory libSQL database. Never a mock: the ordering rule above is a property of how SQLite enforces a partial index, and a fake would accept the broken order happily.

The cases that are the SEAM's rather than this backend's (versioned reads, as-of reads against the declared capabilities, reorg revert with a counter that must go back down, read-your-writes, block atomicity) are not written here: `test/conformance.test.ts` runs the shared suite, [`@etherfold/state-store-conformance`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-conformance), against this store under three retention claims and once more inside a table namespace, beside another generation already migrated into the same handle. What stays in this package's own tests is what only a versioned-row backend can be asked: the partial unique index, the batch, the `revertTo` ordering, the DDL, the block addressing, and the SQL query surface.
