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
