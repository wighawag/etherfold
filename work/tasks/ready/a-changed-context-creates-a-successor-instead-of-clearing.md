---
title: 'A changed context creates a SUCCESSOR instead of calling processor.clear()'
slug: a-changed-context-creates-a-successor-instead-of-clearing
spec: the-server-and-cli-hold-generations-too
blockedBy: [the-generation-registry-is-durable-on-sql, a-generation-folds-into-its-own-tables]
covers: [1, 2]
needsAnswers: true
---

## What to build

The **generation container above `StreamBuilder`** — the piece this runtime lacks and the browser
already has. Today a persisted cursor carrying a different source, config or processor version is
DISCARDED: `StreamBuilder`'s private `currentLastSync()` calls `processor.clear()`, from both public
methods and therefore from both ingest routes, and the server answers progressively less until it has
caught up. That is the outage, with a concrete call site. In the generation model that branch stops
discarding and instead RESOLVES-OR-CREATES the generation the incoming context names, leaving the
canonical one answering exactly what it answered before.

A container here holds, for ONE named indexer: the generations it was built to hold (each a
stream-builder over its own processor over its own state namespace), the durable registry those
generations are recorded in, and the canonical pointer reads resolve through. It is the chain-free
SIBLING of the existing `Indexer` container, which cannot serve: that one builds `IndexerGeneration`
engines whose `load()` opens with `eth_chainId`, which is precisely why the receiving half of a split
deployment uses `StreamBuilder` instead.

**Reuse the model; do not restate it.** Generation identity, stream identity, the caps, the promotion
policy and its `on-catch-up` default, pause/drain, and drop-on-promotion are all `@etherfold/core`'s
already and are consumed unchanged. If a rule currently sits inside the existing container and must be
shared, LIFT it rather than copying it: a second copy of the promotion trigger is a second source of
truth that will drift.

Scope for this task:

- **The processor-only change** — a new fold over the SAME stream, which is the common reconfigure and
  the free one: it re-fetches nothing and the wire context is unchanged, so the existing single-context
  route keeps working. A filter/config change needs the wire widening and is
  `one-registry-entry-holds-several-live-wire-contexts`.
- **The successor is created, registered and given its own state namespace**, and the canonical
  generation keeps folding and keeps answering while it exists.
