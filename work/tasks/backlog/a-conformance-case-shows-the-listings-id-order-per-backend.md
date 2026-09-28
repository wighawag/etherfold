---
title: 'A conformance case shows which id order each backend''s listing uses, so the order question is decided on evidence'
slug: a-conformance-case-shows-the-listings-id-order-per-backend
blockedBy: []
covers: []
---

## What to build

EVIDENCE for a decision the maintainer has not made yet (`the-listings-id-order-is-decided`). The bounded id-prefix listing (ADR-0021: "ascending in that id's own order", "lexicographic over the stringified id") does not say WHICH string order, and the backends disagree. `compareIds` in `@etherfold/state-store` (`listing.ts`) compares with JavaScript's `<`, which is UTF-16 code-unit order, and the memory and patch backends sort a listing by it; IndexedDB compares string keys by UTF-16 code units too; SQLite walks its TEXT id index in BINARY order, which is UTF-8 byte order (code-point order). The accessor seam, meanwhile, fixes text order as UTF-8 bytes on every backend (ADR-0099). The two orders differ only when an id mixes a supplementary-plane character (above U+FFFF, a surrogate pair in UTF-16) with a character in U+E000 to U+FFFF: UTF-16 sorts the supplementary character first (its high surrogate, U+D800 to U+DBFF, is below U+E000), while UTF-8 bytes sort the U+E000 to U+FFFF character first.

There is a second place this may bite that is not only ordering: `MutationContext.list` (`mutation-context.ts`, the read-your-writes merge) asks the store for `limit + staged` rows in the STORE's order and then re-sorts the merge with `compareIds`, so on SQLite a listing inside a block may be sorted in a different order from the one outside it, and may even cut a different set of rows at `limit`. Whether it does is part of the evidence.

Add a case to `@etherfold/state-store-conformance` that writes ids straddling the boundary (for example `'\u{1F600}'`, `'\uE000'`, `'\uFFFD'`, `'a'`) under one prefix and asserts the order the listing ascends in, for `listCurrent`, `listAsOf` (where claimed) and `MutationContext.list` with some of those ids staged in the current block. The expected order is DECLARED per backend AND per read, through a new option in `StateStoreConformanceOptions` (for example `idOrder: {listCurrent: 'utf-16', listAsOf: 'utf-16', mutationContextList: 'utf-16'}`, defaulting to UTF-8 byte order, the order the accessor promises), and the case asserts that exact sequence POSITIVELY. Per read, not per backend, because one backend can disagree with itself (SQLite's `listCurrent` walks its index in UTF-8 order while `MutationContext.list` re-sorts in UTF-16). Not `it.fails`, which would also pass on a setup error; a positive assertion turns red the moment any order changes, in either direction. The declared-order assertions use a limit that covers every id written, so they measure ORDER only; what `MutationContext.list` returns when the limit CUTS the listing (a set that may be neither order's first rows, since it fetches in the store's order and re-sorts in UTF-16) is measured separately as evidence for the README, not asserted as a conformance order. Measure the real engines too: IndexedDB's order on Chromium, Firefox and WebKit, from the real-browser suite in `packages/state-store-indexeddb/browser/`, since `fake-indexeddb` only models the specification.

## Acceptance criteria

- [ ] The conformance case exists and runs on memory, patch, SQLite and IndexedDB (`fake-indexeddb`); each backend's registration declares, per read, the order it actually uses, the case asserts that order positively, and no case is skipped or registered as an expected failure.
- [ ] The `MutationContext.list` case with staged ids is included, and the evidence says whether SQLite inside a block returns a different ORDER only, or also a different SET of rows at the limit.
- [ ] The real-browser IndexedDB suite asserts the order each engine uses, on Chromium, Firefox and WebKit.
- [ ] `docs/spikes/the-listings-id-order-per-backend/README.md` tabulates, per backend and per read (`listCurrent`, `listAsOf`, `MutationContext.list`, the accessor's text `orderBy` for comparison), the order observed, with the ids used, so `the-listings-id-order-is-decided` can cite it.
- [ ] No backend's order is changed in this task.
- [ ] Changesets: `@etherfold/state-store-conformance` (minor, a new case and option), plus every other published package whose directory changes, tests included (patch or minor, never major).
- [ ] CI: dorfl's `verify` gate runs vitest only, so the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done (the real-engine order is asserted only there).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: evidence, per backend, of the id order the bounded listing uses, so the maintainer can decide between "UTF-8 everywhere" and "only ASCII ids are ordered" (ADR-0021, ADR-0099). Look at `compareIds` and the listing helpers in `@etherfold/state-store` (`listing.ts`, `memory.ts`, `mutation-context.ts`), the patch store's listing, SQLite's listing statements (`statements.ts`), IndexedDB's key encoding (`keys.ts`) and listing, the conformance suite's `bounded-listing` cases and `StateStoreConformanceOptions`, and the real-browser suite in `packages/state-store-indexeddb/browser/`. The accessor's UTF-8 text ordering (`@etherfold/accessor`, and the IndexedDB accessor's in-memory sort) is the comparison point.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Check that `compareIds` still uses `<` and that SQLite's id index is still BINARY. If a backend already changed its order, record that in the evidence rather than assuming the description above (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> Do not choose the answer and do not change any backend's order: that is `the-listings-id-order-is-decided`, which waits for the maintainer.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files.
>
> CI: dorfl's gate runs vitest only. The real-browser suites run in CI's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs; the PR is done only when those three are green too.
