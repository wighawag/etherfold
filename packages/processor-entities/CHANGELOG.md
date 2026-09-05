# @etherfold/processor-entities

## 1.0.0

### Major Changes

- da289e2: A published snapshot a client cannot read is REFUSED, never installed as state — closing the last corner `tagged-bigint-codec-across-storage-adapters` left open knowingly (ADR-0040).

  The blob snapshot's format number now lives in `@etherfold/core` as `BLOB_SNAPSHOT_FORMAT`, beside the codec it versions, so the WRITER (`@etherfold/cli`'s keeper) and every READER import one number. It used to be the CLI's own `SNAPSHOT_FORMAT`, which the browser could not see (`@etherfold/browser` must not depend on the CLI and still bundles for a tab), so the CLI refused a format-1 file locally while `keepStateOnIndexedDB` installed the same bytes — whose every `uint256`, with no fallback reviver left, arrived as the string `"123n"` instead of a BigInt. `isReadableBlobSnapshot` and the `BlobSnapshotEnvelope` type are exported alongside it; the CLI no longer exports a format constant of its own.

  `keepStateOnIndexedDB` now checks the number on every remote fetch: an unreadable snapshot is refused whole (never translated, never half-read) and the refusal is logged with the location and both numbers. An unreadable mirror is treated exactly as an unreachable one already was — skipped when it loses selection, failed over from when it wins — and local state that is already ahead still wins over any remote, readable or not. A prefix-form mirror's bare `lastSync` file carries no format and is read as SELECTION data only: nothing from it is installed, and the state file it selects for carries the check.

  The ENTITY snapshot envelope's constant is renamed `ENTITY_SNAPSHOT_FORMAT` (`@etherfold/state-store`; re-exported by `@etherfold/processor-entities`) so the two envelopes — which version different file shapes and revise independently — are distinguishable by NAME at a call site that can hold both. They are not merged.

  Nothing is published under `@etherfold/*` yet, so no format-1 snapshot exists in the wild: this is a guard added before the first release rather than a breaking correction to one already shipped.

### Minor Changes

- f3dc9a5: `on<EventName>` handler args are now a UNION when one event name covers two wire events, instead of the two input lists MERGED.

  An upgraded contract can emit `Transfer(address,address,uint256)` before the upgrade block and `Transfer(address,address,uint256,bytes)` after it. They share a name, so `ExtractAbiEventNames` collapses them and the author writes one `onTransfer` -- which is fine. What was not fine is what `args` said about it: `InputValues` mapped over the extracted event with `T` taken WHOLE, so the mapped type did not distribute and the two input lists merged into `{from, to, id, memo}` with `memo` REQUIRED. A pre-upgrade log then handed the author `undefined` through a type promising a value, with no cast and no warning anywhere.

  `InputValues` now distributes. (It landed in both authoring packages, which each held their own copy; the free-form one has since been deleted with its package, ADR-0037.) `event.args.memo` no longer compiles un-narrowed; `if ('memo' in event.args)` narrows to the version that has it, shared fields included.

  A single-version ABI -- every processor written today -- is unaffected: distributing over a non-union is the mapped type itself, and that is pinned as a type-identity assertion rather than assumed. Handler keys stay NAME-based; a signature-keyed alias (`on['Transfer(address,address,uint256,bytes)']`) is a later addition and would remove nothing.

  Both directions run under `pnpm typecheck` (`@ts-expect-error` as the assertion), since vitest strips types without checking them.

### Patch Changes

