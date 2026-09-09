---
title: 'One command runs the whole pipeline, and the split is a deployment choice rather than a milestone'
slug: one-command-runs-the-whole-pipeline
taskedAfter: [one-processor-everywhere]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **ANSWERED AND RE-SCOPED, 2026-09-03.** Tasking was attempted on 2026-09-02 and STOPPED at
> `TASKING-PROTOCOL` §2's drift check, because one of the two problems this spec is motivated by had
> been solved. The four questions are answered below against the tree, the Problem Statement is
> corrected, and the spec is taskable. The command set survived; the SCOPE shrank.

## Answers

1. **How much is already delivered? Three things, and the spec is smaller than it reads.** Verified
   row by row against the tree on 2026-09-03:

   | row | today | verdict |
   | --- | --- | --- |
   | `run` | nothing assembles it | **MISSING, and it is the headline** |
   | `build` | today's `index` (the default command) | exists, misnamed |
   | `fetch` | the `etherfold-fetch` bin in `platforms/nodejs-fetcher` | exists, wrong front door |
   | `index` (new meaning) | nothing | **MISSING** |
   | `serve` | `serve` | exists |
   | `/status` cursor | `healthy`, `database`, `reorgs`, `schema`, `lastError` and nothing else | **MISSING** |

   So the genuinely NEW work is `run`, the new `index`, and one `/status` field. `build` and `fetch`
   are a rename and a re-homing of things that already work. **Do not let the shrink lose the new
   `index`:** it is not a cosmetic re-meaning, it is the WIRE RECEIVER, and its absence is exactly the
   "a split deployment is missing its RECEIVER" gap the Problem Statement names — today's `serve` is
   constructed with `{getDB, getEnv}` and no `getIngestion`, so it hosts no processor.

