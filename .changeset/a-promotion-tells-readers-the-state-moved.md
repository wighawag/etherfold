---
'@etherfold/core': minor
'@etherfold/browser': patch
'@etherfold/state-moved-conformance': minor
'@etherfold/server': patch
---

A promotion tells readers the state moved, even at a quiet tip (ADR-0083, amended).

`@etherfold/core`: the state-moved signal gains a third case, `StateRepointed` (`{kind: 'repointed', coherence, generation}`), published AT ONCE whenever the canonical pointer moves (a promotion, a policy move, or a move back), by both `Indexer` and `ReceivingIndexer`. It carries the rotated coherence token and the generation that answers from here on, and no block and no entity set. Before this, a pointer move rotated the token and published nothing, so on a chain with no next block a reader that re-reads on `onStateMoved` kept rendering the retired generation while reads answered the new one. The rotation still happens first, before the pointer-moved callback and the state notification; the announcement is made once the read path has followed the pointer, so a reader re-reading the instant it is told is answered by the generation it names. A block after the move carries the same token, so a reader invalidates everything once. A move onto the generation already answering announces nothing. `StateMovedPublisher.rotateForPointerMove(reason)` rotates and returns the announcer, so a pointer move published under an unrotated token is unexpressible. A reader's two-line rule is unchanged; code that switches exhaustively on `kind` gains a case.

`@etherfold/browser`: the cross-tab channel carries the new case (its message guard accepted `applied` and `retracted` only). The port and the SharedWorker host already carried the value unchanged.

`@etherfold/state-moved-conformance`: the `the coherence token` chapter now asserts that a promotion is ANNOUNCED with no block to wait for (a rotated token and the new generation, and exactly those fields), and that the block after it carries the same token.

`@etherfold/server`: tests only; the SSE endpoint carries the new case unchanged.
