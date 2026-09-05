---
title: 'The server and the CLI hold generations too, over the emission-stream table'
slug: the-server-and-cli-hold-generations-too
taskedAfter: [a-reconfigure-is-not-an-outage, indexer-server-feed]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **FORWARD-POINTER, ordering: task this AFTER `every-deployment-shape-counts-the-reorgs-it-concluded`
> has landed. SATISFIED — that task landed on 2026-09-05, so this ordering gate is now clear and
> nothing here is left to build for it.** That is a TASK rather than a spec, so it cannot be
> expressed as a `taskedAfter` edge, which is why it is written here where whoever tasks this will
> read it.
>
> Both change the SHAPE OF THE DATABASE `build` PRODUCES, so they must be serialised or the second
> retrofits the first. That task ALREADY gave `build` the fixed-table schema it lacked and writes the
> reorg counters through one writer; this spec makes `build` hold a generation. (That table was
> called `Meta` when this was written and is now `_meta`, renamed into the store's reserved `_`
> namespace so a processor-declared entity cannot silently collide with it.) And the two are
> already coupled by an argument, not merely by a file: the answer to open question 3 below turns on
> a `build`-produced database being indistinguishable from a `run`-produced one, which is exactly
> what that task established. Do NOT emit a task to add that table: it exists.
>
> `indexer-server-feed`, the `taskedAfter` edge above, is a separate and already-satisfied question:
> both of ITS deps (`historical-state-database`, `a-reconfigure-is-not-an-outage`) are in
> `specs/tasked/`, so it is unblocked and is the head of this chain.

> **ALSO ABSORBS `indexer-server-feed`'s rebuild stories (9-11), which it supersedes.** That spec
> owns the STORAGE and the FEED — the ADR-0006 emission table, the two views, cursor semantics,
> compaction, the indexed topic columns — and this spec is `taskedAfter` it because it needs that
> table. Its rebuild stories described ADR-0008's blue-green: replay into a namespace keyed by the
> processor version hash, flip a pointer, DROP the old. Keyed by the processor hash alone that cannot
> express a FILTER change, and dropping the old namespace is what makes a revert impossible, so the
> generation model supersedes it rather than being layered on top of it. Building blue-green and then
> replacing it would be paying twice. The boundary moved; the work did not duplicate.

> **SPLIT out of `a-reconfigure-is-not-an-outage`** under `TASKING-PROTOCOL` §2a. That spec's
> landables all edit `packages/browser/src/IndexerState.ts`, and nothing in it builds a stream keeper
> over the server's storage, so as it stood the destination was a browser-only generation model with
> a SERVER ADR (ADR-0008) amended to describe it. The generation MODEL is runtime-agnostic and stays
> there; this spec is the runtime.

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
spec, not two. Older text describing the CLI as a one-shot `indexToTip` batch that never
reconfigures describes what it is today, not what it is becoming.

## Solution

The generation model, unchanged, over the server's storage. A generation is still a stream plus a
fold; one is canonical; the pointer moves when a successor is ready and moves back to revert.

Three things this runtime supplies that the browser one does not:

- **A stream keeper over the emission-stream table**, satisfying the same `ExistingStream` contract
  the two key/value keepers do.
- **A generation container above `StreamBuilder`**, so a changed context creates a successor instead
  of calling `processor.clear()`.
- **The canonical pointer as a table row**, which is what ADR-0008's `current_version` row becomes.

**This runtime is the SECOND cursor-record keeper, not the first.**
`appending-to-the-stream-costs-the-batch` fixes a CURSOR CONTRACT of three properties and leaves
PLACEMENT to each keeper, subject to the cursor living within its stream's subtree. A SQL keeper holds
its cursor in its own ROW and updates it in the SAME transaction as the segment insert, which
satisfies all three directly. The IndexedDB keeper already does exactly this with `setMany`, writing
one segment per batch and never rewriting anything, so there is prior art rather than novelty — which
is itself the argument for the shared conformance material, since a SECOND implementation is where it
earns its keep. Note there is no tail and no seal to port: those were a filesystem strategy and
filesystem storage is not supported.

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

<!-- open-questions -->

## Open questions

1. ~~What is the emission-stream table's schema, and does it exist yet?~~ **ANSWERED, and it is why
   this spec is `taskedAfter indexer-server-feed`.** `StreamBuilder`'s docstring (not ADR-0006's — an
   ADR has none) says it "does not store the emission stream: that arrives with ADR-0006, in the
   `indexer-server-feed` spec". That spec owns the table; this one consumes it.
