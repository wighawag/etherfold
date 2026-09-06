---
title: 'The rebuild replays the LOCAL stream in bounded chunks against a durable checkpoint, and the pointer moves at the end'
slug: the-rebuild-replays-the-local-stream-in-bounded-chunks
spec: the-server-and-cli-hold-generations-too
blockedBy: [the-stored-emission-stream-is-a-stream-a-successor-can-refold, a-changed-context-creates-a-successor-instead-of-clearing]
covers: [2, 8, 9, 10]
---

<!-- open-questions -->

## Open questions
1. ~~**How is "the successor has caught up" decided?**~~ **ANSWERED, jointly with question 1 of
   `the-stored-emission-stream-is-a-stream-a-successor-can-refold`: catch-up is decided on the
   emission `seq` HIGH-WATER (`readStreamHighWaterMark`), not on a block comparison.** A follower
   consumes rows; its completeness is a stream-space property, so `seq` is exact and has no
   under-claim. Block coverage is answered separately by a per-`(indexer, stream)` coverage row (that
   task's answer 1), which exists for the WIRE cursor rather than for this predicate.

   Because ADR-0052 lets the stored stream sit one batch AHEAD of the state that folded it, "level"
   is defined against the stream's high-water `seq` at the moment of the check, and a successor that
   reaches it is caught up even if a further batch lands immediately after — the next check simply
   finds more.
2. ~~**After the pointer moves, does the RETIRED generation go on folding, and who writes the shared
   stream?**~~ **ANSWERED: it KEEPS FOLDING, and the WRITER DOES NOT CHANGE AT PROMOTION.**

   Half of this is already decided: ADR-0044 says which generation writes a stream is the FIRST one
   held on it, "registration order, not the canonical pointer", precisely so promotion does not hand
   the append duty to a different engine mid-flight. So promotion moves the POINTER, not the APPEND
   DUTY. The original generation stays the receiver and appender; the promoted successor keeps
   following.

   The retired generation keeps folding because a frozen one would answer STALE data the instant it
   was reverted to, which defeats retaining it. It is a follower on a shared stream, so it fetches
   nothing and costs only the re-fold of new rows; story 7's cap bounds accumulation. **Its wire
   context therefore stays LIVE** — which is the answer
   `one-registry-entry-holds-several-live-wire-contexts` deliberately declined to assume.

   **The one case where the duty DOES move is DELETION, not promotion**, and it is owned by
   `the-generation-registry-is-durable-on-sql`: the writer is the OLDEST SURVIVING generation on the
   stream.

## What to build

The **rebuild driver**: a successor generation catches up by REPLAYING the locally stored emission
stream, in BOUNDED CHUNKS against a DURABLE CHECKPOINT, and the canonical pointer moves when it is
level — atomically, at the end, with the retired generation RETAINED.

This is the shape this repo already has twice. `prune` and `compactEmissionPairs` are calls the HOST
SCHEDULES, doing bounded work per invocation and REPORTING whether they finished (ADR-0022), and the
compaction task asserts resumability by driving call after call through a FRESH container. Story 9 is
that same shape: bounded work, a checkpoint that is durable in the database rather than in a closure,
and a report a scheduler acts on. Build it PLATFORM-NEUTRAL, so a Node cron, a CLI loop and a browser
can each drive it.

What it must get right:

- **It replays; it does not fetch.** A processor-only upgrade costs a LOCAL SCAN, not a re-index:
  assert ZERO chain calls, not fewer. The replay HONOURS the verdicts the stored stream carries
  (ADR-0042) rather than re-deriving retractions from a window a rebuild does not have, and it walks
  the stream to rebuild the unconfirmed window rather than filtering `removed` entries out.
- **Each chunk commits its state and its checkpoint together**, so a process killed mid-rebuild resumes
  from the checkpoint and never re-applies or skips a chunk. Assert it by driving chunk after chunk
  through a FRESH container, as the compaction task does.
- **The canonical generation is served throughout.** Reads answer from the incumbent for the entire
  rebuild; nobody ever observes partial state.
- **The move is one small write, at the end**, and the retired generation is RETAINED under the caps
  rather than dropped — which is what makes a rollback free BEFORE the move (nothing was overwritten)
  and free AFTER it too (the previous generation still answers). This is where this supersedes
  ADR-0008's drop-the-old-namespace rule; its rebuild-alongside mechanism is what you are building.
- **Promotion policy is not re-decided here.** `on-catch-up` is the default everywhere, `immediate` and
  `manual` exist, and the trigger and the arming are already written — in the CHAIN-FACING container
  (`packages/core/src/container.ts`). The chain-free container this task builds on
  (`a-changed-context-creates-a-successor-instead-of-clearing`) deliberately stops short of promotion,
  so if the trigger is not shared by the time you get here, LIFT it into something both containers use
  rather than writing a second copy: two promotion triggers are two sources of truth and will drift.
  That lift is IN SCOPE for this task.

Scope fence: the Cloudflare Worker's SCHEDULING (ADR-0008's self-enqueueing queue plus its cron
watchdog) is explicitly NOT here — `platforms/cf-worker` has neither binding — and is a follow-on task
named in the spec's Out of Scope. This task owes the driver and the checkpoint.

