---
title: 'The server and the CLI hold generations too, over the emission-stream table'
slug: the-server-and-cli-hold-generations-too
taskedAfter: [a-reconfigure-is-not-an-outage, indexer-server-feed]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **ABSORBS `indexer-server-feed`'s rebuild stories (9-11), which it supersedes.** That spec owns the
> STORAGE and the FEED — the ADR-0006 emission table, the two views, cursor semantics, compaction, the
> indexed topic columns — and this spec is `taskedAfter` it because it needs that table. Its rebuild
> stories described ADR-0008's blue-green: replay into a namespace keyed by the processor version hash,
> flip a pointer, DROP the old. Keyed by the processor hash alone that cannot express a FILTER change,
> and dropping the old namespace is what makes a revert impossible, so the generation model supersedes
> it rather than being layered on top of it. The boundary moved; the work did not duplicate.

> **SPLIT out of `a-reconfigure-is-not-an-outage`** under `TASKING-PROTOCOL` §2a. That spec's
> landables are all browser-side, and nothing in it builds a stream keeper over the server's storage.
> The generation MODEL is runtime-agnostic and stays there; this spec is the runtime.

## Problem Statement

`a-reconfigure-is-not-an-outage` makes a reconfigure survivable by holding several GENERATIONS and
moving a canonical pointer. It is specified per NAMED INDEXER and per GENERATION rather than per runtime,
deliberately — but every landable that actually RUNS a generation is browser-side, and the two stream
keepers that exist are the filesystem and IndexedDB.

The server has the same problem and none of the machinery:

- `StreamBuilder` holds an `EventProcessor` and calls **`processor.clear()`** whenever the persisted
  cursor carries a different source, config or processor version — on `/ingest` and on
  `/ingest/expected-from-block`. That is the outage, with a concrete call site.
- Its stream is the ADR-0006 **emission-stream table** behind `RemoteSQL`, not ordinal segments in a
  key/value store, so `appending-to-the-stream-costs-the-batch`'s keeper does not serve it.
- ADR-0008 already decided a blue-green rebuild FOR THE SERVER, keyed by the processor version hash
  alone. Its 2026-08-31 amendment records that the key was too narrow (it cannot express a filter
  change) and points at the generation model — a pointer that currently leads to a spec with no
  server tier.

**And the CLI is the same runtime.** The goal is a CLI that runs what a server runs, so this is one
spec, not two. Older text describing the CLI as a one-shot batch that never reconfigures describes
what it is today, not what it is becoming.

## Solution

The generation model, unchanged, over the server's storage. A generation is still a stream plus a
fold; one is canonical; the pointer moves when a successor is ready and moves back to revert.

Three things this runtime supplies that the browser one does not:

- **A stream keeper over the emission-stream table**, satisfying the same `ExistingStream` contract
  the key/value keepers do — read-only, because the fold already writes that table.
- **A generation container above `StreamBuilder`**, so a changed context creates a successor instead
  of calling `processor.clear()`.
- **The canonical pointer as a table row**, which is what ADR-0008's `current_version` row becomes.

## User Stories

1. As an operator, I want a feed whose context changed to be handled deliberately rather than by a
   silent `processor.clear()`.
2. As an operator, I want my server to keep answering queries from the canonical generation while a
   successor rebuilds, instead of serving progressively less.
3. As an operator, I want to move the pointer BACK to the previous generation when a new processor
   turns out worse, without re-ingesting.
4. As an operator, I want a rebuild in progress to be distinguishable from an empty result, which is
   the same absence-versus-contradiction distinction the reorg model and `SuspectedTruncationError`
   already make.
5. As an operator running MULTIPLE NAMED INDEXERS on one server or CLI, I want them fully isolated,
   so no query, prefix scan or cap in one can ever reach another's data.
6. As a developer, I want the CLI to run exactly what the server runs, so what I test locally is what
   deploys.
7. As an operator, I want a bound on how many generations a named indexer accumulates, and a loud
   refusal at the bound rather than a silent eviction.
8. As a maintainer, I want a processor-logic upgrade to rebuild state from the locally stored stream
   rather than from the chain, so an upgrade costs a local scan instead of a full re-index. (From
   `indexer-server-feed`, story 9.)
9. As a maintainer, I want the rebuild to run in BOUNDED CHUNKS against a durable checkpoint, so it
   completes on a serverless host that cannot hold a long-running loop. (From `indexer-server-feed`,
   story 10; ADR-0008's self-enqueueing queue reasoning survives unchanged, and the cron watchdog
   with it.)
10. As an operator, I want the canonical generation served throughout a rebuild and the pointer moved
    atomically at the end, so readers never observe partial state and a rollback before the move is
    free. (From `indexer-server-feed`, story 11 — now strictly stronger, because the retired
    generation is RETAINED under the caps rather than dropped, so the rollback stays free AFTER the
    move too.)

