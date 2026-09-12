# @etherfold/platform-nodejs

## 0.2.0

### Minor Changes

- 0f33468: A NAMED INDEXER IS A ROUTE SEGMENT AND A REGISTRY ENTRY, on both halves of the wire.

  An indexer-server hosted exactly one indexer: `ServerOptions.getIngestion` resolved a single `LogIngestion`, and the ingest routes were the unnamespaced `/ingest` and `/ingest/expected-from-block`. It now hosts SEVERAL, each under a NAME an operator supplies at deploy time (ADR-0036).

  **`/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block` replace the unnamespaced pair, which is GONE rather than kept beside them.** The name is a ROUTE SEGMENT and is deliberately NOT a field in the envelope: putting tenancy in the wire format would turn a misdirected batch into a payload error rather than a routing one. ADR-0004's `{source, config}` envelope and its refusal families (`409` resumable, `400` otherwise) are untouched.

  **`ServerOptions.getIndexer` replaces `getIngestion`, and resolves a registry ENTRY per name.** The entry is an object (`{ingestion}`) so that what a name holds can grow — a later generation model gives one entry several live wire contexts — without every host's resolver changing its return type. `indexerRegistry({name: streamBuilder})` builds one from a plain record for a host that knows its names up front; a host whose names depend on the request writes the function itself. Two named indexers on one server are isolated: a batch pushed to one is not visible to the other.

  **An unknown name is REFUSED, never defaulted: `404 unknown-indexer`.** A routing refusal, matching what the name is, and distinct from `501 ingestion-not-configured`, which a host with NO registry at all still answers under every name (a read tier, or a combined `run`). Both are in the non-retryable 4xx family a sender must not re-send into.

  **`createHttpIngestion` takes the indexer name beside the endpoint** (`@etherfold/core`) and posts to the namespaced routes; it refuses to be built without one rather than addressing nobody. `@etherfold/fetcher-host` reads it from `INDEXER_NAME` and demands it wherever it demands `INGEST_ENDPOINT` and `INGEST_TOKEN`, so a combined host that configures no wire is still asked for nothing.

  **The CLI grows `--indexer <name>` / `INDEXER_NAME`, REQUIRED on `fetch` and `index` and refused on `run`, `build` and `serve`.** The two halves of a split deployment agree on one name the way they already agree on one secret: `fetch` addresses `/{indexer}/ingest`, `index` registers exactly that name and refuses every other. The three commands with no wire route no batch by name, and refuse the flag with that reason rather than accepting and ignoring it.

  `StartOptions.getIngestion` on `@etherfold/platform-nodejs` becomes `getIndexer`, carried through unchanged as before.

