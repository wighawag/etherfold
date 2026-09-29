# The bounded listing's id order, per backend and per read

Task: `a-conformance-case-shows-the-listings-id-order-per-backend` (2026-09-29). Read by `the-listings-id-order-is-decided`, which owns the decision between "UTF-8 everywhere" and "only ASCII ids are ordered". Nothing is decided or changed here: every backend keeps the order it had, and the conformance suite now records it.

## The question

ADR-0021 says a listing ascends "in that id's own order" and that "ordering is lexicographic over the stringified id", but not WHICH string order. Two are in play:

- **UTF-8 bytes** (code point order): SQLite's default BINARY collation over TEXT, and the accessor seam's text order (ADR-0099).
- **UTF-16 code units**: JavaScript's `<` and IndexedDB's key comparison.

They disagree only when one id holds a character above U+FFFF (a surrogate pair in UTF-16, high half U+D800 to U+DBFF) and another holds a character from U+E000 to U+FFFF. UTF-16 sorts the first lower, UTF-8 the second.

## Premise check (2026-09-29)

The task was written on 2026-09-28. Checked against the tree before building:

- `compareIds` (`packages/state-store/src/listing.ts`) still compares with `<` and `>`, so UTF-16 code units. `MemoryStateStore`'s scan (`memory.ts`), `PatchStateStore.listCurrent` (`packages/state-store-patch/src/store.ts`) and `MutationContext.list`'s merge (`mutation-context.ts`) all sort with it.
- SQLite's id columns are `TEXT NOT NULL` with no `COLLATE` clause (`packages/state-store-sqlite/src/ddl.ts`), and the open and history indexes are plain column lists, so the collation is BINARY. The listing statement (`statements.ts`, `listStatement`) is `ORDER BY` the declared id columns with no collation either. The test database is libSQL `:memory:` in its default UTF-8 encoding, so BINARY is UTF-8 byte order.
- IndexedDB's row key is `[entity, ...id]` with every id column a STRING key (`packages/state-store-indexeddb/src/keys.ts`, `rowKey`), listed through `listingRange` over that key, so the specification's string comparison (code units) applies.

No backend had changed its order. The measurements below agree with the task's description.

## The ids used

`ID_ORDER_SAMPLE` in `@etherfold/state-store-conformance` (`src/fixtures.ts`), written as the `position` column of `placement` children of epoch 7, each row's `player` carrying the label:

| label   | id                          | why it is there                                                   |
| ------- | --------------------------- | ----------------------------------------------------------------- |
| U+0042  | `B`                         | before `a` in both binary orders; a locale collation would flip it |
| U+0061  | `a`                         | ASCII baseline                                                    |
| U+E000  | `\uE000` (private use)      | the lowest character above the surrogates                        |
| U+FFFD  | `\uFFFD` (replacement char) | near the top of the BMP                                           |
| U+1F600 | `\u{1F600}` (emoji)         | supplementary plane, a surrogate pair `\uD83D\uDE00` in UTF-16    |

The two expected sequences (`ID_ORDER_SEQUENCES`), written out rather than computed:

- `utf-8`: U+0042, U+0061, U+E000, U+FFFD, U+1F600
- `utf-16`: U+0042, U+0061, U+1F600, U+E000, U+FFFD

## Observed order, per backend and per read

With a limit (10) that covers every id written, so this is ORDER only. Every cell is asserted positively by the conformance case `bounded id-prefix listing > ... ascends in the declared id order`, from the order each backend DECLARES in its registration (`StateStoreConformanceOptions.idOrder`).

| backend                                            | `listCurrent` | `listAsOf`              | `MutationContext.list` (2 of 5 staged) | accessor text `orderBy` (comparison) |
| -------------------------------------------------- | ------------- | ----------------------- | -------------------------------------- | ------------------------------------ |
| memory (`MemoryStateStore`)                        | UTF-16        | UTF-16                  | UTF-16                                 | no accessor                          |
| patch (`PatchStateStore`)                          | UTF-16        | not answered (refuses)  | UTF-16                                 | no accessor                          |
| SQLite (`VersionedStateStore`, libSQL)             | **UTF-8**     | **UTF-8**               | UTF-16                                 | UTF-8                                |
| IndexedDB, `fake-indexeddb` (node)                 | UTF-16        | UTF-16                  | UTF-16                                 | UTF-8                                |
| IndexedDB, Chromium 151.0.7922.34                  | UTF-16        | UTF-16                  | UTF-16                                 | UTF-8                                |
| IndexedDB, Firefox 153.0                           | UTF-16        | UTF-16                  | UTF-16                                 | UTF-8                                |
| IndexedDB, WebKit (Playwright 1.62.1, Safari 26.5) | UTF-16        | UTF-16                  | UTF-16                                 | UTF-8                                |

Where each row is asserted:

