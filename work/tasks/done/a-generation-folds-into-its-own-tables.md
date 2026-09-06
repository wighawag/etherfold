---
title: 'A generation folds into its OWN tables, so two of them share a database and touch nothing of each others'
slug: a-generation-folds-into-its-own-tables
spec: the-server-and-cli-hold-generations-too
blockedBy: []
covers: []
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


## Decisions

**The option is `tableNamespace`, not `namespace`.** "Namespace" already means the reserved `_` prefix everywhere in this repo (`CONTEXT.md`'s entity-declaration entry, `every-fixed-table-lives-in-the-reserved-underscore-namespace`), so a bare `namespace` option in the same package would make one word mean two things. `tableNamespace` is ADR-0053's own noun ("a table-name namespace"). Rejected: `generationNamespace`, because the store must not learn what a generation is; the caller holds that identity. Touches: whatever the follow-on wiring task passes at construction.

**The namespace goes INSIDE the reserved `_` prefix (`_<ns>_blocks`), not in front of it (`<ns>__blocks`).** Uniform prefixing is one rule instead of two, but it makes the store's fixed tables stop starting with `_`, which breaks the invariant `every-fixed-table-lives-in-the-reserved-underscore-namespace` established and `packages/cli/test/fixedTableNamespace.test.ts` asserts on the one database a combined deployment shares between this store and `@etherfold/server`. Touches: that test's rule, and anything that identifies a fixed table by its prefix.

**A namespace is `[A-Za-z0-9]+`, and an underscore in one is a NEW refusal at construction.** The underscore is the join separator, so allowing one inside a namespace makes `a_b` + `c` and `a` + `b_c` one table: two generations silently sharing rows, the exact failure this exists to prevent. Banning it makes the join injective by construction rather than by a uniqueness argument a single store cannot check. Leading digits and mixed case ARE admitted, unlike a declaration at the seam, because every name this package emits is either quoted or begins with `_`, and a rendered `generationDigestOf` (32 lowercase hex, possibly digit-leading) must be usable as it comes. Alternatives considered: allowing `_` and demanding uniqueness from the caller (rejected: unverifiable and silent when wrong); demanding a letter-leading identifier (rejected: forces the wiring task to decorate a digest for no engine reason). Touches: the follow-on task that names namespaces from generation identities, which must not use `_`.

**`sqlite` is refused as a namespace.** Its entity tables would be `sqlite_<entity>`, which the engine refuses however quoted. Same rule and same placement as the existing `sqlite_` entity-name refusal, so it fails where it was configured rather than at `migrate()`.

**Two residual hazards left open and documented rather than closed.** (1) SQLite folds identifier case, so `genA` and `GENA` are one namespace here; a store sees only its own name and cannot refuse the collision, and a caller deriving the name from a digest never meets it. (2) An unnamespaced store declaring an entity literally named `genA_token` lands on namespace `genA`'s `token` table; closing that would mean refusing an entity name for what some *other* store might be called, which is the "legality depends on the neighbours" failure the derived index names were prefixed to avoid, and it needs a database mixing namespaced and unnamespaced stores, which the model does not produce.

**`drop()` is a verb on this backend, not on the `StateStore` seam.** The acceptance criterion needs a production path for "dropping one generation's state", and `@etherfold/server`'s registry already expects an injected `dropState` that owns no naming convention. Putting it on the seam would hand a handler a verb that erases the store, and a backend whose whole storage is a keyspace expresses the disposal differently. Touches: `SQLGenerationRegistryOptions.dropState`, which a later task will wire to this.

**`TableNames` is a REQUIRED parameter on every exported DDL/statement function** (breaking, changeset written; nothing outside this package calls them). A default would make forgetting it compile, and forgetting it does not throw: it quietly reads and writes the unnamespaced table beside the generation it belongs to.

**No new ADR.** ADR-0053 already owns this decision and its rejected alternatives; everything above is implementation detail inside it, and nothing is on disk anywhere yet (nothing constructs a namespaced store), so none of it is hard to reverse. The rationale lives in the module notes at each choice site.