- 56acbef: Every deployment shape counts the reorgs it concluded, not only the one behind an HTTP route.

  `etherfold run` reverted state on a reorg correctly and then reported `{absence: 0, contradiction: 0}` on `/status` for ever, because the counter was written by the HTTP ingest route and a combined process folds through the direct in-process wire and never touches it. `etherfold build` had no `Meta` table at all. So an operational counter was a fact about the TRANSPORT, and the shape the milestone calls the default was the one that could not report it. Nothing was mis-indexed: the fold was already correct in both shapes, and the equivalence suite proved it. What was missing was the observability, on the one `/status` field the two shapes did not agree about.

  **The count is taken where the reorg is CONCLUDED, and written by whoever OWNS the store** (ADR-0050). `StreamBuilder.receive` reports a concluded revert to a `ReorgRecorder` exactly once, whichever entrance the batch arrived through, and the deployment that opened the database supplies that recorder. The ingest route is a CALLER of `receive` now rather than the owner of a write, so a receiver that both concludes a revert and serves the request that carried it counts it once, and `run`, `build` and `index` all count.
  - **`@etherfold/core`** gains `ReorgRecorder`, `ReorgCounters`, `RecordedReorg` and the durable key names (`REORG_COUNTER_KEY`, `REORG_LAST_KEY`), plus `StreamBuilderOptions.recordReorg`. The keys live here because the writer and the reader are deliberately in different packages: a read tier owns no store and still has to answer "how many reverts does this database record". `recordReorg` is not hashed into the wire identity, since where a count goes is not something a sender asserts. `IngestionOutcome.reorg` is unchanged and is REPORTED rather than delegated: a caller that counted from it would count only on the shape it happens to be, and twice on the shape that is both.
  - **`@etherfold/server`** no longer exports `recordReorg` and writes no counters. It reads them (`readReorgCounters`) for `/status`, including on a read tier that folds nothing, and `ReorgCounters` is re-exported from core. Its dependency posture is unchanged: it still owns no store package.
  - **`@etherfold/platform-nodejs`** exports `ensureFixedSchema(db)`, the auto-setup step `startServer` already performed, so a process that binds no port can still create the fixed tables.
  - **`etherfold`** owns the one writer (`recordReorg`, `reorgRecorderFor`), built by `buildProcessor` against the handle the command folds into, so no folding command can count into a database it does not fold into. **`build` applies the fixed-table schema**, which it never did: it binds no port, so nothing else ever would, and a database it emits is a publishable ARTIFACT that must carry its provenance the moment it becomes an INPUT rather than an output.

  **A counter that cannot be persisted never takes down a fold or a request**, on any shape. That guarantee belonged to the route (`recordReorgSafely`); it lives in `StreamBuilder` now, so it is owed by every shape that counts.

  `packages/cli/test/equivalence.test.ts` drops the exception it carried and compares the `/status` counters between `run` and `fetch` plus `index` directly, through the reorg it already drives: the same counts, the same classification, the same block, and once each. `packages/core/test/oneReorgWriteSite.test.ts` scans the workspace and asserts there is no second site recording a reorg.

- ed8e7ff: What the fetcher has learned about your provider is now READABLE, and can be handed BACK on the next start. Nothing persists it, and that is the decision rather than an omission (ADR-0074).

  The range fetcher works out how wide an `eth_getLogs` range a node will answer by asking, being refused and adapting. It tracks three numbers, all in blocks: a `ceiling` it has been refused at (or that the provider wrote out in its refusal), the widest `safeSpan` that has actually been answered, and the `nextSize` it will ask for next. All three lived in private fields, invisible from outside and gone on restart, so every process start re-paid the discovery from the 50-block starting range upwards and an operator could only infer any of it from timings.

  **`LearnedRange` is now a published type, reported and accepted back.** `LogFetcher.learnedRange` reports it, `LogFetcher.limits` reports it beside `suspectResultCount` (the count and its source, which the previous change made readable but left off every status surface), and `fetch.learnedRange` accepts the same object as configuration. A field is ABSENT rather than zero where nothing has been learned, because a ceiling of `0` reads as "this provider serves nothing" and that is not what "nothing learned yet" means.

  **`GET /status` gains `fetcher`**, from a reporter a host injects beside its cursor reporter (`ServerOptions.getFetcherLimits`, carried through `@etherfold/platform-nodejs`): `{reported: true, learnedRange, suspectResultCount}`, or `{reported: false, reason}` when a reporter cannot answer. It is ABSENT entirely on a host that holds no fetcher, which is most of them -- the receiving half of ADR-0003 makes no chain call at all, so `index`, `serve` and the Workers host carry no such field and nothing is invented in its place. `etherfold run` holds both halves and injects one.

  Unlike the `cursor` beside it, the field is TYPED rather than opaque. A cursor's meaning lives behind the storage seam and belongs to a processor (ADR-0027), which is why ADR-0047 has the server carry it verbatim; a learned range is `@etherfold/core`'s, it is three numbers, and it hides behind no seam -- so a dashboard reading `fetcher.learnedRange.ceiling` reads a documented field. What is kept from ADR-0047 is the half that still applies: a reporter that throws, rejects or has nothing to say degrades to a reason rather than to an omission, because "this deployment runs no fetcher" and "this deployment's reporter is broken" are different news, and neither ever fails the request or changes `healthy`.

  **`LEARNED_RANGE` is the door it comes back in by** (`@etherfold/fetcher-host`, so `etherfold run`, `build` and `fetch` all read it): the reported object, pasted back as JSON. Then the first request asks for what the last run found to work. It is a STARTING POINT and never a promise -- every number is still bounded by `MAX_BLOCKS_PER_FETCH`, adaptation runs over it unchanged, and a provider that has tightened since refuses it and lowers the ceiling on that first round trip, so a stale value costs a retry and can never wedge. A partial object is legitimate (`{"ceiling":2000}` alone is a real thing to know), and an unrecognised key is IGNORED rather than refused, so a report that grows a field does not turn a supervisor that pastes it into an outage. What IS refused, at startup and naming the field, is a value that cannot be read at all: not JSON, not an object, or a member that is not a positive whole number of blocks. The startup line says when a range was remembered, so an unexpected first span is attributable.

  **Nothing is written to any store, by design.** `LogFetcher`'s docstring states the test for state the chain-facing half may hold -- losing it must cost ONE extra request and nothing else -- and the learned range fails it, since losing it re-pays the walk up from the starting range. It is still only performance, so the answer is to move the memory OUT of the stateless component rather than to give that component a store: a fetcher that writes something down can be restored from a stale copy of it, owns that copy's lifecycle, and has a place for the next block number to be put, which is the split brain ADR-0004 exists to remove. Pushing it to the receiver was rejected on its own ground: it puts a fact about ONE SENDER'S PROVIDER into a wire contract that deliberately carries no sender identity.

  A deployment that configures nothing behaves exactly as it did before, byte for byte: the discovery spans a fetcher walks through against a refusing provider are asserted unchanged.

