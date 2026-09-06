---
title: 'Two named indexers on one host never touch each others data, even with identical sources'
slug: two-named-indexers-never-touch-each-others-data
spec: the-server-and-cli-hold-generations-too
blockedBy: [one-registry-entry-holds-several-live-wire-contexts, a-generation-folds-into-its-own-tables]
covers: [5]
---

## What to build

Multi-tenancy made STRUCTURAL: a host registering SEVERAL named indexers gives each one its OWN
DATABASE, so no query, prefix scan or cap in one can ever reach another's data — even when the two
index the same chain, the same contracts and the same processor.

ADR-0053 decides the mechanism and the reason. The two levels have different LIFETIMES: the indexer
set is known at DEPLOY time, so N static bindings express it exactly (including on D1, whose bindings
are static), while a generation is created at RUNTIME and must live inside one binding as a table
namespace. There is also a correctness reason not to merely share: `_blocks` is
`number INTEGER PRIMARY KEY` with `hash` UNIQUE, so two named indexers on different chains collide on
block number with different hashes.

What this task actually changes: a named indexer's DATABASE becomes part of what its registry entry
resolves to, rather than a single handle shared by the whole host. `getDB` today answers per REQUEST
and knows no name — which is right for the host-level surfaces (`/status`, `/admin/setup`) and wrong
for anything keyed on a tenant. The entry object was designed to grow for exactly this kind of reason;
grow it, and make the routes that act on ONE named indexer (ingest, both feed views) use the handle
that name owns.

The guard is the test, and it must FAIL LOUDLY under any missing discriminator: two named indexers,
same chain, same contracts, same processor, both fed; then delete EVERYTHING in one and the other is
still complete and readable.

Note what is deliberately kept: `_emissions.indexer` stays even though it is redundant once each name
has its own database. It is correct, it costs little, and it is what a future serverless deployment
would need to colocate several named indexers in one D1 database. Colocation is explicitly not
required now.

## Acceptance criteria

- [ ] A host can register several named indexers, each resolving to its own database.
- [ ] Two named indexers with IDENTICAL sources, contracts and processor are fed independently: the
      state, the cursor, the stored stream, the reorg counters and the generation registry of one are
      untouched by the other.
- [ ] Deleting everything in one named indexer leaves the other complete and READABLE — assert reads
      after the delete, not table listings.
- [ ] A generation cap reached in one named indexer refuses in that one only.
- [ ] Routes acting on ONE named indexer use that name's handle; host-level surfaces (`/status`,
      `/admin/setup`) keep working on a host built with one name or none.
- [ ] A name the host was not built with is still a `404`, and a host with no registry is still `501`.
- [ ] A changeset accompanies the registry/options shape change.
- [ ] Tests cover the new behaviour, in the repo's existing style.

## Blocked by

- `one-registry-entry-holds-several-live-wire-contexts` — both tasks widen the registry entry, and
  serializing them is cheaper than resolving the conflict afterwards.
- `a-generation-folds-into-its-own-tables` — isolation has to hold across generations as well as across
  names, or the guard test proves less than it claims.

## Prompt

> Make the NAMED INDEXER a real isolation boundary on a host that holds several: one database each,
> asserted by a test that fails loudly if any discriminator is ever forgotten.
>
> Vocabulary (`CONTEXT.md`): an **indexer** is the NAMED unit — one indexed answer set over one chain,
> holding one canonical pointer and its caps, fully isolated from every other; the name is UNIVERSAL,
> supplied by the operator at deploy time, a ROUTE SEGMENT and a name-keyed REGISTRY entry on the
> server, and never DEFAULTED where it routes; **one name is one chain at a time**, so two chains live
> at once are two names.
>
> Where to look: `packages/server/src/registry.ts` and `types.ts` (`ServerOptions`, `getDB`, `getIndexer`
> and the docstrings explaining why each is injected and why the entry is an object), `api/resolve.ts`,
> `api/ingest.ts`, `api/feed.ts`, `packages/server/test/ingest.test.ts` (which already gives each named
> indexer its own database and says why), and the CLI's folding module, which closes over the name every
> stored emission row is keyed on.
>
> Constraining decisions: **ADR-0053** (a named indexer is a DATABASE; a generation is a table namespace
> inside one; why sharing one database would force `_blocks` and `_cursor` to be namespaced by name too),
> **ADR-0036** (the named indexer replaces the project axis, the discriminator is structural and part of
> a composite key every read and write takes), ADR-0052 (the name a combined process folds under, and
> where its default is allowed).
>
> Seams to test at: the routes, the store, the stored stream and the registry — the isolation claim is
> only worth what the test asserts, so assert it end to end. Done means one host runs two indexers that
> cannot see each other, and deleting one is a complete, cheap operation.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if a
> dependency landed differently or an ADR superseded an assumption here, route the task to
> needs-attention with the discrepancy rather than building on the stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do
> not write the done record, the commit message or the PR body yourself.


## Decisions

- **`IndexerRegistryEntry.db` is REQUIRED rather than optional-with-fallback-to-`getDB`.** Chosen because it makes the isolation structural: a host adding a second named indexer cannot omit the handle and silently inherit the first one's rows, because there is nothing to omit, and that is the "fails loudly if a discriminator is forgotten" property the task asks for. The alternative (optional `db`, defaulting to the host handle) keeps every existing host compiling untouched, but it is a default where a tenant-keyed handle is required, which is the same hazard class ADR-0036 forbids for the NAME. Third alternative considered and rejected: widening `getDB(c, name?)`, which the task explicitly rules out and which would give one function two meanings (host-level and tenant-level). *Touches:* every host that passes `getIndexer` (`etherfold index`, `@etherfold/platform-nodejs`, the Worker docs, six test harnesses), and it is a breaking type change covered by the changeset.
- **`indexerRegistry` now takes ENTRIES, and `singleContextEntry` takes the db first; `indexerEntryOn` is the new second builder.** A registry keyed by name must carry each name's handle, and I preferred `Record<string, IndexerRegistryEntry>` over `indexerRegistry(db, Record<string, LogIngestion>)` (which would have made colocation the easy path and one-database-per-name the awkward one, inverting ADR-0053) and over `Record<string, {db, ingestion}>` (which could not register a generation container). `indexerEntryOn` exists because `ReceivingIndexer` can no longer be registered as the entry itself: it answers the two questions but `@etherfold/core` knows no database by design. *Touches:* every `getIndexer` call site above, and the `@etherfold/server` public API.
- **Colocation (two names, one handle) stays expressible and is now explicit.** ADR-0053 keeps `_emissions.indexer` and the registry's name column for exactly that future, and two existing suites (`emissionStream`, the feed harness) assert what those columns do. Rather than forbid it, a host passes the same handle twice and the harnesses say why in a comment. The alternative (refusing a duplicate handle) would have deleted a documented future capability to enforce a rule the type cannot check across requests anyway.
- **The guard test gives a SUCCESSOR generation its own state handle instead of a table namespace inside the tenant database.** ADR-0053's namespace form is asserted over a real shared handle in `packages/cli/test/aChangedContextCreatesASuccessor.test.ts`, and it is not reachable from `@etherfold/server`'s dependency set (see the observation above); adding `@etherfold/processor-entities` + `@etherfold/state-store-sqlite` as devDeps purely for test convenience, or widening another package's options type, both grow past this task's fence. The *opening* fold still folds into the named indexer's own database, so the delete assertion remains a real claim: everything that name holds, state included, goes with the one `DROP`. *Touches:* nothing shipped; it bounds what this file proves, and the comment says where the other half is proved.
