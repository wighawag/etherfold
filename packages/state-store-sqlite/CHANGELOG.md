# @etherfold/state-store-sqlite

## 0.2.0

### Minor Changes

- 2c6ef82: **`DEFAULT_BATCH_BOUNDS` is now set by the tightest hosted backend's FREE tier, so an unconfigured deployment works everywhere.** `maxRowsPerStatement` drops from 500 to **100** and `maxStatementsPerBatch` from 100 to **50**; `maxBytesPerBatch` is unchanged at 90,000.

  The `maxRowsPerStatement` change is a BUG FIX, not a tuning change. `prune` deletes by an explicit list of row ids and each id is a bound parameter, so the old default of 500 emitted a query with 500 bound parameters against a hosted backend that caps them at 100 per query. Retention enforcement therefore failed there while passing on every other backend and in every test: the shape that runs locally and fails only in production. The previous docstring claimed the default was "small enough to fit inside the tightest hosted limits we are aware of", which was not true.

  Both remain CONFIGURATION: pass `{bounds}` to raise them on a local file database or a paid tier, where they are an ordinary throughput knob. `maxRowsPerStatement` is the exception and should not be raised without checking the target backend's per-query parameter limit.

  The vendor's specific limits, their dated source and the plan split are recorded in `work/notes/findings/` rather than in this package, which names no hosted backend by assertion (`test/no-platform-leakage.test.ts`).

### Patch Changes

- 1a6f68b: Every published package now carries a `description` and its own `README.md`.

  Metadata and docs only: no runtime code changed. Four manifests had no `description` at all (`@etherfold/core`, `@etherfold/browser`, `etherfold`, `@etherfold/utils`), which is the line npm shows in search results and on the package page, and seven packages had no README (the four above plus `@etherfold/server`, `@etherfold/platform-nodejs` and the private Worker host). Each README says what the package is, when to reach for it INSTEAD of its neighbours, a minimal snippet taken from code that runs, and links to the related packages.

  Two summaries are worth calling out because a guessed one would have been wrong. **`etherfold index` is a ONE-SHOT**: it folds to the tip it observed and exits, does not follow the chain and cannot be reconfigured while running, so keeping a database current is running it again; live reconfigure is `@etherfold/browser`'s ability. And **`@etherfold/utils` is not a bag of hashing helpers** any more: what is in it is the Node-side loader that turns a processor PATH into the authoring object plus its indexing source, since `contextFilenames` and the `@etherfold/utils/indexer` subpath went with the blob snapshot (ADR-0037).

  One existing description is CORRECTED rather than added: `@etherfold/state-store-sqlite` called itself a "state store for `@etherfold/core`", which names the wrong seam. It depends on `@etherfold/state-store`, `remote-sql` and `named-logs` and on nothing else, and a test in that package asserts as much, because a storage backend depending on the indexer would invert ADR-0016.

  **`etherfold` no longer publishes the repo's root README.** Its `prepack` copied `../../README.md` into the package, so the npm page for the CLI described the monorepo and documented none of its flags; the package now has a README of its own, committed rather than generated, and `prepack` copies only the LICENSE.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- Updated dependencies [da289e2]
- Updated dependencies [8bb063e]
- Updated dependencies [0bf9dc7]
- Updated dependencies [c0d694f]
  - @etherfold/state-store@1.0.0

## 0.1.0

### Minor Changes