2. ~~**How does a generation partition that table?**~~ **ANSWERED, and the premise was wrong: a
   generation does NOT partition that table.** `indexer-server-feed` partitions the LOG table on
   (INDEXER NAME, STREAM), as COLUMNS in its first migration, because ADR-0006 keys the STREAM on
   `{source, config}` and only the STATE on `{source, config, processor}`. Partitioning the log on
   anything carrying the processor would fork the stored stream on a processor-only change, which is
   the case this model promises is free and which story 8 rebuilds FROM. Generations partition the
   STATE. (Columns rather than a schema or a table per partition: neither SQLite nor D1 has schema
   namespaces, and a table per partition would push the log table into dynamic DDL that the server's
   fixed-schema file deliberately excludes.)

   **The KEY SHAPE is not open either, and it is now PINNED — this paragraph's premise has been
   ACTED ON and is kept only so the reasoning is not re-run.** `CONTEXT.md` decides that on this
   runtime the discriminator is STRUCTURAL, part of a composite key every read and write takes,
   never a field a query may omit and never defaulted. When this question was written,
   `indexer-server-feed` was ungated and created that table with no discriminator in it, so tasked
   first it would have shipped a primary key AND a public feed cursor and route with no tenant.
   **That is fixed**: that spec now carries BOTH discriminators (the indexer NAME and the STREAM) as
   columns from the first migration, and it is no longer ungated — it has since been tasked and now
   sits in `work/specs/tasked/`, its `taskedAfter` edge onto `a-reconfigure-is-not-an-outage`
   satisfied. So there is nothing left to do here;
   do not go and re-fix it. (The original note said this was "recorded as a finding against that
   spec". It was recorded IN that spec, which is what actually happened and the right home; `finding`
   is a pinned term for verified EXTERNAL ground truth in `work/notes/findings/` and no such file
   exists or should.)
3. **Does the CLI hold several generations, or one?** A long-running server clearly can. A one-shot
   batch arguably should not, and forcing it to would add a pointer read to a path that has no
   reconfigure. If they differ, the difference must be in the HOST rather than in the model.

   **The EVIDENCE below is written in the PRE-RENAME command vocabulary and the engine it names is
   being retired — re-check it before answering.** `CONTEXT.md` now pins a five-command set in which
   the one-shot is **`build`**, `index` is the RECEIVING half of a split, and `serve` is read-only;
   and `work/specs/tasked/one-command-runs-the-whole-pipeline.md` moves all server-side folding onto
   `StreamBuilder`, so `indexToTip` and `EthereumIndexer` stop being the CLI's engine. The shape of
   the argument survives — different HOSTS over shared machinery is still where the difference would
   live — but the nouns do not.

   Evidence as checked at the time: `etherfold index` was a one-shot `indexToTip` that exits, and
   `etherfold serve` lazily imported `@etherfold/platform-nodejs` and ran the same server, so the two
   verbs were already different HOSTS over shared machinery.

   > **ANSWERED 2026-09-04 by wighawag.** The premise that the CLI and the server are two things is
   > the part to drop: **the CLI IS the server.** `run` follows, folds and answers HTTP in ONE
   > process, so "the server holds generations" and "the CLI holds generations" are one statement,
   > which is what story 6 already asks for. What differs between the commands is EXECUTION, not the
   > model.
   >
   > **`build` holds exactly ONE generation.** A one-shot has no reconfigure, so it never adds a
   > second and never promotes; it creates one and exits. That is the same model instantiated at
   > N=1, NOT a second model, and the distinction matters because
   > `every-deployment-shape-counts-the-reorgs-it-concluded` requires a database `build` produced to
   > carry the same facts as one `run` produced -- it emits a publishable artifact that is later fed
   > into another process. A `build` that held a DIFFERENT shape would make that artifact
   > distinguishable on exactly the axis that task says it must not be. Holding one costs a pointer
   > read at startup, against an artifact that is otherwise identical.
   >
   > So the difference lives in the HOST, as this question anticipated: a long-running host may add
   > and promote; a one-shot creates one and exits.

   The evidence above is superseded by this answer and kept only so the reasoning is not re-run. Its
   nouns (`indexToTip`, `EthereumIndexer`) are retired; the shape of its argument -- different HOSTS
   over shared machinery -- is what survived, and is what the answer records.