- memory: `packages/state-store-conformance/test/memory-store.conformance.test.ts`, and `the-suite-catches.test.ts` shows the case going red when the declared order is wrong.
- patch: `packages/state-store-patch/test/conformance.test.ts`. It claims `revert-only`, so `listAsOf` is not selected.
- SQLite: `packages/state-store-sqlite/test/conformance.test.ts`, four runs (unbounded, a 60-block window, revert-only, a table namespace).
- IndexedDB (node): `packages/state-store-indexeddb/test/conformance.test.ts`.
- IndexedDB (engines): `packages/state-store-indexeddb/browser/state-store.spec.ts`, twice per engine. The shared suite runs with the engine's declared order (`ID_ORDER_BY_ENGINE`, passed to the `conformance` case as `idOrder`), and a dedicated `id-order` case reports each read's order so a disagreement names the engine and the read. The local run of 2026-09-29 is in `results/browser-id-order.json`; CI's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs assert it on every PR.
- Accessor column (comparison, not new here): `@etherfold/accessor`'s conformance case `text orders by UTF-8 bytes, nulls first ascending, ties by id` puts U+E000 before U+1F600 on SQLite (`packages/state-store-sqlite/test/accessor-conformance.test.ts`) and IndexedDB (`packages/state-store-indexeddb/test/accessor-conformance.test.ts`, and the `accessor-conformance` browser case on all three engines). The IndexedDB accessor gets there by sorting in memory with `compareUtf8` (`packages/state-store-indexeddb/src/accessor.ts`), not from its key order. Its tie break by the declared id is also documented as UTF-8, but its conformance cases only tie on ASCII ids.

So: the in-process sorts and IndexedDB agree with each other (UTF-16), SQLite's own reads disagree with them (UTF-8), and SQLite disagrees WITH ITSELF between a read outside a block and the same read inside one. The accessor is UTF-8 everywhere, which matches SQLite's listing and nothing else's.

## What `MutationContext.list` keeps when the limit CUTS it

Measured in `packages/state-store-sqlite/test/listing-id-order.test.ts`, beside `MemoryStateStore` for comparison. The merge asks the store for `limit + staged` rows in the STORE's order, merges the staged rows, re-sorts with `compareIds` (UTF-16) and keeps the first `limit`. Stored under epoch 7: U+0061, U+E000, U+FFFD, U+1F600. Limit 2.

| scenario (inside a block)                  | SQLite answers    | memory answers     | UTF-16 first two | UTF-8 first two |
| ------------------------------------------ | ----------------- | ------------------ | ---------------- | --------------- |
| `listCurrent`, outside a block             | U+0061, U+E000    | U+0061, U+1F600    | U+0061, U+1F600  | U+0061, U+E000  |
| nothing staged under the prefix            | U+0061, U+E000    | U+0061, U+1F600    | U+0061, U+1F600  | U+0061, U+E000  |
| stored U+0061 overwritten (staged)         | U+0061, U+E000    | U+0061, U+1F600    | U+0061, U+1F600  | U+0061, U+E000  |
| new U+1F601 staged (not yet stored)        | U+0061, U+1F601   | U+0061, U+1F600    | U+0061, U+1F600  | U+0061, U+E000  |

`truncated` is `true` in every row, correctly.

**Answer to the acceptance question: on SQLite, inside a block, the listing differs in ORDER and also in the SET of rows kept at the limit.** Which set depends on whether a row is STORED or STAGED: stored rows are cut in UTF-8 order before the merge ever sees them, staged rows are never cut by the store, and the merge then sorts in UTF-16. The last row is a set that is neither order's first rows: the stored U+1F600 is dropped by the store's UTF-8 cut, while the staged U+1F601, which sorts after it in BOTH orders, is kept. On memory, patch and IndexedDB the store's order and the merge's order are the same (UTF-16), so the cut is always UTF-16's first rows; this is shown for memory and follows by construction for the other two, which sort or walk in the same order as `compareIds`.

The case where it bites is a handler that lists a bounded page of children inside a block on a SQLite backend, where the ids mix supplementary-plane characters with U+E000 to U+FFFF and the page is cut. Ids come from event arguments (addresses, hashes, decimals, all ASCII), so no measured stream has hit it.

## Reproducing

- Node backends: `pnpm --filter @etherfold/state-store-conformance test`, and the `conformance.test.ts` of `state-store-patch`, `state-store-sqlite` and `state-store-indexeddb`; the cut table is `pnpm --filter @etherfold/state-store-sqlite exec vitest run test/listing-id-order.test.ts`.
- Engines: `pnpm --filter @etherfold/state-store-indexeddb exec playwright test browser/state-store.spec.ts -g "id order declared"`. This rewrites `docs/spikes/indexeddb-row-backend-browser-default/results/browser-<project>.json` as every run of that spec does; `results/browser-id-order.json` here is the `id-order` entry extracted from those files.
