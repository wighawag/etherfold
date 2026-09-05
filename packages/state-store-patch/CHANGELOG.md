# @etherfold/state-store-patch

## 0.1.1

### Patch Changes

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

- Updated dependencies [da289e2]
- Updated dependencies [8bb063e]
- Updated dependencies [0bf9dc7]
- Updated dependencies [c0d694f]
  - @etherfold/state-store@1.0.0

## 0.1.0

### Minor Changes

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

### Patch Changes

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
