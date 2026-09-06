---
title: 'The stored emission stream is a STREAM a successor can re-fold, read-only'
slug: the-stored-emission-stream-is-a-stream-a-successor-can-refold
spec: the-server-and-cli-hold-generations-too
blockedBy: []
covers: []
---

<!-- open-questions -->

## Open questions
1. ~~**What coverage does a reader over `_emissions` report?**~~ **ANSWERED: (a), a per-`(indexer,
   stream)` COVERAGE ROW written in the same `batch()` as the append — and the catch-up PREDICATE is
   `seq`, not blocks. They are complementary, not alternatives.**

   **(b) is ruled out on its own terms**: `MAX(blockNumber)` under-claims over ranges that carried no
   logs, so a successor sits permanently behind the incumbent and `on-catch-up` never fires.

   **(c) alone is not enough, and this is the part to get right.** `seq` answers "have I consumed
   everything" exactly, but it cannot answer the WIRE. At promotion the canonical generation must
   present a correct `expectedFromBlock` (ADR-0004, receiver-authoritative). A cursor derived from
   stored rows alone under-claims, so the fetcher is told to re-send from too far back — and under
   ADR-0052 those re-sent batches APPEND DUPLICATE ROWS. (c) alone turns a promotion into stream
   corruption.

   **The resolving idea: coverage is a property of the STREAM, not of any generation's fold.** Store
   it once, beside the stream. Every generation folding it inherits the same claim, so promotion hands
   over a correct wire cursor with no reconciliation, and WRITER SUCCESSION (see
   `the-generation-registry-is-durable-on-sql`) leaves it untouched. Use `seq` via the existing
   `readStreamHighWaterMark` for the catch-up predicate: a follower is caught up when it has folded
   through the stream's high-water `seq`.

   **State the ADR-0052 asymmetry rather than assuming it away:** the coverage row moves with the
   APPEND, which is ordered BEFORE the fold, so coverage may sit one batch ahead of every generation's
   state. That is the allowed direction (ADR-0038: stream ahead of state, never behind).

   **The keeper stays READ-ONLY** (spec answer 9 is unchanged): the coverage row is written by the
   emission appender, never by `saveNewEvents`.
2. ~~**Does the cursor-contract testing decision still stand?**~~ **ANSWERED: YES, it stands, because
   question 1 resolved to (a).** A cursor contract exists again, so assert the SAME three properties
   as the IndexedDB keeper. What does NOT apply is the segment-port conformance material, since this
   implementation does not ride `createSegmentedStream`.

## What to build

A **stream a generation can re-fold, over the stored emission table** — the thing a successor on a
SHARED stream folds instead of re-fetching from the chain. It is a `StreamReader` over `_emissions`
for one (indexer, stream), wrapped by the existing `readOnlyStream` so that `saveNewEvents` and
`clear` are no-ops and the ONE-WRITER RULE stays structural (ADR-0044): the fold that indexes the
stream is the only thing that appends to it, and everything else re-folding it is handed a view whose
writes go nowhere.

**A replay, not a fetch (ADR-0042).** The rows carry the fold's own verdicts — retractions INCLUDED,
superseded rows flagged — so a consumer of this reader must HONOUR those verdicts rather than
re-derive them from a window a rebuild does not have. Preserve `removed` markers, order by `seq`,
tolerate HOLES in `seq` (compaction is allowed to leave them and both existing cursors already
tolerate them), and never renumber.

**Do NOT ride `createSegmentedStream` over SQL.** Segments exist because the IndexedDB keeper needs
batched writes; SQL does not, and `_emissions` is already `seq`-addressed with a validated cursor
codec above it. Implement the reader directly over `seq`.

Scope fence: this task adds a READER, and the appender stays exactly where ADR-0052 put it (inside the
fold, before the state advances) emitting exactly the rows it emits today. The ONE writer change this
task may make is the COVERAGE ROW of answer (a) above, if that is how question 1 is answered: it is
written inside the EXISTING `appendEmissions` batch (`packages/server/src/emissions.ts` builds its
statements and issues one `batch()`, so there is a place for it), and it moves no emission write and
adds no second appender. Under answers (b) or (c) there is no writer change at all.

