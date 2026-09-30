---
'@etherfold/graphql': minor
'@etherfold/state-store': patch
'@etherfold/processor-entities': patch
'@etherfold/browser': patch
---

Follow-ups from reviewing the snapshot, tab-election and hash-pinning changes.

- `@etherfold/graphql`: `QueryContext.blocks` is now REQUIRED (as `asOf` is), so `extensions.blockHash` is always present, `null` exactly when `block` is. New `queryBlocksOf(store)` builds the member from a store with the query reads.
- `@etherfold/state-store`: `readSnapshot` refuses a download that fails within its first two bytes with `SnapshotFormatError`, as it refuses one that fails later in the head, and cancels that download.
- `@etherfold/processor-entities`: an `onBootstrap` callback that throws no longer stops `stateFactoriesFrom`'s writer from claiming the store; the JSDoc says a reader opened through it runs the backend's migration.
- `@etherfold/browser`: the `openState` example points at `stateFactoriesFrom`.