4. ~~**Where does `project`'s VALUE come from on a server or CLI?**~~ **ANSWERED, and the concept was
   renamed with it.** There is no `project`: the unit is a NAMED INDEXER (`CONTEXT.md`), because once
   an indexer is one chain and one answer set, a separate tenancy axis above it was a synonym. The
   NAME arrives on **`upload`**, alongside the source info and the processor, modelled on the
   thegraph CLI minus its create step. It is supplied by the operator, never defaulted, and refused
   when absent.

   The value therefore comes from a DEPLOY-TIME manifest rather than a runtime code upload: the
   server never loads a processor module (`ServerOptions.getIngestion` is injected precisely so an
   HTTP app never has to), and the Worker host could not anyway, since `loadProcessorModule` is
   `import()` over a filesystem path. `upload` bundles and DEPLOYS; a host registers the N named
   indexers it was built with.
5. ~~**What replaces `processor.clear()` in `StreamBuilder`?**~~ **ANSWERED. The DELETION SWEEP is
   precise and was never the open part.** There is exactly ONE call site, in the private `currentLastSync()`, reached
   from BOTH public methods (`expectedFromBlock()` and `receive()`) and therefore from both ingest
   routes; its docstring already flags that reading can WRITE for this reason. In the generation
   model that branch stops discarding and instead resolves-or-creates the generation the incoming
   context names, leaving the canonical one answering.

   ~~What stays OPEN is whose cursor `expectedFromBlock()` answers with.~~ **ANSWERED by question 6
   below**: it answers PER WIRE CONTEXT, not per indexer, so the ambiguity dissolves. Two generations
   on the SAME stream (a processor-only change) share one stream and therefore one cursor and one
   answer; two generations on DIFFERENT streams have different contexts and get different answers.
   The number was only ambiguous while the endpoint was assumed to return exactly one.
6. ~~**How does a FILTER-change successor get its logs?**~~ **ANSWERED: a registry entry holds SEVERAL
   LIVE WIRE CONTEXTS, and `expected-from-block` answers with one entry per context.**

   The problem was real: `ServerOptions.getIngestion` yielded ONE `LogIngestion` with ONE readonly
   `WireContext`, and `assertContext` refuses a foreign `{source, config}` with a `400` that is
   deliberately NOT resumable — so a successor on a NEW stream could not receive logs at all while
   the old generation was still being fed. This is the server's version of the browser's "a successor
   follows the head itself", and it does not port, because in the browser the indexer owns its own
   fetching and here it does not.

   The resolution rides on what `indexer-server-feed` already builds. That spec introduces
   `/{indexer}/ingest` and a NAME-KEYED REGISTRY resolving one `LogIngestion` per named indexer, with
   ONE live context each. THIS spec widens a registry entry to hold several: the route selects the
   INDEXER, and the batch's own `{source, config}` then selects WHICH stream-builder within it
   receives the batch. A context in neither is still the existing `400`, so the refusal families are
   untouched.

   `POST /{indexer}/ingest/expected-from-block` correspondingly answers with one
   `{context, expectedFromBlock}` per LIVE context rather than a single pair. That is a WIDENING of
   what it does today — it already returns its `context` beside the block number, precisely so a
   sender knows which receiver it reached — and it is what lets one fetcher host run one fetch loop
   per context. Record it as a deliberate response-shape change with a changeset.

   The one thing to build carefully: a successor's context becomes live when the successor is created
   and stops being live when its generation is dropped or the successor becomes canonical and the old
   stream is reaped. That lifetime is this spec's, since it owns generation creation and the caps.
7. ~~**Where does a NON-CANONICAL generation's state live on ONE SQL database?**~~ **ANSWERED: a
   TABLE-NAME NAMESPACE per generation, never a generation COLUMN.** A column's single advantage is
   cross-generation queries, which this spec does not want. Against it: ADR-0008 ends blue-green by
   DROPPING the old namespace, which is `DROP TABLE` under a namespace and a full-scan
   `DELETE ... WHERE generation = ?` under a column — not reclaiming pages without `VACUUM`, and
   bounded by the D1 per-request limits `platforms/cf-worker/src/d1.ts` already encodes, so undoing a
   rebuild would need its own bounded-chunk driver. A column also forces every index to LEAD with the
   generation and makes every read seek past rows it can never return, degrading reads during exactly
   the window ADR-0008 says readers must keep being served. And a namespace makes story 5 structural:
   deleting one generation is a `DROP`, not an argument about a filter nobody forgot.

   **Why this does NOT contradict the emission table choosing COLUMNS.** That decision was justified
   by a constraint that does not reach here: "a table per partition pushes the log table into dynamic
   DDL the fixed schema deliberately excludes". `packages/server/src/schema/sql/db.sql` is a STATIC,
   enumerable artifact (`schemaStatements` parses that one file, and a test asserts the statements
   come from it), so a table whose NAME is computed at runtime cannot be expressed in it. The state
   store has no such artifact and never could: `ddlForEntity` GENERATES `CREATE TABLE IF NOT EXISTS
   "<entity>"` at runtime from user-declared entities. Adding the generation is one more input to a
   generator that already exists. Dynamic DDL is impossible in the log regime and already the norm in
   the state regime, so choosing differently is principled rather than inconsistent.

   Rejected: **database-per-generation**. D1 bindings are static (`wrangler.toml`), so a generation
   created at RUNTIME cannot get one, and it would break the one-handle property `run` relies on.
