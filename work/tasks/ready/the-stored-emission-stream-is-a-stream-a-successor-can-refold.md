---
title: 'The stored emission stream is a STREAM a successor can re-fold, read-only'
slug: the-stored-emission-stream-is-a-stream-a-successor-can-refold
spec: the-server-and-cli-hold-generations-too
needsAnswers: true
blockedBy: []
covers: []
---

<!-- open-questions -->

## Open questions

1. **What coverage does a reader over `_emissions` report, given that table stores no cursor record?**
   `StreamFetcher` answers `{lastSync, eventStream}`, and on the segment keeper the `lastSync` comes
   from the CURSOR RECORD stored beside the segments (the three block numbers). `_emissions` has no
   such row: it is one row per emitted log, `seq`-addressed, holes legal. The WRITE side is settled —
   there is exactly ONE append site and it is the fold's — and only the READ side is open. Note what
   ADR-0052 actually decided about that write, because an earlier telling of this question got it
   wrong: the append is its OWN `batch()`, ORDERED BEFORE the fold, and NOT in one transaction with
   the state cursor. The accepted cost is recorded there: the stream may sit one batch AHEAD of the
   state, never behind. So a coverage row written with the append can legitimately be ahead of the
   state cursor of the generation that folded it, and any answer below has to be honest about that
   asymmetry rather than assume the two move together. Candidates, none pinned:
   - **(a)** add a per-(indexer, stream) coverage/high-water row written in the SAME transaction as the
     append, making this a full keeper that satisfies the cursor contract's three properties directly;
   - **(b)** derive it from `MAX(blockNumber)` of the stored rows — which UNDER-claims, since a stream
     legitimately covers ranges that carried no logs, so a re-folding successor would report a cursor
     permanently behind the canonical generation's and the `on-catch-up` promotion would never fire
     (see the coupled question on `the-rebuild-replays-the-local-stream-in-bounded-chunks`);
   - **(c)** report no block coverage at all and decide catch-up on the emission `seq` high-water
     instead (`readStreamHighWaterMark` already exists), leaving the successor's own cursor to be
     whatever its fold wrote.
2. **Does the spec's testing decision "the cursor contract is satisfied by the SQL keeper, asserted
   against the same three properties as the IndexedDB keeper" still stand?** The answer to question 9
   says this implementation is READ-ONLY (`saveNewEvents` and `clear` are no-ops), holds no cursor of
   its own, and does not ride the segment port, so the shared conformance material has nothing to
   attach to. If the answer to question 1 is (a), a cursor contract exists again and should be
   asserted; under (b)/(c) there is nothing to assert and that testing decision is superseded. Say
   which.

<!-- /open-questions -->

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

## Open questions

- the-canonical-pointer-moves-back-without-re-ingesting is not blockedBy the-rebuild-replays-the-local-stream-in-bounded-chunks, but it cannot be built without it: on this runtime the chain-free container created by a-changed-context-creates-a-successor-instead-of-clearing deliberately stops short of promotion (its own What-to-build says so), and the rebuild task is the one that owns the FORWARD pointer move and explicitly takes the lift of the promotion trigger and its arming into a shared place as IN SCOPE. Built as written and in parallel, the revert task has nothing to revert FROM and no arming rule to assert its criterion 3 against, so it either stalls on a scope-fence violation or writes a second promotion trigger, which is exactly the two-sources-of-truth the rebuild task warns against. The revert task's own open question 2 also says it CONSUMES question 2 of the rebuild task, an ordering that is prose-only today. Fix: add the rebuild slug to blockedBy plus the Blocked-by prose (edit supplied). (work/tasks/backlog/the-canonical-pointer-moves-back-without-re-ingesting.md frontmatter blockedBy: [a-changed-context..., one-registry-entry...]; criterion 'After the revert, the automatic promotion policy does not move the pointer forward again'; rebuild task: 'The chain-free container this task builds on deliberately stops short of promotion ... That lift is IN SCOPE for this task.')