- df47021: State can now be read as of a block **hash**, a **height** or a **timestamp**.

  `getAsOf` and `queryAsOf` take a `BlockAddress` (`101`, `{number}`, `{hash}` or `{timestamp}`) where they took a block number. All three axes resolve to a block number through the canonical `_blocks` table this package already writes, and then run the same as-of predicate, so they answer identically when they identify the same block. Widening a parameter, so existing calls by number are unaffected.
  - **Hash is the identifier a consumer should store.** Pinning a height means a reorg silently changes what "state at 18,000,123" refers to; pinning the hash makes the lookup answer "no such block", which is itself the signal that whatever was derived from it is invalid.
  - **"No such block" is a distinct answer from "block known, entity absent."** An address that resolves to no block throws `NoSuchBlockError` (with a `reason` of `unknown-hash` or `no-recorded-block-at-or-before`), while `undefined` keeps its ordinary meaning. `resolveBlockNumber(address)` is the soft form, answering `undefined` and throwing nothing, and `getBlock(address)` returns the recorded row so a consumer can turn a time or a height into the hash to pin. See `docs/adr/0015`.
  - **A timestamp resolves to the latest recorded block at or before T**, and to nothing before the first recorded block, never to the first block. Ties are broken by the highest block number.
  - **Rows exist only for blocks that carry our logs**, which is the caller's judgement: every block handed to `applyBlock` is recorded, including one with no mutations, since a block can carry a log of ours that changes nothing and a consumer can legitimately pin its hash. A height needs no row and stays readable regardless; a hash needs one.
  - `normalizeBlockTimestamp` reads `blockTimestamp` off a log in either encoding clients return (0x-prefixed hex per the spec, or decimal), and refuses anything else rather than defaulting to 0. Block hashes are folded to lower case on write and on lookup, so an echoed-back upper-case hash cannot masquerade as a reorg.

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

- b61de79: A declaration is now legal on every backend or refused on every backend, and the rest of the "same declaration, different meaning" class is closed.

  `entity-identifier-sql-keyword` fixed the SQL-KEYWORD half by quoting in `@etherfold/state-store-sqlite`, deliberately keeping one engine's reserved-word list out of the shared seam. This finishes the audit it opened. **It contains source-compatibility breaks** (named below); breaking an existing declaration was accepted where the rule is right.

  **Two names that differ only in CASE are now refused at declaration time, on every backend** (`@etherfold/state-store`, **breaking**). `{name: 'token'}` and `{name: 'Token'}` were accepted (`normalizeEntities` de-duplicated by exact string) and then meant two different things: SQLite folds identifier case even inside quotes, so `CREATE TABLE IF NOT EXISTS "Token"` matched the existing `token` and was silently SKIPPED, leaving ONE table with `token`'s columns and `getCurrent('Token', ...)` answering with `token`'s row, while the memory, patch and IndexedDB backends kept two entities. Quoting cannot reach this one, and no spelling of the DDL makes the engines agree, so the answer had to be the declaration's: two names a backend could confuse are one name.

  Unlike a keyword list, this belongs at the seam, and the distinction is written out where the rule lives (`src/entities.ts`): a keyword list is one engine's VOCABULARY, which quoting removes entirely; case is IDENTITY, and the backends disagree about it, so it is a PORTABILITY rule. The rule applies at all three levels -- entity names, id columns and fields -- with id columns and fields treated as one namespace, since they are the columns of one row. The message names both spellings and says to rename one. A repeated id column (`id: ['id', 'id']`, previously accepted here and `duplicate column name` at `migrate()` on SQLite) is refused too.

  **An entity named like another entity's derived index no longer breaks `migrate()`** (`@etherfold/state-store-sqlite`, **breaking for a stored database, not for a declaration**). An index and a table share ONE namespace in SQLite, so declaring `token` beside `token_open` was two ordinary entities everywhere else and `SQLITE_ERROR: there is already an index named token_open` here. The derived index names now carry the store's `_` prefix (`_token_open`, `_token_history`, `_token_lower`, `_token_upper`), which the seam already keeps declarations out of, so the collision is impossible by construction rather than refused by a new rule -- a declaration's legality must not depend on which other entities were declared beside it. An existing database re-migrates cleanly and keeps its old, now-redundant indexes under their old names; drop them by hand or rebuild.

  **An entity name in SQLite's own `sqlite_` namespace is refused when the store is CONSTRUCTED** (`@etherfold/state-store-sqlite`, **breaking**), rather than at `migrate()`. SQLite refuses `sqlite_`-prefixed object names however they are quoted, so this is genuinely one engine's limit and does not become a seam rule; what it does become is a DECLARATION-time failure, where the store was built, instead of a deploy-time one. `sqlite_`-prefixed COLUMN names stay legal, because SQLite allows them and narrowing the seam for no engine reason is the same defect pointing the other way.

  **Audited and left alone.** Identifier LENGTH: no backend imposes one (SQLite stores a 2,000-character table name and its indexes; the others hold names as JS strings), so the seam invents none. NON-ASCII and NFC/NFD collisions: already unreachable, because the shape rule `/^[A-Za-z][A-Za-z0-9_]*$/` is ASCII-only, so `café` and `cafe` + U+0301 are both refused as identifiers and can never become the case collision in another alphabet. That is also why the case fold is exact rather than approximate, and the regex now says so.

  **`@etherfold/state-store-conformance` carries every new rule**, so a future backend inherits the obligation instead of rediscovering it. The `a declaration means the same thing on every backend` group gains the case cases (entity, id column, field, and across the id/field boundary), the non-ASCII case, and `DECLARATION_PROBES`: an exported list of legally-shaped names that strain some engine (`sqlite_` entity and column names, a 200-character entity name and column names, and an entity named like a derived index), each asserting only that the store REFUSES when it is constructed or stores and reads the row back -- never accepted-then-fatal-at-`migrate()`. Adding a probe is how a newly found engine limit becomes every backend's problem at once.

  The `_` prefix rule, the shape rule and `entity-identifier-sql-keyword`'s quoting are unchanged and still tested.

