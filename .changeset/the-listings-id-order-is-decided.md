---
'@etherfold/state-store': minor
'@etherfold/state-store-conformance': minor
'@etherfold/state-store-indexeddb': minor
'@etherfold/state-store-patch': patch
'@etherfold/state-store-sqlite': patch
---

The bounded id-prefix listing has ONE id order on every backend and every read: UTF-8 byte order, which is code point order (ADR-0021, amended). It differs from the UTF-16 code-unit order some backends used only for an id above U+FFFF against one from U+E000 to U+FFFF.

- `@etherfold/state-store`: `compareIds` compares each id column by its UTF-8 bytes rather than with JavaScript's `<`, so `MemoryStateStore`, `PatchStateStore` and the read-your-writes merge in `MutationContext.list` all list in UTF-8 order. A listing cut by its limit inside a block now keeps the same rows as the store's own order, on SQLite too. New export `compareUtf8(a, b)`, the string comparison it uses.
- `@etherfold/state-store-indexeddb`: each id column is keyed by its UTF-8 bytes (`idKey`, a binary key) instead of its string, so the key order the listing walks is UTF-8 order. This is a KEY-LAYOUT change: `SCHEMA_VERSION` is 2, and a database written by an earlier version is DISCARDED at the version change (every object store recreated empty, `KEY_LAYOUT_SINCE`) and must be refolded; it is never read in the old order. Records still carry the id columns as plain strings in `values`. `openDatabase`'s `upgrade` callback now also receives the old version.
- `@etherfold/state-store-conformance`: the `idOrder` option and the `DeclaredIdOrder` type are removed; the `bounded id-prefix listing` cases assert UTF-8 order for every backend, and a new case asserts that `MutationContext.list` cut by its limit inside a block keeps UTF-8's first rows.
- `@etherfold/state-store-patch`, `@etherfold/state-store-sqlite`: no source change; the patch store's listing and both stores' in-block listings follow `compareIds`.