- 29895dc: Fixed silent, permanent event loss when a `feed`/`replay` batch loop is interrupted: every intermediate cursor is now true on its own.

  `promiseToFeed` hands the processor one batch at a time, and the processor PERSISTS the cursor it is given (`applyEventStream` writes it verbatim for the batch's last block). Those cursors were built by copying the FINAL cursor and walking `lastToBlock` forward, so every intermediate batch carried the final unconfirmed WINDOW: a cursor claiming to have synced through block X while listing blocks above X as already folded.

  That is unresumable. The engine treats the top of the window as the boundary above which events are new, so a run resuming from such a cursor skips every block between `lastToBlock` and the top of the window: they are neither below the resume point nor above the window, and nothing ever delivers them again. The loss is bounded by the finality window, permanent, and completely silent.

  The same defect handed a RETRACTION-ONLY batch the extent of the whole scan. A batch that reverts blocks 101 to 103 and applies nothing was told `lastToBlock: 103` while the fold was back at 100, with the replacement blocks still queued behind it. A crash between the revert and the re-apply left state reverted and a cursor claiming completeness, so the resumed run applied nothing and the replacement branch was lost outright.

  Both are reachable on the ordinary path, not only on a crash: every reconfigure verb calls `disableProcessing()` first, and a cancellation lands in exactly this loop.

  Now each batch is handed a cursor narrowed to what IT has folded, and only the LAST batch gets the stream's own cursor, at which point the whole stream is folded and the claim is true. A retraction-only batch reports the fork point, which is a genuine move backwards and the correct one: the state really is back there until the replacements land. A retraction-only batch that is the last one still takes the stream's cursor, so a scan that legitimately found nothing continues to advance.

  The narrowing rule now exists ONCE, as `cursorSyncedThrough`, newly exported from `@etherfold/core`. `@etherfold/processor-entities` re-exports it as `syncedThrough`, the name its callers already use: the engine narrows per batch and the processor narrows per block, and two copies of a rule this subtle is how the two halves drift apart.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- bb86a77: The free-form JS-object processor path is DELETED. There is one way to author a processor: entity declarations plus handlers over a `MutationContext` (ADR-0037).

  `@etherfold/js-processor` is gone, with `fromJSProcessor`, `JSProcessor`, `JSObjectEventProcessor` and its immer `History`. What it uniquely offered was an authoring STYLE, not a capability: no as-of queries, no retention or pruning, no bounded listing, and no schema for the query layer, which is generated from entity declarations. Its state was also a whole blob rewritten per save, which is the shape this repo has spent a design pass removing from the stream. What is NOT lost is its STORAGE characteristic: a plain object with history as immer reverse patches survives behind the proper seam as `@etherfold/state-store-patch` (the light store), with the capability reporting and conformance coverage the seam provides.

  **`@etherfold/browser`: one kind, one call shape.** `createIndexerState(processor)` takes the processor itself. The `ProcessorKind` / `TaggedProcessor` union, the bare `EventProcessorWithInitialState` form it also accepted, and the `keepState` option are removed, along with `keepStateOnIndexedDB` and `keepStateOnLocalStorage`. `updateProcessor` takes the same bare shape.

  ```ts
  // before
  const indexer = createIndexerState({kind: 'entities', processor: fromEntityProcessor(p)(store)});
  // after
  const indexer = createIndexerState(fromEntityProcessor(p)(store));
  ```

  **`@etherfold/core`: the `KeepState` family is deleted, snapshot half included.** `KeepState`, `ExistingStateFetcher`, `StateSaver`, `AllData`, `ProcessorContext` and `EventProcessorWithInitialState` go, and so does the BLOB snapshot envelope beside them (`BLOB_SNAPSHOT_FORMAT`, `BlobSnapshotEnvelope`, `isReadableBlobSnapshot`). The seam had exactly one caller, `JSObjectEventProcessor.keepState`, and its two masters turned out to be one: the entity path's bootstrap never used it. Installing state somebody else computed is `openSnapshotAware` / `bootstrapFromSnapshot` at the STORAGE seam, where a store's own transaction is, and `ENTITY_SNAPSHOT_FORMAT` is now the only envelope number. ADR-0040's rule (a format a reader cannot read is refused, never translated) is unaffected and is what the surviving reader still does.

  **`etherfold`: `--store` loses its `file` value and `--folder` goes with it.** `--store sqlite --db <libsql url>` is the whole of it, and `--store` stays required: it is the axis a second backend arrives on. `packages/cli/src/keepState.ts` (`createFileKeepState`, the blob snapshot writer) is deleted, and so is the kind/store mismatch refusal, which had nothing left to be a mismatch between.

  **`@etherfold/utils`: a module hands over the PROCESSOR, not a kind tag** (superseding ADR-0039). `createProcessor` returns the authoring object itself; `instantiateProcessorWithKind`, `ResolvedProcessor` and `ProcessorKind` are removed, and `instantiateProcessor` returns what the factory made, typed by the caller. A module still returning `{kind, processor}` is REFUSED naming ADR-0037, rather than unwrapped, so the retired shape cannot reach a store that would ask it for `entities` and get `undefined`. The `@etherfold/utils/indexer` subpath goes too: it existed for `contextFilenames`, the blob snapshot's file naming, and `@etherfold/browser` no longer depends on this package at all.

  **The stratagems conformance workload keeps its question and loses its regeneration.** The committed golden state is still what the ported entity processor is compared against on every backend, and the vendored original is still committed (typechecked, with its `JSProcessor` type vendored beside it). What is gone is `src/oracle.ts` and the `regenerate-golden-state` script, because driving that original needed `fromJSProcessor`: the golden is now a FROZEN expectation rather than a recomputable one. `CONTEXT.md` already treated a diff on it as a FINDING and not a fixture update, so regeneration was never the normal path.

  **Six example apps used the deleted path.** `event-processor-nfts` keeps only its entity processor (which the browser demo and `etherfold index` already ran) and is the end-to-end demonstration, beside `browser-reference`. `basic`, `event-processor-bleeps`, `event-processor-conquest-eth`, `event-processor-conquest-fplay` and `mud` are DELETED rather than left broken, and `web-demo` goes with them: it consumed three of them and rendered a state blob as a JSON tree, which is the shape the entity path does not have.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- Updated dependencies [0ba3c60]
- Updated dependencies [a1fccd0]
- Updated dependencies [5427806]
- Updated dependencies [c6b5215]
- Updated dependencies [0f33468]
- Updated dependencies [a64a843]
- Updated dependencies [5729da5]
- Updated dependencies [2e10f5e]
- Updated dependencies [ce43a7b]
- Updated dependencies [1524a04]
- Updated dependencies [a4d106e]
- Updated dependencies [351c585]
- Updated dependencies [839e781]
- Updated dependencies [4e5067e]
- Updated dependencies [dc08d24]
- Updated dependencies [29895dc]
- Updated dependencies [e7d06c9]
- Updated dependencies [da289e2]
- Updated dependencies [1d9be43]
- Updated dependencies [ab779b0]
- Updated dependencies [793f3d6]
- Updated dependencies [8bb063e]
- Updated dependencies [1a6f68b]
- Updated dependencies [56acbef]
- Updated dependencies [1d619c9]
- Updated dependencies [d50583b]
- Updated dependencies [37146b2]
- Updated dependencies [74f74f5]
- Updated dependencies [9a41ba3]
- Updated dependencies [0bf9dc7]
- Updated dependencies [b0e9a0d]
- Updated dependencies [bb86a77]
- Updated dependencies [5adafa9]
- Updated dependencies [c0d694f]
- Updated dependencies [d10b64e]
- Updated dependencies [01ed0ef]
- Updated dependencies [9e2c66d]
- Updated dependencies [b824312]
- Updated dependencies [35fc4c2]
- Updated dependencies [4f206c3]
- Updated dependencies [8c8341a]
  - @etherfold/core@1.0.0
  - @etherfold/state-store@1.0.0

## 0.1.0

### Minor Changes

- 5854d60: **`EntityEventProcessor`: run an entity processor against ANY `StateStore`.**

  The runtime the storage seam was built for and the one thing that was missing from it. `new EntityEventProcessor(store, processor)` is an `EventProcessor` the core drives, with the store INJECTED, so the same processor definition (entity declarations plus `on<EventName>` handlers over a `MutationContext`) indexes to SQLite on a server, to IndexedDB in a browser tab, to the light patch store or to memory in a test, with nothing about the processor changed. `fromEntityProcessor(processor, options)(store)` is the factory form, mirroring `fromJSProcessor`.

  `process()` hands back an **`EntityStateView`**: the seam's four reads (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`) plus the capability report. `queryCurrent` / `queryAsOf` are deliberately NOT on it, and not stubbed to throw either, so asking a backend-neutral handle for caller-supplied SQL is a compile error in the editor rather than a runtime throw in a browser tab. `VersionedStateView` (`@etherfold/processor-sqlite`) is the tier that has them.

  **The sync cursor moved behind the storage seam** (ADR-0027) and is written in the same transaction as the block it describes. `serializeLastSync` / `deserializeLastSync` now live here, alongside `SYNC_CURSOR_KEY`, `parseStoredCursor` and `syncedThrough`; `@etherfold/processor-sqlite` re-exports all four from its `sync.ts`, and its `_sync` table is gone, so the SQL that reached it goes with it: **`SYNC_TABLE`, `SYNC_ROW_ID`, `SYNC_SCHEMA_DDL`, `readLastSync`, `writeLastSyncStatement` and `deleteLastSyncStatement` are removed** from `@etherfold/processor-sqlite`'s surface. The storage is `@etherfold/state-store-sqlite`'s neutral `_cursor (key, value)` table, reached through `StateStore.readCursor` / `writeCursor` / `clearCursor`. This closes a live defect: the cursor used to be a second round trip after the blocks, and a crash in that window left state ahead of the cursor, which is not self-healing — the restart replayed a block the store already held and `applyBlock` refused it, so the indexer wedged until a human intervened.

  **`applyEventStream` takes an optional `cursor`** (`{key, lastSync}`) and applies each block together with the cursor that describes THAT block, because one `process` call carries many blocks and each is its own transaction. A stream with no blocks still records the range it scanned.

  **`VersionedStateEventProcessor` is unchanged in behaviour and is now a thin SQLite flavour** of `EntityEventProcessor`: it builds a `VersionedStateStore` from a `RemoteSQL`, keeps the SQL read tier, and delegates the rest. Revert-then-apply, the block grouping, the version hash, the code fingerprint and the retention reconciliation exist once rather than twice.

- 4e75014: **An entity store can start from state somebody else computed, and it stays honest about the history it never received** (ADR-0028).

  This is the entity path's half of a capability the free-form path has always had: `keepStateOnIndexedDB(name, remote)` takes one or more published locations, asks each how far it has got, uses the furthest, prefers LOCAL state when local is already ahead, and skips an unreachable mirror rather than dying. A client that bootstraps comes up near the tip instead of replaying every log the contract ever emitted.

  **`@etherfold/state-store`** gains the snapshot envelope and the store handle that keeps it honest:
  - `StateSnapshot` -- `{format, processor, savedAt, takenAt, cursor, rows}`, deliberately shaped like the CLI's file envelope so a reader of one recognises the other. `rows` are the LIVE rows at `takenAt`, and `SnapshotHead` is the same envelope without them, which is what a client fetches to choose between mirrors.
  - `openSnapshotAware(store)` -- the handle a deployment that may bootstrap uses on EVERY boot (it migrates the store itself). `.bootstrap(snapshot, {processor})` installs the rows and their cursor as one `applyBlock`, and records where the contents came from under a second cursor-port key (`SNAPSHOT_ORIGIN_KEY`), so a reload is as honest as the first run.
  - The honesty: a bootstrapped store reports its retention as a **window whose oldest block is the snapshot's**, never the `unbounded` a freshly migrated store would claim, and an as-of read below that block is refused with `BlockNotRetainedError` instead of answering `undefined` -- which would read as "the entity was absent then", an ordinary answer a caller acts on normally, and wrong. The floor is intersected with whatever the deployment configured, and a store that answers no historical read at all is left saying exactly that.
  - `RevertBeyondSnapshotError` -- a reorg reaching below the snapshot is refused loudly and changes nothing. There are no superseded versions under the snapshot to reopen at any price, and a partly undone reorg is a plausible state nothing downstream can tell apart from a correct one.
  - `SnapshotProcessorMismatchError` / `SnapshotFormatError` -- a snapshot computed by another processor version, or in an envelope this build does not read, is refused rather than loaded.

  **`@etherfold/processor-entities`** gains the client side:
  - `bootstrapFromSnapshot(store, locations, {processor, finalityDepth?, fetch?})` -- mirrors, most-advanced-wins, prefer-local, fail over on error. Two deliberate differences from the free-form keeper: failover walks EVERY remaining candidate in descending order (the keeper tries the winner and one more), and a snapshot from another processor version is not a candidate at all. Given a `finalityDepth`, a snapshot taken inside the reorg-eligible window of the tip its producer had observed is declined, so the revert that could not be undone is avoided as well as refused. It returns a `BootstrapOutcome` rather than throwing when nothing is usable: indexing from the start block is the correct answer to "no snapshot is available".
  - `openAndBootstrap(store, locations, options)` -- the boot path, which keeps the SAFE order the short one: open snapshot-aware first, then bootstrap only if the store has never synced.
  - `createSnapshot(...)` -- the MINIMAL producer, and it says so. Publishing snapshots as a first-class artifact (a publish command, format versioning, mirror layout, pruning old ones) is a design of its own.

  **`@etherfold/browser`** gains no API and one piece of documentation that matters: `createBrowserStateStore` now says how a browser deployment bootstraps, and that the store must be opened through `openSnapshotAware` on EVERY boot rather than only on the boot that installs a snapshot. The mechanism deliberately does not live here -- deciding whether local is already ahead means reading `lastToBlock` out of a stored cursor, and the cursor's codec belongs to the entity runtime (ADR-0027), which this package does not depend on so that it stays free of any one processor package.

  **`@etherfold/state-store-conformance`** gains a `bootstrapping from a snapshot` group, so every backend inherits the obligation rather than rediscovering the trap in somebody's browser tab: rows and cursor installing as one unit, the origin surviving a fresh handle over the same storage, the revert refusal, the wipe still working, and -- selected on what the backend claims -- the floor being refused below and answered at and above.

- 879c4fe: Lift the processor authoring API out of the SQLite packages, so one processor runs against several storage backends.

  Two new packages. **`@etherfold/state-store`** is the seam: entity declarations, `MutationContext` (now including `update` as sugar over get-then-spread-then-set), the `StateStore` interface a backend implements (`migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `revertTo`), the capabilities it declares, and `MemoryStateStore`, a reference implementation in versioned rows over a Map. It declares no dependencies at all, which is what lets a storage primitive depend on it. **`@etherfold/processor-entities`** is the ABI-typed authoring surface (`EntityProcessor`, the `on<EventName>` handler map) plus the revert-then-apply engine (`applyEventStream`), written once against `StateStore` rather than per backend. ADR-0018 records why this is two packages and not one.

  A backend now **reports what it can do as data**, readable before `migrate` and before any read: a retention kind (`revert-only`, a window of N BLOCK NUMBERS, or `unbounded`) and whether it answers as-of reads. `@etherfold/state-store-sqlite` reports `unbounded` because that is what is true of it: the package has no pruning, and it deliberately takes no retention option, since a store that accepted a window it cannot enforce would be making exactly the claim the report exists to prevent.

  **`@etherfold/state-store-sqlite`** implements `StateStore` nominally, which it already did structurally: only `capabilities` was added. Its entity, mutation and block-pointer vocabulary is now defined at the seam and re-exported from here, so there is one definition rather than two; `ColumnType` is a deprecated alias of `FieldType`. Its block addressing (`getBlock`, hash and timestamp axes, `NoSuchBlockError`) and its SQL query surface (`queryCurrent` / `queryAsOf`) are unchanged and stay backend-specific on purpose.

  **`@etherfold/processor-sqlite`** consumes the authoring types rather than defining them. `SQLProcessor` is kept as a deprecated alias of `EntityProcessor`, so existing processors compile unchanged; the type never had anything SQL in it.

  The claim is asserted, not stated: `processor-entities/test/two-backends.test.ts` runs one processor, unmodified, against a real libSQL database and against the in-memory store, with the same declarations and the same handlers, and pins that the resulting state is identical, that read-your-writes composes two events in one block, and that a reorg makes a counter go back down on both.

- 18c6876: The read surface is now GENERATED from the entity declarations, so `{name, id, fields}` is the single description of the data for storage and for reads.

  ```ts
  const entities = declareEntities([{name: 'token', id: 'id', fields: {owner: 'text', transferCount: 'integer'}}]);

  const store = new MemoryStateStore(entities); // the same array drives the storage...
  const surface = createReadSurface(store, entities); // ...and types the reads

  const token = await surface.token.getCurrent({id: '1'}); // {id: string; owner: string | null; ...} | undefined
  await surface.placement.listCurrent({epoch: 7}, 8); // the children of a key, bounded
  ```

  No table name, no column string, no hand-written row type. **Rename `owner` in the declaration and the consumer stops COMPILING**, instead of reading `undefined` in production, which is the whole reason the surface is generated rather than written beside the declaration.
  - **Two tiers, one schema source.** `createReadSurface` (`@etherfold/state-store`) is the seam's four reads (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`) and runs unchanged on every backend. `createQuerySurface` (`@etherfold/state-store-sqlite`) is those four PLUS `queryCurrent` / `queryAsOf`, which take caller-supplied SQL. The asymmetry is placement, not caution: the bounded tier is what a handler is held to, and a handler runs once per event on every backend including the ones with no query planner (ADR-0021), while a server-side reader runs per request with a planner underneath it.
  - **The as-of parameter is whatever the STORE takes**, read off its own signature. Over a plain `StateStore` that is a block number; over `@etherfold/state-store-sqlite` it is a height, a `{hash}` or a `{timestamp}`. So a hash reaches the backend that can resolve one, and does not compile against a backend that cannot, with no new capability flag to declare.
  - **Errors stay errors.** `NoSuchBlockError` (ADR-0015) and `BlockNotRetainedError` (ADR-0019) travel through the surface untouched; neither becomes `undefined`, which keeps its one meaning of "the block is known and the entity was absent from it".
  - **Rows are PROJECTED to the declared columns**: id columns, then every declared field, with an unlisted one as `null` (a version is a whole row) and the version columns dropped, since they are storage rather than state and a projected row cannot be spread back into a write.
  - **Nothing is decoded beyond the declared storage class**, so a `uint256` stored as decimal `text` comes back as the string it is and the consumer calls `BigInt()`. Decoding it would need the declaration to SAY a text column is a u256, which it cannot; ADR-0025 records the answer and leaves the field type itself to `tagged-bigint-codec-across-storage-adapters`.
  - **`declareEntities` keeps a declaration's literal types** and changes nothing at run time. An annotated declaration (`const TOKEN: EntityDeclaration = ...`) widens `'owner'` to `string`, after which nothing can be derived from it.
  - **Nothing here ships GraphQL, and nothing here blocks it.** The decided stack (Hono, then Yoga, then Pothos, built programmatically, no SDL and no deploy-time codegen) walks the same declarations for its object types and resolves them through this surface, so it is an addition rather than a refactor. The example keeps its hand-written routes.

### Patch Changes

- ce8f7d2: A handler can now ask about a SET of rows: the bounded id-prefix listing.

  ```ts
  // entity: {name: 'placement', id: ['epoch', 'position', 'playerIndex'], fields: {player: 'text'}}
  const {rows, truncated} = await state.list('placement', {epoch: 7}, 8);
  ```

  That is the one read the entity model was missing, and it is what makes a one-to-many expressible the way a subgraph's `@derivedFrom` does it: children are their own entity keyed by their parent, and the collection is DERIVED WHEN READ. Nothing is maintained at write time. `MutationContext` gains `list`; `StateStore` gains `listCurrent` and `listAsOf`, which every backend must implement.

  **The bound is the decision, not an implementation detail.** A listing takes a PREFIX of the declared id (a leading run of its id columns, at least one) plus a REQUIRED limit, and takes no `where`, no `orderBy` and no offset. A handler runs once per event on every backend, including the ones with no query planner, so the seam gets the one shape that is an indexed range scan everywhere: a key-prefix range with a bound. An accidental full scan is therefore impossible to EXPRESS rather than merely discouraged. `@etherfold/state-store-sqlite`'s `queryCurrent` / `queryAsOf`, which do take caller-supplied SQL, are the server-side read layer and are unchanged. See `docs/adr/0021`.
  - **Truncation is reported, never inferred.** A listing answers `{rows, truncated}`, and every backend reads one row more than the limit to fill it in, because `rows.length === limit` cannot tell an exact answer from a cut-off one and a cascade delete that guesses wrong leaves orphans silently.
  - **Order is the id's own, ascending**, which is what a range scan gives for free, and therefore LEXICOGRAPHIC over the stringified id: `'10'` sorts before `'9'`. Key ordered children by something naturally unique and ordered (an event ordinal, or `(blockNumber, logIndex)`) and make a numeric key fixed-width. If arrival order is wanted, that is a modelling answer, not a parameter.
  - **Read-your-writes holds for a listing too**: a child written earlier in the block appears and one deleted earlier in the block does not, which means merging the block's staging area into the scan rather than falling through to the store. The fetch budget accounts for staged deletes, so a limit is still filled from beyond them.
  - **In SQLite it is one indexed range scan**: equality on the leading id columns plus `ORDER BY` the declared id rides the entity's id index with no sort and no table scan. Pinned by the generated statement's shape AND by `EXPLAIN QUERY PLAN`, since no behavioural assertion can tell a range scan from a table scan that returns the same rows.
  - **The conformance suite gained a group for it**, so a new backend is held to the same answers, and `@etherfold/processor-entities` gained a test that models the real ordered bounded collection from `work/notes/findings/sqlite-in-the-browser.md` (a window of seven, evicting the oldest and everything nested under it) with no stored array, no CSV index and no count, on both backends.

- e0a6480: The log ingestion endpoint, and the receiving half of the wire contract (ADR-0004).

  `@etherfold/core` gains **`StreamBuilder`**: the stream-builder of ADR-0003, as an object. It takes contiguous ranges of raw logs from a stateless log-fetcher, derives every retraction itself, drives an `EventProcessor`, and is authoritative about where the next range must start. It makes no chain calls at all, which is why it is not `EthereumIndexer`: that class opens `load()` with `eth_chainId`, so the half of a split deployment that hosts the processor could never use it. It reads the persisted cursor on every call rather than caching one, because the intended host is serverless and an in-memory cursor is one isolate's private opinion of a value the database owns.

  `@etherfold/server` gains **`GET` and `POST /ingest`**, behind an `INGEST_TOKEN` bearer token. The stream-builder is injected exactly like the database (`getIngestion` alongside `getDB` / `getEnv`), so which processor runs against which source stays a deployment's choice; a server with none answers `501` rather than pretending to have a cursor.

  The cursor is the idempotency key, so there is no dedupe table and no idempotency header. A batch whose `fromBlock` is not the server's `expectedFromBlock` is refused with **`409` carrying that value**, and the sender re-sends from there; a batch re-sent after a lost acknowledgement takes exactly that path, so at-least-once on the wire is exactly-once in effect. `409` is the only resumable refusal: a foreign `{source, config}`, a malformed range, or a payload that is not the range it claims are `400`, because no block number makes them right and a sender must not retry them forever.

  `generateStreamToAppend` now throws a typed `UnexpectedFromBlockError` carrying `expectedFromBlock`, instead of an `Error` whose message had to be parsed. Same rule, same message, one place: the HTTP layer reads the number off the error rather than re-deriving it, so the wire and the engine cannot drift apart.

  A revert concluded from **absence** is surfaced and counted apart from one concluded from a hash **contradiction**. Absence is an inference and is indistinguishable from a sender that under-delivered a range, so `/status` now reports `reorgs: {absence, contradiction, last}` from the database (not from process memory, since a rate is the point and isolates are recycled), and an absence-driven revert is logged at `error` level naming the range. It does not make the server unhealthy: it is a signal to investigate, not a fault.

  Wire batches are serialized with `serializeWireBatch` / `parseWireBatch`, which tag BigInts as `{__bigint__: "..."}`. A decoded log's `args` hold a BigInt for every `uint256` an ABI declares and `JSON.stringify` throws on those, while the older `"123n"` suffix convention would revive a contract-emitted string ending in `n` as a number. The tagged codec now lives once, in `@etherfold/core` (`taggedBnReplacer` / `taggedBnReviver`), and `@etherfold/processor-entities`' sync-cursor codec uses it instead of its own copy.

- c359dcb: The light state store, behind the same seam: `@etherfold/state-store-patch`.

  **A new package.** Current state as a plain object, history as immer reverse patches, reorg revert by replaying them backwards. It is the cheapest legitimate implementation of the storage seam, so a browser tab that only needs current state and reorg safety pays nothing for versioned rows while running the SAME processor as the server:

  ```ts
  const store = new PatchStateStore(processor.entities, {retention: 'revert-only', finalityDepth: 64});
  await applyEventStream(store, processor, eventStream, config); // the same processor as on SQLite
  ```

  `packages/processor-entities/test/patch-backend.test.ts` asserts that equality against `@etherfold/state-store-sqlite` on the same input, and the store passes `@etherfold/state-store-conformance` under its own claim.

  **It advertises `revert-only`, and that is a MEASURED result rather than a limitation.** Backwards replay is correct wherever the patches exist (matched the recorded state at every depth to 64 on Chromium, Firefox, WebKit and node, at a cost linear in depth). What withdraws the capability is SPARSITY: history is pruned by BLOCK-NUMBER distance from the tip, while a real stream carries only event-bearing blocks, which on the launched stratagems game on Base are median **429 blocks apart**. At a finality of 64 exactly one block's reversals survive, the tip's, and no tuning returns it. So `revertTo` works and is the reason this backend exists, while every as-of read throws `BlockNotRetainedError` at every depth — never the tip value, which is the single failure mode this design exists to prevent because it is plausible. Asking this store for a window is refused where it is configured rather than downgraded quietly.

  **A revert it cannot perform is an error, not a partial revert.** Once a block's reverse patches have been pruned, `revertTo` throws `RevertBeyondPatchHistoryError` (naming the blocks it cannot undo, the deepest revert still available and the declared depth) and leaves the state untouched, because a half-undone reorg is the write-path twin of a historical read served from the tip. `store.retainedReversals()` reports the depth still available — on a sparse stream, one block.

  **Memory-only, and the capability report says so** (`durability: 'memory-only'`): a reload is an empty store. Persisting is deliberately left to the seams that own it — the whole-state `KeepState` path above, and the row-level IndexedDB backend beside. See ADR-0023.

  `prune()` drops the reverse patches at or below `tip - finalityDepth` and is a call the host schedules (ADR-0022), never a side effect of a write, which is the deliberate difference from `@etherfold/js-processor`'s `History`.

- ab45129: Retention becomes a number a deployment SETS, a store REPORTS, and a read is REFUSED against.

  **The unit is block numbers, and there is only one unit.** A deployment writes `retention: 'unbounded' | 'revert-only' | {blocks: N}` on a store (or on `VersionedStateEventProcessor` / `fromSQLProcessor`, which pass it through). `{blocks: N}` is the only window spelling: a bare number names no unit, a duration is refused on every spelling, and a count of updates is refused too. Those are not style rules. Time would prune on WALL-CLOCK progress rather than chain progress, so a stalled indexer would drop history it never finished writing and a halted chain would expire its whole window while the tip stands still; "last N updates" is derivable above the seam from the blocks each backend already indexes, and adding it below would duplicate the prune path, the report and the tests for a unit that is a floor block number. See ADR-0019.

  **Sizing a window is not sizing a number of updates**, and the arithmetic is counter-intuitive enough to state at the API: on the real measured stream, event-bearing blocks are median **429 blocks apart**, so a window of 64 blocks holds exactly ONE event-bearing block. The default is `unbounded`, which is the only report true of a store that does not prune.

  **A window below the finality depth is refused where it is configured**, naming both numbers, because reorg revert reopens versions closed after the fork point and would find them pruned. `finalityDepth` is required alongside a window for the same reason, and `VersionedStateEventProcessor` checks it a second time at `load` against the finality the stream actually runs with, since a floor validated against the wrong number is silent corruption waiting for a deep reorg.

  **An as-of read the store cannot serve now throws instead of answering.** `BlockNotRetainedError` carries the block that was requested and the range that is retained, and it joins `NoSuchBlockError` under a new shared base, `BlockUnavailableError` (both exported from `@etherfold/state-store` and re-exported from `@etherfold/state-store-sqlite`). ADR-0015 settled that an unresolvable block address is an error and not an empty result; this is the other way a historical read can fail, and it must not arrive as `undefined` (which reads as "the entity was absent then") or as the tip value (a plausible wrong number nothing downstream can tell apart from a true one). A store set to `revert-only` refuses every as-of read and keeps reverting.

  **No store claims a window it does not enforce.** `@etherfold/state-store-sqlite` has no pruning, so a configured window is validated, warned about, and reported as `unbounded` -- which is what the store actually does, since every version ever written is still there. `MemoryStateStore` behaves identically. The right to report a window is earned by `prune-versions-outside-retention-window`.

  `VersionedStateView` now exposes `capabilities`, so the consumer holding the read handle can discover at startup what history is available instead of discovering it from a refusal (or a wrong number) in production. The capability cases run against both backends in `processor-entities/test/two-backends.test.ts`.

- ebf9690: One conformance suite every state-store backend must pass, including its capability claims.

  **A new package, `@etherfold/state-store-conformance`.** Adding a backend is providing a factory and running one suite:

  ```ts
  await describeStateStoreConformance('MyStore', (declarations) => new MyStore(declarations));
  ```

  It asserts EXTERNAL BEHAVIOUR only -- what a read returns after a write, after a revert, as of a block -- and never a table, a statement or a version column, so a versioned-rows backend and a patch-log backend can both be asked it. Five groups: versioned reads (a version is a COMPLETE row with a half-open validity range), as-of reads tested against what the store CLAIMS, reorg revert including a counter that must go back DOWN, read-your-writes within a block, and a block applying as one atomic unit.

  **The capability report is read first, and then tested.** A store claiming `unbounded` is asked a read at any depth; a store claiming a WINDOW is asked at both of its edges and must refuse below it with a `BlockNotRetainedError` naming what was asked and what is kept; a store that answers no historical read must refuse every one of them. Testing a backend against a capability it never claimed would fail honest backends, and testing it against less than it claimed is what lets a claim become fiction.

  **That the capability cases are real is itself a test.** The suite is run against backends carrying one lie each -- claiming a window it does not honour, answering an as-of read from the tip, accepting a revert without undoing the state -- and the tests assert which cases go red. This is why the cases are exported as DATA (`stateStoreConformanceCases`, `runStateStoreConformance`) with the vitest registration as a thin adapter on top: a suite that only registers tests can be run but cannot be asserted on. See ADR-0020.

  **The reorg case is the load-bearing one and runs on every backend**, not once: an accumulated counter that does not decrease when its block is reverted is the canonical bug this design exists to make impossible, and the real instance is recorded in `work/notes/findings/sqlite-in-the-browser.md` (a `computedPoints` of 12 going back to 6). The counter is accumulated through the mutation context, because the read is where the bug bites.

  The suite runs today against `MemoryStateStore` and against `@etherfold/state-store-sqlite`'s `VersionedStateStore` on a real libSQL database, each under three retention claims. Shared cases that existed as a second copy in `state-store-sqlite` and `state-store` have moved into it; what stays in those packages is what only that implementation can be asked.

- 0ac08c0: Follow-on from the tagged BigInt codec landing everywhere: no behaviour change in any of these three, but they each referred to the convention that is gone.

  `@etherfold/processor-sqlite`'s deployment-shapes test simulated the wire crossing with `bnReplacer` / `bnReviver`, which no longer exist; it now crosses through the REAL `serializeWireBatch` / `parseWireBatch`, so it exercises what a deployed log-fetcher and receiver actually put on the wire. `@etherfold/js-processor`'s version test carried an inline copy of the old suffix reviver to stand in for "the same convention the real keepers use", and now uses the codec those keepers actually use. `@etherfold/processor-entities`' sync-cursor note said the tagged codec was shared with the wire; it is now the repo's only BigInt convention, and says so.

- Updated dependencies [ff393f7]
- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [4e75014]
- Updated dependencies [ce8f7d2]
- Updated dependencies [0957f8c]
- Updated dependencies [c681b79]
- Updated dependencies [9d21d67]
- Updated dependencies [ca6f981]
- Updated dependencies [b61de79]
- Updated dependencies [31833b6]
- Updated dependencies [2a4e6ed]
- Updated dependencies [047cd73]
- Updated dependencies [eba61c3]
- Updated dependencies [dece521]
- Updated dependencies [939364a]
- Updated dependencies [d24872f]
- Updated dependencies [78d8377]
- Updated dependencies [3de4c35]
- Updated dependencies [bc118e4]
- Updated dependencies [bc5d71a]
- Updated dependencies [e0a6480]
- Updated dependencies [9738f1c]
- Updated dependencies [879c4fe]
- Updated dependencies [33afc5b]
- Updated dependencies [01ab642]
- Updated dependencies [18c6876]
- Updated dependencies [4097ccd]
- Updated dependencies [e0e5832]
- Updated dependencies [ab45129]
- Updated dependencies [ebf9690]
- Updated dependencies [5854d60]
- Updated dependencies [3a78285]
- Updated dependencies [0ac08c0]
- Updated dependencies [cefe0de]
  - @etherfold/state-store@0.1.0
  - @etherfold/core@0.7.0
