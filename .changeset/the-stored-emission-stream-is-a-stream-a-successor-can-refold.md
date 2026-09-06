---
'@etherfold/server': minor
---

The stored emission stream is now a STREAM a generation can re-fold: `storedEmissionStream(db, indexer)` is an `ExistingStream` over `_emissions`, so a processor-only upgrade rebuilds from local disk with zero `eth_getLogs` and zero writes to the stream.

That is what ADR-0006's table was for. A successor sharing a STREAM with the incumbent is a follower (ADR-0044): it fetches nothing and re-folds what is already stored. Until now nothing on this runtime could hand a generation that stream.

```ts
const generation = new IndexerGeneration(provider, processor, source, {
  stream: {finality},
  keepStream: storedEmissionStream(db, indexerName),
});
await generation.load(); // the load IS the rebuild
```

**Read-only, structurally.** It goes out through `readOnlyStream`, so `saveNewEvents` and `clear` are NO-OPS. That is the one-writer rule made structural rather than conventional: only the generation that INDEXES a stream appends to it (through `EmissionAppender`, ADR-0052), and everything else folding it is handed a view whose writes go nowhere. `clear` matters more than symmetry suggests — the load path clears on every stream shape it cannot use, and a re-fold takes those branches over a table another generation is still appending to.

**A replay, not a fetch (ADR-0042).** Retractions are delivered INCLUDED, at their original block, in `seq` order; `alive` is never consulted (that is the canonical view's rule, and applying it here would hide exactly the reorgs a re-fold has to replay); holes in `seq` are tolerated and nothing is renumbered. It deliberately does not ride `createSegmentedStream`: SQL already has a sequence, so segmentation would add ordinals, a contiguity rule and a damage class this substrate cannot exhibit.

**A new fixed table, `_stream_coverage`, and `SCHEMA_VERSION` 4.** The rows cannot say how far a stream reaches, because a range that carried no logs moves the fetch cursor without adding one — so the claim is stored beside the stream, one row per `(indexer, stream)`, written in the SAME `batch()` as the emissions it covers. It is keyed on the STREAM and not on a generation, so every generation folding it inherits the same claim and a promotion needs no reconciliation. It carries no `processor` column, exactly as `_emissions` carries none. Read it with `readStreamCoverage`. See ADR-0055.

`IF NOT EXISTS`, so a version-3 database gains the table EMPTY: each of its streams reads as ABSENT until its writer appends the next batch. Nothing already stored is touched.

**PRESENCE is the claim and never "there are rows."** A stream that has been scanned and found nothing is PRESENT with an empty event list — reporting absent would re-scan from the start block on every reload. Rows with no claim are the opposite and are reported ABSENT, because they cannot say what filter produced them or how far they reach. A stream that does not reach back to the block asked for is reported absent too, and NOTHING is deleted in response: unlike the segment keeper's identical check, this view owns none of these rows.
