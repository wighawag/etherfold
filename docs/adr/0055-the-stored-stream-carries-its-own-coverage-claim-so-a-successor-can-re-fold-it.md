# The stored stream carries its own COVERAGE CLAIM, so a successor can re-fold it

The point of storing the emission stream (ADR-0006, ADR-0052) is that a processor-only upgrade rebuilds from local disk instead of from the chain: a successor that shares a STREAM with the incumbent fetches nothing and re-folds what is already there (ADR-0044). Making that possible needs one thing the rows themselves cannot supply — HOW FAR the stream reaches — because a range that carried no logs moves the fetch cursor without adding a row.

We decided that **the stream carries its own coverage claim, stored once beside it and written in the SAME `batch()` as the emissions**: a `_stream_coverage` row per `(indexer, stream)` holding the three block numbers plus the stream's identity (`SCHEMA_VERSION` 4). `@etherfold/server` then exposes `storedEmissionStream(db, indexer)`, an `ExistingStream` over `_emissions` wrapped in `readOnlyStream`, so a generation folds the stored stream and cannot write to it.

Two consequences of that one decision are load-bearing and are recorded below: the appender is now called on **every** batch, including the ones that emitted nothing; and the claim is keyed on the STREAM rather than on a generation's fold.

## Why coverage is STORED and not DERIVED from the rows

The obvious reading — "the rows are the stream, so ask the rows" — is wrong in a way that is quiet for as long as the chain is busy and permanent afterwards.

`MAX(blockNumber)` is the highest block that carried a LOG. The fetch cursor is the highest block that was SCANNED. Those differ by however many quiet blocks the deployment last saw, which on a real contract is routinely thousands (`CONTEXT.md` records a median of 429 blocks between event-bearing blocks on the measured stream, and long quiet stretches are ordinary). A stream whose coverage is derived from its rows therefore UNDER-CLAIMS, and two things go wrong:

- a successor re-folding it sits permanently behind the incumbent, so a promotion policy of `on-catch-up` never fires;
- worse, at promotion the canonical generation must present a correct `expectedFromBlock` (ADR-0004, receiver-authoritative). Told a number too far back, the fetcher re-sends ranges that were already folded — and under ADR-0052 the receiver APPENDS whatever it concludes, so the re-sent batches become DUPLICATE ROWS. A derived cursor turns a promotion into stream corruption.

Counting `seq` does not close it either. `seq` answers "have I consumed everything in this stream" exactly, and it is the right CATCH-UP predicate (a follower is caught up when it has folded through `readStreamHighWaterMark`). It simply cannot answer the WIRE, which is asked in block numbers.

## Why the appender is now called on an EMPTY batch

It was not, and the reasoning recorded at the time was "a cycle that emitted no logs still advances the cursor, and there is nothing about it for a stream to hold". Once the write carries coverage there is exactly one thing for it to hold, and the empty cycle is the only place that thing can come from — skipping it reproduces the derived-cursor defect above with extra steps. So `StreamBuilder.storeStream` hands over every batch and `appendEmissions` writes the claim with no rows beside it.

This is not a new shape. It is what ADR-0035's contract already requires of a keeper — "an empty save costs nothing proportional to the history", satisfied there by `writeCursorOnly` — arriving on the SQL substrate. The cost is one small upsert per cycle, and no read: the `seq` high-water mark is only asked for when there is something to number.

What it does change is the blast radius of a store that cannot be written: the append refuses the batch (ADR-0052, deliberately not best-effort), and that now applies to quiet cycles too. That is the correct direction. A fold that cannot record how far it got must not advance past it, which is the same rule stated for a fold that cannot record what it emitted.

## Why the claim is keyed on the STREAM and not on a generation

Several generations fold ONE stream and only the writer appends to it (`CONTEXT.md`, **follower**). A per-generation coverage record would have to be reconciled at every promotion and re-derived on every writer succession, and two generations could disagree about a fact neither of them owns. Stored once beside the stream, every generation folding it inherits the same claim; promotion hands over a correct wire cursor with nothing to merge; and deleting the writer (which hands the append duty to the next-oldest generation) leaves the row untouched.

