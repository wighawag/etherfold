# @etherfold/processor-sqlite

## 0.1.1

### Patch Changes

- 850a3af: Dropped `named-logs` from the runtime dependencies: nothing in the package imports it, so it was an install a consumer paid for and never used.
- 1d9be43: Every caller, example and doc now names the GENERATION container: `IndexerGeneration` for one stream plus one fold, and the two FACTORIES for the browser hook.

  This is the MIGRATE batch of the expand → migrate → contract rename the generation container needs. Nothing is removed: `EthereumIndexer` is still exported from `@etherfold/core` as an alias to `IndexerGeneration`, and `createIndexerState` still accepts a processor built over a store. What changed is that nothing in this repository reaches for either any more, so `the-old-indexer-shape-is-deleted` can delete both without a compile error anywhere.

  **`@etherfold/browser` re-exports the class as `IndexerGeneration`, not `EthereumIndexer`.** A caller that imported the type from this package renames the import; the class itself is unchanged, and `@etherfold/core` still exports the old name for now.

  **The browser hook is written against `{createState, createProcessor}` everywhere.** The README, both example apps, the `IndexerState` and `BrowserStateStore` JSDoc examples and every test now hand over the two factories rather than a processor already built over a store:

  ```ts
  const indexer = createIndexerState({
  	createState: () => createBrowserStateStore(myProcessor.entities, {databaseName: 'my-app'}),
  	createProcessor: (store) => fromEntityProcessor(myProcessor)(store),
  });
  ```

  An indexer holds any number of generations and each folds into its OWN state, so the store cannot be a value handed over once — the hook is what calls these, once per generation. An app that needs the store it built (to rebuild a processor over it on a hot reload, or to read its capability report) captures it in the factory's own closure, which is what both examples now do.

  **The CLI's source-text guard is asserted to still bite.** `packages/cli/test/engine.test.ts` enforces that the CLI constructs and imports no browser engine by matching the identifier with regexes. A rename that left those on a name nothing uses any more would keep them green and VACUOUS — enforcing nothing, with nothing going red to say so — so the patterns are now named functions and are asserted against deliberate violations under BOTH spellings, plus the prose and the generation CONTAINER they must not fire on.

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
- Updated dependencies [1a6f68b]
- Updated dependencies [56acbef]
- Updated dependencies [1d619c9]
- Updated dependencies [d50583b]
- Updated dependencies [37146b2]
- Updated dependencies [f3dc9a5]
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
- Updated dependencies [2c6ef82]
  - @etherfold/core@1.0.0
  - @etherfold/processor-entities@1.0.0
  - @etherfold/state-store-sqlite@0.2.0

## 0.1.0

### Minor Changes

- 5854d60: **`EntityEventProcessor`: run an entity processor against ANY `StateStore`.**

  The runtime the storage seam was built for and the one thing that was missing from it. `new EntityEventProcessor(store, processor)` is an `EventProcessor` the core drives, with the store INJECTED, so the same processor definition (entity declarations plus `on<EventName>` handlers over a `MutationContext`) indexes to SQLite on a server, to IndexedDB in a browser tab, to the light patch store or to memory in a test, with nothing about the processor changed. `fromEntityProcessor(processor, options)(store)` is the factory form, mirroring `fromJSProcessor`.

  `process()` hands back an **`EntityStateView`**: the seam's four reads (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`) plus the capability report. `queryCurrent` / `queryAsOf` are deliberately NOT on it, and not stubbed to throw either, so asking a backend-neutral handle for caller-supplied SQL is a compile error in the editor rather than a runtime throw in a browser tab. `VersionedStateView` (`@etherfold/processor-sqlite`) is the tier that has them.

  **The sync cursor moved behind the storage seam** (ADR-0027) and is written in the same transaction as the block it describes. `serializeLastSync` / `deserializeLastSync` now live here, alongside `SYNC_CURSOR_KEY`, `parseStoredCursor` and `syncedThrough`; `@etherfold/processor-sqlite` re-exports all four from its `sync.ts`, and its `_sync` table is gone, so the SQL that reached it goes with it: **`SYNC_TABLE`, `SYNC_ROW_ID`, `SYNC_SCHEMA_DDL`, `readLastSync`, `writeLastSyncStatement` and `deleteLastSyncStatement` are removed** from `@etherfold/processor-sqlite`'s surface. The storage is `@etherfold/state-store-sqlite`'s neutral `_cursor (key, value)` table, reached through `StateStore.readCursor` / `writeCursor` / `clearCursor`. This closes a live defect: the cursor used to be a second round trip after the blocks, and a crash in that window left state ahead of the cursor, which is not self-healing — the restart replayed a block the store already held and `applyBlock` refused it, so the indexer wedged until a human intervened.

  **`applyEventStream` takes an optional `cursor`** (`{key, lastSync}`) and applies each block together with the cursor that describes THAT block, because one `process` call carries many blocks and each is its own transaction. A stream with no blocks still records the range it scanned.

  **`VersionedStateEventProcessor` is unchanged in behaviour and is now a thin SQLite flavour** of `EntityEventProcessor`: it builds a `VersionedStateStore` from a `RemoteSQL`, keeps the SQL read tier, and delegates the rest. Revert-then-apply, the block grouping, the version hash, the code fingerprint and the retention reconciliation exist once rather than twice.

