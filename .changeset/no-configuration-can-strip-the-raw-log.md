---
'@etherfold/core': major
---

**BREAKING: the `parse.logValues` knob is DELETED.** No configuration can strip the raw log out of what is stored or sent any more, and the guarantee is STRUCTURAL rather than stated.

It was never a decoding option: its type was an allowlist over the RAW log's own fields (`address`, `topics`, `data`, `blockNumber`…), and `LogEventFetcher.parse` applied it by keeping `args` UNCONDITIONALLY while dropping every raw field not named — preserving the DERIVATION and discarding the SOURCE. That is backwards for a stream that stores what the node said: an event whose raw half was projected away has nothing left to decode from, which is exactly what makes a cached stream unreadable on replay (ADR-0034). It was also an unfinished stub with zero callers and a live footgun, since the loop iterated the object's KEYS and never read the boolean, so `{topics: false}` KEPT `topics`.

Gone with it: the `logValues` field on `LogParseConfig`, the `LogValuesFlags` type and the `OptionsFlags` helper it was built from, and the projection branch in `parse`. Every parsed event now carries the whole raw log the node reported. Nothing is published, so this costs a changeset and no migration; the stream-config digest is NOT narrowed, because `parse` belongs to it on the strength of `parseConfig.filters`.

**The detect-and-clear guard SURVIVES.** `LogEventFetcher.reparse` still answers `undefined` for an event with no raw log to decode, and the indexer's load path still CLEARS such a stream rather than replaying it on trust. It is simply unreachable for anything written from here on: what it now guards is a stream ALREADY ON DISK, written by an older version whose parse config could project `topics` or `data` away. Both halves are pinned by `packages/core/test/rawLogIsNeverStripped.test.ts`.
