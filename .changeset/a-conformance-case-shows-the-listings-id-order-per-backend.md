---
'@etherfold/state-store-conformance': minor
'@etherfold/state-store-sqlite': patch
'@etherfold/state-store-indexeddb': patch
'@etherfold/state-store-patch': patch
---

The conformance suite records which string order each backend's bounded id-prefix listing ascends in (ADR-0021 does not yet say). New option `StateStoreConformanceOptions.idOrder` (`DeclaredIdOrder`: `listCurrent`, `listAsOf`, `mutationContextList`, each an `IdOrder` of `'utf-8'` or `'utf-16'`, defaulting to `'utf-8'`, the accessor's text order from ADR-0099), and three new cases in the `bounded id-prefix listing` group that assert the declared order positively over ids straddling the UTF-8 / UTF-16 boundary (`ID_ORDER_SAMPLE`, `ID_ORDER_SEQUENCES`, both exported). A backend that registers without `idOrder` and lists in UTF-16 code units now fails those cases, so declare the order it uses. No backend's order changes: memory, patch and IndexedDB declare UTF-16 on every read; SQLite declares UTF-8 for `listCurrent` and `listAsOf` and UTF-16 for `MutationContext.list`, whose merge re-sorts with `compareIds`. The SQLite package also measures what that merge keeps when the limit cuts a listing inside a block, and the IndexedDB browser suite asserts the order on Chromium, Firefox and WebKit. Evidence: `docs/spikes/the-listings-id-order-per-backend/README.md`.