- 879c4fe: Lift the processor authoring API out of the SQLite packages, so one processor runs against several storage backends.

  Two new packages. **`@etherfold/state-store`** is the seam: entity declarations, `MutationContext` (now including `update` as sugar over get-then-spread-then-set), the `StateStore` interface a backend implements (`migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `revertTo`), the capabilities it declares, and `MemoryStateStore`, a reference implementation in versioned rows over a Map. It declares no dependencies at all, which is what lets a storage primitive depend on it. **`@etherfold/processor-entities`** is the ABI-typed authoring surface (`EntityProcessor`, the `on<EventName>` handler map) plus the revert-then-apply engine (`applyEventStream`), written once against `StateStore` rather than per backend. ADR-0018 records why this is two packages and not one.

  A backend now **reports what it can do as data**, readable before `migrate` and before any read: a retention kind (`revert-only`, a window of N BLOCK NUMBERS, or `unbounded`) and whether it answers as-of reads. `@etherfold/state-store-sqlite` reports `unbounded` because that is what is true of it: the package has no pruning, and it deliberately takes no retention option, since a store that accepted a window it cannot enforce would be making exactly the claim the report exists to prevent.

  **`@etherfold/state-store-sqlite`** implements `StateStore` nominally, which it already did structurally: only `capabilities` was added. Its entity, mutation and block-pointer vocabulary is now defined at the seam and re-exported from here, so there is one definition rather than two; `ColumnType` is a deprecated alias of `FieldType`. Its block addressing (`getBlock`, hash and timestamp axes, `NoSuchBlockError`) and its SQL query surface (`queryCurrent` / `queryAsOf`) are unchanged and stay backend-specific on purpose.

  **`@etherfold/processor-sqlite`** consumes the authoring types rather than defining them. `SQLProcessor` is kept as a deprecated alias of `EntityProcessor`, so existing processors compile unchanged; the type never had anything SQL in it.

  The claim is asserted, not stated: `processor-entities/test/two-backends.test.ts` runs one processor, unmodified, against a real libSQL database and against the in-memory store, with the same declarations and the same handlers, and pins that the resulting state is identical, that read-your-writes composes two events in one block, and that a reorg makes a counter go back down on both.

- 33afc5b: A processor's `version` is now REQUIRED, and the indexer reports when the declared version no longer matches the code.

  **Breaking for processor authors, in both authoring surfaces.** `version` becomes a required field on `JSProcessor` (`@etherfold/js-processor`) and on `SQLProcessor` (`@etherfold/processor-sqlite`), and a processor without a non-empty one now throws at construction, naming the processor by its handlers. Add a `version` to each processor object, ideally generated (as `examples/event-processor-nfts` does, from a hash of its own built file) so it cannot be forgotten.

  **Breaking for `EventProcessor` implementors.** `getCodeFingerprint(): string | undefined` is a REQUIRED method, not an optional one. An optional method would be a hole with a polite name: an implementation that never wrote one, or a wrapper that forgot to forward it, would lose drift detection with nothing to show for it. Returning `undefined` is still a valid answer and means "cannot tell", which is never reported as drift. Both cache wrappers (`EventCache`, `ProcessorFilesystemCache`) forward it.

  **Breaking for stored state: every version hash changes, so existing state is discarded once.** Both implementations dropped their fallback constants entirely rather than merely making them unreachable. `${version || 'unknown'}` is gone with the optional version, and `configHash || 'not-configured'` is gone too: the config is now hashed the same way whether or not `configure()` was called, so an unconfigured processor and one configured with `undefined` no longer get different hashes and no longer discard each other's state.

  **New: advisory drift detection for the version an author forgot to bump.** `getCodeFingerprint()` is derived from the processor's own handler sources and persisted as `LastSync.context.processorFingerprint`. On load, when the version hash is UNCHANGED but the fingerprint is not, the core reports at error level through `named-logs` and through a new `indexer.onProcessorDrift` callback, and keeps going. Set `strictProcessorDrift: true` in the indexer config to refuse to start instead.
  - The fingerprint is deliberately NOT part of `getVersionHash()`. A minifier or a transpiler change moves it without changing behaviour, and folding that in would force a full state rebuild on a deploy that changed no logic.
  - **Absence is never drift.** A cursor with no fingerprint, and a processor that answers `undefined`, both report nothing.
  - `processorCodeFingerprint(processor)` and `assertProcessorVersion(processor, implementation)` are exported from `@etherfold/core` for anyone implementing their own `EventProcessor`.
  - `ProcessorContext.version` is now required, since every processor has one.

- 01ab642: A configured retention window is now ENFORCED against storage, so a store that declares one stops growing.

  **`StateStore.prune(options?)` is the new verb**, on the seam and implemented by both shipped stores. It deletes the versions the declared retention no longer covers and reports what went: `{tip, floor, versionsDeleted, complete}`. Assert on `versionsDeleted`, never on reported bytes: `navigator.storage.estimate()` is quantised and lags badly enough that the spike measured it reporting MORE space used after a prune that dropped nothing.

  **It is a call the HOST schedules, and that is a decision rather than an omission (ADR-0022).** A prune plus `VACUUM` measured 1.1 seconds at 62,553 versions while a block on the same real stream carries a median of 7 mutations, so folding it into `applyBlock` would stall whichever block happened to cross a threshold, for work that block did not cause, and would have a store picking a maintenance cadence for a browser tab, a backfilling CLI and a long-running server alike. An amortised policy is `prune({maxVersions: n})` on your own schedule (watch `complete`); a background policy is `prune()` on a timer. Pruning a store with nothing to enforce (`unbounded`, or `revert-only` with no declared `finalityDepth`) is a NO-OP and not an error, so a host may schedule it unconditionally. `VersionedStateEventProcessor.prune()` is the same call for a deployment that configured retention through the processor; it is on the processor and not on the read-only `state` view, because it is a write.

  **The LIVE version of an entity is never dropped, however old it is.** A row written once at block 12,082,307 and never touched again is still the current state, and on the real measured stream (event-bearing blocks median 429 apart, rows written once and never revisited) that is the normal case rather than an edge. The floor is `retentionFloor`, which is exactly `retainedRange(...).from`, so the block a read is refused below and the block a version is deleted at cannot drift apart, and `revertTo` still reaches the full depth of the window afterwards.

  **A store with a window configured now REPORTS that window** instead of downgrading to `unbounded`, on `@etherfold/state-store-sqlite` and on `MemoryStateStore` alike, because both now enforce it on both halves: refused on every as-of read, and dropped from storage by `prune`. `retentionWithoutPruning` is REMOVED (it existed only to express "this store cannot enforce what it was asked"). The report remains about what a caller may RELY on rather than about bytes on disk, so a host that has not pruned yet still refuses the reads its window excludes -- the safe direction, and the same one a `revert-only` store already took.

  **`BatchBounds` gains `maxRowsPerStatement` (default 500).** The existing bounds cap a batch and say nothing about a single statement touching an unbounded number of rows, which is exactly the shape a hosted backend rejects, so a prune deletes by an explicit bounded list of row ids instead of by predicate. That also makes the count exact, which `remote-sql` (rows, no affected-row count) could not otherwise supply.

  `@etherfold/state-store-conformance` gains a `pruning, and what must survive it` group, asked of every backend under each retention claim, and its windowed subjects are now ordinary configuration rather than test doubles.

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

- 39e10b1: New package: an `EventProcessor` whose derived state lives in the versioned-row state store instead of memory, so indexing a chain produces time-travellable state as a side effect of normal processing.

  `VersionedStateEventProcessor` implements the existing contract (`getVersionHash` / `load` / `process` / `reset` / `clear`) and writes through `@etherfold/state-store-sqlite`. A `removed: true` event becomes a single `revertTo(forkPoint)` rather than any private undo mechanism, where the fork point is one below the lowest retracted block in the stream. That covers a reorg which removes a block's logs with no replacement (the `d24872f` case) as well as a hash replacement, because the revert is driven by the retraction itself and never by what replaced it.

  `process` returns a read-only `VersionedStateView` (as-of and current reads on the hash, height and time axes) instead of a materialised state object, and the sync cursor is persisted in this package's own fixed `_sync` table.

  Behavioural equivalence with the in-memory path is asserted rather than assumed: the tests run the same scenarios as `@etherfold/js-processor`'s reorg characterization tests, and additionally run both processors over the same streams and compare the resulting states directly.

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

- 9738f1c: One processor, run under the single-process CLI and under the split indexer-server, is now a test rather than an assurance.

  `packages/processor-sqlite/test/deployment-shapes.test.ts` takes ONE `EntityProcessor` (one `version`, one set of entity declarations, imported and not rewritten) and runs it two ways over the same captured chain: as a single `EthereumIndexer` doing fetch, stream-building and processing in one process (what `etherfold serve` is, and the intended CLI shape), and as a split deployment where a stateless log-fetcher pushes contiguous ranges across a wire to an indexer-server that hosts the stream-builder and the processor. Both land on the same state, including through a reorg whose replacement branch carries fewer events, so the global counter comes DOWN and an entity the replacement never mentions goes back to what the confirmed block wrote. Both are run against two storage backends (versioned rows in libSQL, versioned rows in a Map), so the four states have to agree and the backend is the only line that differs.

  The input is a replayed stream fixture: the chain is captured once with `captureStream`, serialized once, and every run re-parses the same text, so the comparison is against identical bytes rather than two chain reads.

  **The seam boundary is encoded so that closing it goes red**, since "the boundary is intact" is not otherwise checkable. Four ways, and the first is the load-bearing one: the indexer-server half is constructed with a provider that THROWS on every JSON-RPC method, naming the boundary. Because the same processor and the same core run both ways, a convenience added on the single-process path -- where one would be added -- is exercised again on the split path, where it cannot be answered. The other three: everything crossing the wire is JSON and is asserted to survive the crossing unchanged; the envelope is asserted to be ADR-0004's and to carry no `removed` markers and no `unconfirmedBlocks`, so all reorg information is derived by the receiver; and the receiver is authoritative about the cursor, with a batch starting anywhere else refused and nothing applied.
  - **`EthereumIndexer.expectedFromBlock` is new**, and it is the ADR-0004 primitive the split shape needs: the block the next batch must start at, which a stateless log-fetcher cannot compute because it holds no cursor. `feed()` already refused a batch that started anywhere else (`generateStreamToAppend` enforces it internally); what was missing was a way to ASK, without which the sender would have to hold the cursor itself. It reaches back over the unconfirmed window rather than answering `lastToBlock + 1`, because re-fetching that window is how a reorg is detected at all.

- 0ac08c0: Follow-on from the tagged BigInt codec landing everywhere: no behaviour change in any of these three, but they each referred to the convention that is gone.

  `@etherfold/processor-sqlite`'s deployment-shapes test simulated the wire crossing with `bnReplacer` / `bnReviver`, which no longer exist; it now crosses through the REAL `serializeWireBatch` / `parseWireBatch`, so it exercises what a deployed log-fetcher and receiver actually put on the wire. `@etherfold/js-processor`'s version test carried an inline copy of the old suffix reviver to stand in for "the same convention the real keepers use", and now uses the codec those keepers actually use. `@etherfold/processor-entities`' sync-cursor note said the tagged codec was shared with the wire; it is now the repo's only BigInt convention, and says so.

- Updated dependencies [ff393f7]
- Updated dependencies [6c875dd]
- Updated dependencies [5854d60]
- Updated dependencies [535ccc1]
- Updated dependencies [df47021]
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
- Updated dependencies [c359dcb]
- Updated dependencies [9738f1c]
- Updated dependencies [879c4fe]
- Updated dependencies [33afc5b]
- Updated dependencies [01ab642]
- Updated dependencies [18c6876]
- Updated dependencies [4097ccd]
- Updated dependencies [e0e5832]
- Updated dependencies [ab45129]
- Updated dependencies [2a0cb96]
- Updated dependencies [ebf9690]
- Updated dependencies [5854d60]
- Updated dependencies [68b2afe]
- Updated dependencies [3a78285]
- Updated dependencies [0ac08c0]
- Updated dependencies [0ac08c0]
- Updated dependencies [cefe0de]
- Updated dependencies [f8050e2]
  - @etherfold/state-store-sqlite@0.1.0
  - @etherfold/core@0.7.0
  - @etherfold/processor-entities@0.1.0