- **A cap REFUSES here, loudly**, naming what an operator could delete, instead of the successor being
  created (story 7's observable face). The cap VALUES are this container's input, not the SQL
  substrate's: `openGenerationRegistry` takes `GenerationCaps` as an argument, so decide where a host
  supplies them (options on the container, threaded from the server's options and the CLI's config)
  and what they default to, and record that in `## Decisions`. A cap nobody can set is not story 7.
- **Not in scope:** how the successor actually catches up (the bounded-chunk rebuild driver), moving
  the pointer BACK, the `/status` surface, and multi-name hosting. Each is its own task.

**Behaviour with NO container must be exactly today's.** A `StreamBuilder` constructed without one
still discards a foreign cursor as it does now. This is additive: the Worker host and every existing
test must keep passing untouched.

## Acceptance criteria

- [ ] With a container present, a batch whose context names a fold this indexer has not seen CREATES a
      generation instead of calling `processor.clear()` — asserted AT that call site, with a spy or
      equivalent, because that call is the outage this task removes.
- [ ] The canonical generation's state is untouched by the creation: read it before and after and get
      identical answers (story 2).
- [ ] The new generation is registered durably and its state lands in its own namespace; nothing is
      written into the canonical generation's tables or cursor.
- [ ] Re-presenting the same context RESOLVES the already-registered generation rather than creating a
      second record.
- [ ] At the cap, creation is REFUSED naming what to delete, and no partial generation is left behind
      (no orphan tables, no orphan record).
- [ ] The caps are CONFIGURABLE by the host that builds the container, with a documented default, and
      a host that sets a different bound gets the refusal at that bound.
- [ ] A restart against the same database comes back holding the same generations, with the same
      canonical one answering.
- [ ] A `StreamBuilder` built WITHOUT a container behaves exactly as today, including the discard.
- [ ] A changeset accompanies any public API change (`@etherfold/*` packages are not published yet, so
      a breaking change costs a changeset and not a migration).
- [ ] Tests cover the new behaviour, in the repo's existing style.

## Blocked by

- `the-generation-registry-is-durable-on-sql` — the container needs somewhere durable to record a
  generation and a pointer to resolve reads through.
- `a-generation-folds-into-its-own-tables` — a successor needs state of its own, or creating one
  corrupts the incumbent.

## Prompt

> Remove the server/CLI outage: a context change must CREATE A GENERATION beside the live one instead
> of discarding the state the live one answers from.
>
> Vocabulary (`CONTEXT.md`): a **generation** is a stream plus a fold over it, identified by
> `{stream digest, processor version hash}`; an **indexer** is the NAMED unit holding several
> generations, one **canonical pointer** and the **generation caps**; the **stream-builder** is the
> chain-free receiver that derives every reorg and is authoritative about where the next batch starts;
> a **follower** is a non-canonical generation on a shared stream.
>
> Where to look: `packages/core/src/streamBuilder.ts` (the `processor.clear()` call site is in the
> private `currentLastSync()`, reached from `expectedFromBlock()` and `receive()`, and its docstring
> already flags that reading can WRITE for this reason), `packages/core/src/container.ts` (the existing
> chain-facing container — the model to reuse, including `GenerationSpec`'s state-then-processor
> factories and why they are per generation), `packages/core/src/generation/*` (registry, promotion
> policy, identity), and the CLI's folding module, which is where the store, the processor and the two
> ports that write what a fold concluded are assembled for every command that owns a database.
>
> Constraining decisions: ADR-0043 (state first, factories per generation), ADR-0044 (how a successor
> advances is determined by its stream), ADR-0046 (the promotion trigger and drop-on-promotion),
> ADR-0045 (pause is a cap and a drain), ADR-0053 (a generation's state is a table namespace, a named
> indexer is a database), ADR-0008 (the rebuild-alongside mechanism this serves, superseded only in its
> key and its retention), ADR-0052 (the emission append is the fold's and runs before the state
> advances — a successor must not double-append; only the INDEXING generation writes a stream).
>
> Seams to test at: `StreamBuilder`'s receive/expectedFromBlock path with a container attached, and the
> registry underneath it. Done means the concrete `processor.clear()` on a context change is gone on
> this runtime, the incumbent still answers, and the successor exists with its own state.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if a
> dependency landed differently or an ADR superseded an assumption here, route the task to
> needs-attention with the discrepancy rather than building on the stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT —
> in particular WHERE the container lives and whether you lifted a rule out of the existing container
> or duplicated it. Do not write the done record, the commit message or the PR body yourself.

## Open questions

- the-canonical-pointer-moves-back-without-re-ingesting is not blockedBy the-rebuild-replays-the-local-stream-in-bounded-chunks, but it cannot be built without it: on this runtime the chain-free container created by a-changed-context-creates-a-successor-instead-of-clearing deliberately stops short of promotion (its own What-to-build says so), and the rebuild task is the one that owns the FORWARD pointer move and explicitly takes the lift of the promotion trigger and its arming into a shared place as IN SCOPE. Built as written and in parallel, the revert task has nothing to revert FROM and no arming rule to assert its criterion 3 against, so it either stalls on a scope-fence violation or writes a second promotion trigger, which is exactly the two-sources-of-truth the rebuild task warns against. The revert task's own open question 2 also says it CONSUMES question 2 of the rebuild task, an ordering that is prose-only today. Fix: add the rebuild slug to blockedBy plus the Blocked-by prose (edit supplied). (work/tasks/backlog/the-canonical-pointer-moves-back-without-re-ingesting.md frontmatter blockedBy: [a-changed-context..., one-registry-entry...]; criterion 'After the revert, the automatic promotion policy does not move the pointer forward again'; rebuild task: 'The chain-free container this task builds on deliberately stops short of promotion ... That lift is IN SCOPE for this task.')