For the same reason there is no `processor` column, exactly as there is none on `_emissions`: a stream is identified by its fetch filter plus its stream config and by nothing else. The claim stores the FETCH-filter half of a `ContextIdentifier` (`source` and `config`) and nothing more, which is precisely what `sourceInvalidationOf`'s stream verdict reads.

**The ADR-0052 asymmetry is stated rather than assumed away**: coverage moves with the APPEND, which is ordered BEFORE the fold, so it may sit ONE BATCH AHEAD of every generation's state. That is the allowed direction (ADR-0038: a stream may be ahead of the state, never behind), and it is the same one the emissions themselves already have.

## Why the reader does not ride `createSegmentedStream`

Segments exist because the IndexedDB keeper needs a save to cost its batch on a substrate with no sequence of its own. SQL has one: `_emissions` is already `seq`-addressed, with a validated opaque cursor codec above it. Riding the segment helper would add ordinals to allocate, a contiguity rule, and a whole damage class — a GAP — that this substrate cannot exhibit. What IS inherited is ADR-0035's CONTRACT rather than its layout, which is what that ADR says the contract is for: one authoritative claim per stream, a claim that can never cover events the store lacks (one `batch()`), and an empty save that costs nothing proportional to the history.

Note the words: a **hole** in `seq` is legal (pair-compaction leaves them and never renumbers), a **gap** in segment ordinals is damage. They are not synonyms and this reader has only the first.

## Considered options

- **Derive coverage from `MAX(blockNumber)`.** Rejected above: it under-claims over quiet ranges, so `on-catch-up` never fires and a promotion re-sends batches that are appended twice.
- **Use `seq` alone, with no block-level claim.** Rejected as insufficient rather than wrong. It is the right catch-up predicate and is used as one; it cannot produce an `expectedFromBlock`, and a generation that cannot present one cannot be promoted safely.
- **Put the claim on `_emissions` as columns of the last row.** Rejected: the table is APPEND-ONLY except for the `alive` flag, so this would introduce a second mutable column, make "the latest row" a thing every read has to find, and leave a stream with no rows — the ordinary state of a deployment whose contracts have not emitted yet — unable to hold a claim at all.
- **Read the claim off the generation's own sync cursor (`_cursor`, ADR-0027).** Rejected: that is the STATE's cursor, per generation and inside a generation's table namespace (ADR-0053), and it says how far a PROCESSOR got rather than how far the STREAM reaches. Using it would make the stream's coverage a function of whichever fold was asked, which is exactly what "coverage is a property of the stream" denies.
- **Call the row `_stream_cursor`.** Rejected on vocabulary. `_cursor` already exists in the same database meaning the state store's opaque sync cursor, so a second `_..._cursor` one table away holding a different thing is the one-word-two-meanings hazard the reserved `_` namespace exists to prevent. COVERAGE is already the word `CONTEXT.md` uses for what a cursor asserts ("a cursor is a coverage claim, not a timestamp per event").
- **Have the reader CLEAR what it cannot use, as the segment keeper does.** Rejected, and this is the sharpest difference between the two. The segment keeper OWNS its stream; this view does not, and the generation that does is still appending to it. So every shape this reader cannot serve — no claim, a history that does not reach back to the block asked for, an unreadable substrate — is reported ABSENT and nothing is deleted.

## Consequences

- **`SCHEMA_VERSION` is 4** and `db.sql` creates `_stream_coverage` with `IF NOT EXISTS`. A version-3 database gains the table EMPTY, so each of its streams reads as ABSENT until its writer appends the next batch, at which point the claim is written and the stream becomes re-foldable. Nothing already stored is touched or lost, and the `startBlock` a re-created claim records is the first block of that next batch rather than of the true history — which the reader then honestly refuses to serve from below.
- **`EmissionWrite` carries `coverage`**, so every host that supplies an appender supplies it. There is only one such implementation (`emissionAppenderFor`), because the write belongs to the package that owns the table.
- **PRESENCE is the claim and never "there are rows"**, which decides both directions: a stream scanned and found empty is PRESENT with no rows (reporting absent would re-scan from the start block on every reload), and rows with no claim are not a stream anything may fold, because they cannot say what filter produced them.
- **The reader is wrapped in `degradingStream` as well as `readOnlyStream`.** The load path calls `fetchFrom` with no `try`/`catch` above it, so a database error here would make a generation permanently unloadable rather than merely un-followed.
