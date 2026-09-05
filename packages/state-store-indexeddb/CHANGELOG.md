# @etherfold/state-store-indexeddb

## 0.1.1

### Patch Changes

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

- d45f11d: The browser backend, behind the same seam: `@etherfold/state-store-indexeddb`, and it is the browser DEFAULT.

  **A new package.** Versioned rows in IndexedDB, so a tab keeps history, reverts a reorg, starts cold by reading one row instead of all of them, and pays a write cost proportional to what CHANGED. The same processor that runs on a server against `@etherfold/state-store-sqlite` runs on it unchanged, and `@etherfold/browser` gains the one line where a browser deployment chooses:

  ```ts
  const store = await createBrowserStateStore(processor.entities); // IndexedDB, the default
  const light = await createBrowserStateStore(processor.entities, {
  	backend: (entities) => new PatchStateStore(entities, {retention: 'revert-only', finalityDepth: 64}),
  });
  ```

  Choosing the second one touches no processor code: a processor is entity declarations plus `on<EventName>` handlers over a `MutationContext`, and it names no backend.

  **The default is a CONDITION, not a preference, and it is written down as one** (`docs/adr/0024`). On the real workload (the launched stratagems game on Base: 31,332 events, 4,072 live rows) IndexedDB beat wasm SQLite on writes by 1.6x to 6.9x and on reads by 4x to 14x on every engine that can run both, WebKit cannot run the SQLite route at all, and three of four tabs FAIL AT OPEN on both SQLite VFSs. The ADR records the four things that would all have to be true for wasm SQLite to win, and the five that would overturn the choice, from `work/notes/findings/sqlite-in-the-browser.md`.

  **It is not a speed-up.** The incumbent whole-state blob (`keepStateOnIndexedDB`) is the FASTEST writer at today's sizes: 2.0 ms/block on Chromium against 45.6 for row-level writes, a 20x throughput loss at 4,072 live rows. What row-level writes buy is what the blob cannot do at any speed: an as-of read, a revert, a bounded cold start, and a per-write cost that stops tracking total state.
  - **It passes `@etherfold/state-store-conformance`** under all three retention claims, in node under `fake-indexeddb` on every commit and in **Chromium, Firefox and WebKit** via `pnpm --filter @etherfold/state-store-indexeddb test:browser` (the same suite, not a browser-flavoured copy). Evidence in `docs/spikes/indexeddb-row-backend-browser-default/results/`.
  - **The bounded id-prefix listing is one `IDBKeyRange.bound([entity, ...prefix], [entity, ...prefix, []])` cursor**, asserted rather than assumed: the tests record the range the store handed IndexedDB and how many records it walked, because a scan-and-filter returns the same rows.
  - **Retention is enforced on both halves**, so what it reports is what it does: an as-of read outside the window throws `BlockNotRetainedError` and never the tip value, and `prune` walks the `upper` index — where a LIVE version cannot appear at all, because `null` is not a valid IndexedDB key — so the row that IS the current state cannot be dropped however old it is. The window is measured against the tip read from the database, so it is right after a reload and right when another tab moved it.
  - **`revertTo` is two index range scans** (drop what the fork opened, reopen what it closed) rather than a per-block undo journal, and `getAsOf` is one backwards cursor over that key's versions.
  - **Four tabs against one database complete with zero row mismatches**, which is the case both wasm-SQLite VFSs fail at open.

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
