---
'@etherfold/graphql': minor
'@etherfold/state-store': minor
'@etherfold/state-store-indexeddb': minor
'@etherfold/state-store-sqlite': minor
'@etherfold/server': minor
---

A GraphQL query can be pinned to a block HASH, every answer names its block's hash, and no answer mixes two branches (ADR-0099, amended 2026-09-30).

- `@etherfold/graphql`: a root field's `block` is now a `@oneOf` input `BlockAddress {number: SafeInt, hash: Bytes32}` (breaking: `block: 10` becomes `block: {number: 10}`). `extensions` gains `blockHash` beside `block`. An unrecorded hash is refused with the new code `block-not-recorded`, which never claims a reorg. `QueryContext` gains `blocks: {at, of, revertSequence}`, and every operation reads the store's revert sequence before its pin and after its last field, so a reorg away from the pinned block and back (A, B, A) during one operation is retried, then refused, rather than answered from two branches. `graphqlQueryHandler` now requires `blockAt`, `blockOf` and `revertSequence` on the store it reads. New `Bytes32` scalar.
- `@etherfold/state-store`: the seam's closed record union gains `revertSequence` (ADR-0080, amended). The claimed handle (`openForWriting`) and the snapshot-aware handle forward `tip`, `blockAt`, `blockOf` and `revertSequence` by feature detection. New `QueryReads` type.
- `@etherfold/state-store-indexeddb` and `@etherfold/state-store-sqlite`: new `blockAt(number)`, `blockOf(hash)` (normalised as on write) and `revertSequence()`, a persisted count incremented in the same transaction as every `revertTo`. SQLite gains a public `tip()`.
- `@etherfold/server`: `/graphql` answers with `blockHash` and resolves `block: {hash}`, and its reorg guard reads the revert sequence.