8. ~~**Does the INDEXER NAME use the same mechanism at a second level?**~~ **ANSWERED: NO — one
   DATABASE per named indexer, and the namespace mechanism is used only for generations.** The two
   levels have different LIFETIMES, and that is what picks the mechanism. The indexer set is known at
   DEPLOY time ("a host registers the N named indexers it was built with"), so N static D1 bindings
   express it exactly; a generation is created at RUNTIME, so it must live inside an existing binding
   and can only be a namespace within one.

   This is also what the code already does: `packages/server/test/ingest.test.ts` gives each named
   indexer its OWN database, saying "there is no shared table here to partition yet". And there is a
   correctness reason not to merely share one: `_blocks` is `number INTEGER PRIMARY KEY` with `hash`
   UNIQUE, so two indexers on DIFFERENT chains collide on block number with different hashes. Sharing
   a database would force `_blocks` and `_cursor` to be namespaced too, at which point separate
   databases are simpler and give story 5 the stronger guarantee.

   **Accepted cost, stated:** this makes `_emissions.indexer` redundant for the shapes this spec
   builds. It is kept — it stays correct, costs little, and is what a future serverless (D1)
   deployment would need to colocate several indexers in one database. Colocation is explicitly NOT
   required now.
9. ~~**What IS the SQL stream keeper, and does it become the `_emissions` writer?**~~ **ANSWERED:
   NEITHER — the FOLD writes, and the keeper only READS.** The question assumed the route must own
   the append because only the route segment holds the indexer name. That premise is the defect, not
   the constraint: it is the same shape ADR-0050 removed for reorg counters, and it is being fixed
   ahead of this spec by `work/tasks/.../every-deployment-shape-stores-the-stream-it-folded.md`,
   which injects an emission-appending port into `StreamBuilder` (the sibling of `ReorgRecorder`) so
   every deployment shape stores what it folded. TASK THIS SPEC AGAINST THAT WORLD.

   With the append in the fold, the "SQL stream keeper" is simply an `ExistingStream` over
   `_emissions` whose `saveNewEvents` and `clear` are NO-OPS — which is exactly ADR-0044's
   `readOnlyStream`, the thing a FOLLOWER generation re-folds through. So there is no second writer to
   reason about and the one-writer rule stays structural.

   **The cursor question dissolves with it:** the contract wants the cursor to move in the SAME
   transaction as the append, and once the append is in the fold, that is already the transaction
   where state and cursor move atomically.

   **Do NOT ride `createSegmentedStream` over SQL.** Implement `ExistingStream` directly over `seq`.
   Segments exist because the IndexedDB keeper needs batched writes; SQL does not, and `_emissions` is
   already `seq`-addressed with holes legal and a validated cursor codec. Accepted cost, stated: the
   shared conformance material attached to the segment port does not apply to this implementation.

   **Vocabulary warning for the tasker:** "keeper" is overloaded in `CONTEXT.md`. The STATE keeper
   (`KeepState`) is DELETED (ADR-0037) and nothing persists through one; the STREAM keeper
   (`ExistingStream` / `keepStream`) is live and is what this answer means.
10. ~~**How much of story 9's serverless HOST does this spec owe?**~~ **ANSWERED: the
    PLATFORM-NEUTRAL bounded-chunk driver here; the Worker's queue and cron wiring elsewhere.** This
    repo already has the pattern twice — `prune` and `compactEmissionPairs` are host-scheduled calls
    doing bounded work per invocation and reporting whether they finished (ADR-0022), with the
    compaction task asserting resumability by driving call after call through a FRESH container. Story
    9 is that same shape: a rebuild driver doing bounded work against a durable checkpoint row, tested
    the same way.

    ADR-0008's self-enqueueing queue with a cron watchdog is a SCHEDULING POLICY over that driver. It
    needs a queue binding and a cron handler `platforms/cf-worker` does not have (three files, no
    processor, no store), and it is Cloudflare-specific where the driver must serve a Node cron, a CLI
    loop and a browser equally. Building both here would make the whole generation model undeployable
    until the Worker grows bindings. The Worker wiring is a FOLLOW-ON task against
    `platforms/cf-worker`, and is named in Out of Scope so it is not lost.
