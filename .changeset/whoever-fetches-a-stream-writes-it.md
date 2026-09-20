---
'@etherfold/core': minor
'@etherfold/server': minor
'@etherfold/browser': patch
'etherfold': minor
---

**Whoever FETCHES a stream is the thing that appends to it, and a stream outlives every fold over it** (ADR-0087).

**The write duty and the FETCH come off the generation.** A stored stream still has exactly ONE writer, and on the receiving side it is now the DEPLOYMENT rather than one generation per stream. `StreamWriter` (`@etherfold/core`) is that writer: one per stream a `ReceivingIndexer` holds a fold on, it is what a stream's address on the wire resolves to, and it is positioned from the STREAM's own coverage claim through the new `StreamCursorSource` port (`streamCursorSourceOn`, `@etherfold/server`). Every generation over that stream merely READS it.

This closes a measured data-loss defect. The elected writer was the OLDEST generation registered on a stream, which after a restart with changed bytes is a generation the process holds no fold for — so the duty belonged to something absent while a present fold folded happily, with no refusal and no warning. Handing the duty to the fold that IS present stores the history a second time (measured: 4 emission rows where 2 are correct), and no timing fixes it, because a reconciliation sees the fold BELOW the coverage and then ABOVE it and never ON it.

**A stream is never deleted because the last fold over it went away.** Every automatic reap is gone: registering into an occupied `successor` slot and drop-on-promotion both take the generation's row and its state namespace and leave the stream. `GenerationRegistry.deleteGeneration` takes `{reapStream}`, false by default, and the operator's `reclaim` is the one caller that asks; `deleteStream` is unchanged except that it now accepts a stream no generation folds, which is the ordinary state of a kept one. The registry keeps a durable record of the streams it holds (`keptStreams`, the `_generation_streams` table on SQL), so the SWEEP on open tells a kept stream from a pre-generation orphan and the keep survives a restart.

Breaking, and nothing depends on it:

- `writerOf` is renamed `fetcherOf` on the module and on `GenerationRegistry`. The derivation is unchanged (the oldest surviving generation on a stream); what changed is that it is an ANSWER to "which generation was this stream fetched for" and never permission to append.
- `HeldFold` loses `ingestion`, `writesStream` and `follows`, and its `rebuild` is required: a fold is ONE shape now. `ReceivingIndexer.writesStream` and `followers()` are gone, `ingestion` answers the stream's writer, and `ReceivingIndexerOptions` takes `streamCursor` beside `appendEmissions` and `replay` — a container missing any of the three is refused at `open` rather than folding for ever on stale history.
- `LogIngestion.generation` is optional: a stream's address has no single fold behind it. `singleContextEntry` refuses a receiver that names none.
- `GenerationRegistryPort` implementations must carry `keptStreams` in their state and honour `keepStream` / `forgetStreams` in a write.
- `DeclinedReclaim` loses `writes-a-followed-stream`. Under `dropOnPromotion` an ordinary upgrade now really does drop the superseded generation; the stream it fetched is kept.

Two fixes that ride with it:

- **The append-only path gains the hole guard** ADR-0087 first credited to `IndexerGeneration.streamCanReceive` and its own amendment moved (`StreamHoleError`). It is permissive where no stream is stored, which is the documented absence of one and not an unknown position. `streamCanReceive` itself now refuses on an unknown STATE position (`!lastSync`, inert today) and stays permissive on an absent stream.
- **A catch-up replay no longer re-applies a branch it already retracted.** Window membership cannot tell "still held" from "held and taken back", so a fold reaching back over its own reorg window re-applied a dead block at a height its replacement occupies (measured: `UNIQUE constraint failed: _blocks.number`). A rebuild from a fresh cursor is untouched and still reproduces the live run exactly.