## Acceptance criteria

- [ ] A successor on a SHARED stream reaches the incumbent's position by replaying `_emissions` alone,
      with ZERO chain calls and ZERO writes to the stream.
- [ ] The rebuild proceeds in bounded chunks: each call does a bounded amount of work and REPORTS
      whether it finished, exactly as `prune` and `compactEmissionPairs` do.
- [ ] Resumability is asserted by driving chunk after chunk through a FRESH container (a new process /
      new object graph, not a loop in one closure), including a kill between two chunks.
- [ ] Reads answer from the canonical generation for the whole rebuild, and the answers do not change
      until the pointer moves.
- [ ] The pointer moves ONCE, atomically, when the successor is level; before the move a rollback is a
      no-op, and after the move the retired generation is still registered, still holds its own state
      and can still answer (the operator-facing way BACK is
      `the-canonical-pointer-moves-back-without-re-ingesting`, not this task).
- [ ] Whatever question 2 resolves to is implemented and asserted: what the retired generation does
      after the move, and which generation writes the shared stream from then on.
- [ ] A rebuild over a stream containing a REORG lands on the same state the original fold produced —
      compare state, not row counts.
- [ ] Tests cover the new behaviour, in the repo's existing style.

## Blocked by

- `the-stored-emission-stream-is-a-stream-a-successor-can-refold` — there is nothing to replay through
  until the stored stream is readable as a stream.
- `a-changed-context-creates-a-successor-instead-of-clearing` — there is no successor to rebuild until
  a context change creates one.

## Prompt

> Make a processor upgrade cost a LOCAL SCAN instead of a re-index: rebuild the successor's state from
> the stored emission stream, in bounded chunks against a durable checkpoint, and move the canonical
> pointer at the end.
>
> Vocabulary (`CONTEXT.md`): a **generation** is a stream plus a fold over it; a **follower** is a
> non-canonical generation on a SHARED stream that fetches NOTHING; the **canonical pointer** is the
> single record naming which generation answers reads, and its **promotion trigger** is the successor
> reaching the canonical generation's cursor, compared LIVE; **drop-on-promotion** is OFF by default,
> because retaining is what makes moving the pointer back a revert rather than a re-index; **prune** and
> **pair-compaction** are the two existing examples of a host-scheduled call doing bounded work.
>
> Where to look: `packages/core/src/generation/promotion.ts` and `container.ts` (the trigger, the
> arming, drop-on-promotion), `packages/core/src/indexer.ts` (`replay`, `followMore`,
> `generateStreamFromReplay` — how a replay rebuilds the unconfirmed window by WALKING the stream),
> `packages/server/src/compaction.ts` and the state store's `prune` (the bounded-work-plus-report shape,
> and the test that drives it through a fresh container), and the emission-stream reader this task is
> blocked on.
>
> Constraining decisions: ADR-0008 (rebuild alongside, chunked against a durable checkpoint, readers
> never see partial state — superseded in its key and its retention, not its mechanism), ADR-0022 (a
> bounded call the host schedules, never a side effect of a write), ADR-0042 (a replay honours the
> verdicts the stream carries), ADR-0044 (a follower fetches nothing and writes no stream), ADR-0046
> (the promotion trigger and drop-on-promotion), ADR-0053 (the successor's state is its own table
> namespace, so the rebuild writes nowhere near the incumbent's rows).
>
> Seams to test at: the driver's per-call report, the state after promotion, and the chain seam (assert
> zero calls). Done means an upgraded processor catches up from disk, resumably, while the old answers
> keep being served, and the pointer moves once at the end.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if a
> dependency landed differently or an ADR superseded an assumption here, route the task to
> needs-attention with the discrepancy rather than building on the stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT —
> in particular where the checkpoint lives and how a chunk is sized. Do not write the done record, the
> commit message or the PR body yourself.

## Decisions

**Where the checkpoint lives: it IS the successor's own sync cursor, and there is no second durable value.** `EventProcessor.process` persists the `LastSync` describing each block in the same transaction as that block (ADR-0027 puts the cursor behind the storage seam precisely because only the store holds that transaction), so "the state and the checkpoint commit together" is a guarantee the seam already makes rather than one this driver arranges. Alternative considered: a `_rebuild` checkpoint table keyed per generation. Rejected because it cannot be atomic with the state write, so a crash between the two leaves a checkpoint that re-applies or skips a chunk — the exact failure the chunking exists to survive. Touches: any future host that wants to inspect rebuild progress reads the generation's own cursor, not a rebuild row. Recorded in ADR-0056.

