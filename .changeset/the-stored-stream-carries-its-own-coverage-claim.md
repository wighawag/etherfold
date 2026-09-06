---
'@etherfold/core': minor
---

The emission-stream write port now carries the stream's COVERAGE CLAIM, and it is handed over on EVERY batch rather than only on the ones that emitted something.

`EmissionWrite` gains `coverage` (`StreamCoverage`): the FETCH-filter half of the identity these logs were fetched under, plus `latestBlock` / `lastFromBlock` / `lastToBlock`. It is the cursor record ADR-0035 says a keeper keeps beside its stream, in the shape that ADR ended up with — no unconfirmed window, because a keeper's copy of the window is read by nobody and a replay rebuilds it by walking the events.

**Why a store cannot derive it.** `MAX(blockNumber)` is the highest block that carried a LOG; the fetch cursor is the highest block that was SCANNED. A range that carried no logs moves the second and not the first, so a stream whose coverage is derived from its rows under-claims for as long as the chain is quiet. A successor re-folding it sits permanently behind the incumbent, and at promotion the canonical generation presents an `expectedFromBlock` too far back — whose re-sent batches ADR-0052 appends a SECOND time. See ADR-0055.

**Why the empty batch is no longer skipped.** `StreamBuilder` used to return early for a batch that emitted nothing, on the reasoning that "there is nothing about it for a stream to hold". There is exactly one thing, and the quiet cycle is the only place it can come from. So the appender is called with an empty `emissions` array and a moved `coverage`, which is the shape ADR-0035's empty save already has on the segment keeper (`writeCursorOnly`): one small write, nothing proportional to the history.

The visible edge of that: the append is deliberately not best-effort (ADR-0052), so a store that cannot be written now refuses a QUIET batch too. That is the correct direction — a fold that cannot record how far it got must not advance past it.