2. **The rename stands, this spec owns it, and it MUST land before publishing.** Nothing is published
   yet, so renaming the only shipped command costs nothing today and becomes a breaking change to a
   shipped CLI the moment `publish-etherfold-and-deprecate-old-names` runs. That is the same
   permanent asymmetry the publish task already respects by blocking on
   `a-snapshot-a-client-cannot-read-is-refused-not-installed` ("today the fix is free; after
   publishing, the same fix is a breaking correction to a shipped package"). **The rename task this
   spec emits must therefore be added to `publish-etherfold-and-deprecate-old-names`'s `blockedBy`,
   on that precedent.**

3. **The flag surface still matches, with ONE correction.** Verified: `--store` survives, is
   REQUIRED, takes exactly one value (`sqlite`), and `--db <url>` is required alongside it. The
   surviving `-d` flag is the DEPLOYMENTS folder (hardhat-deploy/rocketh format) and is unrelated to
   the retired fs-state `--folder`; do not conflate them. The correction: because `--store` is
   required, the `fetch` row — the one command that owns no database — must state that `--store` and
   `--db` are **NOT ACCEPTED** there rather than optional. Otherwise `fetch` inherits a required flag
   it has no use for, and the failure lands on the one command that should need nothing but a node URL
   and an ingest endpoint.

4. **Still the only new surface, and the seam is intact.** Verified: `/status` reports no cursor, and
   `d1-limits-reach-the-stores-batch-bounds` did NOT foreclose the seam — the server remains
   host-agnostic, with everything host-shaped arriving through `getDB`/`getEnv`. So the injected
   reporter is still right, and now has a landed precedent to imitate rather than a plan to invent.
   **Forward-note, load-bearing:** `a-reconfigure-is-not-an-outage` landed a model where an indexer
   holds several GENERATIONS and progress is reported per generation. The server does not hold
   generations yet (`the-server-and-cli-hold-generations-too`), so report ONE cursor now — but shape
   the field so it can grow a generation dimension later, rather than hard-coding a scalar that work
   would have to break.

## Problem Statement

**The combined pipeline already works, and no user can run it.** `one-processor-cli-and-split-server`
proved with a test that one processor and one set of entity declarations produce the same state under
the single-process path and the split path. That test constructs the pieces directly, so the capability
exists in the repo and is unreachable from a terminal.

What a terminal offers instead is two commands that each do part of it:

- **`etherfold index`** follows the chain, folds an ENTITY processor into SQLite, and exits at the
  tip. This is the one row that has since been DELIVERED: `index-to-a-store-from-the-cli` removed the
  `this processor do not support "keepState" config` refusal, and `packages/cli/src/keepState.ts` is
  gone entirely (ADR-0037). What is wrong with it now is only its NAME: a one-shot that terminates at
  the tip is this spec's `build`, and the `index` name is needed for the wire receiver.
- **`etherfold serve`** starts the HTTP server with `{getDB, getEnv}` and **no `getIngestion`**, so it
  hosts no processor and no fetcher. It is the RECEIVING half of a split — and the half it is waiting
  for is the one thing here that IS already runnable.

**The chain-facing half already has a binary, and the spec is worse if it pretends otherwise.**
`platforms/nodejs-fetcher` ships `etherfold-fetch` (`src/bin.ts` → `runFetcherProcess` →
`runFetcherLoop`), with signal handling and an exit code, configured entirely from the environment:
`INDEXING_SOURCE` as a JSON source, `ETH_NODE_URI`, `INGEST_ENDPOINT`, `INGEST_TOKEN`. So a split
deployment is missing its RECEIVER (a server host that actually holds a processor), not its sender.
So `fetch` below is a flag-driven front door onto an existing deployable rather than a new one, and
that bin is retired in the same change so there is exactly one way to run a fetcher.

So the shape a developer most wants — one process that follows a chain, folds into SQLite, and answers
an HTTP endpoint, on any Node runtime — is assembled by nobody, even though nearly every part of it
ships: `@etherfold/fetcher-host` (`runFetcherLoop`, backoff, scheduling) with its Node adapter,
`createDirectIngestion` in core (both halves of the ADR-0004 wire in one process, in about eighteen
lines), `@etherfold/state-store-sqlite`, and `@etherfold/server` behind `platforms/nodejs` on libSQL.
The one piece that does NOT ship is named in the Solution: `/status` reports no cursor.

**And the tree reads as though the split were the goal.** ADR-0003 split the components for good
reasons, and every spec since has been written per component, so a reader would reasonably conclude
that the split deployment is the target and the combined one a convenience. It is the other way round:
the combined deployment is the thing that must work end to end first, and the split is a deployment
choice made when a chain-facing host and a serving host genuinely need to be different machines.

## Solution

**Five commands, named for the DEPLOYMENT INTENT rather than for the internal split**, so choosing one
needs no knowledge of how the components divide:

| command | follows the chain | folds into state | answers queries | terminates | database |
| --- | --- | --- | --- | --- | --- |
| **`run`** | yes | yes | yes | no | owns it |
| **`build`** | yes | yes | no | at the tip | owns it |
| **`fetch`** | yes | no | no | no | none (`--store`/`--db` are REFUSED, not optional) |
| **`index`** | no | yes | no | no | owns it |
| **`serve`** | no | no | yes | no | reads one written elsewhere |

Two compositions, and both are true of the CODE rather than slogans: **`run` is `fetch` plus `index`
plus `serve` in one process** — the first pairing is precisely what `createDirectIngestion` expresses,
the same `LogFetcher` and the same `StreamBuilder` with the transport as the only difference
(`CONTEXT.md`, "the wire is a deployment choice, not two implementations") — and **`build` is `run`
without the serving, stopping at the tip**. No component is implemented twice, and no command is a
special case of another's code.

**`run` is the priority and the default thing to reach for.** It is the one that must work on any Node
runtime, and it is the one this spec exists to create.

**The query surface is `/status` and nothing more, deliberately — and it is one field short today.**
`/status` reports health, the reorg counters (`absence` versus `contradiction`, per ADR-0004), the
schema version and the last error. It does NOT report the cursor: `getStatusAPI` returns `healthy`,
`database`, `reorgs`, `schema` and `lastError` and nothing else, and no code in `packages/server/src`
reads one. (Do not run that as a GREP drift-check: the WORD `cursor` does appear there, seven times,
all in `api/ingest.ts` comments explaining that the cursor is the idempotency key. It is the FIELD
that is missing, not the word.) That matters twice over, because the cursor is the field that makes a pipeline
OBSERVABLE (story 6) and the one the headline test watches advance, so this spec cannot claim it as
existing surface.

**Getting it there is the one piece of new surface in this spec, and it is deliberately the smallest
shape that does not break a seam.** The server has no store dependency
(`d1-limits-reach-the-stores-batch-bounds` is blocked on exactly that), and the cursor is an opaque string
behind the storage seam (ADR-0027), so `@etherfold/server` must not learn to read a cursor table.
Instead the cursor arrives the way everything host-shaped already arrives: an injected reporter beside
`getDB` / `getEnv` / `getIngestion`, supplied by the process that owns the store, absent on a host
that has none, and reported verbatim rather than interpreted. A richer query layer is real future work
and is explicitly NOT in this milestone; see Out of Scope, because several specs name it as their
consumer and a reader should not assume it is imminent.

## User Stories

1. As a developer, I want ONE command (`run`) that follows a chain, folds into SQLite and answers
   HTTP, so I can run the whole indexer locally without assembling components or reading about a
   split.
2. As a developer, I want the processor object I run in a browser tab to run under `run` UNCHANGED, so "write it once" is something I can verify from a terminal rather than from a test file.
3. As an operator, I want to run the chain-facing half on a host near my node and push to an
   indexer-server elsewhere, without changing my processor, my declarations or my configuration — so
   splitting is a deployment decision I can defer and then reverse.
4. As an operator, I want a read-only endpoint (`serve`) over a database something else writes, so the
   serving tier can scale or move without carrying an indexer with it.
5. As a developer or a CI job, I want a command that follows the chain, folds, and EXITS at the tip, so
   I can produce a database or a publishable artifact reproducibly without running a server.
6. As an operator, I want `/status` to tell me the cursor, the reorg counters and the schema version, so
   a running deployment is observable without a query layer existing yet.
7. As a developer choosing a command, I want the NAMES to describe what the process does for me, so I do
   not have to learn the fetcher/stream-builder/read-surface split to pick one.

## Implementation Decisions

**`run` is assembly, not new machinery — with two named exceptions, and no others.** It constructs a
`LogFetcher`, wires it to a `StreamBuilder` through `createDirectIngestion`, gives the stream-builder
an `EntityEventProcessor` over a `state-store-sqlite` store on one libSQL handle, hands the same
handle to `@etherfold/server` as its `getDB`, and drives the whole thing with `runFetcherLoop`. All of
those exist. The exceptions are small and are named so that a task can tell "assembly" from "design":

- **the `/status` cursor reporter** (above), because `/status` reports no cursor today;
- **`startServer` takes a URL, not a handle.** `platforms/nodejs`'s `StartOptions.db` is a libSQL
  `string`, so "one handle, two users" needs an option that accepts an existing `RemoteSQL` (it
  already exports `createNodeDB` for exactly this kind of sharing). Extend that adapter rather than
  re-implementing its port binding, schema auto-setup and address readback in the CLI — and note the
  file overlap with `d1-limits-reach-the-stores-batch-bounds`, which also lands there.

Beyond those two, if a task finds itself designing a component, it has left this spec.

**Which ENGINE `run` and `build` fold with is the load-bearing choice here, and this spec makes it
explicitly.** There are two combined pipelines in the tree, not one: `EthereumIndexer` (fetches AND
processes in one object; what the browser runs and what `etherfold index` runs today via
`indexToTip`), and `LogFetcher` + `createDirectIngestion` + `StreamBuilder` (the ADR-0003 halves with
the transport removed). **`run` and `build` are built on the SECOND.**

The reason that is not merely tidy: **the equivalence this spec tests would otherwise be an
equivalence between two IMPLEMENTATIONS.** "`run` and `fetch` + `index` produce identical state" is
worth asserting because the transport is supposed to be the only difference; if `run` folded through
`EthereumIndexer` and `index` through `StreamBuilder`, the test would compare two engines that happen
to agree today, and every later divergence between them would surface as a mysteriously failing
headline test rather than as a bug in one place. Folding through `StreamBuilder` leaves ONE
server-side engine behind all four folding commands, with the browser as the only other consumer.
The corollaries point the same way: `EthereumIndexer` cannot be split into the two halves at all (it
opens `load()` with `eth_chainId`, which is why the chain-free `StreamBuilder` exists as a separate
object); the fetch cycle brings operational machinery the CLI's `indexToTip` loop does not have
(announced and SILENT truncation detection via `suspectResultCount`, the correction protocol, backoff,
the five-report classification); no chain-side check is lost, because `LogFetcher` already owns the
`eth_chainId` check in a split deployment; and `CONTEXT.md` already names `createDirectIngestion` as
the combined shape for a host that is not a browser. What `EthereumIndexer` has and a server does not
want is the kept-stream CACHE, which is a browser concern: on a server the database IS the durable
artifact.

Two things to CHECK rather than assume while re-engining, neither a blocker: that `StreamBuilder`
delivers a reorg's retractions in ONE batch the way `EthereumIndexer.feed` deliberately does, and that
a `keepState`-style JS-object processor still loads and persists under it (ADR-0037 retires that path,
but not before this lands). The consequences to state rather than discover:

- `EthereumIndexer` stays the BROWSER's engine and is not touched;
- the CLI stops folding through it, so what `index-to-a-store-from-the-cli` builds on top of it (its
  `init()` / `indexToTip` construction) does NOT simply move under a new command name — its
  `--store` decision, its module-declared processor KIND and its refusals survive, its engine wiring
  does not. See the Further Notes and the open question that goes with it;
- no command is a special case of another's code, which is only true because all four folding paths
  meet at `StreamBuilder`.

**The names are chosen freely, and NOTHING in the existing CLI constrains them.** Say so explicitly,
because the opposite was assumed once already: an earlier draft preserved `index`'s current meaning on
the ground that `stratagems-snapshots` shells out to it. That is not a constraint. Nothing is
published, stratagems is a CAPABILITY REFERENCE rather than a compatibility constraint (`CONTEXT.md`),
and any consumer we own is ours to update in the same change. Renaming and re-meaning every command is
free; the cost is a changeset and a README.

**`serve` means ONLY serving, and freeing it is what made the set work.** An earlier draft had `serve`
do everything, which left the read-only tier with no honest name: `read` and `query` both sound like
ISSUING a query rather than answering one, `api` is equally true of the commands that fold, and
`reader` collides with **consumer**, which `CONTEXT.md` reserves for anything reading the FEED and
warns against renaming. The ambiguity was never in the read tier's name — it was that the serving verb
had been spent on a command that does three jobs. So `serve` answers queries and does nothing else,
and the all-in-one is `run`.

**`index` is the FOLDING half, because indexing is turning logs into state.** The half that fetches
holds no cursor, no state and no database — ADR-0003 made it stateless on purpose — so it has the
weakest claim to the project's central verb, and naming it `index` would leave the component that
actually indexes without a name. `fetch` matches the domain term (`log-fetcher`) exactly. Note the
retired word: that component used to be the "watcher" and ADR-0003 renamed it; do not bring it back.

**`index` exposes `/ingest` but NOT the query API, and that asymmetry is the point.** It has an HTTP
surface because it must RECEIVE pushed batches, which is the write path; answering queries is
`serve`'s. So a split deployment is `index` and `serve` against ONE database — the writer and a
stateless read tier — and that shape falls out of the command set instead of needing to be explained.
`/status` is available wherever there is an HTTP surface, since it reports on the database rather than
on the process.

**`build` is the one-shot, and it is named for what it PRODUCES.** Follow the chain, fold, stop at the
tip, exit — for CI, for a reproducible local database, and later for producing an artifact a browser
can seed from (a captured stream or a state snapshot,
`a-generation-can-be-seeded-from-a-published-artifact`). "Run my indexer" and "make a thing, then stop"
are different intents with different users, which is why this is a command rather than a flag on
`run`.

**`serve` is defined now and earns its keep later.** With no query layer it would answer `/status` and
nothing else, which is not much of a product. It is specified here so the SHAPE is fixed — a serving
tier that holds no processor and writes nothing — and so that `run` and `index` are not accidentally
built in a way that assumes the writer and the reader are the same process. Do not let its thinness
today argue for folding it into `run` as a flag.

**`etherfold-fetch` is RETIRED, and `platforms/nodejs-fetcher` survives as a library.** There is
exactly one way to run a fetcher, and it is `etherfold fetch`. The adapter package keeps
`startFetcher` / `runFetcherProcess` — signal handling, the loop, the exit code — and loses
`src/bin.ts` and its `bin` entry, which is precisely the shape `platforms/nodejs` already has: no
binary, and the CLI imports `startServer` from it. So the symmetry is restored rather than invented,
the runtime adapter stays the only place a runtime is named (ADR-0003's rule for `platforms/*`), and
the CLI puts a flag surface in front of configuration that is environment-only today. Removing a
published `bin` is a breaking change to `@etherfold/platform-nodejs-fetcher`: changeset, and the
deletion is one emitted task's to OWN rather than a side effect of another.

**`serve` expects a remote database, and libSQL makes that free.** `createClient` takes `libsql:`,
`http(s):` and `ws(s):` URLs, so a read tier connects to a Turso database the writer also uses with no
new API and no SQL-over-HTTP endpoint. A general SQL-over-HTTP surface is explicitly rejected: the
narrow, authenticated, idempotent-by-cursor `/ingest` wire is what this system uses for remote writes,
and a second, wider one would be strictly worse.

**Every command resolves its processor and source THE SAME WAY, which is work rather than a
property.** The goal is unchanged — moving between commands is a deployment change and never a
rewrite, which is story 12 of `one-processor-everywhere` made reachable — but today the three
entry points disagree, and a spec that asserts the goal as if it already held would leave the
reconciliation unowned. `@etherfold/fetcher-host` resolves from the ENVIRONMENT
(`INDEXING_SOURCE` as a JSON source, `ETH_NODE_URI`, `INGEST_ENDPOINT`, `INGEST_TOKEN`,
`resolveFetcherHostConfig`); the CLI resolves from FLAGS and a processor module (`-p`, `-d`, `-n`,
`loadProcessorModule` / `resolveSource`); `platforms/nodejs` reads `DB` and `PORT`. So one resolution
path is a deliverable of this spec: flags first, environment behind them, the same variable names the
fetcher host already refuses by name, shared by all five commands. Note the one asymmetry that is
correct and must survive it: **`fetch` takes a SOURCE but no processor**, because the chain-facing
half holds no processor by ADR-0003.

## Testing Decisions

- **The headline is a TERMINAL test, not a unit test**: invoke `run` against a fixture chain, assert
  state lands in SQLite and `/status` reports an advancing cursor. The existing proof of equivalence is
  a test that constructs the pieces; this must be the command.
- **The same processor object under `run` and in a browser** produces the same state, which is the
  assertion that makes story 2 more than a claim. `one-processor-cli-and-split-server` already pins the
  single-process versus split equivalence; extend that shape rather than inventing a second one.
- **`run` and `fetch` + `index` produce identical state** from the same fixture, which is the concrete
  form of "the split is a deployment choice": the same components, the transport as the only
  difference. Assert too that `index` + `serve` against ONE database answers the same reads as `run`.
- **`build` terminates at the tip and exits non-zero on failure**, so a CI job can depend on its exit
  code rather than on parsing output.
- **`serve` answers reads against a database it did not write**, and refuses to write — asserted as
  the existing seam does it: with no `getIngestion`, the ingestion routes answer `501`. The route is
  MOUNTED either way (`createServer` composes `getStatusAPI` and `getIngestAPI` unconditionally), so
  the difference between `index` and `serve` is a capability, not a route table. Do not split the app
  to make the prose literal.
- **No command silently degrades**: a missing node URL, an unreachable database or an absent processor
  is a refusal that names the flag, not a process that starts and does nothing.

## Out of Scope

- **The GraphQL query layer.** Decided in principle elsewhere (Hono, Yoga, Pothos over entity
  declarations, with `one-processor-everywhere` guaranteeing the schema source) and deliberately NOT in
  this milestone. `/status` is the query surface for now. Recorded explicitly because
  `a-reconfigure-is-not-an-outage` and `the-server-and-cli-hold-generations-too` both name that layer
  as a consumer, and a reader should not infer it is imminent.
- **The log FEED and its two views**, which are `indexer-server-feed`.
- **Generations, the canonical pointer and multi-indexer hosting**, which are
  `a-reconfigure-is-not-an-outage` and `the-server-and-cli-hold-generations-too`. This spec is one
  indexer per process; `index` and `serve` gain the indexer-name route segment when that lands.
- **Triggers**, which are a separate deliverable entirely (ADR-0005).
- **A serverless shape for `run` or `fetch`.** A cron cannot follow a chain (`CONTEXT.md`); the
  chain-facing half needs a host that can hold a process.

## Resolved Questions

Three were open at review and all three are now DECIDED and recorded above. They are kept here with
their answers because each one changes what an existing artifact is FOR, and because a later reader
finding the alternative attractive should meet the reasoning rather than re-run it.

1. **`index-to-a-store-from-the-cli` is REWRITTEN before it is claimed, not landed and re-engined.**
   It is still in `work/tasks/backlog/` and unclaimed, so there is nothing to preserve by rushing it:
   landing it on `EthereumIndexer` would buy an entity-store CLI path that the very next task takes
   apart, and would leave a done record describing an engine the CLI no longer uses. The rewrite keeps
   everything that was actually decided in it — `--store` required with `file` / `sqlite`, the
   processor KIND coming from the module and never from a flag, the kind/store mismatch refused before
   any RPC call, `--folder` required only for `--store file`, retention settable and pruning never
   automatic, and `examples/event-processor-nfts/src/entities.ts` running unchanged — and replaces its
   engine wiring (`init()` building an `EthereumIndexer`, `indexToTip` driving it) with the
   `LogFetcher` + `createDirectIngestion` + `StreamBuilder` assembly. It keeps `covers: [1, 12]`
   against `one-processor-everywhere`, since what it proves is still "one processor, both
   deployments"; this spec's tasks are `blockedBy` the rewritten task.
2. **The ENGINE decision is CONFIRMED: `run` and `build` fold through `StreamBuilder`.** The argument
   is above. What settled it is that the end state is ONE engine, not two: `EthereumIndexer` is itself
   a candidate to become a thin wiring of `LogFetcher` + `createDirectIngestion` + `StreamBuilder`
   plus a browser-only layer (the kept-stream cache and its re-decode, reconfigure, the observable
   hooks, the genesis check). If that lands, the browser CONVERGES onto the engine chosen here and
   nothing in this spec moves; had the CLI been put on `EthereumIndexer` instead, that same refactor
   would have to undo it first. So the two options are not symmetric, and this is the one that is a
   step toward the convergence. The refactor itself is deliberately NOT in this spec: it touches
   `@etherfold/browser`'s main class and wants its own spec, and it is captured in
   `work/notes/ideas/the-indexer-could-be-a-wiring-of-the-two-halves.md` with the inventory of what
   `EthereumIndexer` carries that the two components do not. Worth knowing what it would buy, since it
   is more than tidiness: it upgrades story 2 from "the same processor object runs in both" to "the
   same processor AND the same engine".
3. **`etherfold-fetch` is RETIRED**, and `platforms/nodejs-fetcher` survives as a library; see the
   decision above. The bin removal is a named deliverable of one emitted task, with a changeset.

## Further Notes

The tasks this emits should be `blockedBy` `index-to-a-store-from-the-cli`, which is what makes the CLI
accept an ENTITY processor at all (today it throws `this processor do not support "keepState" config`)
and is currently unblocked in `work/tasks/backlog/`. That task is written against the CLI's current
`index` command, and under this spec's names its work lands in `build` and `run`. Do NOT read that as
a pure rename: the command name moves, the `--store` decision and the module-declared processor kind
move with it unchanged, but its ENGINE does not. That task is REWRITTEN against `StreamBuilder`
before it is claimed (Open Questions 1), and this spec's tasks are `blockedBy` the rewritten
version — so the rewrite is the first thing to do after this spec is confirmed, and it is not one of
the tasks this spec emits.

**The rename has to propagate, and these are the artifacts that still carry the old meanings.** Name
an owner for each before tasking, since three of them are live:

- `work/tasks/done/index-to-a-store-from-the-cli.md` — `index` throughout, in the folding sense;
- `work/tasks/done/retire-the-js-object-processor-path.md` — twice, and its ordering argument
  depends on which command carries the `keepState` refusal;
- `CONTEXT.md`, "What must work FIRST" — corrected in the same change as this spec; its first bullet
  described the all-in-one as `serve`, which is now the read-only tier;
- `work/specs/tasked/one-processor-everywhere.md` ("`etherfold serve` runs fetching, processing and
  serving in one process") and `work/tasks/done/one-processor-cli-and-split-server.md` — both are
  launch snapshots in terminal or tasked folders and are deliberately NOT edited; the glossary entry
  in `CONTEXT.md` is what a reader is meant to land on instead. ADR-0037 likewise keeps its wording.

**How the stories cut, so a tasker does not emit fiction for four of them.** Stories 1, 3 and 6
are vertical tasks. Story 2 is an ASSERTION on story 1's task (the same processor object under `run`
and in a tab), not a task of its own — and it cannot be WRITTEN until `index-to-a-store-from-the-cli`
has recorded, in its `## Decisions`, where the processor KIND tag lives on the module, since that is
what the browser and the CLI must agree on; do not write it speculatively. Story 4 is nearly
delivered already — today's `etherfold serve` is the read tier — so it cuts as rename plus the
refuses-to-write assertion. **Story 5 is NOT a vertical task**: the one-shot that follows the chain,
folds and exits at the tip on its own exit code is ALREADY an acceptance criterion of
`index-to-a-store-from-the-cli`, on the same `runFetcherLoop`-plus-`AbortController` driver that task
names as "the same driver `build` will use". So story 5 cuts exactly as story 4 does: the RENAME to
`build` plus its README, over work that task delivers. Cutting it vertically emits a second
implementation of a one-shot that already exists under another name. Story 7 is this spec's framing
and is delivered by the others; there is no naming task.

**Two named deliverables have no story and must be ASSIGNED at tasking time or they are silently
dropped**: the unified configuration-resolution path (flags first, environment behind them, the same
variable names across all five commands — see the Implementation Decisions), and the deletion of
`platforms/nodejs-fetcher/src/bin.ts` with its `bin` entry and changeset. The second is already
declared to be "one emitted task's to OWN rather than a side effect of another", so name which one.

**Both host adapters are already built** (`agnostic-server-skeleton`, in `tasks/done/`). What is not
built is D1's per-request limits reaching the store's batch bounds, which was blocked on the server
having no store dependency and is now `work/tasks/done/d1-limits-reach-the-stores-batch-bounds.md`
(the re-minted forward half of the cancelled `server-platform-adapters`). `run` is the first thing
that wires a store into a server process, so that work becomes reachable here; it is not this spec's
to deliver, but the seam it was waiting for is the one this spec creates. It is not merely tidy
either — `work/notes/findings/d1-caps-bound-parameters-per-query-at-100.md` establishes that the
shipped default is 5x over D1's bound-parameter cap on the prune path, so retention enforcement is
currently broken on D1 and passes everywhere else.
