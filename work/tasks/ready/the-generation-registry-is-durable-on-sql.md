---
title: 'The generation registry and the canonical pointer are rows in the database'
slug: the-generation-registry-is-durable-on-sql
spec: the-server-and-cli-hold-generations-too
blockedBy: []
covers: [7]
needsAnswers: true
---

## What to build

The DURABLE SUBSTRATE the generation model already expects, over `RemoteSQL`: which generations a
named indexer holds and which one is CANONICAL, as ROWS, so a process restart comes back holding
what it held and the pointer it last moved — and the caps REFUSING at that bound rather than
evicting.

The rules are already built and are NOT to be rewritten. `openGenerationRegistry` (`@etherfold/core`,
`generation/registry.ts`) owns registration, the caps refusal, deletion, reaping and the pointer,
over a five-operation PORT (`read`, `commit`, `listStreamDigests`, `dropStreamSubtree`, `dropState`).
Two substrates exist as prior art: the reference one in memory (`generation/memory.ts`) and the
durable IndexedDB one in `@etherfold/browser`. This task adds the THIRD, on SQL, and inherits every
rule from the port rather than re-deciding one.

What this substrate has to get right:

- **The CAPS are CONFIGURATION, not rows.** `openGenerationRegistry(port, caps)` takes them as an
  argument, and the five-operation port has no cap operation at all: the substrate persists the
  generation RECORDS and the POINTER, and the refusal is the registry's rule applied over what this
  substrate read. Do NOT add a caps table, a caps column or a sixth port operation — that would fork
  a model this task consumes. (Where the cap VALUES come from on this runtime is the container's,
  and is named in `a-changed-context-creates-a-successor-instead-of-clearing`.)
