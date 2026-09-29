---
title: 'The bounded listing states one id order, and every backend keeps it'
slug: the-listings-id-order-is-decided
blockedBy: [a-conformance-case-shows-the-listings-id-order-per-backend]
covers: []
---

<!-- open-questions -->

## Open questions

1. Should the bounded id-prefix listing promise UTF-8 byte order (code-point order) on every backend, or should ADR-0021 state that id order is guaranteed only for ASCII ids? The evidence is `docs/spikes/the-listings-id-order-per-backend/README.md` (from `a-conformance-case-shows-the-listings-id-order-per-backend`). Background: memory, patch and IndexedDB list ids in UTF-16 code-unit order, SQLite in UTF-8 byte order, and the accessor seam already promises UTF-8 for text (ADR-0099). They differ only for ids that mix a character above U+FFFF with one in U+E000 to U+FFFF. Ids come from event arguments (addresses, hashes, decimals), so it may never bite in practice.
   - **UTF-8 everywhere**: `compareIds` (memory, patch, and the read-your-writes merge in `MutationContext.list`) compares by code point, and IndexedDB needs an encoded key for id columns (a byte encoding of each id string), which changes its key layout and so needs a package-level `versionchange` and a migration of existing databases. One order on every backend, matching the accessor; the cost is the IndexedDB key change.
   - **ASCII only**: ADR-0021 says the order of ids outside ASCII is backend-defined, and nothing changes in code; the conformance case keeps asserting each backend's declared order. Cheap; the cost is a documented difference between a server and a browser, which ADR-0098 treats as the failure to avoid for semantic types.
   - Ordering with `an-indexeddb-index-serves-the-accessor`: the UTF-8 answer changes IndexedDB's key layout with a package-level `versionchange` in `keys.ts`, and that task adds another. If you answer UTF-8, say which lands first so a `blockedBy` can serialise them.
   - If the evidence shows `MutationContext.list` on SQLite cuts a different SET of rows at the limit inside a block (not only a different order), note that the ASCII-only answer leaves that inconsistency within ONE backend, and say whether the merge should at least sort in its store's own order.

<!-- /open-questions -->

## Answers (maintainer, 2026-09-29)

1. **UTF-8 everywhere.** One order on every backend, matching the accessor; the cost is accepted as paying for the future (ids are ASCII today).
   - **No migration of existing databases.** There are no users yet: the IndexedDB key-layout change bumps the package-level version, and a database written with the old layout may be DISCARDED and rebuilt at the `versionchange` (its stores recreated, the state refolded) rather than upgraded row by row. It must never be READ with the old layout under the new code: an old database opened by the new code comes back empty in the new layout, never mis-ordered.
   - **Readable ids stay.** The id columns become byte keys, which devtools shows as opaque. Each record already carries the id columns as plain strings in `values` (`completeRow`), so the readable form is kept there: do not drop it, and say so in the key-layout comment in `keys.ts`.
   - **This lands before `an-indexeddb-index-serves-the-accessor`,** which is now blocked by this task, so the index is built once, on the new key layout.
   - With UTF-8 everywhere, the merge in `MutationContext.list` sorts in the same order as every store, so the SQLite in-block SET difference the evidence found goes away: assert that in `state-store-sqlite/test/listing-id-order.test.ts`, which pins the current cut and must change.


## What to build

Built only once the question above is answered; this section is written for either answer, and the builder follows the one given.

- **If UTF-8 everywhere**: `compareIds` orders by code point (UTF-8 byte order); the IndexedDB backend encodes id columns so its key order is UTF-8 byte order, with the `versionchange` (discard and rebuild, per the answers above) (`keys.ts` is where key layout is sanctioned); every backend's declared id order in the conformance case from `a-conformance-case-shows-the-listings-id-order-per-backend` becomes the UTF-8 default (the option's per-backend overrides are removed) and the case passes on every backend and on the three real engines; ADR-0021's "Ordering is lexicographic over the stringified id" consequence is amended to say UTF-8 byte order.
- **If ASCII only**: ADR-0021's ordering consequence is amended to say that the order is guaranteed for ASCII ids and backend-defined beyond, naming the divergence and the evidence; the conformance case's per-backend declared orders stay and its comment cites the amendment; the listing's doc comments (`compareIds`, `MutationContext.list`, the store seam's `listCurrent` / `listAsOf`) say the same.

## Acceptance criteria

- [ ] ADR-0021 states the chosen order, dated, with the evidence cited.
- [ ] For UTF-8 everywhere: the conformance case passes with no per-backend order override on memory, patch, SQLite and IndexedDB, and in the real-browser suite on Chromium, Firefox and WebKit; an IndexedDB database written with the old layout, opened by the new code, is recreated empty in the new layout and never read in the old order (a test opens one written with the old layout).
- [ ] For ASCII only: the doc comments and ADR-0021 agree, and the conformance case still records each backend's order.
- [ ] Changesets for every published package changed (patch or minor, never major; an IndexedDB key-layout change is at least minor).
- [ ] CI: dorfl's `verify` gate runs vitest only, so the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done.

## Blocked by

- `a-conformance-case-shows-the-listings-id-order-per-backend`

## Prompt

> Goal: one stated id order for the bounded listing (ADR-0021), as the maintainer answered the open question above. Read the evidence in `docs/spikes/the-listings-id-order-per-backend/README.md`, ADR-0021, ADR-0099's text-order rule and ADR-0098's one-change rule, then look at `compareIds` and `MutationContext.list` in `@etherfold/state-store`, the patch store's listing, IndexedDB's `keys.ts` and listing, and the conformance case the blocking task added.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Check that the open question is answered in this file (if `needsAnswers` is still set, do not build), that the blocking task landed with the evidence, and that the answer still fits it. If not, route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.
>
> CI: dorfl's gate runs vitest only. The real-browser suites run in CI's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs; the PR is done only when those three are green too.

## Decisions

- **The discard covers every object store, the writer claim and cursors included.** The answer said the old database may be discarded and "its stores recreated". Keeping the cursors or the writer token next to an empty state would describe a state that no longer exists. The alternative was to discard only `current`, `versions` and `blocks`. This touches only `upgrade` in `store.ts`.
- **A new `KEY_LAYOUT_SINCE` constant, separate from `SCHEMA_VERSION`.** A future new object store should keep the existing "just create what's missing" upgrade and not discard data. Only a key-layout change should raise this constant. The alternative was to discard whenever the stored version is lower than `SCHEMA_VERSION`, which would wipe databases on every future bump. I rewrote the `SCHEMA_VERSION` comment ("stays 1 until published") to say this, following the maintainer's instruction to bump the version.
- **I removed the conformance `idOrder` option entirely, not just its per-backend values.** With one stated order, a per-read declaration has nothing left to do, and the conventions say to delete rather than deprecate. I kept `IdOrder` and `ID_ORDER_SEQUENCES['utf-16']` so a failing case can say it got UTF-16 order. The change reaches every backend's conformance test and the browser spec.
- **`compareUtf8` moved into `@etherfold/state-store` and is exported.** The listing and the accessor now share one comparator instead of two copies of the same logic. The alternative was a private copy inside `compareIds`. It is a new public name in `state-store`, and the IndexedDB accessor now imports it.
- **`openDatabase`'s `upgrade` callback gets a third argument, `oldVersion`.** The discard needs it. Existing callers are unaffected.
