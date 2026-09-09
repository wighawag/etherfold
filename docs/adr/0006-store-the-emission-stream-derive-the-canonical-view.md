# Store the emission stream, derive the canonical view

The indexer-server stores the **emission stream**: the append-only sequence the stream-builder already produces, retractions included, one row per emitted log with its own `seq`. A reorg appends the `removed` rows and flags the superseded originals as dead. Two views are then served over that one table: the full `seq`-ordered stream (retraction-aware, for real-time consumers) and a canonical view (`WHERE alive AND blockNumber <= gate`, ordered by `(blockNumber, logIndex)`, for consumers that never want to hear the word reorg). We chose to store the emission form because it is what the code already computes, so persisting it is zero derivation, while the canonical view is cheaply derived from it and not the reverse.

This is an addition to `work/specs/tasked/historical-state-database.md`, which scoped the log-processor to state queries only.

## Considered Options

- **Store only the canonical set** (delete reorged rows). Simplest storage and filter-free reads, but it destroys retraction information permanently, which makes cancel-before-fire consumers unbuildable rather than merely unexposed. Rejected: it trades away optionality irreversibly to save a flag column.
- **Store the emission stream and serve it unfiltered.** Forces every gated consumer to implement retraction handling. Rejected as the only option, kept as one of the two views.
- **Store both as separate tables.** Same reads, double the writes and storage, for no gain over a flag plus a partial index.

## Consequences

- Cost of keeping the information: one flag column, one partial index, one extra row per retracted log, and an `UPDATE` on the rare reorg path bounded by the reorged blocks' logs.
- **Cursors differ per view and must not be confused.** `(blockNumber, logIndex)` is not a cursor over the emission stream: it is not unique there (an event appears once applied and again retracted) and not monotonic (after a reorg the stream continues at lower block numbers). Conversely a synthetic sequence is wrong for the canonical view. Each view keeps its own.
- **The canonical view's cursor carries the block hash, and the server validates it**, answering "rewind to fork block F" when it is no longer canonical. Without this a consumer resuming at `(105, 3)` after a reorg is served the new branch from that key onward and silently never sees the new block 105's earlier logs. Validating the single block at the cursor is provably sufficient, because a reorg invalidates a contiguous suffix: if the cursor's hash is still canonical, the whole prefix behind it is too.
- **`seq` holes are legal by contract**, from day one. A cursor means "give me `seq` greater than mine", never "expect contiguity", so that enabling compaction later cannot break consumers that quietly assumed otherwise.
- **Pair-compaction is a config, off by default.** A dead original and its retraction are a matched pair with no net effect and may be dropped together once far below finality, which keeps a from-genesis replay consistent. It is off by default because it is irreversible and because the stream's completeness is what makes processor upgrades possible (ADR-0008). It remains safe for rebuilds when enabled, since an apply/retract pair has no net effect on a reducer whose revert is exact.
- The stream is keyed by `{source, config}` while the state is keyed by `{source, config, processor}`, which is the split `ContextIdentifier` (`packages/ethereum-indexer/src/types.ts`) already encodes. A processor-logic change therefore cannot invalidate the stream.