- aea6d2a: THE NODE SERVER STARTS ON A DATABASE HANDLE IT WAS GIVEN, and carries a host's ingestion and cursor reporter through to the app.

  **`StartOptions.db` accepts a `RemoteSQL` as well as a libSQL URL** — one option, two forms, because a host has one database and the only question is who OPENED it. The URL form is unchanged in every respect (same defaulting to `DB` then `file:./etherfold.db`, same schema auto-setup, same returned handle, same shutdown). The handle form is what makes "one process, one database" true: a process that folds a processor into a store hands the SAME handle to the server, so the store's writes are what the server reads. Two handles onto one URL would be two connections with two views of it — against `:memory:` not even the same database — and two schema-setup races.

  **A handle the adapter was GIVEN is not its to close.** `close()` stops the HTTP listener and leaves the database alone, so shutting the server down never takes a store's connection with it. Whoever built the handle closes it.

  **`StartOptions.getIngestion` and `StartOptions.getCursorReport`** — the two capabilities only a HOST can build, accepted in `@etherfold/server`'s own shape (resolved per request, since that is what the Workers model forces on the app) and handed to it unchanged. With an ingestion supplied, a server started here can host a processor and its `/ingest` routes work; with none, they answer `501` to an authenticated caller exactly as they do today, and `401` to an unauthenticated one, since the token guard sits on the path ahead of the capability. With a reporter supplied, `/status` reports the cursor; with none, it carries no `cursor` field rather than an invented one.

  This adapter still builds no processor, names no store package and knows no chain concept: it decides what the app's database, environment, ingestion and reporter ARE, and nothing else.

### Patch Changes