- 879c4fe: Lift the processor authoring API out of the SQLite packages, so one processor runs against several storage backends.

  Two new packages. **`@etherfold/state-store`** is the seam: entity declarations, `MutationContext` (now including `update` as sugar over get-then-spread-then-set), the `StateStore` interface a backend implements (`migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `revertTo`), the capabilities it declares, and `MemoryStateStore`, a reference implementation in versioned rows over a Map. It declares no dependencies at all, which is what lets a storage primitive depend on it. **`@etherfold/processor-entities`** is the ABI-typed authoring surface (`EntityProcessor`, the `on<EventName>` handler map) plus the revert-then-apply engine (`applyEventStream`), written once against `StateStore` rather than per backend. ADR-0018 records why this is two packages and not one.

  A backend now **reports what it can do as data**, readable before `migrate` and before any read: a retention kind (`revert-only`, a window of N BLOCK NUMBERS, or `unbounded`) and whether it answers as-of reads. `@etherfold/state-store-sqlite` reports `unbounded` because that is what is true of it: the package has no pruning, and it deliberately takes no retention option, since a store that accepted a window it cannot enforce would be making exactly the claim the report exists to prevent.

  **`@etherfold/state-store-sqlite`** implements `StateStore` nominally, which it already did structurally: only `capabilities` was added. Its entity, mutation and block-pointer vocabulary is now defined at the seam and re-exported from here, so there is one definition rather than two; `ColumnType` is a deprecated alias of `FieldType`. Its block addressing (`getBlock`, hash and timestamp axes, `NoSuchBlockError`) and its SQL query surface (`queryCurrent` / `queryAsOf`) are unchanged and stay backend-specific on purpose.

  **`@etherfold/processor-sqlite`** consumes the authoring types rather than defining them. `SQLProcessor` is kept as a deprecated alias of `EntityProcessor`, so existing processors compile unchanged; the type never had anything SQL in it.

  The claim is asserted, not stated: `processor-entities/test/two-backends.test.ts` runs one processor, unmodified, against a real libSQL database and against the in-memory store, with the same declarations and the same handlers, and pins that the resulting state is identical, that read-your-writes composes two events in one block, and that a reorg makes a counter go back down on both.

- 01ab642: A configured retention window is now ENFORCED against storage, so a store that declares one stops growing.

  **`StateStore.prune(options?)` is the new verb**, on the seam and implemented by both shipped stores. It deletes the versions the declared retention no longer covers and reports what went: `{tip, floor, versionsDeleted, complete}`. Assert on `versionsDeleted`, never on reported bytes: `navigator.storage.estimate()` is quantised and lags badly enough that the spike measured it reporting MORE space used after a prune that dropped nothing.

  **It is a call the HOST schedules, and that is a decision rather than an omission (ADR-0022).** A prune plus `VACUUM` measured 1.1 seconds at 62,553 versions while a block on the same real stream carries a median of 7 mutations, so folding it into `applyBlock` would stall whichever block happened to cross a threshold, for work that block did not cause, and would have a store picking a maintenance cadence for a browser tab, a backfilling CLI and a long-running server alike. An amortised policy is `prune({maxVersions: n})` on your own schedule (watch `complete`); a background policy is `prune()` on a timer. Pruning a store with nothing to enforce (`unbounded`, or `revert-only` with no declared `finalityDepth`) is a NO-OP and not an error, so a host may schedule it unconditionally. `VersionedStateEventProcessor.prune()` is the same call for a deployment that configured retention through the processor; it is on the processor and not on the read-only `state` view, because it is a write.

  **The LIVE version of an entity is never dropped, however old it is.** A row written once at block 12,082,307 and never touched again is still the current state, and on the real measured stream (event-bearing blocks median 429 apart, rows written once and never revisited) that is the normal case rather than an edge. The floor is `retentionFloor`, which is exactly `retainedRange(...).from`, so the block a read is refused below and the block a version is deleted at cannot drift apart, and `revertTo` still reaches the full depth of the window afterwards.

  **A store with a window configured now REPORTS that window** instead of downgrading to `unbounded`, on `@etherfold/state-store-sqlite` and on `MemoryStateStore` alike, because both now enforce it on both halves: refused on every as-of read, and dropped from storage by `prune`. `retentionWithoutPruning` is REMOVED (it existed only to express "this store cannot enforce what it was asked"). The report remains about what a caller may RELY on rather than about bytes on disk, so a host that has not pruned yet still refuses the reads its window excludes -- the safe direction, and the same one a `revert-only` store already took.

  **`BatchBounds` gains `maxRowsPerStatement` (default 500).** The existing bounds cap a batch and say nothing about a single statement touching an unbounded number of rows, which is exactly the shape a hosted backend rejects, so a prune deletes by an explicit bounded list of row ids instead of by predicate. That also makes the count exact, which `remote-sql` (rows, no affected-row count) could not otherwise supply.

  `@etherfold/state-store-conformance` gains a `pruning, and what must survive it` group, asked of every backend under each retention claim, and its windowed subjects are now ordinary configuration rather than test doubles.

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

- e0e5832: Renamed to the `@etherfold` scope (ADR-0017). `ethereum-indexer` is now `@etherfold/core`, and `ethereum-indexer-browser`, `-js-processor`, `-fs`, `-fs-cache` and `-utils` are now `@etherfold/browser`, `@etherfold/js-processor`, `@etherfold/fs`, `@etherfold/fs-cache` and `@etherfold/utils`. The two previously unpublished `@ethereum-indexer/*` packages move to `@etherfold/*`.

  The CLI is the one exception to the scope: `ethereum-indexer-cli` becomes the flat package **`etherfold`**, because it is the package that installs the `etherfold` command.

  No API changed: update the package name in your imports and the exports are identical.

  **You must migrate to keep receiving updates.** There is no re-export shim under the old names, so nothing further will be published as `ethereum-indexer*` and no version of an old name forwards to the new one. Already-published versions stay installable indefinitely, so existing pins keep resolving, but they are frozen.

  **The CLI command is renamed**: the CLI installs `etherfold` instead of `ei`, so `npm i -g etherfold` then `etherfold -p <processor>`. Update any script that shells out to `ei`.

  `named-logs` namespaces follow the package names, so any log filter matching `ethereum-indexer*` needs updating to `@etherfold/*`. The CLI is the exception: its namespaces follow the command, so `ei` and `ei:keepState` become `etherfold` and `etherfold:keepState`.

  `ethereum-indexer-server` and `ethereum-indexer-db-utils` are deliberately NOT renamed: both are on the retirement path set by ADR-0010, and they have since moved to `archive/` in the repository, outside the workspace. Their published versions stay installable and are not deprecated here.

- ab45129: Retention becomes a number a deployment SETS, a store REPORTS, and a read is REFUSED against.

  **The unit is block numbers, and there is only one unit.** A deployment writes `retention: 'unbounded' | 'revert-only' | {blocks: N}` on a store (or on `VersionedStateEventProcessor` / `fromSQLProcessor`, which pass it through). `{blocks: N}` is the only window spelling: a bare number names no unit, a duration is refused on every spelling, and a count of updates is refused too. Those are not style rules. Time would prune on WALL-CLOCK progress rather than chain progress, so a stalled indexer would drop history it never finished writing and a halted chain would expire its whole window while the tip stands still; "last N updates" is derivable above the seam from the blocks each backend already indexes, and adding it below would duplicate the prune path, the report and the tests for a unit that is a floor block number. See ADR-0019.

  **Sizing a window is not sizing a number of updates**, and the arithmetic is counter-intuitive enough to state at the API: on the real measured stream, event-bearing blocks are median **429 blocks apart**, so a window of 64 blocks holds exactly ONE event-bearing block. The default is `unbounded`, which is the only report true of a store that does not prune.

  **A window below the finality depth is refused where it is configured**, naming both numbers, because reorg revert reopens versions closed after the fork point and would find them pruned. `finalityDepth` is required alongside a window for the same reason, and `VersionedStateEventProcessor` checks it a second time at `load` against the finality the stream actually runs with, since a floor validated against the wrong number is silent corruption waiting for a deep reorg.

  **An as-of read the store cannot serve now throws instead of answering.** `BlockNotRetainedError` carries the block that was requested and the range that is retained, and it joins `NoSuchBlockError` under a new shared base, `BlockUnavailableError` (both exported from `@etherfold/state-store` and re-exported from `@etherfold/state-store-sqlite`). ADR-0015 settled that an unresolvable block address is an error and not an empty result; this is the other way a historical read can fail, and it must not arrive as `undefined` (which reads as "the entity was absent then") or as the tip value (a plausible wrong number nothing downstream can tell apart from a true one). A store set to `revert-only` refuses every as-of read and keeps reverting.

  **No store claims a window it does not enforce.** `@etherfold/state-store-sqlite` has no pruning, so a configured window is validated, warned about, and reported as `unbounded` -- which is what the store actually does, since every version ever written is still there. `MemoryStateStore` behaves identically. The right to report a window is earned by `prune-versions-outside-retention-window`.

  `VersionedStateView` now exposes `capabilities`, so the consumer holding the read handle can discover at startup what history is available instead of discovering it from a refusal (or a wrong number) in production. The capability cases run against both backends in `processor-entities/test/two-backends.test.ts`.

- 2a0cb96: New package: the versioned-row state store the server-side design rests on (`docs/design/historical-state-database.md`).

  Entity state is kept as versioned rows with a half-open block-validity range (`_lower` inclusive, `_upper` exclusive, `NULL` meaning live) on the `remote-sql` interface and nothing else, so the same code runs on local SQLite, on libSQL/Turso and on hosted SQLite. An entity is declared as `{name, id, fields}` and the store issues the DDL itself: the table, the partial unique index on open rows (which also enforces "exactly one live version per business key"), and the indexes the as-of and revert paths ride.

  `VersionedStateStore` exposes `migrate`, `applyBlock` (close-then-insert, exactly one `batch([...])`, so one atomic unit and one round-trip), `applyBlocks` (packs several blocks per batch for backfill, never splitting one), `revertTo` (DELETE versions opened above the fork, then re-open versions closed above it — an order that is not interchangeable, and is pinned in both directions by a test against a real SQLite engine), and the read side `getAsOf` / `queryAsOf` / `getCurrent` / `queryCurrent`.

  Per-request statement and payload limits are a configurable bound with a conservative default (`DEFAULT_BATCH_BOUNDS`), not a hardcoded assumption about any one provider.

  This is the first package published under the `@etherfold` scope, and the first to follow the `<role>-store-<backend>` naming scheme. See `docs/adr/0014` for the scope migration and why the backend is named rather than left as a generic `sql`, and `docs/adr/0017` for the word the scope ended up spelling.

- 5854d60: **The storage seam gains a sync-cursor port, and `applyBlock` can write the cursor with the block** (ADR-0027).

  `StateStore` gains `readCursor(key)` / `writeCursor(key, value)` / `clearCursor(key)` over an **opaque string**, and `applyBlock(block, mutations, cursor?)` takes an optional `{key, value}` that is written in the SAME transaction as the block. This reverses an explicit "deliberately absent" on the interface: a cursor that could only be a SQL table stopped one-processor-several-backends at the first deployment that was not SQLite, and only the store holds the transaction the block write happens in, so only the store can stop a crash from leaving state ahead of the cursor.

  It stays a STRING and never a typed `LastSync`: that is a `@etherfold/core` type, and typing the port with it would make this package depend on core, invert ADR-0016 and drag viem into every storage primitive. `@etherfold/state-store` still declares no dependencies at all.

  Per backend:
  - **`@etherfold/state-store-sqlite`**: a new fixed `_cursor (key, value)` table, created by `migrate()` alongside `_blocks`, and the cursor statement rides in the same `batch([...])` as the block. `CURSOR_TABLE`, `readCursorStatement`, `writeCursorStatement` and `clearCursorStatement` are exported like the rest of the SQL.
  - **`@etherfold/state-store-indexeddb`**: a new `cursors` object store, written inside the block's own transaction. The package's schema version moved from 1 to 2; the upgrade is additive and `contains`-guarded, so an existing database gains the store and keeps every row. A processor declaring another entity is still not a migration.
  - **`@etherfold/state-store-patch`**: an in-memory map, written after the point where anything can still refuse. Its `durability: 'memory-only'` already says what that means for the cursor: it goes with the process, exactly as the state does.
  - **`MemoryStateStore`**: the same, as the executable definition.

  `@etherfold/state-store-conformance` gains a `the sync cursor` group: the round trip, the clear, the opacity of the value, and the one that matters — a store never reports a cursor ahead of its last applied block, asserted through a refused block and through a re-applied height. The suite's own tests gain a backend that writes the cursor before the block, so the new group is proven to catch it.

  A cursor is deliberately NOT reverted by `revertTo` and not touched by `prune`: how far the caller got is not entity state.

- 68b2afe: Remove `parentHash` from `_blocks`, `BlockPointer` and `RecordedBlock`.

  **Breaking for anyone already passing it:** `BlockPointer.parentHash` no longer exists, and the `_blocks` table has one fewer column. Existing databases need the column dropped (or recreated), since the insert no longer supplies it.

  The field was carried over from the design sketch and could never be filled honestly. A block's parent hash is not on a log, so recording it would cost the extra `eth_getBlockByHash` round-trip per block that this design exists to avoid, and ADR-0002 makes that cost acute: the in-browser path is primary and a browser provider often cannot batch those calls at all.

  It would also have described a linkage this table does not have. `_blocks` is deliberately sparse, holding only blocks that carry our logs, so two consecutive rows are almost never parent and child. A `parentHash` stored there could not be walked, and the `''` default the store was applying was a placeholder that a future chain-linkage check would have read as a real value. The cross-check it would have served (`verifyBlocks`, ADR-0004) is deferred in the design's §9, and if it is ever built it needs the field plumbed onto the log stream rather than reconstructed at this layer.

- f8050e2: The read handle `process()` hands back can use the bounded listing.

  `VersionedStateView` forwarded six store methods and not the two that the listing added, so a consumer holding the handle -- which is what `@etherfold/processor-sqlite` actually publishes, and what `onStateUpdated` is given -- had to reach a one-to-many through `queryCurrent` and a hand-written `WHERE`. That is the surface the bounded listing exists to make unnecessary (ADR-0021), and it was unavailable at precisely the place it was meant to be used.

  ```ts
  const view = await processor.process(events, lastSync);
  const {rows, truncated} = await view.listCurrent('holding', {owner}, 20);
  const then = await view.listAsOf('holding', {owner}, {hash}, 20);
  ```

  - **`listAsOf` takes this backend's addressing**, a height, `{hash}` or `{timestamp}`, like the view's other as-of reads, and refuses the same two ways: an address identifying no block throws `NoSuchBlockError`, a block outside retention throws `BlockNotRetainedError`. Neither is answered from the tip.
  - **The handle stays untyped**, entity names as strings with a caller-supplied row type. The typed reads generated from entity declarations are `createReadSurface` / `createQuerySurface`, and they are a deliberately separate thing; this is an omission closed, not a redesign.
  - **`@etherfold/state-store-sqlite` now re-exports `EntityIdPrefix` and `Listing`** from the seam, alongside the seam vocabulary it already re-exported. Its own `listCurrent` / `listAsOf` signatures name those types, so a consumer of this package alone could not previously write down the argument or the result.

### Patch Changes

- ff393f7: The last two reads that answered plausibly now refuse, or answer whole.

  Both were the same bug wearing two hats: a read that could not be served came back as `undefined`, which at this seam is not a shrug but a STATEMENT -- the block is fine and the entity was absent from it -- and it is what a caller acts on normally.

  **An `at` that is not a block number is refused** (`InvalidBlockNumberError`, `@etherfold/state-store`). `getAsOf('token', {id: '1'}, {hash: '0x64'})` on a backend with no addressing layer used to pass the retention check, compare an object against every version range, match nothing, and report the token as absent at a block nobody had named. The guard is `assertBlockNumber`, called first thing inside `assertRetained`, so it is written ONCE and every backend whose as-of reads take a block number inherits it (memory, patch, IndexedDB) across `getAsOf` and `listAsOf` alike, rather than three copies drifting.
  - **It is a `TypeError`, deliberately outside the `BlockUnavailableError` family.** Every member of that family is a fact about the STORE (the address resolved to no block; the versions are outside retention), and a caller acts on one by re-pinning or widening retention. A non-number `at` is a fact about the CALL: no store configuration makes it answerable, so it is a programmer error and it does not get swallowed by a `catch (e) { if (e instanceof BlockUnavailableError) ... }` written for the other thing. It comes BEFORE the retention check for the same reason: a `revert-only` store answering "not retained" would send its caller off to widen a window that was never the problem.
  - **`@etherfold/state-store-sqlite` keeps its richer addressing** (a height, `{hash}`, `{timestamp}`), because it resolves to a block number before the seam sees one. Its HEIGHT axis now throws the same `InvalidBlockNumberError` (via the seam's shared `isBlockNumber`) instead of a bare `Error`, with the same message it had; `NoSuchBlockError` still answers an address that resolves to no recorded block.

  **`MutationContext.get` answers with a WHOLE row for a key staged in the same block.** It returned `{...staged.values}`, which is only what the handler passed to `set`, so an id column and a declared field the write did not list were `undefined` for a row written earlier in the SAME block and present for one written in an earlier block: the shape of a row depended on when it was read. `get` now builds a staged row through `stagedRow`, the construction `list` already used for exactly this reason, so the two cannot drift apart again and a handler cannot read a field that is only sometimes there.

  Both are in the conformance suite (`@etherfold/state-store-conformance`), so a new backend inherits them: `versioned reads` gains the refusal (asked of every backend, whatever addressing sits above it), and `read-your-writes within a block` gains the row shape plus a case pinning that `get` and `list` agree about a staged row.

- 2a4e6ed: An entity column named after a SQL keyword no longer works on some backends and kills `migrate()` on others.

  **The defect.** `{name: 'placementPlayer', id: ['epoch', 'position', 'index'], ...}` passed identifier validation (`index` matches the shape rule and does not touch the store's `_` namespace), was stored and read without complaint by `MemoryStateStore`, `@etherfold/state-store-patch` and `@etherfold/state-store-indexeddb`, and then died on `@etherfold/state-store-sqlite` at `store.migrate()` with `SQLITE_ERROR: near "index": syntax error`. SQL cannot bind an identifier as a parameter, so a name reaches the engine as TEXT, and a SQL KEYWORD has a perfectly ordinary identifier shape: `index`, `order`, `group`, `select`, `table`, `where`, `default`, `references` and `primary` were all in the same position. The declaration is the surface ONE processor writes and SEVERAL backends store, so this made a processor silently non-portable and failed at deploy time on one platform, far from where the name was written.

  **The fix is to QUOTE, not to reject.** `@etherfold/state-store-sqlite` now emits every identifier that came from a declaration double-quoted -- the entity name, its id columns, its fields, and the index names derived from the entity name -- in its DDL (`src/ddl.ts`), in its statement builders (`src/statements.ts`) and in the reads on the store itself. **This is not a compatibility break:** every declaration that was legal before is still legal, and the ones that used to be fatal on SQLite now work. Rejecting keywords at declaration time was the other defensible fix and was not taken: it would have pushed one engine's reserved-word list into the surface every backend shares, broken declarations that are legal today, and re-opened the same hole the day SQLite adds a keyword or a second SQL backend arrives with a different list. The store's own fixed names (`_lower`, `_upper`, `_rowid`, `_blocks`) stay bare, so "quoted" reads as "this name came from outside".

  The shape rule is unchanged and still does its job: `to"ken`, `a-b` and anything else that is not `/^[A-Za-z][A-Za-z0-9_]*$/` is refused at declaration time, on every backend, and the `_` prefix stays the store's own. Quoting is not what stands between a declaration and injection; the shape check still runs first.

  **`@etherfold/state-store-conformance` gains a group, `a declaration means the same thing on every backend`**, asked of every backend. That is the property this was a defect against rather than a naming preference: a declaration one backend accepts must work on all of them, and one any backend refuses must be refused by all of them, at DECLARATION time. Its subject is a new shared fixture, `RESERVED` -- an entity named `order` with id columns `group` and `index` and fields `select`, `table`, `where`, `default`, `references` and `primary`. It is in `CONFORMANCE_ENTITIES`, so every case migrates it, every revert sweeps it and every prune considers it, and the keyword identifiers reach every statement a backend emits rather than only its DDL. A backend that adds this version of the suite and does not quote will see the whole run go red, which is what it did here before the fix.

  `quoted(name)` and `quotedList(names)` are exported from `@etherfold/state-store-sqlite` for the caller-supplied-SQL tier (`queryCurrent` / `queryAsOf`), where the predicate text is the caller's to write and therefore the caller's to quote: `store.queryCurrent('order', {where: `${quoted('default')} > ?`, args: [7]})`.

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

- Updated dependencies [ff393f7]
- Updated dependencies [4e75014]
- Updated dependencies [ce8f7d2]
- Updated dependencies [b61de79]
- Updated dependencies [2a4e6ed]
- Updated dependencies [879c4fe]
- Updated dependencies [01ab642]
- Updated dependencies [18c6876]
- Updated dependencies [ab45129]
- Updated dependencies [ebf9690]
- Updated dependencies [5854d60]
  - @etherfold/state-store@0.1.0
