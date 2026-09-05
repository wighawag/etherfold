---
title: 'The generation registry and the canonical pointer are rows in the database'
slug: the-generation-registry-is-durable-on-sql
spec: the-server-and-cli-hold-generations-too
blockedBy: []
covers: [7]
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

## WRITER SUCCESSION on a delete, DECIDED — and it is this task's, because the commit is

ADR-0044 says which generation WRITES a stream is the FIRST one held on it, "registration order, not
the canonical pointer". It does NOT say what happens when that generation is DELETED, and nothing
else in the tree does either. Unhandled, deleting the writer is a SILENT STALL and worse: generations
on one stream share a wire context and the RECEIVER for that context is the writer, so with it gone
nothing appends AND an incoming batch resolves to no receiver. `/status` keeps looking healthy while
the cursor quietly stops.

**The rule is restated, not replaced: the writer of a stream is the OLDEST SURVIVING generation held
on it.** That subsumes ADR-0044's rule (at the start, the oldest survivor IS the first held) and
defines succession without letting the POINTER in. It is deliberately NOT "the canonical takes over":
that would reintroduce the very coupling ADR-0044 refused, and leave two rules where one does. In the
ordinary sequence — rebuild, promote, drop the old one — the promoted successor inherits the duty
anyway, as a CONSEQUENCE of being the oldest survivor rather than as a special case.

Succession happens ATOMICALLY WITH THE DROP, in the same registry commit, or a crash between them
leaves a stream with no writer: the successor's `readOnlyStream` is swapped for the real writable
`ExistingStream` (it stops being a follower), and the wire context's receiver moves to it.

The COVERAGE ROW (see `the-stored-emission-stream-is-a-stream-a-successor-can-refold`) is a property
of the STREAM, so it survives succession untouched and the new writer continues from it. Nothing to
migrate.

This is very likely an amendment to ADR-0044 (`work/protocol/ADR-FORMAT.md`); if it is, write it and
name it in the `## Decisions` block.

## Acceptance criteria

- [ ] A `GenerationRegistryPort` over `RemoteSQL`, scoped to one named indexer, passing the same
      behaviour the memory and IndexedDB substrates pass: register, resolve an already-registered
      generation instead of duplicating it, refuse at a cap naming what to delete, delete, reap.
- [ ] **Deleting the WRITER hands the append duty to the oldest surviving generation on that stream,
      in the SAME commit as the delete.** Asserted on the rows: after the drop, exactly one
      generation holds the writable stream and the wire context resolves to it, so an incoming batch
      is still received and still appends.
- [ ] **Dropping the LAST generation on a stream reaps the stream subtree**, since no writer can
      remain. Use `dropStreamSubtree`; this is the same sweep the criterion below performs, triggered
      rather than discovered.
- [ ] **Dropping the CANONICAL generation is REFUSED**, naming it: something must always be
      answering, which is also what guarantees a survivor exists to inherit the duty.
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