- 2e10f5e: A receiver now says WHAT it emitted and WHICH STREAM it folds, so a host can store the emission stream without deriving either for itself.

  `LogIngestion` gains `streamDigest`, the wide `streamDigestOf` value over the fetch filter plus the resolved stream config: the same name a stream has in the browser's stream address (ADR-0035), so one stream is one name everywhere. It is deliberately not `context`: the wire identity is a CHANGE DETECTOR between the two halves of one deployment, 32-bit per entry and over the whole entry on purpose (ADR-0034), so it moves on a decode-only change the fetch filter never saw and it collides. Neither is survivable in a KEY.

  `IngestionOutcome` gains `emissions`, the ordered stream of what was applied and what was taken back, with retractions carrying their original block. It is REPORTED for the same reason `reorg` is: `StreamBuilder.receive` is the one place that knows what the fold concluded, and a host that re-derived it would be holding a second answer. The `applied` / `retracted` counts are that list partitioned on `removed` and stay, so a caller that only reports progress need not walk it.

  `EmittedLog` is exported: one entry of that stream with the ABI taken away, which is to say the raw log the node reported plus the verdict. Taking the ABI away is the point, since a host that STORES logs is not a host that decodes them, and the decoded `args` are what some earlier ABI made of those bytes and are re-derived on replay against the source running now.

  Breaking for anyone implementing `LogIngestion` by hand (a fake in a test): both new members are required. Neither is optional, deliberately. An optional field on the fold's output is a hole with a polite name, and a receiver that quietly omitted one would leave a host storing nothing under a key it could not form. The Node adapter's own fake receiver is updated for that reason and its behaviour is otherwise unchanged.

- 1a6f68b: Every published package now carries a `description` and its own `README.md`.

  Metadata and docs only: no runtime code changed. Four manifests had no `description` at all (`@etherfold/core`, `@etherfold/browser`, `etherfold`, `@etherfold/utils`), which is the line npm shows in search results and on the package page, and seven packages had no README (the four above plus `@etherfold/server`, `@etherfold/platform-nodejs` and the private Worker host). Each README says what the package is, when to reach for it INSTEAD of its neighbours, a minimal snippet taken from code that runs, and links to the related packages.

  Two summaries are worth calling out because a guessed one would have been wrong. **`etherfold index` is a ONE-SHOT**: it folds to the tip it observed and exits, does not follow the chain and cannot be reconfigured while running, so keeping a database current is running it again; live reconfigure is `@etherfold/browser`'s ability. And **`@etherfold/utils` is not a bag of hashing helpers** any more: what is in it is the Node-side loader that turns a processor PATH into the authoring object plus its indexing source, since `contextFilenames` and the `@etherfold/utils/indexer` subpath went with the blob snapshot (ADR-0037).

  One existing description is CORRECTED rather than added: `@etherfold/state-store-sqlite` called itself a "state store for `@etherfold/core`", which names the wrong seam. It depends on `@etherfold/state-store`, `remote-sql` and `named-logs` and on nothing else, and a test in that package asserts as much, because a storage backend depending on the indexer would invert ADR-0016.

  **`etherfold` no longer publishes the repo's root README.** Its `prepack` copied `../../README.md` into the package, so the npm page for the CLI described the monorepo and documented none of its flags; the package now has a README of its own, committed rather than generated, and `prepack` copies only the LICENSE.

