---
'@etherfold/browser': patch
---

The tab-bundle canary in `bundlesForABrowser.test.ts` now detects `createQuerySurface`'s SQL query tier by its implementation (no `@etherfold/state-store-sqlite` module contributes bytes to the bundle, and nothing defines or calls `queryCurrent` or `queryAsOf`) rather than by the bare method names, which every tab now legitimately carries in `@etherfold/state-store`'s reserved read-surface names. Test-only change.