- **`commit` takes a DECISION FUNCTION, and the SEAM CANNOT HOLD A TRANSACTION OPEN ACROSS IT.**
  That is the hard part of this task. It is a DECISION YOU MAKE while building — not an open
  question, and not a reason to stop — and it must be recorded in the `## Decisions` block of your
  final report (and as an ADR if it meets `ADR-FORMAT.md`'s gate, which a new atomicity convention
  over `RemoteSQL` plausibly does). The decision ("is this already registered, does this breach a
  cap") has to be made from the state the write is then applied to, or two writers both pass a cap of
  two and leave three generations behind them. But
  `RemoteSQL` is exactly `prepare(sql)` plus `batch(statements)` (see `remote-sql`, and the note in
  `state-store-sqlite/src/store.ts` that a transaction is exposed ONLY as a batch): a batch is a
  PRE-BUILT statement list, so there is no way to read, run JS, and write while still inside the
  transaction. The memory port's synchronous guarantee therefore does NOT carry over for free, and a
  read-outside-then-write implementation that merely LOOKS atomic is the failure mode to avoid.
  Candidate shapes, none pinned and none exhaustive: push the decision INTO SQL so the write is
  conditional on the state it was decided from (an insert guarded by a `SELECT` over the same rows,
  inside the one `batch`), or carry a version/generation-count row that every commit reads and then
  conditionally updates, so a loser's write applies to nothing and is retried. Whatever is chosen,
  the mechanism must be stated in the `## Decisions` block and asserted in a test that does not
  depend on timing. If you conclude that NO mechanism available over `prepare` + `batch` is honest
  here, that is drift worth stopping on: route the task to needs-attention with what you found
  rather than shipping a read-then-write that merely looks atomic.
- **The canonical pointer is ONE small row.** Moving it is promotion, moving it back is revert, and
  an absent `canonical` in a write means LEAVE IT WHERE IT IS rather than clear it.
- **It is SCOPED to one named indexer.** Carry the name as a column exactly as `_emissions` does, even
  though ADR-0053 gives each named indexer its own database and the column is therefore redundant
  today: it stays correct, costs little, and is what a future colocated deployment needs.
- **`listStreamDigests` and `dropStreamSubtree` answer over the stored emission stream**, which is
  where a stream physically lives on this runtime (`_emissions`, keyed on (indexer, stream)). The
  unregistered-subtree sweep the registry drives is what reclaims a stream nothing points at.
- **`dropState` is INJECTED, not implemented here.** Where a generation's state tables live is
  `a-generation-folds-into-its-own-tables`'s, and the memory port already takes it as an option; take
  it the same way and default it to doing nothing, so the two tasks stay in different packages.

The table is a FIXED table in the reserved `_` namespace, in the static schema file the server owns
(`packages/server/src/schema/sql/db.sql`), because two application paths must produce the same
database and one of them is wrangler's D1 migration, which executes that file and nothing else. Bump
`SCHEMA_VERSION` and the version row in the SQL together — a test asserts they agree, and another
asserts every fixed name carries the `_` prefix.

## Acceptance criteria

- [ ] A `GenerationRegistryPort` over `RemoteSQL`, scoped to one named indexer, passing the same
      behaviour the memory and IndexedDB substrates pass: register, resolve an already-registered
      generation instead of duplicating it, refuse at a cap naming what to delete, delete, reap.
- [ ] The caps REFUSE loudly at the bound and evict nothing, and the refusal names the generations an
      operator could delete (story 7).
- [ ] The canonical pointer survives a fresh handle: open a second registry over the same database and
      it reports the same generations and the same canonical one.
- [ ] A cap decision made concurrently cannot be beaten: two commits racing over one database leave
      the number of generations within the cap. Assert it against the atomicity mechanism you chose
      and recorded in `## Decisions`, never by timing, and never by a read-then-write that a second
      writer can interleave with.
- [ ] Nothing about the CAPS is persisted by this substrate: no caps table, no caps column, and the
      port still has exactly its five operations.
- [ ] The sweep finds an emission-stream subtree no registered generation names, and dropping it
      removes exactly that stream's rows and no other stream's or other indexer's.
- [ ] The fixed table is in the static schema file, `SCHEMA_VERSION` and the version row agree, and the
      reserved-namespace test still passes.
- [ ] Tests cover the new behaviour, in the repo's existing style (vitest, per-package `test/`).

## Blocked by

- None — can start immediately.

## Prompt

> Give the server/CLI runtime a DURABLE generation registry: the records, the canonical pointer and
> the caps, as rows in the database it already owns.
>
> Vocabulary (`CONTEXT.md`): a **generation** is a stream plus a fold over it, identified by
> `{stream digest, processor version hash}`; an **indexer** is the NAMED multi-tenancy unit; the
> **canonical pointer** is the single record naming which generation answers reads; **generation caps**
> are counts that REFUSE at the bound and never evict (deliberately not called *retention*).
>
> Read `packages/core/src/generation/registry.ts` FIRST — it is the rules, over a port, and this task
> supplies a substrate for that port and nothing else. Read `generation/memory.ts` (the reference
> substrate, including how it takes `dropState` as an option) and the IndexedDB substrate in
> `@etherfold/browser` (the durable prior art, including how it sweeps subtrees). The server's fixed
> tables and the reasoning about why they are static SQL are in `packages/server/src/schema/sql/db.sql`
> and `packages/server/src/schema.ts`; the stored emission stream you sweep over is
> `packages/server/src/emissions.ts`.
>
> The seam you have is `RemoteSQL`: `prepare` + `batch`, and nothing else. Read `remote-sql`'s types
> and `packages/state-store-sqlite/src/store.ts` (which already documents that a transaction exists
> only as a batch, and how `commitSegmentWithCursor`-shaped writes cope) BEFORE designing `commit`.
> How `commit` stays atomic over that seam is YOURS to decide and to record; the caps are a
> configured argument to `openGenerationRegistry` and are not something this substrate stores.
>
> Constraining decisions: ADR-0053 (a generation is a table namespace, a named indexer is a database),
> ADR-0036 (the named indexer is the discriminator and is structural), ADR-0006 (the emission table),
> ADR-0008 (the rebuild mechanism this pointer serves; superseded in its key and its retention only).
>
> Seams to test at: the port's five operations, and the registry ABOVE it (open a registry on the SQL
> port and assert the rules hold, exactly as the other substrates are asserted). Done means a second
> process opening the same database sees the same generations and the same canonical generation, and a
> cap refuses instead of evicting.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a
> dependency landed differently than this task assumes, or an ADR superseded an assumption here, do
> NOT build on the stale premise — route the task to needs-attention with the discrepancy as the
> reason.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT (the
> runner transcribes it into the done record). Do not write the done record, the commit message or the
> PR body yourself.

## Open questions

- the-canonical-pointer-moves-back-without-re-ingesting is not blockedBy the-rebuild-replays-the-local-stream-in-bounded-chunks, but it cannot be built without it: on this runtime the chain-free container created by a-changed-context-creates-a-successor-instead-of-clearing deliberately stops short of promotion (its own What-to-build says so), and the rebuild task is the one that owns the FORWARD pointer move and explicitly takes the lift of the promotion trigger and its arming into a shared place as IN SCOPE. Built as written and in parallel, the revert task has nothing to revert FROM and no arming rule to assert its criterion 3 against, so it either stalls on a scope-fence violation or writes a second promotion trigger, which is exactly the two-sources-of-truth the rebuild task warns against. The revert task's own open question 2 also says it CONSUMES question 2 of the rebuild task, an ordering that is prose-only today. Fix: add the rebuild slug to blockedBy plus the Blocked-by prose (edit supplied). (work/tasks/backlog/the-canonical-pointer-moves-back-without-re-ingesting.md frontmatter blockedBy: [a-changed-context..., one-registry-entry...]; criterion 'After the revert, the automatic promotion policy does not move the pointer forward again'; rebuild task: 'The chain-free container this task builds on deliberately stops short of promotion ... That lift is IN SCOPE for this task.')
