---
date: 2026-09-27
---

# A stream seed taken from a stored stream that saw a reorg is refused as incoherent

Seen while attempting `publish-writes-the-stream-seed-when-asked`. ADR-0065 and `incoherenceOf` (`packages/core/src/stream/seedInstall.ts`) admit retractions in a seed declaring the producer kind `stored-stream`, so a server's append-only `_emissions` stream is meant to be seedable verbatim. The same pass refuses a seed that carries two block hashes at one height, and the ordinary reorg in a stored stream is exactly that: an application at block N on the losing branch, its retraction, and the replacement at block N on the winning branch. So every stored stream holding an uncompacted reorg produces a seed the install rejects as `incoherent`, which makes the retraction allowance unreachable in practice. A producer can avoid it by dropping matched apply/retract pairs (what pair-compaction would leave, ADR-0006), but the two rules as written contradict each other.
