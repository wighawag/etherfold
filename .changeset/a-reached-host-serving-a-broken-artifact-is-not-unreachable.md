---
'@etherfold/core': patch
'@etherfold/browser': patch
---

A stream seed whose body cannot be DECOMPRESSED is now refused `unreadable-format` rather than `unreachable`.

Both reasons were already in `NotInstalledReason`, so nothing about the type changes; what changes is which one a corrupt or truncated artifact produces. The fetch now stops at the transport and the inflate happens under its own refusal, because the two reasons send someone to different places: a host that answers `200` with a half-uploaded file has been REACHED, and calling that "could not reach it" points an operator at their network while the artifact is what is broken. `unreadable-format` already means "something was fetched and it is not a seed this build reads", which a body that will not inflate is. Failover is unaffected — either reason walks to the next location.

The `@etherfold/browser` entry is for tests only, with no runtime change: the snapshot-only mode's fixture now publishes a cursor whose observed tip is the finality depth above the snapshot's own block, and the client passes `finalityDepth`, so the consumer half of ADR-0028's two-sided defence is actually exercised. Previously the publisher reported the snapshot's own block as the tip it had seen — which is what indexing straight to the tip produces — and against that `insideReorgWindow` is true for any positive depth, so the guard could never have been on. A new case asserts a snapshot taken at its producer's tip is refused `inside-reorg-window` and installs nothing, and that the same document one finality depth deeper is admitted.
