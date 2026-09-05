---
title: 'The rebuild replays the LOCAL stream in bounded chunks against a durable checkpoint, and the pointer moves at the end'
slug: the-rebuild-replays-the-local-stream-in-bounded-chunks
spec: the-server-and-cli-hold-generations-too
needsAnswers: true
blockedBy: [the-stored-emission-stream-is-a-stream-a-successor-can-refold, a-changed-context-creates-a-successor-instead-of-clearing]
covers: [2, 8, 9, 10]
---

<!-- open-questions -->

## Open questions

1. **How is "the successor has caught up" decided on THIS runtime?** The promotion trigger compares the
   successor's cursor against the CANONICAL generation's, live. That comparison is `lastToBlock`
   against `lastToBlock` in the existing container, and it only works if the re-folding successor can
   report a cursor comparable to the incumbent's. It may not be able to: `_emissions` stores no
   coverage claim, so a successor's cursor derived from the rows it replayed can sit permanently below
   an incumbent whose cursor advanced over ranges that carried no logs — and then `on-catch-up` never
   fires and the rebuild never promotes. This is the same question as question 1 on
   `the-stored-emission-stream-is-a-stream-a-successor-can-refold`, seen from the driver's side: is
   catch-up (a) a block-number comparison made honest by a coverage row written with the append,
   (b) a comparison against the stream's `seq` high-water, or (c) something else? Answer both together.
   Whichever it is, ADR-0052 allows the stored stream to sit one batch AHEAD of the state that folded
   it (the append is its own write, ordered BEFORE the fold), so "level" must be defined against that
   asymmetry rather than against an assumed single transaction.
2. **After the pointer moves, does the RETIRED generation go on folding — and who then writes the
   shared stream?** On this runtime the writer of a stream is the `StreamBuilder` that RECEIVES wire
   batches and appends what it folded (ADR-0052), and a successor on the SAME stream is a follower
   that writes nothing (ADR-0044). Nothing in the model says what changes at the promotion, and
   ADR-0008's own answer (feed both briefly, flip, DROP the old) is exactly the part this spec
   supersedes: the old generation is now RETAINED. Three things hang on the answer and no task
   currently owns it — whether the retired generation keeps advancing (which decides whether
   `the-canonical-pointer-moves-back-without-re-ingesting` can assert 'the same answers as before the
   promotion' at all), whether the promoted follower is fed live or stays a re-folder of somebody
   else's appends, and whether a retired generation's WIRE CONTEXT stays live
   (`one-registry-entry-holds-several-live-wire-contexts` owns the live set and deliberately does not
   assume this). A 'pause' does NOT settle it: on this runtime pause is an explicit operator action,
   and the container REFUSES to pause a follower (`CannotPauseFollowerError`).

<!-- /open-questions -->

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

## Open questions

- the-canonical-pointer-moves-back-without-re-ingesting is not blockedBy the-rebuild-replays-the-local-stream-in-bounded-chunks, but it cannot be built without it: on this runtime the chain-free container created by a-changed-context-creates-a-successor-instead-of-clearing deliberately stops short of promotion (its own What-to-build says so), and the rebuild task is the one that owns the FORWARD pointer move and explicitly takes the lift of the promotion trigger and its arming into a shared place as IN SCOPE. Built as written and in parallel, the revert task has nothing to revert FROM and no arming rule to assert its criterion 3 against, so it either stalls on a scope-fence violation or writes a second promotion trigger, which is exactly the two-sources-of-truth the rebuild task warns against. The revert task's own open question 2 also says it CONSUMES question 2 of the rebuild task, an ordering that is prose-only today. Fix: add the rebuild slug to blockedBy plus the Blocked-by prose (edit supplied). (work/tasks/backlog/the-canonical-pointer-moves-back-without-re-ingesting.md frontmatter blockedBy: [a-changed-context..., one-registry-entry...]; criterion 'After the revert, the automatic promotion policy does not move the pointer forward again'; rebuild task: 'The chain-free container this task builds on deliberately stops short of promotion ... That lift is IN SCOPE for this task.')