## Implementation, Testing and Tasking detail

**Tasked on 2026-09-05; the detail moved to the tasks and the durable WHY to an ADR**, as the one-time
trim `TASKING-PROTOCOL` §6 describes. The eleven answered open questions, the Implementation Decisions
and the Testing Decisions that lived here are now owned by the ten tasks below, which is where they
will be kept true. Nothing is lost: the full text is in git history, and the physical-mapping decisions
those questions settled are **`docs/adr/0053-a-generation-is-a-table-namespace-and-a-named-indexer-is-a-database.md`**.

None of the MODEL was re-decided here: generation identity, stream identity, the canonical pointer, the
caps that refuse rather than evict, cap-and-drain pausing and the `on-catch-up` promotion default are
all `a-reconfigure-is-not-an-outage`'s and are consumed unchanged. ADR-0008 is superseded in its KEY and
its RETENTION, not in its mechanism.

The ten tasks, in dependency order:

1. `the-generation-registry-is-durable-on-sql` — the registry, the canonical pointer and the caps as
   rows, over the port the model already defines.
2. `a-generation-folds-into-its-own-tables` — the per-generation table namespace in the versioned state
   store.
3. `the-stored-emission-stream-is-a-stream-a-successor-can-refold` — the read-only stream over
   `_emissions`.
4. `a-changed-context-creates-a-successor-instead-of-clearing` — the generation container above
   `StreamBuilder`, and the end of the `processor.clear()` outage.
5. `one-registry-entry-holds-several-live-wire-contexts` — the wire widening a filter-change successor
   needs, and `expected-from-block` answering per context.
6. `the-rebuild-replays-the-local-stream-in-bounded-chunks` — the platform-neutral driver, its durable
   checkpoint, and the pointer move at the end.
7. `the-canonical-pointer-moves-back-without-re-ingesting` — the revert.
8. `a-rebuild-in-progress-is-never-an-empty-answer` — the `/status` dimension and the refusal.
9. `two-named-indexers-never-touch-each-others-data` — a database per named indexer, and the guard.
10. `the-cli-and-the-server-hold-generations-the-same-way` — one path for both, and `build` at N=1.

**Story-to-task map**, so a hole is visible rather than argued: 1 → 4 + 5; 2 → 4 + 6; 3 → 7; 4 → 8;
5 → 9; 6 → 10; 7 → 1 (observable at 4); 8 → 6 (over 3); 9 → 6; 10 → 6 + 7. Tasks 2 and 3 are never
named deliverers and that is deliberate: they are the substrate every story above rests on.

Three tasks launched with `needsAnswers`, and the questions are in their bodies: what coverage a reader
over `_emissions` can honestly report (tasks 3 and 6, one question seen from two sides), and what an
operator's affordance for the revert is, given that the command set is pinned at five verbs (task 7).

## Out of Scope

- **The generation model itself**, which is `a-reconfigure-is-not-an-outage`.
- **The client-side stream keepers**, which are `appending-to-the-stream-costs-the-batch`.
- **The GraphQL query frontend.** Decided elsewhere (Hono, Yoga, Pothos over entity declarations) and
  guaranteed a schema source by `one-processor-everywhere`. What this spec owes it is the
  once-per-read-unit-of-work generation resolution the sibling pins, so a query cannot straddle a
  promotion.
- **Seeding a generation from a published artifact**, which is
  `a-generation-can-be-seeded-from-a-published-artifact`.
- **The Cloudflare Worker's rebuild SCHEDULING** — ADR-0008's self-enqueueing queue plus cron
  watchdog. This spec owes the platform-neutral bounded-chunk driver and its durable checkpoint; the
  queue binding, the cron trigger and the handler are a FOLLOW-ON task against `platforms/cf-worker`,
  which today has three files, hosts no processor, owns no store and has neither binding. Named here
  so the deferral is deliberate rather than forgotten.
- **A fetcher host running one fetch loop PER CONTEXT.** The receiver widening (task 5) is what makes
  it possible; building it is not this spec's.
- **Storing the emission stream on every deployment shape**, which is the prerequisite task
  `every-deployment-shape-stores-the-stream-it-folded` — landed 2026-09-05, ADR-0052. This spec READS
  that table and never reshapes it.

## Further Notes

The dropped stub `work/specs/dropped/an-ingest-server-reconfigure-is-not-a-blackout.md` asked three
questions about this runtime and was dropped because the sibling spec answered them at the model
level. This spec is the part that stub could not have written: not whether the server holds
generations, but what it costs over `RemoteSQL` and the ADR-0006 table.