**If the answer is (a), this task also touches the STATIC SCHEMA.** A coverage row means a fixed table
or column in `packages/server/src/schema/sql/db.sql` plus a `SCHEMA_VERSION` bump and the matching
version row, and `the-generation-registry-is-durable-on-sql` bumps that same file and the same
constant. They are both startable today, so under answer (a) LAND AFTER that task (or coordinate the
version number with it) rather than racing it to the same two lines. Under (b)/(c) the two tasks share
no file. **Whoever answers question 1 with (a) must ADD `the-generation-registry-is-durable-on-sql` to
this task's `blockedBy` when clearing `needsAnswers`** — otherwise the serialisation is prose only and
two claimable tasks race the same `SCHEMA_VERSION` bump.

## Acceptance criteria

- [ ] A reader over `_emissions`, scoped to one (indexer, stream), that yields the stored emission
      stream from a given block in `seq` order with retractions included and holes tolerated.
- [ ] Wrapped through `readOnlyStream`, so `saveNewEvents` and `clear` are NO-OPS: assert that folding
      through it appends nothing to `_emissions` and deletes nothing.
- [ ] Re-folding a stored stream through this reader reproduces the state the original fold produced —
      assert on a fixture containing a REORG, so the retraction path is exercised and not just the
      happy one.
- [ ] It reads only its own (indexer, stream): rows of another stream or another named indexer in the
      same table are never returned.
- [ ] Whatever question 1 resolves to is implemented and asserted (a coverage row written inside the
      existing append batch, or the documented absence of one), and question 2's testing decision is
      answered accordingly.
- [ ] Under answer (a) only: the static schema file and `SCHEMA_VERSION` agree, and the
      reserved-namespace test still passes.
- [ ] Tests cover the new behaviour, in the repo's existing style.

## Blocked by

- None — can start immediately, once the open questions above are answered.

## Prompt