11. ~~**Which surface makes a rebuild in progress distinguishable from an empty result (story 4)?**~~
    **ANSWERED: it is TWO surfaces, and separating them dissolves the question.**

    - **An OPERATOR watching progress reads `/status`.** ADR-0047 already reserves the room — the
      generation dimension "grows inside" the cursor envelope, and the host owns the contents — so the
      envelope gains a per-generation entry: the canonical one, plus any rebuilding one with its
      checkpoint. Additive, and it adds no endpoint, which `one-command-runs-the-whole-pipeline`
      forbids.
    - **A CONSUMER doing a read has no ambiguity, by construction.** A read is served from the
      CANONICAL generation and already advertises the generation identity it answered from, and
      ADR-0008's whole point is that readers never see partial state. A rebuilding generation is never
      the one answering.
    - **The one real case is "no canonical generation YET"** — a first build, where the state is
      genuinely empty AND a rebuild is running. That is ADR-0015's territory: REFUSE the read, naming
      the generation that has not caught up. Never answer empty.

<!-- /open-questions -->

## Implementation Decisions

**None of the MODEL is re-decided here.** Generation identity (its STREAM plus the processor version
hash — the VERDICT decides whether anything is created at all, which is a different question and one
the model spec keeps deliberately separate), stream identity (the deduplicated `streamHash` digest plus the stream config hash),
the canonical pointer, the caps that refuse rather than evict, cap-and-drain pausing, and the
promotion policy defaulting to `on-catch-up` everywhere are all
`a-reconfigure-is-not-an-outage`'s and are consumed unchanged. Restating any of them here would
create a second source of truth that drifts.

**The INDEXER NAME is the discriminator**, structurally non-omittable, and it is the same composite
key `indexer-server-feed` pins on the emission table. That spec owns the table and now also owns the
physical mapping (COLUMNS, since neither SQLite nor D1 has schema namespaces); this spec consumes it.

**One name is one chain at a time**, and the consequence is worth stating because it removes a
feature rather than adding one: changing an indexer's chain moves `chainId`/`genesisHash` in the
block-0 skeleton entry, so it moves the source hash and therefore the STREAM — an ordinary
reconfigure that makes a new generation, with the old one retained and revertible. So this runtime
needs no chain axis in its tenancy key at all. Two chains live at once are two names.

**ADR-0008 is superseded in its KEY and its RETENTION, not in its mechanism.** Its rebuild-alongside
and flip-a-pointer shape is what this builds. Its namespace key (processor version hash alone) cannot
express a filter change and is replaced by the generation identity. Its drop-the-old-namespace rule is
replaced by the caps, which is what makes moving the pointer back possible. That amendment is already
recorded on the ADR; this spec is the thing it points at for the server.

## Testing Decisions

- **A context change creates a successor rather than calling `processor.clear()`**, asserted at that
  call site, which is the concrete outage this spec removes.
- **Queries keep being served from the canonical generation** across a full rebuild, and a rebuild in
  progress is distinguishable from an empty result.
- **The pointer moves back** and the previous generation answers exactly as before, with no
  re-ingestion.
- **The cursor contract is satisfied by the SQL keeper**, asserted against the same three properties
  as the IndexedDB keeper rather than against a layout — ideally through the shared conformance
  material `appending-to-the-stream-costs-the-batch` names, which is where a third implementation
  earns its keep.
- **Two NAMED INDEXERS with identical sources never touch each other's data**: same chain, same
  contracts, same processor; deleting everything in one leaves the other complete and readable. This
  is the multi-tenancy guard and it fails loudly under any missing discriminator.
- **The CLI and the server take the same path**, asserted by driving both through one fixture.

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
  watchdog. This spec owes the platform-neutral bounded-chunk driver and its durable checkpoint
  (open question 10); the queue binding, the cron trigger and the handler are a FOLLOW-ON task
  against `platforms/cf-worker`, which today has three files, hosts no processor, owns no store and
  has neither binding. Named here so the deferral is deliberate rather than forgotten.
- **Storing the emission stream on every deployment shape**, which is the prerequisite task
  `every-deployment-shape-stores-the-stream-it-folded`. Story 8 rebuilds from the LOCALLY stored
  stream, and until that task lands `run` and `build` store none; this spec READS that table and
  never reshapes it.

## Further Notes

The dropped stub `work/specs/dropped/an-ingest-server-reconfigure-is-not-a-blackout.md` asked three
questions about this runtime and was dropped because the sibling spec answered them at the model
level. This spec is the part that stub could not have written: not whether the server holds
generations, but what it costs over `RemoteSQL` and the ADR-0006 table.
