---
title: 'Reaping a stream subtree leaves its `_stream_coverage` claim behind, so an emptied stream reads as a complete one'
kind: observation
noticedBy: drive-tasks conductor (Gate-3, between PR #71/#72/#73 and the tasks that consume them)
relates: [the-generation-registry-is-durable-on-sql, the-stored-emission-stream-is-a-stream-a-successor-can-refold, the-rebuild-replays-the-local-stream-in-bounded-chunks, a-changed-context-creates-a-successor-instead-of-clearing]
---

## What was noticed

`GenerationRegistryPort.dropStreamSubtree` on the SQL substrate (`packages/server/src/generations.ts`) deletes from `_emissions` and from nothing else:

```sql
SELECT COUNT(*) AS records FROM _emissions WHERE indexer = ?1 AND stream = ?2
DELETE                     FROM _emissions WHERE indexer = ?1 AND stream = ?2
```

Since PR #73 a stream has a SECOND durable artifact under the same `(indexer, stream)` key: its coverage claim in `_stream_coverage`. Reaping does not touch it, so a swept or reaped stream leaves an orphan claim behind.

This is a SEAM defect rather than a mistake in either task. `dropStreamSubtree` was written in `the-generation-registry-is-durable-on-sql` when `_emissions` was the only place a stream physically lived, and `_stream_coverage` arrived one task later in `the-stored-emission-stream-is-a-stream-a-successor-can-refold`, whose scope fence confined its writer change to the coverage row inside the existing append batch. Neither task owned the join. Both are correct on their own terms and the gap is between them.

## Why it matters

Presence is deliberately the CLAIM and never "there are rows" (ADR-0035, restated in `streamReader.ts`), so that a stream which has been scanned and found nothing is PRESENT with no rows rather than absent. That rule is right, and it is exactly what makes the orphan dangerous. After a reap, `storedEmissionStream(...).fetchFrom(source, fromBlock)` on the same digest:

1. reads the surviving claim, so the stream is PRESENT;
2. passes the `startBlock > fromBlock` refusal, because the stale `startBlock` is the ORIGINAL one and is at or below what is asked for;
3. reads zero rows, because they were reaped;
4. returns `{eventStream: [], lastSync: {lastToBlock: <the old tip>}}`.

A generation folding that is told, with no error anywhere, that it has re-folded the entire history and may resume at the old tip. Its state is EMPTY. That is the whole-history version of the hazard the `startBlock` check was added to prevent: silent, permanent and self-consistent, and it survives a reload because the claim is durable. It is a HOLE in `CONTEXT.md`'s sense, produced by a delete rather than by a missed write.

The re-registration path compounds it. `startBlock` is deliberately absent from the coverage upsert's `DO UPDATE` list ("written once and never updated"), so if the same digest is folded again after a reap, the stale `startBlock` persists and the claim asserts a reach back to a block whose rows no longer exist.

## Why it is not biting yet, and when it will

Nothing constructs `storedEmissionStream` in production today; it is a reader waiting for a consumer. The reap paths are live, though, and there are three:

- the unregistered-subtree sweep on every `openGenerationRegistry` (`registry.ts`, the `swept` list),
- dropping the LAST generation on a stream,
- `deleteStream`.

`the-generation-registry-is-durable-on-sql`'s Decision 8 already flags that the FIRST registry open on a pre-generation database sweeps its stored stream, because today's `run`/`index` register no generation. With #73 landed, that same first open now also leaves an orphan claim. So the two consuming tasks — `a-changed-context-creates-a-successor-instead-of-clearing`, which opens the registry before it can create anything, and `the-rebuild-replays-the-local-stream-in-bounded-chunks`, which is the reader's first real consumer — are the ones that will step on it.

## What would close it

Almost certainly one statement: add `DELETE FROM _stream_coverage WHERE indexer = ?1 AND stream = ?2` to the same `batch()` as the emissions delete, so the claim and the rows it covers are reaped together exactly as they are written together. A test in the shape of the existing reap cases — reap a stream, then assert `readStreamCoverage` is `undefined` and that the reader reports ABSENT rather than an empty-but-complete stream — would pin it.

Worth deciding as part of that: whether the coverage row should be reaped by the SUBSTRATE (it owns both tables, and "written in one batch, deleted in one batch" is a tidy symmetry) or whether `dropStreamSubtree`'s contract should say a stream's whole physical footprint goes, so a future substrate cannot forget a third table the same way this one forgot the second.

## Not fixed here

Captured rather than fixed, per the conductor's capture-don't-fix-in-place rule: it is outside the scope of the three tasks that produced it, and closing it is a small deliberate change with a schema-adjacent contract question attached, which is a task's decision and not a review's.
