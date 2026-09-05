---
title: 'Every deployment shape stores the emission stream it folded, not only the one behind an HTTP route'
slug: every-deployment-shape-stores-the-stream-it-folded
blockedBy: []
covers: []
---

## What to build

Make the stored EMISSION STREAM a fact of the FOLD rather than of the transport, so `run` and
`build` store what they folded exactly as `index` does.

Today `appendEmissions` (`packages/server/src/emissions.ts`) has exactly ONE call site: the HTTP
ingest route (`packages/server/src/api/ingest.ts`). `run` and `build` fold through
`createDirectIngestion` and never touch a route, so **a database they produce has an EMPTY
`_emissions` table**. The feed views work only on the split shape.

**This is the same defect ADR-0050 removed one task earlier**, in the same place, for the same
reason: a fact concluded by the fold was being written by whichever entrance the batch arrived
through. It also contradicts ADR-0050's own recorded consequence, that a database `build` produced
must be indistinguishable from one `run` produced.

### Why it matters more than the counter did

A `build`-produced database is a publishable ARTIFACT that is later fed into another process. With no
stored stream:

- a processor-logic change must RE-FETCH the whole history from the node rather than re-folding what
  is already on disk, which is the cost the stored stream exists to remove;
- `the-server-and-cli-hold-generations-too` story 8 ("rebuild state from the locally stored stream")
  is unbuildable on exactly the shapes that hold a local store.

### The shape, DECIDED — follow ADR-0050's, with ONE deliberate difference

**The write moves INTO the fold**, through a port injected by whoever owns the store: an emission
appender on `StreamBuilder`, the sibling of the `ReorgRecorder` ADR-0050 introduced. The route stops
being a writer and the indexer NAME arrives from the host that registered the indexer rather than
from the URL segment.

**The difference, and it is the important part: this write is NOT best-effort.** ADR-0050's counter
may fail and be logged, because losing a count is better than rolling back the state it describes. A
lost EMISSION is the opposite: `CONTEXT.md`'s **hole** entry says a state that advanced past events
the stream never received is silent, permanent and self-consistent corruption, invisible to the gap
check, and that it is fixed on the ENGINE side "by writing the stream BEFORE processing and not
processing a batch that was not saved". So the append is ordered BEFORE the fold and a batch whose
append failed is NOT processed. Do not copy `noteReorg`'s catch-and-log here.

### The indexer name on a combined shape

`--indexer` is a WIRE option today: required on `fetch` and `index`, not accepted on `run`/`build`.
The emission row needs one (`indexer` is `NOT NULL`).

**Decided: `--indexer` becomes OPTIONAL on `run` and `build`, with a documented default, and stays
REQUIRED and never defaulted on `fetch` and `index`.** ADR-0036's never-defaulted rule exists so a
misdirected BATCH is a routing error rather than a payload one; a combined process has no wire and no
routing, so that rule's purpose does not reach it. Requiring it would break `etherfold run`, the
readme's headline one-liner, for a discriminator that only matters once databases are colocated.
Record the default and the reason.

## What this is NOT

- **NOT a change to the emission table's SCHEMA.** No column is added, removed or re-keyed. It still
  carries no generation and nothing about the processor.
- **NOT a change to what `_emissions` MEANS** or to the two feed views over it. Their tests must pass
  untouched.
- **NOT best-effort.** See above. If you find yourself catching and logging an append failure, stop.
- **NOT the generation model.** One stream per named indexer here;
  `the-server-and-cli-hold-generations-too` owns generations and reads this table, it does not
  reshape it.
- **NOT a re-opening of ADR-0036's never-defaulted rule for the WIRE.** The default is for the
  combined shapes only, which have no wire.

## Acceptance criteria

- [ ] `run`, `build` and `index` all append their emissions, and a database each produced carries the
      same rows for the same chain. Asserted as an EQUIVALENCE between the combined and split shapes,
      in `packages/cli/test/equivalence.test.ts`, beside the reorg-counter comparison ADR-0050 added.
- [ ] Asserted on a database `build` EMITTED, not only on a live process, exactly as ADR-0050's
      `Meta`/`_meta` criterion is.
- [ ] The write goes through ONE path and the route is a CALLER, not the owner. A test asserts there
      is no second append site, in the shape of `packages/core/test/oneReorgWriteSite.test.ts`
      (including its guard against a vacuous scan).
- [ ] A combined process does not DOUBLE-append by both folding and receiving; the split shape's rows
      are unchanged. Assert the split shape is unchanged rather than assuming it.
- [ ] **A failed append does NOT advance the state**: the batch is not processed, the cursor does not
      move, and the next cycle re-derives the same delta. Asserted with a store that refuses the
      append, and asserted to leave NO hole (state and stream agree about how far they got).
- [ ] Retractions still land as retractions, `alive` is still maintained, and `seq` still allocates
      monotonically per `(indexer, stream)` with holes legal, on every shape.
- [ ] `--indexer` is accepted and optional on `run`/`build` with its default documented, still
      required and never defaulted on `fetch`/`index`, and a test covers both halves.
- [ ] Both feed views answer over a database a COMBINED process folded, given a host that resolves
      that indexer, so the feed is no longer a split-shape-only surface.
- [ ] Ship a changeset for every published package whose surface changes.
- [ ] `pnpm build && pnpm typecheck && pnpm test` green.

## Blocked by

- None.

## Prompt