- f5fb4d2: One named indexer receives logs for SEVERAL LIVE STREAMS at once, so a filter change can build a successor while the incumbent keeps being fed and keeps answering.

  A FILTER or CONFIG change makes a NEW STREAM, and therefore a new `{source, config}` on the wire. With one receiver per name a successor on one could not receive a single log: `assertContext` refused its batches with the `400` that is deliberately not resumable, so it starved while the incumbent went on being fed. The route now selects the INDEXER by its segment and the batch's own `{source, config}` selects WHICH receiver inside it.

  **`IndexerRegistryEntry` is now two questions rather than one field** (`@etherfold/server`). It was `{ingestion}`; it is now `liveIngestions(): Promise<readonly LogIngestion[]>` (one receiver per LIVE wire context, at most one per stream, since a stream is ONE address on the wire) and `canonicalGeneration(): Promise<GenerationId>` (which generation answers reads). Both are ASKED rather than read, because only the generation registry answers them honestly: a generation deleted elsewhere stops being live, and the canonical pointer moves, without a host being told.

  ```ts
  // a host holding one receiver, unchanged in behaviour
  getIndexer: indexerRegistry({alpha: myStreamBuilder}); // or singleContextEntry(myStreamBuilder)
  // a host holding generations: the container answers both questions itself
  getIndexer: (_c, name) => (name === 'alpha' ? myReceivingIndexer : undefined);
  ```

  **`POST /{indexer}/ingest/expected-from-block` answers `{success, contexts: [{context, expectedFromBlock}, ...]}`**, one entry per live context, and no longer a single top-level `{expectedFromBlock, context}` pair. This is a deliberate RESPONSE-SHAPE change and the widening of what the route already did: it returned its `context` beside the number precisely so a sender knew which receiver it had reached, and one pair could only ever have named one of several — silently. It is also what lets one fetcher host later run one fetch loop per context, which is not built here.

  **The ASK NAMES THE ASKER on the sending side.** `IngestionTarget.expectedFromBlock(context)` takes the `{source, config}` the sender pushes; `LogFetcher` passes its own, and `createHttpIngestion` finds its entry in the list. A list holding no entry for this sender is an `IngestionRefusedError` with code `context-mismatch` — non-retryable, raised before a single log is fetched, and the same fact as the `400` a foreign batch earns one round trip later (over HTTP this replaces the `WireContextMismatchError` the fetcher used to raise from the ask; both are fatal and neither is resumable). `createDirectIngestion` holds one receiver and ignores the argument.

  **The refusal families are unchanged.** `409` is still the ONE resumable refusal, an unknown name is still `404`, a host with no registry is still `501`, and a context no live receiver holds is still a `400 context-mismatch`. What changed is that its `expected` field is now an ARRAY naming EVERY live context rather than a single one — the same choice `GenerationCapReachedError` makes when it names every deletable generation instead of picking one.

  **A live context has a LIFETIME, and it is DERIVED FROM THE REGISTRY.** `ReceivingIndexer.add(spec)` builds a fold beside the ones already held — its own state, its own processor, its own receiver — and registers it, which is the moment its context becomes live; a cap refuses there, with nothing partial left behind. It stops being live when its generation is DELETED (and its stream reaped with it, if it was the last on it), and a batch for it is then the ordinary `400`. Deliberately NOT derived from the canonical pointer: a superseded generation is RETAINED under the caps, so "the successor became canonical" is not by itself a reason to stop feeding the old context, and what that rule should be stays a policy input rather than a rewrite of this routing.

  **A second receiver on a stream already held is REFUSED.** A batch carries `{source, config}` and nothing that could tell two folds over one stream apart, so the second would be reachable only by iteration order. Such a fold is a PROCESSOR-change successor, and ADR-0044 already says how it advances: it re-folds the stream the writer stores, rather than being fed the same batches twice. `ReceivedGenerationSpec` accordingly takes `source` (and now a per-fold `stream` config), which is the only way to say "a different stream".

  **Both feed views answer from the CANONICAL generation alone**, its stream and its fold read TOGETHER once per request, so a response can never pair one generation's stream with another's fold. A successor being fed under the same name is invisible to a consumer until the pointer moves; when it does, a cursor for the old stream meets the existing `400 stream-mismatch`, which is explicitly not a rewind.

  `sameWireContext` is exported from `@etherfold/core`, because the host that selects a receiver must apply the same comparison the receiver would apply to refuse it — a second copy could select a receiver that then refused the batch.

  `@etherfold/platform-nodejs` and `etherfold` carry no new behaviour: they pass the registry through, and each now builds the widened entry (one live context each) where it used to build `{ingestion}`.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- 132cc1c: The one-shot is `etherfold build`, `serve` is only the read tier, and no command is implicit.

  **BREAKING, and it is the whole point.** `etherfold index` is gone and resolves to nothing: the word is needed for the wire receiver, which receives pushed batches, owns the database and does not terminate. The one-shot that folds to the tip and exits is now named for what it PRODUCES.

  ```sh
  etherfold index -p ./processor.js --store sqlite --db file:./etherfold.db   # before
  etherfold build -p ./processor.js --store sqlite --db file:./etherfold.db   # after
  ```

  **There is no DEFAULT command any more**, so a bare `etherfold …` now needs a command word: `etherfold -p ./processor.js --store sqlite --db file:./etherfold.db` was the one-shot and is now an unknown-option error. `etherfold` with nothing after it prints help and indexes nothing. The default existed so the rename from `ei` would not also cost users their argument order (ADR-0017); the name is changing anyway, and under a set of five names chosen so a reader can tell what a process will DO, an invocation that silently means one of them is the ambiguity the set exists to remove.

  Nothing about the pipeline moved. `build` keeps every flag (`-p`, `--store`, `--db`, `--retention`, `-d`, `-n`, `--rps`, and the `ETHEREUM_NODE` fallback), every refusal, the stop-at-tip driver and the exit codes (0 at the tip, non-zero on a refusal no waiting fixes). The package's exported `run(options)` is renamed to `build(options)` to match, and `main`'s injectable `run` collaborator becomes `build`, because `run` is a DIFFERENT command in the set being built (it follows the chain, answers queries and never terminates).

  **`serve` keeps its name and narrows its promise to serving.** It holds no processor, makes no chain call and writes no indexed state: it answers over a database something else wrote. That was already true of the code and not of the docs. It is now asserted rather than described: a server started the way `serve` starts one answers `501 ingestion-not-configured` on `/ingest` and `/ingest/expected-from-block` to an authenticated caller, while `/status` still answers, and an unauthenticated caller still gets `401` first, so the absence of a processor is not something an anonymous caller can probe.