**How a chunk is sized: a budget in EMISSIONS, cut on a BLOCK boundary, and always ending ABOVE the fold's own position.** Emissions because that is what the work is proportional to; a block boundary because the stream is `seq`-ordered and a reorg puts an application, its retraction and its replacement at one block at arbitrarily separated `seq` values, so a row-aligned cut would leave rows below its own resume point and skip them for ever. The third clause is the non-obvious one and it fixes a real stall I hit while building: `getFromBlock` REACHES BACK over the reorg window, so a fold level with the tip re-reads blocks it has already folded, and a budget spent inside them cuts the chunk where the fold already is — the identical chunk is then asked for for ever, with no error anywhere. So `ReplayChunkQuery` carries `foldedThrough` and the reader guarantees a cut above it; the extra work is bounded by the reorg window, which is what one live cycle already pays. `DEFAULT_MAX_EMISSIONS_PER_CHUNK = 2000`. Touches: any second `ReplaySource` implementation (an IndexedDB one) owes the same rule. Recorded in ADR-0056 with a regression test at both the reader and the driver level.

**"Caught up" is measured against the stream's COVERAGE CLAIM, not the emission `seq` high-water — a deliberate deviation from this task's answered open question 1.** The launched answer says catch-up is decided on `readStreamHighWaterMark`. I could not implement that honestly: evaluating it needs a persisted consumed-`seq`, which cannot be written in the store's block transaction and would therefore be the second durable checkpoint the decision above rejects; and the naive in-memory form is simply wrong in the steady state, because the resume point walks past old rows so a level fold reads none and its highest observed `seq` sits permanently below the high-water. The coverage claim (ADR-0055, landed by the sibling task since this one was written) removes the under-claim the original answer was guarding against — it moves on every batch including quiet ones — and it is the same space the promotion trigger already compares in (`hasReachedCursor` over `lastToBlock`, ADR-0046), so no second notion of "level" enters the system. The high-water is still read and REPORTED on every chunk (`RebuildReport.highWater`) as the honest measure of what is being folded. Alternative considered and rejected: `complete = the read hit its budget`, which is the same stall wearing a different hat. Touches: `a-rebuild-in-progress-is-never-an-empty-answer` (the `/status` dimension will report from this) and `the-canonical-pointer-moves-back-without-re-ingesting`. Recorded in ADR-0056.

**`immediate` together with `dropOnPromotion` is REFUSED on the receiving container.** ADR-0046 requires that combination to DEFER the drop until the successor reaches the cursor the previous generation had at the promotion, and that interlock is per-advance bookkeeping the chain-facing container keeps and this one does not. `on-catch-up` and `manual` drops ARE implemented, including the never-drop-a-followed-writer decline (which is what fires on the ordinary processor upgrade). Alternative considered: accept the flag and ignore it — rejected as accept-and-ignore on the one setting whose cost is unrecoverable (a complete state discarded for one that has proved nothing). Touches: `ReceivingIndexerOptions.promotion`, and whatever `the-cli-and-the-server-hold-generations-the-same-way` threads into it.

**`ReceivingIndexer.add` no longer refuses a second fold on a held stream; it makes it a FOLLOWER.** That refusal was a placeholder whose own message named this task as the fix, and ADR-0044 says the choice is determined by the stream and is never a knob — so a separate `follow()` verb would have made it one. Consequence: `HeldFold.ingestion` is now optional and `HeldFold.follows` is reported beside `writesStream`. A container given no `replay` source still refuses, naming the missing port, rather than registering a generation that could never advance. Touches: `receivingContainer.test.ts` (rewritten assertion), `severalLiveWireContexts.test.ts` (one optional-chain), and the server's `IndexerRegistryEntry`, whose `liveIngestions()` contract is unchanged.

**Named the container verb `rebuildMore` rather than `followMore`.** Coherence check: `followMore` already means "advance from the stored stream alone", UNBOUNDED, on `IndexerGeneration` — reusing it for the bounded version would give one name two bound-semantics. `rebuild` already means exactly this in ADR-0008 and `CONTEXT.md` (blue-green rebuild), so it re-means nothing. The JSDoc and the `CONTEXT.md` **follower** entry say the two are one mechanism at two bounds.

**No new index for the block-ordered probe**, matching `compactEmissionPairs`' own precedent: the canonical index is partial on `alive = 1`, so a scan over a stream including retractions is a table scan whatever the order, and a third index on a table weighed against D1's 10GB ceiling is paid for by every deployment. Nothing here has been measured against a stream large enough to say it earns its keep; recorded as a consequence in ADR-0056 so the day it does is a decision and not a discovery.