> Make the stored emission stream a fact of the FOLD rather than of the transport in `etherfold`.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does
> it still match the code, `work/tasks/done/` and the ADRs (0050 on a concluded reorg being counted by
> the fold and persisted by the store's owner, 0036 on the named indexer and why the name is never
> defaulted on the wire, 0006 on the stored stream, 0038 and `CONTEXT.md`'s "hole" entry on why a
> stream must be written before the state advances)? If a premise no longer holds, route to
> needs-attention with the discrepancy rather than building on it.
>
> The defect: `appendEmissions` has exactly one call site, the HTTP ingest route. `run` and `build`
> fold through `createDirectIngestion`, never reach it, and therefore produce databases with an EMPTY
> `_emissions` table. This is the same shape ADR-0050 removed for the reorg counters one task earlier,
> and it contradicts that ADR's own consequence that a `build`-produced database must be
> indistinguishable from a `run`-produced one.
>
> Fix it the way ADR-0050 did: inject an emission-appending port into `StreamBuilder`, the sibling of
> `ReorgRecorder`, supplied by whoever owns the store and closed over the indexer name the host
> registered. The route becomes a caller.
>
> ONE DELIBERATE DIFFERENCE, and it is the part to get right. The counter is best-effort and catches
> its own failure; THIS WRITE MUST NOT. A lost emission is a HOLE: a state that advanced past events
> the stream never received, which is silent, permanent, self-consistent and invisible to the gap
> check. So append BEFORE processing and do not process a batch whose append failed. Do not copy
> `noteReorg`'s catch-and-log.
>
> The combined shapes need a name for the `NOT NULL` `indexer` column. Make `--indexer` optional on
> `run`/`build` with a documented default; keep it required and never defaulted on `fetch`/`index`,
> because the never-defaulted rule protects the WIRE and a combined process has no wire.
>
> Do NOT change the emission table's schema, do not change what the two feed views mean, and do not
> build any part of the generation model.
>
> Done means: all three folding shapes store what they folded, a `build` artifact carries its stream,
> exactly one append site exists and a test says so, a refused append leaves no hole and does not
> advance the state, and the feed answers over a database a combined process produced.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in
> particular where the append sits relative to `processor.process`, how the failure path guarantees no
> hole, and what the combined-shape default name is. Moving this seam may meet the ADR gate
> (`work/protocol/ADR-FORMAT.md`); if it does, write the ADR and name it in the block.

## Decisions

**Where the append sits relative to `processor.process`, and how the failure path guarantees no hole.** The append is the first durable act of `receive`, immediately after the delta is derived and strictly before `processor.process`, and it is *not* wrapped: a failure propagates out of `receive`, so the processor is never called, the store's transaction never opens, the cursor never moves, and the next cycle re-derives the identical delta. Alternative considered and rejected: append after the fold (that is the order the route had, and it is exactly what produces a hole). The accepted cost in the other direction, documented at the call site and in the ADR: if the append lands and the fold then fails, the stream is one batch ahead and the re-derived delta is appended again — legal by ADR-0038 ("ahead or level, never behind"), whereas a hole is not. Touches: `StreamBuilder.noteReorg` stays catch-and-log, so the two ports next to each other now have deliberately different failure semantics.

**A refused append stops the fold, which changes what `--no-auto-setup` does.** Because `_emissions` is a fixed table, a folding command pointed with `--no-auto-setup` at a database nobody has migrated now retries its cycle and reports no progress instead of indexing on. The error carries no `retryable: false`, so the fetcher host classifies it as `retry` and the deployment catches up by itself once the schema arrives. This is user-visible and it invalidated an existing equivalence case ("folds identically when it cannot write the counter at all"), which I replaced with the no-hole/catch-up case; the counter's best-effort guarantee is still pinned at the unit level in `packages/core/test/streamBuilder.test.ts`. Touches: `--no-auto-setup` on `run` and `index`, and the README paragraphs about it.

**The combined-shape default name is the constant `default` (`DEFAULT_INDEXER_NAME`, `packages/cli/src/config.ts`).** Alternatives: derive it from the database file name (rejected — a copied or moved file would silently fork the stored stream), or require the flag (rejected — it breaks `etherfold run`, the readme's headline one-liner, for a discriminator that only matters once two answer sets share a database). `run` and `build` share the one constant so an artifact one built is one the other continues. Touches: ADR-0048 ("only the port may default") is amended by ADR-0052; ADR-0036's never-defaulted rule is *narrowed to routing*, not re-opened — `fetch`/`index` are unchanged and a test covers both halves. It also touches `--help` (the flag is now visible on `run`/`build`) and `RunConfig`/`BuildConfig`, where I put `indexer` as a plain field and deliberately *not* inside a `Wire`.

**The SQL write stays in `@etherfold/server`, so `etherfold` takes it as a real dependency (dev → prod).** This is the one place I diverged from ADR-0050's placement, which put the reorg SQL in the CLI. Reason: `@etherfold/server` owns the emission table's DDL, both of ADR-0006's views, and the `seq` high-water read that the append and the canonical view's cursor must agree about; moving the write out would split one table's contract across two packages and duplicate the row shape. The CLI already starts that server in three of its five commands, and the import is dynamic like the rest of `buildProcessor`. Alternative considered: put the SQL in the CLI and have the server test keep a copy (as `test/utils/hostRecorder.ts` does for counters) — rejected as duplication of the table's own semantics.

**The one-append-site test lives in `packages/server/test/`, not `packages/core/test/`.** Its sibling is in core because the durable *key names* it scans for are in core; the durable name here is `EMISSION_STREAM_TABLE`, which the server owns, so importing it there is what keeps the test and the table from drifting. It still scans the whole workspace and keeps the vacuous-scan guard.

**The port is OPTIONAL on `StreamBuilder`, like `ReorgRecorder`.** A host that supplies none stores no stream and folds identically (asserted). Rejected making it required: it would be a constructor break for every embedder, and the honest statement is that storing a stream is the store owner's capability, not the engine's. Every shipped shape supplies one; the consequence (such a host has no feed to serve) is documented on the type.