- 5deb214: A NAMED INDEXER resolves to the DATABASE it owns, so a host registering several gives each one its own and no query, prefix scan or cap in one can reach another's rows.

  ADR-0053 decides the mechanism and the reason: a generation is a table NAMESPACE inside one database, and a named indexer is the DATABASE. The two levels have different LIFETIMES: the indexer set is known at DEPLOY time, so N static bindings express it exactly (including on D1, whose bindings are static), while a generation is created at RUNTIME and must live inside one binding. There is also a correctness reason not to merely share: `_blocks` is `number INTEGER PRIMARY KEY` with `hash` UNIQUE, so two named indexers on different chains collide on block number with different hashes.

  **`IndexerRegistryEntry` now carries `db`** (`@etherfold/server`). It is REQUIRED, which is what makes the isolation STRUCTURAL rather than remembered: a host registering a second named indexer cannot leave it out and silently inherit the first one's rows, because there is nothing to leave out. `getDB` stays exactly what it was and is now clearly the HOST-LEVEL handle: it answers per request and knows no name, which is right for `/status` and `/admin/setup` (facts about the deployment) and wrong for anything keyed on a tenant.

  ```ts
  // one receiver per name, over the database that name owns
  getIndexer: indexerRegistry({
  	alpha: singleContextEntry(alphaDB, alphaBuilder),
  	beta: singleContextEntry(betaDB, betaBuilder),
  });
  // a host holding generations: the container answers the two questions, the host supplies the handle
  getIndexer: (_c, name) => (name === 'alpha' ? indexerEntryOn(alphaDB, myReceivingIndexer) : undefined);
  ```

  **Both feed views read through the entry's handle** (`GET /{indexer}/feed`, `GET /{indexer}/canonical`), and the ingest routes were already isolated by construction: the fold, its store, its emission appender and its reorg recorder are all the host's, bound to the database that name owns.

  **Three shape changes, and nothing else moves.** `singleContextEntry(db, ingestion)` takes the handle first; `indexerRegistry` takes ENTRIES rather than bare receivers, because a name resolves to what it holds AND to where it holds it; and `indexerEntryOn(db, holds)` is new, the one line a host holding a `ReceivingIndexer` writes, since `@etherfold/core` knows no database and cannot carry one (its generation state is a type parameter precisely so it does not).

  **Colocation is still expressible and is now explicit.** Two names MAY be given one handle (`_emissions.indexer` and the generation registry's own name column keep them apart, which is why those redundant columns are kept), and that is a host's decision made where it can be read rather than one the type makes for it by defaulting.

  **The refusal families are unchanged.** A name this host was not built with is still a `404`, a host with no registry is still `501`, `409` is still the one resumable refusal, and a context no live receiver holds is still a `400`.

  `etherfold`, `@etherfold/fetcher-host`, `@etherfold/platform-nodejs` and `@etherfold/platform-nodejs-fetcher` carry no new behaviour: each names the handle its one named indexer already folded into, where it used to register a bare receiver.

  The guard is `packages/server/test/twoNamedIndexers.test.ts`: two named indexers with IDENTICAL sources, contracts, stream config and processor (so `streamDigestOf` cannot tell them apart and neither can a wire context) on a host whose own `getDB` handle is a THIRD database holding neither one's rows, so a read that forgot the discriminator answers with nothing rather than with something plausible. It asserts the routes, the store, the stored stream and the registry end to end, that a generation cap reached in one refuses in that one only, and that deleting everything in one is a `DROP` with no filter anywhere while the other stays complete and READABLE.

- Updated dependencies [ebfa4f0]
- Updated dependencies [ddcced5]
- Updated dependencies [391dbf8]
- Updated dependencies [0f33468]
- Updated dependencies [56fda62]
- Updated dependencies [1524a04]
- Updated dependencies [1d9be43]
- Updated dependencies [ab779b0]
- Updated dependencies [793f3d6]
- Updated dependencies [8bb063e]
- Updated dependencies [1a6f68b]
- Updated dependencies [56acbef]
- Updated dependencies [ffe7c40]
- Updated dependencies [f5fb4d2]
- Updated dependencies [0bf9dc7]
- Updated dependencies [20fecac]
- Updated dependencies [1fa09f5]
- Updated dependencies [08d39d8]
- Updated dependencies [114879f]
- Updated dependencies [a6963b4]
- Updated dependencies [6c321a1]
- Updated dependencies [2c62a30]
- Updated dependencies [2e10f5e]
- Updated dependencies [c0d694f]
- Updated dependencies [01ed0ef]
- Updated dependencies [ed8e7ff]
- Updated dependencies [132cc1c]
- Updated dependencies [449f6fb]
- Updated dependencies [41b59fe]
- Updated dependencies [9229c30]
- Updated dependencies [9bfc424]
- Updated dependencies [5deb214]
- Updated dependencies [0a53b98]
  - @etherfold/server@0.2.0

## 0.1.0

### Minor Changes

- 086de7b: Adds the platform-agnostic indexer-server and its Node host, and a `serve` command to the CLI.

  `@etherfold/server` is a Hono app that receives its database and environment by injection (`{getDB, getEnv}`) and imports no runtime: no Node built-ins, no Cloudflare types, no concrete driver. It ships the fixed-table schema and a `/status` route reporting database reachability, whether the schema is applied and at which version, and the last error this process saw. `POST /admin/setup` applies the schema. A test asserts the package names no runtime, so the property is checked rather than trusted.

  `@etherfold/platform-nodejs` is the Node host: a libSQL-backed `RemoteSQL`, environment from the process, served over HTTP. It applies the schema at startup by default (one process owning one file), which `autoSetup: false` disables.

  The CLI gains `etherfold serve`, which runs that host, so a project can start an indexer-server without wiring anything. `etherfold index` remains the default command, so existing `etherfold -p <processor> -f <folder>` invocations are unchanged.

  A Cloudflare Worker host also exists, at `platforms/cf-worker`, and is not published: it is a deployable, not a library.

  The server is a skeleton. It serves status and schema only: no chain logic, no store wiring, no feed. Those arrive with the tasks that follow ADR-0003.

### Patch Changes

- Updated dependencies [086de7b]
- Updated dependencies [b40298e]
- Updated dependencies [e0a6480]
  - @etherfold/server@0.1.0