> Make the stored emission stream READABLE as a stream a generation can fold, so a processor-only
> upgrade rebuilds from local disk instead of re-fetching the chain.
>
> Vocabulary (`CONTEXT.md`): the **emission stream** is what the fold produced, stored append-only with
> retractions included and superseded rows flagged (ADR-0006); a **follower** is a non-canonical
> generation on a SHARED stream that fetches NOTHING and re-folds the stored stream; a **read-only
> stream view** (`readOnlyStream`, `@etherfold/core`) is an `ExistingStream` whose writes are no-ops,
> and is what makes the one-writer rule structural; a **hole** in `seq` is legal, a **gap** in segment
> ordinals is damage — they are not synonyms.
>
> Where to look: `packages/server/src/emissions.ts` (the table, the append, the high-water read),
> `packages/server/src/feed/*` (the two views over the same rows and the opaque cursor above them),
> `packages/core/src/stream/readOnly.ts` and `stream/fixture.ts` (`replayStream` is the same shape over
> a captured fixture), `packages/core/src/types.ts` (`ExistingStream`, `StreamFetcher`), and
> `IndexerGeneration.replay` / `generateStreamFromReplay` in `packages/core/src/indexer.ts` for what a
> replay consumer expects.
>
> Constraining decisions: ADR-0044 (how a successor advances is determined by its stream, never
> configured; the read-only view), ADR-0042 (a fetch is not a replay: honour the stored verdicts),
> ADR-0006 (the stored stream and its two views), ADR-0052 (the append is the fold's and runs before the
> state advances — do not move it), ADR-0035 (the cursor contract's properties and why placement is each
> keeper's).
>
> Seams to test at: the reader itself, and a fold driven through the read-only view over a fixture with
> a reorg in it. Done means a generation can be re-folded from `_emissions` alone, with zero
> `eth_getLogs` calls and zero writes to the stream.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if a
> dependency landed differently or an ADR superseded an assumption here, route the task to
> needs-attention with the discrepancy rather than building on the stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do
> not write the done record, the commit message or the PR body yourself.

## Decisions

**1. Widened the core `EmissionWrite` port with `coverage`.** The task's scope fence says the coverage row is "written inside the EXISTING `appendEmissions` batch", and there is a place for it — but the payload the appender receives (`{stream, emissions}`) carries no cursor at all, so the data for it does not exist server-side. `EmissionWrite` now carries `StreamCoverage` (`{source, config, latestBlock, lastFromBlock, lastToBlock}`), ABI-free like `EmittedLog` beside it. Alternative considered and rejected: have the host wire a second write — that is the "second appender" the fence forbids, and it could not be atomic with the rows. **Touches** `@etherfold/core` (`emissionStream.ts`, `StreamBuilder.storeStream`) and every host supplying an appender (only `emissionAppenderFor` exists). No emission write moved; ADR-0052's ordering is untouched.

**2. The appender is now called on EVERY batch, including one that emitted nothing.** This reverses a deliberate, pinned behaviour (`StreamBuilder.storeEmissions` early-returned; `packages/core/test/streamBuilder.test.ts` asserted "an empty cycle costs no write", which I rewrote). It is forced by answer (a) being honest: a claim only written on log-bearing batches under-claims over quiet ranges, which is precisely the `MAX(blockNumber)` failure question 1 rules out — a successor permanently behind, and a promotion whose `expectedFromBlock` is too far back, whose re-sent batches ADR-0052 appends twice. It is the shape ADR-0035's contract already requires (`writeCursorOnly`: an empty save writes the cursor and no segment). Visible edge, recorded rather than hidden: the append is not best-effort, so a store that cannot be written now refuses a **quiet** batch too. **Touches** `@etherfold/core` and the sibling task `the-rebuild-replays-the-local-stream-in-bounded-chunks`, which shares question 1.

**3. Named it `_stream_coverage` / "coverage claim", not `_stream_cursor`.** Coherence check: `_cursor` already exists in the *same database*, meaning the state store's opaque **sync cursor** (ADR-0027) — how far a *processor* got. A second `_..._cursor` one table away holding a different thing is the one-word-two-meanings hazard the reserved `_` namespace exists to prevent. "Coverage" is already `CONTEXT.md`'s word for what a cursor asserts. Recorded in the glossary so later tasks inherit the term rather than forking it.

**4. The claim stores only the STREAM half of the context (`source` + `config`), and the reader returns `processor: ''`.** The IndexedDB cursor record stores the whole `ContextIdentifier`; here that would file a generation's fact under a shared key, which is the rule `_emissions` already states about its own columns ("nothing about the PROCESSOR, and no GENERATION"). Verified that `sourceInvalidationOf`'s stream verdict reads `source` and `config` alone, and that no consumer of `fetchFrom`'s `lastSync` reads `context.processor`. Alternative: store the whole context — simpler, but stores a value nothing reads and a later reader could wrongly trust.

**5. A `startBlock` column, written once, and a stream that does not reach back to the requested block is reported ABSENT.** Mirrors the segment keeper's identical check (ADR-0035), so a partial history is not replayed as though it were whole. It is an *absence*, not a new error class, and — unlike the segment keeper — nothing is deleted in response, because this view owns none of those rows. **Touches** the schema (a column) and the migration story: a version-3 database gains the table empty, so a stream reads ABSENT until its writer's next batch, at which point `startBlock` records *that* batch's first block rather than the true history's — which the reader then honestly refuses to serve from below. Called out in the ADR and the changeset.

**6. Exported only the wrapped `ExistingStream`, not the bare `StreamReader`.** You cannot obtain a writable handle on `_emissions` through this module, so the one-writer rule is unreachable-by-construction rather than a convention a caller could skip.

**7. Note for the human, since I must not edit the task body:** the task says whoever answers question 1 with (a) must add `the-generation-registry-is-durable-on-sql` to `blockedBy`. That task is already **done**, so the serialisation it protected is satisfied and `blockedBy: []` is now correct rather than stale; I took its `SCHEMA_VERSION` 3 and bumped to 4 without racing it.
