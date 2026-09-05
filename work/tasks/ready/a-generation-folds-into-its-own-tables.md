---
title: 'A generation folds into its OWN tables, so two of them share a database and touch nothing of each others'
slug: a-generation-folds-into-its-own-tables
spec: the-server-and-cli-hold-generations-too
blockedBy: []
covers: []
needsAnswers: true
---

## What to build

The versioned state store gains a **table-name NAMESPACE**, so two generations fold into ONE database
handle and are as separate as two databases: separate entity tables, separate `_blocks`, separate
`_cursor`, separate derived indexes. Deleting one generation's state is a `DROP` of exactly its
tables.

This is the substrate under "the canonical generation keeps answering while a successor rebuilds".
Without it a successor writes into the incumbent's rows, and — because the sync cursor lives under one
fixed key — into its cursor too, so the promise the whole spec rests on cannot even be expressed.

**The boundary is exact.** The namespace covers everything the STORE owns and nothing the SERVER
owns: `_meta`, `_emissions` and the generation registry are per NAMED INDEXER and are deliberately
SHARED across its generations, because a processor-only change re-folds the same stored stream and
that is what makes it free. Do not namespace them, and do not let the store's namespace leak into the
static schema file.

Points that decide whether this lands correctly:

- **`_blocks` and `_cursor` are namespaced too, not just the entity tables.** Two generations on the
  same chain would otherwise share one block table, where one generation's `revertTo` deletes rows the
  other still needs, and one fixed cursor key, where the second fold silently resumes on the first's
  position.
- **The namespace is a NAME, derivable before the processor exists.** A generation is
  `{stream digest, processor version hash}` and both halves are computable up front (the digest from
  the source and stream config; `EntityEventProcessor.getVersionHash()` from the declared version, the
  entities and the config), so the caller names the namespace and the state-then-processor build order
  (ADR-0043) still holds.
- **Identifier discipline is this backend's, not the seam's.** Entity names are validated and quoted at
  declaration time and the `_` prefix is reserved for the store; a namespace prefix must not change
  what a DECLARATION may say, must stay inside SQLite's identifier rules, and must keep the derived
  index names collision-free for the reason the existing `_`-prefixed index naming exists.
- **Absent namespace = today's names, byte for byte.** Every existing deployment and every existing
  test keeps the tables it has; this is additive.

## Acceptance criteria

- [ ] Two `VersionedStateStore` instances over ONE `RemoteSQL` handle under DIFFERENT namespaces:
      writing entities in one changes nothing readable in the other, and their sync cursors are
      independent.
- [ ] A revert in one generation's store does not touch the other's blocks or rows.
- [ ] Dropping one generation's state removes exactly its tables (and their indexes) and leaves the
      other complete and READABLE — assert a read after the drop, not just a table listing.
- [ ] The server-owned fixed tables (`_meta`, `_emissions`, the generation registry) are NOT namespaced
      and are still found by the code that owns them.
- [ ] With no namespace configured, the created table and index names are exactly what they are today.
- [ ] The conformance suite still passes for this backend, including with a namespace configured.
- [ ] Tests cover the new behaviour, in the repo's existing style.

## Blocked by

- None — can start immediately.

## Prompt

> Make the SQLite/libSQL versioned state store able to hold SEVERAL GENERATIONS in ONE database by
> giving it a table-name namespace.
>
> Vocabulary (`CONTEXT.md`): a **generation** is a stream plus a fold over it, identified by
> `{stream digest, processor version hash}`; a **version** is one complete row of an entity with a
> half-open block-validity range; the **sync cursor** lives behind the storage seam under a
> caller-chosen key and is written in the same transaction as the block it describes (ADR-0027).
>
> Where to look: `@etherfold/state-store-sqlite` — `ddl.ts` (the one module that emits DDL, and the
> note explaining why entity DDL is dynamic and why derived index names carry a prefix), `statements.ts`,
> `store.ts`, `query-surface.ts`, `identifiers.ts`. The seam and its rules are `@etherfold/state-store`;
> the conformance suite a backend must pass is `@etherfold/state-store-conformance`. Who constructs the
> store today is `buildProcessor` in the CLI's folding module — leave it alone here, wiring the
> namespace to a real generation is a later task.
>
> Constraining decisions: **ADR-0053** (a generation's state is a table-name namespace inside one
> database, a named indexer is a database; and why a generation COLUMN and a database-per-generation
> were both rejected), ADR-0043 (a generation is built state first, and its factories are per
> generation), ADR-0021 and ADR-0025 (what the read surface is allowed to be).
>
> Seams to test at: two stores on one handle, asserted through the seam's own reads and through
> `revertTo`/`prune`; and the conformance suite, run with a namespace set. Done means two generations
> can fold into one database with no shared row, no shared cursor and no shared block table, and
> dropping one leaves the other readable.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if a
> dependency landed differently or an ADR superseded an assumption here, route the task to
> needs-attention with the discrepancy rather than building on the stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do
> not write the done record, the commit message or the PR body yourself.

## Open questions

- the-canonical-pointer-moves-back-without-re-ingesting is not blockedBy the-rebuild-replays-the-local-stream-in-bounded-chunks, but it cannot be built without it: on this runtime the chain-free container created by a-changed-context-creates-a-successor-instead-of-clearing deliberately stops short of promotion (its own What-to-build says so), and the rebuild task is the one that owns the FORWARD pointer move and explicitly takes the lift of the promotion trigger and its arming into a shared place as IN SCOPE. Built as written and in parallel, the revert task has nothing to revert FROM and no arming rule to assert its criterion 3 against, so it either stalls on a scope-fence violation or writes a second promotion trigger, which is exactly the two-sources-of-truth the rebuild task warns against. The revert task's own open question 2 also says it CONSUMES question 2 of the rebuild task, an ordering that is prose-only today. Fix: add the rebuild slug to blockedBy plus the Blocked-by prose (edit supplied). (work/tasks/backlog/the-canonical-pointer-moves-back-without-re-ingesting.md frontmatter blockedBy: [a-changed-context..., one-registry-entry...]; criterion 'After the revert, the automatic promotion policy does not move the pointer forward again'; rebuild task: 'The chain-free container this task builds on deliberately stops short of promotion ... That lift is IN SCOPE for this task.')
