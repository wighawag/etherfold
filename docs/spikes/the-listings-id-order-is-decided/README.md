# The bounded listing's id order, after the decision

Task: `the-listings-id-order-is-decided` (2026-09-29). The maintainer answered "UTF-8 everywhere" (ADR-0021, amended), on the evidence in `docs/spikes/the-listings-id-order-per-backend/README.md`. This folder holds what the real engines answered once the change was in.

## What changed

- `compareIds` (`packages/state-store/src/listing.ts`) compares each id column with `compareUtf8`, which is UTF-8 byte order (code point order) without encoding. The memory store, the patch store and the read-your-writes merge in `MutationContext.list` all sort with it. The IndexedDB accessor's text order uses the same function (it had a private copy).
- IndexedDB (`packages/state-store-indexeddb/src/keys.ts`) keys each id column by its UTF-8 bytes (`idKey`), so its key order is UTF-8 byte order. `SCHEMA_VERSION` is 2; a database below `KEY_LAYOUT_SINCE` (2) is discarded at the version change and comes back empty (`upgrade` in `store.ts`).
- SQLite is unchanged: its BINARY collation over UTF-8 TEXT was already UTF-8 byte order.

## Observed order, per backend and per read

| backend                       | `listCurrent` | `listAsOf`             | `MutationContext.list` | cut inside a block |
| ----------------------------- | ------------- | ---------------------- | ---------------------- | ------------------ |
| memory                        | UTF-8         | UTF-8                  | UTF-8                  | UTF-8's first rows |
| patch                         | UTF-8         | not answered (refuses) | UTF-8                  | UTF-8's first rows |
| SQLite (libSQL)               | UTF-8         | UTF-8                  | UTF-8                  | UTF-8's first rows |
| IndexedDB, `fake-indexeddb`   | UTF-8         | UTF-8                  | UTF-8                  | UTF-8's first rows |
| IndexedDB, Chromium 151       | UTF-8         | UTF-8                  | UTF-8                  | UTF-8's first rows |
| IndexedDB, Firefox 153        | UTF-8         | UTF-8                  | UTF-8                  | UTF-8's first rows |
| IndexedDB, WebKit (Safari 26.5) | UTF-8       | UTF-8                  | UTF-8                  | UTF-8's first rows |

Every cell is asserted by the conformance group `bounded id-prefix listing` (no per-backend order option any more); the cut column is the case `MutationContext.list, CUT by its limit inside a block, keeps the first rows in UTF-8 byte order`, and on SQLite it is also pinned beside memory in `packages/state-store-sqlite/test/listing-id-order.test.ts`.

## Files

- `results/browser-id-order.json`: the `id-order`, `old-layout` and `access-path` cases of `packages/state-store-indexeddb/browser/state-store.spec.ts` from a local run on 2026-09-29 (Playwright 1.62.1), extracted from the spec's `browser-<project>.json` output. `old-layout` is a database written by hand with the previous layout (version 1, string keys) and opened by the new code: empty before writing, UTF-8 order after. `access-path` shows the listing's range bounds holding the id column as bytes on each engine.

## Reproducing

- Node: `pnpm --filter @etherfold/state-store-conformance test`, and `test` in `state-store`, `state-store-patch`, `state-store-sqlite` and `state-store-indexeddb` (the old-layout case is `state-store-indexeddb/test/key-layout.test.ts`).
- Engines: `pnpm --filter @etherfold/state-store-indexeddb exec playwright test browser/state-store.spec.ts`. That rewrites `docs/spikes/indexeddb-row-backend-browser-default/results/browser-<project>.json` as every run of that spec does.
