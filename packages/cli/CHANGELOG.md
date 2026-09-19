# ethereum-indexer-cli

## 1.0.0

### Major Changes

- da289e2: A published snapshot a client cannot read is REFUSED, never installed as state — closing the last corner `tagged-bigint-codec-across-storage-adapters` left open knowingly (ADR-0040).

  The blob snapshot's format number now lives in `@etherfold/core` as `BLOB_SNAPSHOT_FORMAT`, beside the codec it versions, so the WRITER (`@etherfold/cli`'s keeper) and every READER import one number. It used to be the CLI's own `SNAPSHOT_FORMAT`, which the browser could not see (`@etherfold/browser` must not depend on the CLI and still bundles for a tab), so the CLI refused a format-1 file locally while `keepStateOnIndexedDB` installed the same bytes — whose every `uint256`, with no fallback reviver left, arrived as the string `"123n"` instead of a BigInt. `isReadableBlobSnapshot` and the `BlobSnapshotEnvelope` type are exported alongside it; the CLI no longer exports a format constant of its own.

  `keepStateOnIndexedDB` now checks the number on every remote fetch: an unreadable snapshot is refused whole (never translated, never half-read) and the refusal is logged with the location and both numbers. An unreadable mirror is treated exactly as an unreachable one already was — skipped when it loses selection, failed over from when it wins — and local state that is already ahead still wins over any remote, readable or not. A prefix-form mirror's bare `lastSync` file carries no format and is read as SELECTION data only: nothing from it is installed, and the state file it selects for carries the check.

  The ENTITY snapshot envelope's constant is renamed `ENTITY_SNAPSHOT_FORMAT` (`@etherfold/state-store`; re-exported by `@etherfold/processor-entities`) so the two envelopes — which version different file shapes and revise independently — are distinguishable by NAME at a call site that can hold both. They are not merged.

  Nothing is published under `@etherfold/*` yet, so no format-1 snapshot exists in the wild: this is a guard added before the first release rather than a breaking correction to one already shipped.

- f0f6e8d: One configuration path for every command: flags first, environment behind them, and a refusal that names both.

  The three entry points disagreed. The fetcher deployable read everything from the ENVIRONMENT and refused by name; the CLI read FLAGS and made requiredness a parser setting; the Node server host read two variables of its own. Now one module (`src/config.ts`) owns the whole flag-and-environment resolution for the CLI, both shipped commands run entirely off it, and the three commands that do not exist yet (`run`, `fetch`, `index`) already have their row in the same table.

  **`ETHEREUM_NODE` is RETIRED. The node URL variable is `ETH_NODE_URI`**, which is the name a fetcher deployable already refuses by, and it is now the only one. There is one name per input.

  ```sh
  ETHEREUM_NODE=https://rpc.example etherfold build …   # before
  ETH_NODE_URI=https://rpc.example etherfold build …    # after
  ```

  **`etherfold serve` now REFUSES to start without a database.** It resolves `--db`, then `DB`, and refuses naming both when neither is set, instead of falling through to the Node adapter's convenience default and creating an empty `./etherfold.db` nobody named. `@etherfold/platform-nodejs` is unchanged: the CLI passes the database it resolved explicitly, so that default is no longer reachable from a command.

  **Every input is resolved the same way, and there is one name for each (ADR-0048).** A flag beats the environment; the environment is used when the flag is absent; neither present is a refusal that names the flag AND the variable, made before the chain is dialled or a database is opened. The variables are the fetcher host's (`INDEXING_SOURCE`, `ETH_NODE_URI`, `INGEST_ENDPOINT`, `INGEST_TOKEN`, `REQUESTS_PER_SECOND`) plus the Node server host's (`DB`, `PORT`). The other six inputs (`-p`, `--store`, `--retention`, `-d`, `--host`, `--no-auto-setup`) are flags only: the environment carries what varies between deployments of one image, a flag carries what the image IS.

  **`INDEXING_SOURCE` now works on the CLI**, as the variable form of `-d, --deployments`: one JSON document, parsed and refused by field name. It resolves a source with NO chain call, which is what the wire receiver will need, since it makes none.

  **Nothing is accepted and ignored.** A flag a command does not own now PARSES and is refused with the reason it does not own it, rather than meeting `unknown option`: `etherfold serve -p ./processor.js` says that a read tier holds no processor and points at `index`, `run` and `build`. Those flags are hidden from `--help`, so the surface a user reads is still exactly what the command owns. An ambient VARIABLE a command does not own is not read at all rather than refused, so one host can run several commands side by side.

  **`--port` lost its commander default.** It was `'2000'` at the parser, which meant the flag was always present and `PORT` could never be reached. The default is now the resolver's, applied only when neither the flag nor the variable said anything. It is the only defaulted input.

  **`--rps` is parsed to a number.** It was typed as one and arrived as a string; a value that is not a positive number is now refused.

  **`prepareIndexing` takes the command name first**: `prepareIndexing('build', options, deps)`. `Options` now covers every flag any of the five commands takes, and every field on it is optional, because requiredness lives in the resolver and not in the parser. `resolveIndexOptions` is replaced by `resolveCommandConfig(command, options, env)`, which is exported along with the command table, the resolved shapes and `serve(options, deps)`.

- bb86a77: The free-form JS-object processor path is DELETED. There is one way to author a processor: entity declarations plus handlers over a `MutationContext` (ADR-0037).

  `@etherfold/js-processor` is gone, with `fromJSProcessor`, `JSProcessor`, `JSObjectEventProcessor` and its immer `History`. What it uniquely offered was an authoring STYLE, not a capability: no as-of queries, no retention or pruning, no bounded listing, and no schema for the query layer, which is generated from entity declarations. Its state was also a whole blob rewritten per save, which is the shape this repo has spent a design pass removing from the stream. What is NOT lost is its STORAGE characteristic: a plain object with history as immer reverse patches survives behind the proper seam as `@etherfold/state-store-patch` (the light store), with the capability reporting and conformance coverage the seam provides.

  **`@etherfold/browser`: one kind, one call shape.** `createIndexerState(processor)` takes the processor itself. The `ProcessorKind` / `TaggedProcessor` union, the bare `EventProcessorWithInitialState` form it also accepted, and the `keepState` option are removed, along with `keepStateOnIndexedDB` and `keepStateOnLocalStorage`. `updateProcessor` takes the same bare shape.

  ```ts
  // before
  const indexer = createIndexerState({kind: 'entities', processor: fromEntityProcessor(p)(store)});
  // after
  const indexer = createIndexerState(fromEntityProcessor(p)(store));
  ```

  **`@etherfold/core`: the `KeepState` family is deleted, snapshot half included.** `KeepState`, `ExistingStateFetcher`, `StateSaver`, `AllData`, `ProcessorContext` and `EventProcessorWithInitialState` go, and so does the BLOB snapshot envelope beside them (`BLOB_SNAPSHOT_FORMAT`, `BlobSnapshotEnvelope`, `isReadableBlobSnapshot`). The seam had exactly one caller, `JSObjectEventProcessor.keepState`, and its two masters turned out to be one: the entity path's bootstrap never used it. Installing state somebody else computed is `openSnapshotAware` / `bootstrapFromSnapshot` at the STORAGE seam, where a store's own transaction is, and `ENTITY_SNAPSHOT_FORMAT` is now the only envelope number. ADR-0040's rule (a format a reader cannot read is refused, never translated) is unaffected and is what the surviving reader still does.

  **`etherfold`: `--store` loses its `file` value and `--folder` goes with it.** `--store sqlite --db <libsql url>` is the whole of it, and `--store` stays required: it is the axis a second backend arrives on. `packages/cli/src/keepState.ts` (`createFileKeepState`, the blob snapshot writer) is deleted, and so is the kind/store mismatch refusal, which had nothing left to be a mismatch between.

  **`@etherfold/utils`: a module hands over the PROCESSOR, not a kind tag** (superseding ADR-0039). `createProcessor` returns the authoring object itself; `instantiateProcessorWithKind`, `ResolvedProcessor` and `ProcessorKind` are removed, and `instantiateProcessor` returns what the factory made, typed by the caller. A module still returning `{kind, processor}` is REFUSED naming ADR-0037, rather than unwrapped, so the retired shape cannot reach a store that would ask it for `entities` and get `undefined`. The `@etherfold/utils/indexer` subpath goes too: it existed for `contextFilenames`, the blob snapshot's file naming, and `@etherfold/browser` no longer depends on this package at all.

  **The stratagems conformance workload keeps its question and loses its regeneration.** The committed golden state is still what the ported entity processor is compared against on every backend, and the vendored original is still committed (typechecked, with its `JSProcessor` type vendored beside it). What is gone is `src/oracle.ts` and the `regenerate-golden-state` script, because driving that original needed `fromJSProcessor`: the golden is now a FROZEN expectation rather than a recomputable one. `CONTEXT.md` already treated a diff on it as a FINDING and not a fixture update, so regeneration was never the normal path.

  **Six example apps used the deleted path.** `event-processor-nfts` keeps only its entity processor (which the browser demo and `etherfold index` already ran) and is the end-to-end demonstration, beside `browser-reference`. `basic`, `event-processor-bleeps`, `event-processor-conquest-eth`, `event-processor-conquest-fplay` and `mud` are DELETED rather than left broken, and `web-demo` goes with them: it consumed three of them and rendered a state blob as a JSON tree, which is the shape the entity path does not have.

- 132cc1c: The one-shot is `etherfold build`, `serve` is only the read tier, and no command is implicit.

  **BREAKING, and it is the whole point.** `etherfold index` is gone and resolves to nothing: the word is needed for the wire receiver, which receives pushed batches, owns the database and does not terminate. The one-shot that folds to the tip and exits is now named for what it PRODUCES.

  ```sh
  etherfold index -p ./processor.js --store sqlite --db file:./etherfold.db   # before
  etherfold build -p ./processor.js --store sqlite --db file:./etherfold.db   # after
  ```

  **There is no DEFAULT command any more**, so a bare `etherfold …` now needs a command word: `etherfold -p ./processor.js --store sqlite --db file:./etherfold.db` was the one-shot and is now an unknown-option error. `etherfold` with nothing after it prints help and indexes nothing. The default existed so the rename from `ei` would not also cost users their argument order (ADR-0017); the name is changing anyway, and under a set of five names chosen so a reader can tell what a process will DO, an invocation that silently means one of them is the ambiguity the set exists to remove.

  Nothing about the pipeline moved. `build` keeps every flag (`-p`, `--store`, `--db`, `--retention`, `-d`, `-n`, `--rps`, and the `ETHEREUM_NODE` fallback), every refusal, the stop-at-tip driver and the exit codes (0 at the tip, non-zero on a refusal no waiting fixes). The package's exported `run(options)` is renamed to `build(options)` to match, and `main`'s injectable `run` collaborator becomes `build`, because `run` is a DIFFERENT command in the set being built (it follows the chain, answers queries and never terminates).

  **`serve` keeps its name and narrows its promise to serving.** It holds no processor, makes no chain call and writes no indexed state: it answers over a database something else wrote. That was already true of the code and not of the docs. It is now asserted rather than described: a server started the way `serve` starts one answers `501 ingestion-not-configured` on `/ingest` and `/ingest/expected-from-block` to an authenticated caller, while `/status` still answers, and an unauthenticated caller still gets `401` first, so the absence of a processor is not something an anonymous caller can probe.

### Minor Changes

- 8a8fe33: **A deployment can now RUN from a BUNDLE, and the generation it registers is identified by that bundle's hash** (ADR-0086).

  `--processor` still names a PATH and that does not change. What changes is what the path may point AT: where it names a SELF-CONTAINED bundle, the CLI reads it, hashes it (`sha256:<hex>` over the octets), instantiates it from those bytes and registers a generation whose `processor` identity IS that hash. An author who edits a handler and forgets to bump anything gets a different generation, because there is nothing left to forget. Two machines building the same source get the same one, because the identity is the bytes and not the path they sit at.

  Nothing bundles anything: reading a file and hashing it is not bundling, and the CLI acquires no bundler.

  **Both shapes work, which is the point of this step.** A path naming an UNBUNDLED module -- one that still expects somebody else to resolve an import -- resolves through the module system exactly as it always did and keeps the author-declared identity from `getVersionHash()`. The declared `version`, `getVersionHash()` and the code fingerprint are all untouched; four migrate batches and a contract task follow and each depends on that.

  **A bundle is a module that expects nobody else to resolve anything**, which is `unresolvedImportsOf`'s existing judgement and not a second one. The consequence worth knowing: a hand-written entry point that imports NOTHING is a bundle by that definition and is identified by its bytes rather than by its `version`.

  New in `@etherfold/utils`: `openProcessorArrival(path, options)`, which lands one operator-supplied path on whichever of the two arrivals it describes and answers with `{processor, processorModule, identity?}` -- `identity` present exactly when the path named a bundle. An injected `importModule` governs the module arm alone; the bundle arm imports a `data:` URL of the bytes it just read, where the module cache is keyed on those bytes and is therefore exactly right.

  New in `@etherfold/processor-entities`: `EntityEventProcessorOptions.identity`, the identity a host HANDS a fold when the arrival derived one. Absent is the ordinary case and means the declared hash, unchanged. It is not the caller-declared version hash ADR-0043 rejected: it is derived from something the class cannot see and REPLACES the computation rather than sitting beside it, so there are still never two live answers.

  Nothing parses a processor identity anywhere in the tree, which is what lets two derivations coexist through the migration and after it.

- 882ba22: A generation NO SLOT NAMES is RECLAIMED on request, so a cap stops being the only instrument an operator has.

  A generation cap REFUSES at its bound and never evicts, which is sound and was the ONLY mechanism there was: when it fires an operator is told what they COULD delete and handed nothing to delete it with, so the remedy was hand-written SQL or a deleted database. The durable slots (ADR-0084) make the missing verb expressible for the first time, because a generation no slot names is garbage BY DEFINITION rather than by a judgement about which of four digests is safe to remove.

  **`ReceivingIndexer.reclaim()`** drops every registered generation no slot names and REPORTS what came back. The deletion is not new: it is the registry's own `deleteGeneration`, which takes the row, the state namespace (ADR-0053 makes that a `DROP`) and the stream where no registered generation is left folding it. What is new is the verb and the rule for choosing.

  ```ts
  const report = await container.reclaim();
  report.outcome; // 'reclaimed' | 'declined' | 'nothing-to-reclaim'
  report.reclaimed; // each generation NAMED, with the stream reaped and the records that went with it
  report.declined; // each one kept, and WHY
  report.slots; // what canonical / successor / predecessor hold, which a reclaim never touches
  ```

  **It never takes a generation any slot names, and `predecessor` is the one worth saying out loud**: it is not canonical right now and is exactly the way back from a bad upgrade, so "not canonical" would have been the wrong predicate. The rule is a REFCOUNT over the slot rows (`unslottedGenerations`, exported from `@etherfold/core`), which is what makes a verb that DELETES safe to hand an operator.

  **It DECLINES rather than refusing where dropping would strand a fold that follows the stream that generation writes** (ADR-0044), exactly as the existing drops decline, and says so per generation. A deletion that failed is reported the same way and the generation is still named by no slot, so the next call tries again.

  **Three answers, because "nothing happened" had three causes.** `reclaimed` names what went; `declined` says something was reclaimable and could not go yet; `nothing-to-reclaim` is a SUCCESS that says every generation this indexer holds is named by a slot. Collapsing the last two would tell an operator whose disk is full that there was nothing to free.

  **The operator's affordance is HTTP, beside the pointer move** (ADR-0057's reasoning, unchanged: a Worker is reachable only over HTTP and the CLI command set is pinned at five names):
  - `POST /{indexer}/admin/reclaim-generations` — the verb, on `ADMIN_TOKEN`, which fails closed and is deliberately never the ingest credential. It takes no body. `501 reclaim-not-held` on a host that holds no generations.
  - `GET /{indexer}/admin/canonical-generation` — widened to report `slots` (what each of the three holds), `unslotted` (everything no slot names) and a `slot` on each listed generation. This is the SEE half, so an operator stops matching digests by eye.

  `IndexerRegistryEntry` gains the optional, paired `slots()` and `reclaim()`, forwarded by `indexerEntryOn`; `etherfold run` and `etherfold index` answer both. `GenerationDeletion` now also carries `records`, how many substrate records a reaped stream subtree held, so the report can say what actually came back.

  **It is a VERB an operator runs and NOT a garbage collector.** Nothing fires it on a timer or at `open`: an automatic reclaim deletes with nobody present, which is a different decision with a different risk profile, and ADR-0084 does not make it. **The caps are UNCHANGED**: this gives an operator an instrument, it does not raise a bound or make a refusal less likely.

- 0f33468: A NAMED INDEXER IS A ROUTE SEGMENT AND A REGISTRY ENTRY, on both halves of the wire.

  An indexer-server hosted exactly one indexer: `ServerOptions.getIngestion` resolved a single `LogIngestion`, and the ingest routes were the unnamespaced `/ingest` and `/ingest/expected-from-block`. It now hosts SEVERAL, each under a NAME an operator supplies at deploy time (ADR-0036).

  **`/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block` replace the unnamespaced pair, which is GONE rather than kept beside them.** The name is a ROUTE SEGMENT and is deliberately NOT a field in the envelope: putting tenancy in the wire format would turn a misdirected batch into a payload error rather than a routing one. ADR-0004's `{source, config}` envelope and its refusal families (`409` resumable, `400` otherwise) are untouched.

  **`ServerOptions.getIndexer` replaces `getIngestion`, and resolves a registry ENTRY per name.** The entry is an object (`{ingestion}`) so that what a name holds can grow — a later generation model gives one entry several live wire contexts — without every host's resolver changing its return type. `indexerRegistry({name: streamBuilder})` builds one from a plain record for a host that knows its names up front; a host whose names depend on the request writes the function itself. Two named indexers on one server are isolated: a batch pushed to one is not visible to the other.

  **An unknown name is REFUSED, never defaulted: `404 unknown-indexer`.** A routing refusal, matching what the name is, and distinct from `501 ingestion-not-configured`, which a host with NO registry at all still answers under every name (a read tier, or a combined `run`). Both are in the non-retryable 4xx family a sender must not re-send into.

  **`createHttpIngestion` takes the indexer name beside the endpoint** (`@etherfold/core`) and posts to the namespaced routes; it refuses to be built without one rather than addressing nobody. `@etherfold/fetcher-host` reads it from `INDEXER_NAME` and demands it wherever it demands `INGEST_ENDPOINT` and `INGEST_TOKEN`, so a combined host that configures no wire is still asked for nothing.

  **The CLI grows `--indexer <name>` / `INDEXER_NAME`, REQUIRED on `fetch` and `index` and refused on `run`, `build` and `serve`.** The two halves of a split deployment agree on one name the way they already agree on one secret: `fetch` addresses `/{indexer}/ingest`, `index` registers exactly that name and refuses every other. The three commands with no wire route no batch by name, and refuse the flag with that reason rather than accepting and ignoring it.

  `StartOptions.getIngestion` on `@etherfold/platform-nodejs` becomes `getIndexer`, carried through unchanged as before.

- 12cd1ab: **A `--processor` path that names an UNBUNDLED entry point is refused at CONFIGURATION RESOLUTION, with the command that produces a bundle in the message** (ADR-0086, ADR-0048).

  A processor IS a self-contained bundle and the sha256 of its bytes is its identity, so a configuration naming an entry point names nothing a deployment can fold. That was already refused, but structurally and late: the refusal was made where the arrival was resolved, after the module had been imported, so an author whose build step had not run met an error about module resolution rather than one about their configuration. It is now made with the other input refusals, before a module is imported, a database is opened, a port is bound or a generation is registered, and it names the three things an author needs:

  ```
  -p, --processor "./dist/processor.js" names an ENTRY POINT rather than a bundle: it still imports "./abi.js",
  which nothing resolves for it. A processor is ONE self-contained file, named by the sha256 of its bytes
  (ADR-0086). Build one, and point `etherfold build` at it:

    esbuild ./dist/processor.js --bundle --format=esm --minify --outfile=dist/processor.bundle.js
  ```

  A path this process cannot read at all -- a package name, a directory, or much the commonest, the OUTPUT of a build that has not run -- is refused in the same shape, and there the command's `--outfile` is the path that was named, because writing that file is exactly what is missing. All three folding commands (`run`, `build`, `index`) refuse identically, and so does the re-read behind `POST /{indexer}/admin/reconfigure`, which reports it as `failed` with the live fold untouched.

  **It is not a second heuristic for "is this a bundle".** `unresolvedImportsOf` is this repository's only definition of self-contained -- what the artifact loader refuses on and what the arrival chooses its route with -- and it decides here too, so a bundle that merely MENTIONS a package name in a string is not refused and a `--platform=node` bundle that keeps `node:crypto` still runs.

  **`@etherfold/utils` gains `readProcessorPath`**, which answers what is at a processor path (`bundle` / `entry-point` with the specifiers it still expects somebody else to resolve / `unreadable` with the reason) without importing anything. `openProcessorArrival` now reads the path through it, so a caller that REFUSES a path and the arrival that OPENS one cannot mean two different files or two different verdicts about one.

- 56fda62: A REBUILD IN PROGRESS is never an empty answer: it is VISIBLE on `/status`, and a read that would otherwise lie REFUSES.

  "Nothing here yet" and "this is still being built" must not arrive in the same shape — the same absence-versus-contradiction discipline the reorg model and `SuspectedTruncationError` already keep. Two surfaces, no new endpoint, and no new top-level field.

  **`/status` grows the GENERATION DIMENSION inside the `cursor` envelope, exactly where ADR-0047 reserved room for it.** A host's reporter now hands over the envelope's TWO SLOTS explicitly (`StatusReport`): `value`, where the generation that answers reads has got to, and `generations`, one entry per generation the host holds.

  ```
  GET /status
  {"healthy": true, "cursor": {
    "reported": true,
    "value": {"lastFromBlock": 4200, "lastToBlock": 4242, "latestBlock": 4250, "unconfirmedBlocks": 3},
    "generations": [
      {"generation": "9f…", "canonical": true,  "follows": false, "value": {"lastToBlock": 4242, …}},
      {"generation": "3c…", "canonical": false, "follows": true,  "value": {"lastToBlock": 1200, …}}
    ]}}
  ```

  - **An entry is `{generation, canonical, follows, value?}` and the server fixes every field but the last.** `generation` is the same OPAQUE digest the feed advertises (compared, matched against the admin listing, never parsed); `follows` is the established word for a generation advanced by a REBUILD over the stored stream rather than by the wire (ADR-0044), so `value` on such an entry IS how far its rebuild has got — its own sync cursor, which is the rebuild's only durable checkpoint (ADR-0056). Fixing the shape is also what finally makes the SIZE bound structural: the only free-form part left is `value`, which owes exactly what the top-level `value` owes.
  - **`reported` keeps its exact meaning — is there a CURSOR — and `generations` sits beside it on both branches.** A FIRST BUILD is what makes that load-bearing: it holds a generation and has folded nothing, so it has generations to report and no cursor, and folding the two together would throw away the half that says what is being built. A generation whose cursor cannot be read yet is reported with NO `value` rather than dropped from the listing or zeroed (a zero reads as "synced to block 0").
  - **A host that injects no reporter still carries no `cursor` field at all**, and a reporter that throws, rejects, returns nothing or hands over something unserialisable still degrades the whole envelope to `{reported: false, reason}` without failing the request or changing `healthy`.

  **BREAKING for a host that injects a reporter**: `getCursorReport` now returns `{value, generations?}` instead of the report itself, so `() => readCursorReport(store)` becomes `() => ({value: await readCursorReport(store)})` — or, on this repo's CLI, `readStatusReport({folds, canonical})`. The two slots are named explicitly rather than sniffed for, because `value` is reported VERBATIM and a host is free to put a key called `generations` inside it; inspecting the reported value to decide which shape it was is precisely the parsing ADR-0047 forbids.

  **A READ against a named indexer with NO CANONICAL GENERATION is REFUSED with `503 no-canonical-generation`, never answered as an empty page (ADR-0058).** Both feed views resolve the pointer through ONE place below the routes (`resolveCanonicalGeneration`), so there is one answer to "which generation answers this read" and one refusal when none does — and a surface added later (a read tier answering over a database written elsewhere) inherits it rather than having to remember it.

  ```
  GET /alpha/feed
  503 {"success": false, "error": "no-canonical-generation", "indexer": "alpha", "building": ["3c…"], "message": "…"}
  ```

  - **Why it cannot be a `200`**: a read against a name whose pointer names nothing finds no rows and would answer an empty page with `hasMore: false` — byte-identical to "you are caught up". That is ADR-0015's rule on the read side: a consumer holding an unresolvable address is TOLD, never served an answer it cannot tell apart from a true one.
  - **Why `503`**: nothing about the request is wrong (not the `400` family), the name resolved (not the `404`), and the host CAN serve feeds (not the `501` a host with no registry answers). What is true is that this indexer cannot answer YET, and a caller that retries once a generation is canonical will be served.
  - **What it does NOT refuse** is a canonical generation that has folded little or nothing. The question is WHICH generation answers and never how far it has got; a rebuilding generation is never the one answering, because the pointer moves at the END of a rebuild.
  - `IndexerRegistryEntry.canonicalGeneration()` may therefore answer `undefined`, and the admin route REPORTS that state (`canonical` absent, the generations still listed) rather than refusing it — which is the right way round: a read served from nothing is a wrong answer, while "nothing answers reads yet, and here is what is registered" is what an operator opened that route to see.

  **`readStatusReport` (`etherfold`)** is the reporter the folding commands now inject: one cursor read per generation, nothing computed on demand, and the canonical generation's answer reused as the top-level `value`. `run` and `index` hold ONE fold and report it as one generation, so the shape of `/status` does not depend on how many a deployment happens to hold; `readCursorReport` is unchanged and still summarises one store.

- 5258a04: A change now reaches a RUNNING deployment: `POST /{indexer}/admin/reconfigure` makes a process re-read its own configuration and register whatever generation that names, beside the incumbent, without a restart.

  **The trigger is an ENDPOINT, and whatever noticed the file changed stays OUTSIDE the process.** Everything downstream of "a successor exists" was already built and careful — a successor is registered beside the incumbent, nothing is discarded, the incumbent goes on answering every read, a follower is advanced by a bounded rebuild the host schedules, and the pointer moves on its own once it is level — but nothing INTRODUCED one: a generation was registered when a container OPENED, from configuration, so a changed processor reached a running `run` by stopping it and starting it again. This is the missing half. A file watcher inside the indexer would be development tooling by construction, which is what makes it tempting to gate behind a development flag and then need a second mechanism for production; one endpoint serves a dev watcher, a deploy hook and a CI step alike.

  **Its job is RE-READ, not receive.** A processor is code and cannot cross HTTP, so the route takes no body: the process re-resolves its configuration, re-imports the processor module and registers whatever generation that now names. The watcher owns WHEN and the process owns WHAT. It sits under the same `/{indexer}/admin/` segment as the pointer move and is guarded by the same `ADMIN_TOKEN`, which fails closed and is deliberately never the ingest credential, so handing a remote caller the ability to start a fold reuses the existing authorisation story instead of opening a second one.

  **It answers WHICH of three things it did**, because "I saved the file and nothing happened" otherwise has three indistinguishable causes. `registered` NAMES the generation it registered (`200`, both key fields plus the opaque digest a feed advertises it by, so the value it answers with is the value an operator matches or promotes). `unchanged` is a SUCCESS saying the configuration named the generation this deployment already holds (`200`, with the reason). `failed` refuses (`409`), names what went wrong, and promises the deployment is exactly as it was — a processor that does not compile is the NORMAL state between the two halves of one change, not an exception, so the whole re-read happens before anything is registered and the next build repairs it on the same running process.

  **`unchanged` is the answer an ordinary handler edit gets, and that is stated rather than papered over.** A generation is identified by the processor's DECLARED version hash — its `version` plus a hash of the entity declarations and the config — and never by the source text of its handlers: the code fingerprint is advisory and deliberately stays out of the identity, because a bundler re-emitting the same behaviour differently would otherwise invalidate every deployment's state. So editing a handler body alone names the generation already held, and the refusal says so and says to bump `version`.

  **The module cache is defeated by a cache-busting specifier**, which is what makes the whole thing work at all: `import()` returns the CACHED module for a path already imported, so a re-read without it observes every rebuild as no change. `etherfold` supplies the loader an importer that appends a unique query to the module's file URL. The cost is stated: every reload adds a module instance to the ESM registry and none are ever collected, which is nothing for a development loop and worth knowing for a long-lived process being triggered by a deploy hook.

  **New on `@etherfold/server`**: `IndexerRegistryEntry.reconfigure` (OPTIONAL — absent is a CAPABILITY statement answered with `501 reconfigure-not-held`, exactly as an absent pointer or an absent ingestion is, and independent of `generations`/`promote`, since a host may hold a registry with nothing to re-read from) and the `ReconfigureReport` type it answers with — named that, and not `ReconfigureOutcome`, because `@etherfold/core` already spends that name on the IN-PLACE verb's discard verdict, exactly as `@etherfold/browser`'s `HostReconfigure` already sidesteps it. `etherfold run` registers it; `build`, `index` and `serve` do not, and say so.

  **New on `etherfold`**: `reconfigurerFor` / `ReconfigureContext` (`src/reconfigure.ts`), `PreparedIndexing.reconfigure`, and `foldPartsFor` / `FoldParts` / `openIndexingSource` (`src/folding.ts`) — the fold assembly and the source resolution factored out of `openFolding` and `prepareIndexing` so that a re-read builds its successor the one way this deployment builds folds, rather than a second way that could drift.

- daf335d: **`etherfold index` now SCHEDULES the bounded rebuild for the generations it holds, so a split deployment finishes a processor upgrade by restarting -- like the combined one already does.**

  The arming half landed with ADR-0084: a successor registered at `open` is armed from its durable slot, whether it arrived at `open` or through a reconfigure. This is the other half. `rebuildMore` is TWO things -- it advances every follower and then SETTLES the pointer -- and `index` called it nowhere: only `driveCycles` did, and that runs on `run`. So a receiver restarted with a changed processor came up holding an armed successor, the wire carried it to level, and the pointer stayed on the incumbent for ever. A split deployment's only route to an upgraded fold was deleting a generation by hand.

  **Where the turn comes from, and what it costs.** A TIMER, at `DEFAULT_REBUILD_INTERVAL_SECONDS` (4), exported from `etherfold`. `index` is driven by ARRIVALS rather than by a clock, and that is exactly why the turn is not taken there: ADR-0022 says the rebuild is a call the HOST schedules and never a side effect of a write, and ingest is the only other thing that happens in this process, so "one chunk after each batch" would be that side effect under another name -- an arbitrarily long catch-up between a sender and its acknowledgement, for work that batch did not cause. The cadence is `run`'s own rather than a new number: the gap a caught-up `run` waits is its poll interval, which defaults to 4s, so a follower advances at the same rate on both shapes. A tick with nothing to advance is a few registry reads, the same bargain `run`'s unconditional call already states; a tick with something to advance is bounded at `DEFAULT_MAX_EMISSIONS_PER_CHUNK` (2000) stored emissions, so a large catch-up spreads over ticks instead of stalling the ingest path in one.

  **The rebuild and the prune are SERIALISED, sharing one in-flight guard.** The scarce thing is the one database handle, not the verb: two maintenance passes at once would contend with the fold a sender is waiting on, which is what riding a host-owned gap exists to avoid. An overlapping tick is SKIPPED rather than queued, because both passes are resumable by construction and the next tick continues, while queueing would let a backlog grow behind a slow pass. The prune's own knob (`--prune-interval` / `PRUNE_INTERVAL`) keeps its exact meaning, including `0`: disabling a disk reclaim is deliberately not a way to disable processor upgrades.

  **`index` is still given no fetcher, and the case it therefore cannot serve is said out loud.** A fold added at `open` is not a follower -- `add` decides that from "do I already hold a fold on this stream", and at `open` the fold list is empty -- so it holds no rebuild over the stored stream and is fed by the WIRE. Nothing on this half can fetch for it. A receiver that comes up holding a successor now says so in its startup lines, names the canonical generation still answering, and states that the successor advances only from what a sender pushes at `/{indexer}/ingest` for its own `{source, config}` -- because a sender configured for a different source or stream config is refused there as a foreign context, and that refusal is visible on the SENDER and nowhere here. A process holding no successor says nothing.

  **The stale module-header claim is CORRECTED rather than made true.** It said a batch naming a fold this process has not seen CREATES a generation beside the live one. No code path ever did that: `ReceivingIndexer.add` is reached from `open()` and from a re-read (`reconfigure.ts`, a `run`-only surface), and a batch matching no live wire context is refused with `400 context-mismatch` listing the ones this name holds. Creating a fold from an unseen batch would be a FEATURE -- a receiver that registers generations on a sender's say-so -- and not a cleanup, so the header now says what the code does: a changed `{source, config}` or a changed processor registers a generation beside the live one at RESTART, which is the only moment this command adds a fold. The SAME sentence sat in `CONTEXT.md`'s glossary entry for the two containers and is corrected there too, since one artifact saying it and the other not is how a false claim survives being fixed.

  **The `--promotion` refusal on `index` now gives a reason that is true.** It said the receiving half "schedules no rebuild, so nothing is ever added beside its live fold and the policy would have nothing to act on". The second half stopped being true with this change: a successor the configuration named at start-up IS carried to level and promoted here, under the DEFAULT policy. The flag is still REFUSED and the refusal now says what it is about -- this command takes no promotion input, and whether it should is a question nothing has answered -- which keeps ADR-0048's direction, where refusal to optional is additive and the reverse is breaking. `packages/cli/README.md` carries the same correction.

  `deps.rebuildIntervalSeconds` is new on `IndexDependencies`, the same instrument `pruneIntervalSeconds` is: a test sets it low to watch an upgrade finish without waiting for a deployment's clock, or to `0` to assert that the schedule is what finishes it. There is deliberately NO FLAG for it -- turning it off is turning off processor upgrades on this half.

  `run` is unchanged: it already had both halves. The end-to-end claim is asserted where it lives, on a split deployment stood up the way the CLI tests stand one up -- a real receiver on a real port with a real `etherfold fetch` pushing at it, stopped, and re-run over the same libSQL handle with an edited bundle, driven until the pointer moves (`packages/cli/test/anIndexProcessAdvancesItsSuccessor.test.ts`).

- ab779b0: Every deployment shape stores the emission stream it folded, not only the one behind an HTTP route.

  `appendEmissions` had exactly one call site, the HTTP ingest route, so `etherfold run` and `etherfold build` -- which fold through the direct in-process wire and touch no route -- produced databases whose `_emissions` table was EMPTY. That made the stored stream a fact about the TRANSPORT, exactly as the reorg counters were one task earlier (ADR-0050), and on worse ground: a `build` artifact is a publishable database later fed into another process, so without a stored stream a processor-logic change has to re-fetch the whole history from the node rather than re-fold what is already on disk, and both of ADR-0006's feed views were a split-shape-only surface.

  **The append is a port on the FOLD, supplied by whoever owns the store** (ADR-0052). `StreamBuilder.receive` hands each batch's emissions to an `EmissionAppender` once, whichever entrance the batch arrived through, and the ingest route is a CALLER of `receive` rather than the owner of a write -- so a receiver that both concludes a batch and serves the request that carried it stores it once, and `run`, `build` and `index` all store what they fold.

  **This write is NOT best-effort, and it is ordered BEFORE the fold.** A reorg count that cannot be persisted is a logged miscount; a stream that cannot be persisted is a HOLE -- a state that advanced past events the stream never received, which is silent, permanent, self-consistent and invisible to the gap check. So a store that cannot take the batch refuses the batch: nothing is processed, the cursor does not move, and the next cycle re-derives the same delta.
  - **`@etherfold/core`** gains `EmissionAppender` and `EmissionWrite`, plus `StreamBuilderOptions.appendEmissions`. Like `recordReorg` it is not hashed into the wire identity, and it is optional: a host that supplies none stores no stream, and folds identically. `IngestionOutcome.emissions` is unchanged and is still REPORTED, but a caller that stored it would now be storing a second copy.
  - **`@etherfold/server`** exports `emissionAppenderFor(db, indexer)`, which binds the append to a database and a named indexer. Its ingest route performs no durable write at all now: everything a batch costs happens inside `receive`, and the route decides who may call it and which status code each refusal is. A store failure is a `500` with `lastError` set, and the sender's own recovery is unaffected -- nothing was applied, so its next attempt meets the cursor it already had.
  - **`etherfold`** builds the appender in `buildProcessor`, beside the reorg recorder and against the same handle, so no folding command can store into a database it does not fold into. **`--indexer` becomes OPTIONAL on `run` and `build`, defaulting to `default`**, and stays REQUIRED and never defaulted on `fetch` and `index`. The never-defaulted rule protects the WIRE (a name a host was not built with must be a routing error, ADR-0036), and a combined process routes nothing: it needs a name only to KEY the stream it stores, which is `NOT NULL` on every emission row. `serve` still refuses the flag.

  **One behaviour change worth reading before upgrading:** `--no-auto-setup` against a database nobody has migrated now STOPS a fold rather than degrading it, because the fixed tables carry `_emissions` and a fold that cannot store what it folded must not advance past it. The cycle is retried and the deployment catches up when the schema arrives.

  `packages/cli/test/equivalence.test.ts` compares the stored streams of `run` and `fetch` plus `index` row for row and column for column, asserts the `build` artifact carries the same seven rows under the default name, drives a refused append and asserts it leaves no hole, and serves both feed views over a database a combined process folded. `packages/server/test/oneEmissionAppendSite.test.ts` scans the workspace and asserts there is no second site appending to that table.

- 8bb063e: The server's FIXED tables move into the reserved `_` namespace: `Meta` becomes `_meta` and `EmissionStream` becomes `_emissions` (with its indexes `_emissions_canonical` and `_emissions_by_address_topic`). Nothing about what they CONTAIN changes: same columns, same keys, same two indexes, same semantics.

  It closes a silent collision. Entity tables are created as `CREATE TABLE IF NOT EXISTS "<entity.name>"`, and in every combined shape the store and the server share ONE database handle (`buildProcessor`), so a processor declaring an entity called `Meta` or `EmissionStream` issued that DDL against the SERVER's table: `IF NOT EXISTS` made it succeed silently, and the failure surfaced much later as a column error on a write, pointing nowhere near the declaration that caused it.

  The mechanism that closes it already existed, and the server's tables were simply outside it. `@etherfold/state-store` reserves the `_` prefix and refuses any entity inside it, and the store's own fixed tables already live there as `_blocks` and `_cursor`. Moving the server's two in makes the collision unreachable by CONSTRUCTION, with no new API, no dependency from the store to the server, and no widening of the entity legality rules. Parameterising the reserved set so a composing host declares its fixed names was considered and rejected: it grows optional API on the store for a guard that is off by default (a browser uses the store with no server at all) and relocates the discipline rather than removing it.

  The convention is now a GUARANTEE rather than a memory: a test scans `packages/server/src/schema/sql/db.sql` and fails if any table or index it creates does not begin with `_`, with a guard so an empty or unparsed scan cannot pass it. A fixed table added later without the prefix fails the gate instead of shipping a collision.

  There is NO migration and NO compatibility shim. The `schemaVersion` row lives in the table that was renamed, so a database migrated by an older build has no `_meta` and reports the schema as UNAPPLIED, which is the correct signal: those tables really did change. `SCHEMA_VERSION` therefore stays at `2` -- no database can hold a `_meta` row this build did not write.

  `EMISSION_STREAM_TABLE` still names the table for a host appending under a name it holds; its value is now `_emissions`. `@etherfold/state-store`'s reserved-identifier refusal is unchanged in behaviour, and its message and docstring now say the prefix means "not a user entity" rather than "the store's", since two packages place tables there. The CLI's reorg counters write to `_meta`.

- 56acbef: Every deployment shape counts the reorgs it concluded, not only the one behind an HTTP route.

  `etherfold run` reverted state on a reorg correctly and then reported `{absence: 0, contradiction: 0}` on `/status` for ever, because the counter was written by the HTTP ingest route and a combined process folds through the direct in-process wire and never touches it. `etherfold build` had no `Meta` table at all. So an operational counter was a fact about the TRANSPORT, and the shape the milestone calls the default was the one that could not report it. Nothing was mis-indexed: the fold was already correct in both shapes, and the equivalence suite proved it. What was missing was the observability, on the one `/status` field the two shapes did not agree about.

  **The count is taken where the reorg is CONCLUDED, and written by whoever OWNS the store** (ADR-0050). `StreamBuilder.receive` reports a concluded revert to a `ReorgRecorder` exactly once, whichever entrance the batch arrived through, and the deployment that opened the database supplies that recorder. The ingest route is a CALLER of `receive` now rather than the owner of a write, so a receiver that both concludes a revert and serves the request that carried it counts it once, and `run`, `build` and `index` all count.
  - **`@etherfold/core`** gains `ReorgRecorder`, `ReorgCounters`, `RecordedReorg` and the durable key names (`REORG_COUNTER_KEY`, `REORG_LAST_KEY`), plus `StreamBuilderOptions.recordReorg`. The keys live here because the writer and the reader are deliberately in different packages: a read tier owns no store and still has to answer "how many reverts does this database record". `recordReorg` is not hashed into the wire identity, since where a count goes is not something a sender asserts. `IngestionOutcome.reorg` is unchanged and is REPORTED rather than delegated: a caller that counted from it would count only on the shape it happens to be, and twice on the shape that is both.
  - **`@etherfold/server`** no longer exports `recordReorg` and writes no counters. It reads them (`readReorgCounters`) for `/status`, including on a read tier that folds nothing, and `ReorgCounters` is re-exported from core. Its dependency posture is unchanged: it still owns no store package.
  - **`@etherfold/platform-nodejs`** exports `ensureFixedSchema(db)`, the auto-setup step `startServer` already performed, so a process that binds no port can still create the fixed tables.
  - **`etherfold`** owns the one writer (`recordReorg`, `reorgRecorderFor`), built by `buildProcessor` against the handle the command folds into, so no folding command can count into a database it does not fold into. **`build` applies the fixed-table schema**, which it never did: it binds no port, so nothing else ever would, and a database it emits is a publishable ARTIFACT that must carry its provenance the moment it becomes an INPUT rather than an output.

  **A counter that cannot be persisted never takes down a fold or a request**, on any shape. That guarantee belonged to the route (`recordReorgSafely`); it lives in `StreamBuilder` now, so it is owed by every shape that counts.

  `packages/cli/test/equivalence.test.ts` drops the exception it carried and compares the `/status` counters between `run` and `fetch` plus `index` directly, through the reorg it already drives: the same counts, the same classification, the same block, and once each. `packages/core/test/oneReorgWriteSite.test.ts` scans the workspace and asserts there is no second site recording a reorg.

- 70af4e1: `etherfold fetch` runs the chain-facing half of a split deployment, and it is now the ONLY way to run a fetcher.

  ```sh
  etherfold fetch -n https://rpc.example -d ./deployments --ingest-endpoint https://indexer.example
  ```

  It follows the chain and pushes contiguous ranges of raw logs at an indexer-server elsewhere, so splitting a deployment stays a deployment decision rather than a rewrite: run this near your node, and the folding half anywhere.

  **It is a FRONT DOOR, not a new deployable.** `@etherfold/platform-nodejs-fetcher` already shipped the loop, the signals and the exit code; what it did not have was a flag surface, because it was configured from the environment alone. So this command resolves through the same path as every other one (flags first, environment behind them, one name per input), opens the source, and hands the five inputs an operator configures to that adapter as overrides:

  | flag                | variable              |                                                                                                         |
  | ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
  | `-n, --node-url`    | `ETH_NODE_URI`        | the chain to read                                                                                       |
  | `-d, --deployments` | `INDEXING_SOURCE`     | what to index. REQUIRED in one form or the other: there is no processor module to read contracts out of |
  | `--ingest-endpoint` | `INGEST_ENDPOINT`     | the indexer-server to push to                                                                           |
  | `--ingest-token`    | `INGEST_TOKEN`        | the wire's shared secret                                                                                |
  | `--rps`             | `REQUESTS_PER_SECOND` | the rate limit on the node                                                                              |

  Everything else a fetcher deployment tunes (`SUSPECT_RESULT_COUNT`, the fetch bounds, the backoff, the stream identity) stays in the environment the fetcher host already publishes, rather than growing a second name here.
  - **It owns no state, and says so instead of ignoring the flags that imply otherwise.** `--store` and `--db` are REFUSED (a fetcher holds no cursor and no database, ADR-0003), `-p` is refused (the chain-facing half holds no processor; whatever folds these logs lives behind `--ingest-endpoint`), and `--port` / `--host` are refused (it pushes to an HTTP surface, it does not answer one). A missing node URL, source, endpoint or token is a refusal naming the flag AND the variable, raised before the chain is dialled.
  - **There is nowhere to remember a block number**: no state file, no lock file, no `--from-block`. Progress across restarts comes from the receiver's cursor and from nothing else, and the `409` on the next start is the recovery.
  - **How it ends is the adapter's answer, taken whole** (`runFetcherProcess`): `SIGINT` / `SIGTERM` let the cycle in flight finish and exit `0`; a refusal no waiting fixes exits non-zero, because a fetcher that stays up while achieving nothing is indistinguishable from a working one until somebody reads the state it is not producing; everything else is retried on the escalating, capped backoff.
  - **The CLI is the process now**, so it is what hooks the `named-logs` facade to the console for a fetch run -- the job the retired `etherfold-fetch` binary used to do, and one that a library must not do for an application embedding it.

  New API: **`fetch`** (resolve, open the source and start the loop; returns the adapter's handle), **`fetchMain`** (the process shape, exiting on the code the adapter resolved) and **`prepareFetching`** (this command's row of the table, in the shape `startFetcher` takes).

- 74f74f5: `etherfold index` runs an ENTITY processor into a store, so the same processor object a browser tab indexes with also indexes on a server.

  ```sh
  etherfold index -p ./processor.js --store file   --folder ./state          # free-form, unchanged
  etherfold index -p ./processor.js --store sqlite --db file:./etherfold.db  # entity path, new
  ```

  **`--store` is required and is never defaulted.** The two answers are not interchangeable: `file` keeps a free-form state blob with no history, `sqlite` keeps versioned entity rows that answer as-of reads, survive a reorg, and hold the sync cursor in the same transaction as the block it describes (ADR-0027). A default would hide that difference at the moment a deployment picks. `--db <libsql url>` accompanies `sqlite`, `--folder` accompanies `file`, and each is REFUSED with the other store rather than accepted and ignored. `--retention <blocks|revert-only|unbounded>` is settable on the sqlite arm; nothing prunes inside the index loop, because pruning is a call a host schedules (ADR-0022).

  **The processor KIND comes from the MODULE, not from a flag** (ADR-0039). `createProcessor` returns `{kind: 'entities', processor}` — the same two words and the same shape `@etherfold/browser` takes — and an UNTAGGED module still means `'js-object'`, so every existing CLI invocation keeps working unchanged. A kind/store mismatch is refused at startup naming both, before any RPC call. `@etherfold/utils` gains `instantiateProcessorWithKind` and `ResolvedProcessor` for that; `instantiateProcessor` is unchanged for its existing callers except that it now unwraps a `'js-object'` tag and refuses an `'entities'` module instead of returning something that is not an `EventProcessor`.

  **The engine underneath changed, and `EthereumIndexer` is no longer constructed anywhere in the CLI.** The command now folds through the two ADR-0003 halves with the transport removed — `LogFetcher` → `createDirectIngestion` → `StreamBuilder` → the processor — driven by `runFetcherLoop` plus an `AbortController` that stops at the tip, so the one-shot exits `0` at the tip and non-zero on a refusal no waiting fixes (a foreign `{source, config}`, the wrong chain, a suspected truncation). That is one server-side folding engine rather than two, which is what makes "the split is a deployment choice" testable rather than a claim about two implementations that agree today. It also brings the fetch cycle's machinery to the CLI: announced AND silent truncation detection, the cursor-correction protocol, backoff, and the five-report classification. `EthereumIndexer` is untouched and remains the browser's engine.

  Breaking, and cheap because nothing is published yet:
  - `--store` is now required, so an existing `etherfold index -p … -f …` invocation gains `--store file`;
  - `indexToTip` and `init` are gone from `etherfold`'s module exports, replaced by `prepareIndexing` (which returns the assembled pipeline plus an `index()` that drives it to the tip) and `run`;
  - `@etherfold/core` exports `resolveStreamConfig`, so a host can size a store's retention floor against the finality the stream actually runs with instead of restating the default and silently forking the wire's config hash.

- 1de190f: `etherfold index` receives a pushed stream, owns the database, and completes the five-name command set.

  ```sh
  etherfold index -p ./dist/processor.js --store sqlite --db file:./etherfold.db -d ./deployments
  ```

  The half a split deployment was missing. The chain-facing half has been runnable all along (`etherfold fetch`); what nothing assembled was a server that HOLDS a processor, so a pushed batch met a `501` and a split deployment had a sender and no receiver. This is that receiver: it folds batches another process pushed to it, through the same stream-builder, the same entity processor and the same versioned store `run` folds through, on ONE libSQL handle it also hands to the server. So a split deployment is `index` plus `serve` against one database, and the shape falls out of the command set instead of needing to be explained.

  **It exposes the WRITE path and not the query API, and that asymmetry is the point.** It has an HTTP surface because it must RECEIVE pushes; answering queries is `serve`'s. `/status` is available because there is an HTTP surface, and it reports on the database rather than on the process -- including the cursor, through the same injected reporter `run` builds, which is what makes a split deployment observable.
  - **It makes NO chain call, and that constrains how it resolves its source.** There is no provider in this path, no log-fetcher and no fetcher host. `-n` / `--rps` are REFUSED naming what this command is instead, and the source must be given EXPLICITLY (`-d`, or `INDEXING_SOURCE` as JSON): the wire identity is derived from the source and the stream config together, so a source resolved by asking a node which chain it is on could not be the sender's. A processor module whose contracts are keyed per chain is refused by name, naming both explicit forms, rather than quietly costing an `eth_chainId`.
  - **It authenticates or it refuses everyone.** `--ingest-token` (`INGEST_TOKEN`, which is preferable) is REQUIRED, so a receiver with no secret configured never binds a port rather than coming up as a write endpoint that answers `401` to a sender with no way to know why. A wrong secret is a `401` naming the variable, and nothing is applied.
  - **It is idempotent by cursor, because the cursor IS the idempotency key.** A batch that does not start at the receiver's own `expectedFromBlock` is refused with a `409` carrying that value, and the sender re-sends from there; a sender that fell behind is corrected with no operator involved, and a replayed batch cannot be applied twice.
  - **It owns its database.** The store's tables are created BEFORE a port is bound, so an illegal entity declaration or a retention window that does not cover what a reorg can reach is a refusal that never starts, rather than a `500` to a sender on a process still reporting itself healthy. The server's fixed-table schema is applied at startup as it is for every Node host; `--no-auto-setup` takes that back.
  - **It does not terminate.** A receiver has no tip to stop at -- what it folds arrives from somewhere else -- so it ends on `SIGINT` / `SIGTERM` with exit code `0`, and exits `1` only when it could not start at all.

  **The split is now a deployment CHOICE rather than a second implementation, and that is asserted at the COMMANDS.** `run` and `fetch` plus `index` fold the same processor and the same entity declarations over the same fixture chain -- including a reorg whose replacement branch carries FEWER events -- and land on identical state and an identical cursor, with the transport as the only difference. `index` plus `serve` against one database answer what `run` answers, through the read surface generated from the entity declarations and on the `/status` fields the server derives from the database. `serve` reports no cursor, which is correct rather than a bug: the cursor reaches `/status` only through an injected reporter, and a read tier owns no store.

  New API: **`index`** (assemble the receiver and start answering; returns a handle carrying the url, the one database handle, the store, the processor and the stream-builder), **`indexMain`** (the process shape, resolving the exit code), and the shared folding assembly every command that owns a database now builds through (**`buildProcessor`**, **`openExplicitSource`**, **`STREAM_CONFIG`**).

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

- 598f04c: **`--prune-interval <seconds>` (`PRUNE_INTERVAL`) sets the prune cadence on `etherfold index`.**

  `index` receives pushes and has no cycle, so its scheduled prune runs on a clock rather than in a gap that already exists. That clock is now configurable instead of fixed: `--prune-interval 300` to prune every five minutes, `--prune-interval 0` to turn the schedule off entirely. It defaults to 60 seconds.

  `0` is accepted here, unlike a prune BUDGET of zero, which the seam refuses. The difference is that this is a cadence and not an amount: an operator can coherently want no schedule (a database pruned by something else, deletes scheduled outside the process), while asking for passes that delete nothing is a miscomputed budget. It is also not a way to say you want nothing dropped. That is `--retention unbounded`, the default, where the store answers every historical read rather than refusing the ones it silently stopped keeping.

  **It is REFUSED on every other command, each naming why.** `run` and `build` prune in the gap their cycle already waits, so their prune cadence IS their poll interval and a second clock would be a second answer to a settled question. `fetch` holds no state to prune. `serve` folds nothing and enforces no retention: it reads a database something else wrote, and that writer is what schedules the prune. The asymmetry is deliberate and documented at the point of refusal rather than left to be discovered.

- 0403310: `run` and `build` drive the folds their container HOLDS rather than one receiver captured at `open`, and a `build` settles its pointer before it exits.

  The first piece of ADR-0087. The combined CLI was the one place left that remembered a single receiver instead of asking which contexts are LIVE, and the one-shot was the one command that never settled.

  **`createDirectIngestion` takes a `LiveIngestions` function as well as one `LogIngestion`.** A caller holding a GENERATION CONTAINER has no single receiver to hand over: the container holds several folds, only some of them have one — a FOLLOWER re-folds a stored stream and is deliberately not addressable on the wire (ADR-0044) — and WHICH of them is live moves while the process runs. On that arm the target routes exactly as the ingest route does, selecting on the batch's own `{source, config}` with `sameWireContext`, so the combined shape and the split shape route on ONE fact. It is a widened parameter rather than a sibling function, because there is one concept here and a second name for it would be a second thing to keep in step.

  ```ts
  createDirectIngestion(() => container.liveIngestions());
  ```

  **`NoLiveReceiverError` is what it answers when nothing matches, and `retryable` is a fact about the instance.** Live receivers exist and none is yours is a MISCONFIGURATION, exactly like `WireContextMismatchError`, so it is not retryable. NOTHING live at all is a fact about the MOMENT — what a container whose every held fold is a follower answers — and the container's own machinery closes it, since a bounded rebuild advances the follower and writer succession hands it the wire once it is level (ADR-0044's second amendment). So that one IS retryable: the host stays up, goes on rebuilding, and says so every cycle, which is that amendment's own trade — an unfed stream is visible and recoverable where a silently idle one is neither. It names EVERY live context rather than picking one, for the ingest route's own reason. What it never does is invent an `expectedFromBlock`, which would be a fetcher fetching ranges into nothing.

  **The CLI's fetch assembly no longer reads `container.ingestion`.** That getter throws — "the opening fold of this `ReceivingIndexer` has no receiver, which `open` cannot produce" — and the whole assembly rested on it, so a restarted deployment whose only fold is a follower could not have STARTED. `FoldingAssembly.streamBuilder`, `PreparedIndexing.streamBuilder` and `RunningIndexer` / `RunningReceiver`'s are now OPTIONAL and read off the held fold, where the receiver is already optional: they REPORT which engine a process came up folding and nothing feeds through them.

  **A re-run `build` exits with the pointer on the generation it just folded.** `driveCycles` wrapped its whole rebuild-and-settle block in `if (!stopAtTip)`, so a `build` settled nothing, ever. That was not hypothetical: re-run a `build` over a database it already wrote with CHANGED processor bytes and it is a different identity, so the container registers a successor beside the canonical generation exactly as a restarted `run` does, folds it to the tip — and then exited with the pointer still naming the OLD generation, publishing an artifact that served the old fold with a fully caught-up newer one beside it. The one-shot now takes the same bounded step `run` takes between cycles, ONCE, after the loop and beside the retention pass that is there for the identical reason. It advances every follower it holds by one chunk and settles once; it does NOT wait for anything to catch up, because a settle that waited would make the one-shot unbounded. A `build` stopped from outside skips it, on the same rule as the prune.

  **`run` is unchanged.** Its loop already settled every cycle and still does, once.

  **`build`'s docstring is CORRECTED rather than made true by refusing.** It claimed a one-shot "opens the container with one fold and exits, so it never adds a second and never promotes"; the first half is measured false and the second was true only because of it. Refusing to register the successor would have been a new refusal an operator meets on the ordinary redeploy, where folding the new generation and publishing it costs nothing and is what the generation model is for. `--promotion` is still refused on `build`, and its message now says what the command DOES (takes no input; settles its one successor under the default policy) instead of the claim that it never promotes.

- 0fd7dc9: `etherfold run` follows a chain, folds a processor into SQLite and answers HTTP, in ONE process.

  The command the whole set exists for, and the default thing to reach for. One terminal invocation, no knowledge required of how the components divide:

  ```sh
  etherfold run -p ./dist/processor.js --store sqlite --db file:./etherfold.db -n https://rpc.example --port 2000
  ```

  **It is ASSEMBLY, and every part of it already shipped.** A log-fetcher pushing into a stream-builder through the in-process direct ingestion (the two ADR-0003 halves with the transport removed), the stream-builder folding an entity processor into a versioned state store, that store's libSQL handle handed to the server as its database, and the whole thing driven by the fetcher host's loop. It is the SAME assembly `build` uses — one `prepareIndexing`, one `driveCycles` — with one difference: `build` aborts on the first report that reached the tip, and `run` does not. No component is implemented twice, and the browser's engine is constructed nowhere in the command path.
  - **It does not stop at the tip.** It backs off to the poll interval and keeps following. Stopping is a SIGNAL (exit `0`, with the cycle in flight allowed to finish), or a refusal no waiting fixes (non-zero), and nothing else. A retryable failure is retried indefinitely on the escalating, capped backoff rather than after N attempts, so a transient node outage does not leave a stopped indexer behind.
  - **It serves, on the handle it folds into.** One database, built once by the command: the store writes through it and the server answers over it, rather than two connections with two views of it.
  - **`/status` reports a cursor that ADVANCES**, through the `getCursorReport` seam: `{lastFromBlock, lastToBlock, latestBlock, unconfirmedBlocks}`. Four numbers and never the stored cursor itself, which is a serialized sync structure carrying a window of decoded events — `/status` reports what a host hands it verbatim (ADR-0047), so bounding it is the host's job.
  - **A `run` process hosts no remote writer.** It fetches for itself, so no ingestion capability is injected into its server: an authenticated call to `/ingest` answers `501 ingestion-not-configured`, an unauthenticated one still answers `401`, and `--ingest-endpoint` / `--ingest-token` are refused because there is no wire to configure. The command that receives pushes is `index`.
  - Every input resolves through the same configuration path as the other commands (flags first, environment behind them), and a missing node URL, database or processor is a refusal naming the flag AND the variable, raised before the chain is dialled, a database is opened or a port is bound.

  New API on `etherfold`: **`run`** (assemble, serve and start following; returns a handle with `url`, `db`, `store`, `stopped` and `stop()`), **`runMain`** (the process shape, resolving the exit code) and **`readCursorReport`**. `PreparedIndexing` gained `db` (the one handle) and `config` (the command's resolved row), and its `index()` now follows the tip when the command is `run`.

  `@etherfold/platform-nodejs-fetcher` exports **`stopOnSignals(controller)`**, the signal half of `startFetcher` on its own, so a combined process that drives its own loop stops on `SIGINT`/`SIGTERM` through the same answer rather than a second copy of it.

- 2048aa1: The COMBINED `etherfold run` serves the named indexer it folds, and refuses ingestion because it SAYS it accepts none.

  `run` answered `/status` and nothing else. Every data route is namespaced (`/{indexer}/...`) and resolves through one shared lookup, that lookup answers `501` on a host that supplies no registry of named indexers, and `run` supplied none -- so the FEED, the CANONICAL view, the STATE-MOVED signal and the operator's own promote/revert route were all dark on the shape `CONTEXT.md` calls the milestone. That was never decided. What `run` deliberately withholds is INGESTION (it fetches the chain for itself, so a remote sender pushing into it would be a second writer nobody asked for), and that argument covers the write path and says nothing about reads: they went dark as a SIDE EFFECT, because registration was ALL OR NOTHING.

  **`IndexerRegistryEntry.liveIngestions` is now OPTIONAL, and its ABSENCE states that a name accepts no ingestion** (`@etherfold/server`). It is a CAPABILITY statement, exactly as an absent `generations` / `promote` / `onStateMoved` is, and the ingest routes answer it with **`501 ingestion-not-accepted`** -- distinct from `501 ingestion-not-configured` (this host has no registry at all) and from `404 unknown-indexer` (a tenant it was not built with), so an operator can tell the three apart. It is decided BEFORE the body is read, since no payload could change it, and it is PER ENTRY, so a host may accept pushes for one name and refuse them for another.

  **ABSENT is deliberately not an EMPTY list.** `[]` means "no live wire contexts right now" -- every generation deleted, its streams reaped -- which is a legitimate transient state on a host that DOES accept ingestion, and which still answers exactly what it always did (`400 context-mismatch` naming the empty `expected`, and an empty `contexts` list from the cursor question). Expressing a permanent refusal that way would make the two indistinguishable to a sender and would have the route accept a batch it silently dropped. `indexerEntryOn` forwards `liveIngestions` only where what it was handed answers it, as it already does for the other optional questions.

  **`etherfold run` registers the one name it folds under, READ-ONLY.** Every row of its stored stream and its generation registry is already keyed on that name (`--indexer` / `INDEXER_NAME`, defaulting to `default`), so `/{indexer}/feed`, `/{indexer}/canonical`, `/{indexer}/state-moved` and `/{indexer}/admin/canonical-generation` now answer over the database that process is writing -- the same read surface a split deployment has -- while a push answers `501 ingestion-not-accepted` with a valid `INGEST_TOKEN` presented, and a name it was not started with answers `404`. The refusal rests on the declared capability and never on a credential being unset, which is a door an operator opens by setting a variable for an unrelated reason.

  **`etherfold index` is untouched**, and so is every host that accepts ingestion: `index` registers exactly as it did, and no existing refusal changes shape. ADR-0057's note that "`run` registers no named indexer at all, so every namespaced route stays `501` there" is amended in place: the reason `run` refuses PUSHES is unchanged, and the operator's pointer surface now answers on every shape that HOLDS generations rather than only on the one fed over HTTP.

- 2c62a30: The five CLI commands hold GENERATIONS exactly as a deployed server does, so what a developer tests locally is what deploys -- and `build` holds exactly ONE.

  `run`, `build` and `index` used to fold through a bare `StreamBuilder` over one un-namespaced store, which meant a changed context reached `processor.clear()`: the state the deployment answered from was DISCARDED and it served progressively less until it had caught up. All three now assemble a `ReceivingIndexer` (`@etherfold/core`) in `packages/cli/src/folding.ts`, which is where the CLI supplies the three things that container deliberately cannot have, because it knows no database: the registry substrate (rows in `_generations` / `_generation_pointer`, ADR-0054), the per-generation TABLE NAMESPACE its state folds into (ADR-0053), and the stored stream's two ends (the appender that stores what a fold concluded and the replay source a successor re-folds it from).

  **What differs between the commands is EXECUTION, and nothing else.**
  - **`run`** may ADD a generation and PROMOTE one, because it is a long-running host: `RunningIndexer.container` is the container it holds, a fold added beside the live one is a FOLLOWER (ADR-0044), and `run` advances it by one bounded chunk in the gap its fetch loop already waits between cycles (ADR-0022). The pointer moves once, when the successor is level. It still registers no named indexer, so its ingest, feed and admin routes still answer `501`.
  - **`build`** creates one generation and exits: it never adds a second, never promotes, and run twice over the same inputs it RESOLVES the same generation rather than registering another. That is the same model at N=1, and it is what makes a `build` artifact indistinguishable from a `run` database on the generation axis -- the axis a reader of the artifact resolves through.
  - **`index`** folds through the same container, so a batch naming a fold it has not seen creates a SUCCESSOR instead of clearing anything. Its name now resolves to a container rather than a bare receiver, so `GET`/`POST /{indexer}/admin/canonical-generation` (ADR-0057) answer there instead of `501 generations-not-held`.
  - **`serve`** resolves the CANONICAL POINTER to say which generation answers reads, holding no processor, opening no registry (opening one SWEEPS, which is a write) and registering nothing. It needs no name to do it -- `--indexer` stays refused, and the rows carry the discriminator -- and it says what it found beside the URL it is listening on.

  **`/status` reports one entry per generation held** on `run` and `index` (`generations: [{generation, canonical, follows, value}]`), so a rebuild in progress is visible on the page an operator already watches.

  **Reading the state is now two steps, and this package exports both.** `canonicalGenerationIn(db)` and `canonicalStateNamespaceIn(db)` resolve which generation answers and the table namespace to open it under; `heldGenerationsIn(db)` lists what a database holds. `@etherfold/server` gains the read they are thin over: **`readHeldGenerations(db)`**, every named indexer's registered generations and canonical pointer, read-only over the tables that package owns.

  **The assembly's exported shape moved with it.** `buildProcessor` is replaced by `openFoldingDatabase` (the handle, with the fixed tables in place) plus `openFolding` (the container over it), which is the split the new order forces: a generation's tables are named from the stream digest, so the store cannot be built before the source is resolved, while the database still is. `foldingStatusReport(container)` is the one mapping from what a process holds to what `/status` reports, and `ServeDependencies.startServer` now hands back the handle it opened, because the read tier resolves the pointer over it.

  **Two behaviour changes to know about.** `--no-auto-setup` against a database nobody has migrated is now a refusal to START (a generation is registered before anything is read or written, and the registry is rows), naming both ways out rather than coming up and failing every cycle; and a database written by the pre-generation CLI is not resumed -- its state is in tables nothing points at and its stored stream is swept, so the fold starts again. Nothing is published, so that costs a re-index and no migration.

  The guard is `packages/cli/test/equivalence.test.ts`, extended rather than duplicated: one fixture chain including a reorg, driven through `run`, `fetch` + `index`, `build` and `serve`, comparing the registered generation, the canonical pointer, the state namespace, the stored stream and the reorg counters -- plus a `run` that adds a successor over the same stream and promotes it in-process while the incumbent answers throughout.

- 27b6e65: **A CLI deployment that configures a retention floor now actually reclaims what falls below it**, and the loop that does it is budget-driven, so a serverless host can drive the same one.

  Retention has two halves and only one of them ran on the server side. A window has always bounded what a READ may ask about from the moment it is configured (`assertRetained`, at the seam, on every backend); `prune` is what physically drops the versions it no longer covers, and ADR-0022 makes it an explicit call the HOST schedules -- and no host in this repository scheduled one. So `--retention 50000` bought the refusals of a bounded store and the footprint of an unbounded one, which is strictly worse than either honest position, and nothing anywhere detected it.

  **`pruneMore(states, {maxVersions})` (`@etherfold/state-store`) is that pass, written once.** It prunes every state a host holds, spends ONE budget across them (not one each), skips a state it was handed twice, and reports `{passes, versionsDeleted, complete}`. The shape is `rebuildMore`'s: bounded work per call, reporting whether it finished, with the host looping -- which is what lets a CLI cycle and a Worker's `scheduled` handler drive one loop rather than two implementations of it. The budget is a PARAMETER because the number belongs to the caller's schedule: a Worker passes `d1PruneBudget(plan)` (its per-invocation query allowance), a CLI passes its own.

  **The CLI schedules it, and the two commands loop differently because their lives differ.** `run` takes one bounded pass in the gap it already waits between fetch cycles, so a backlog drains over cycles instead of stalling the one that met it; `build` runs bounded passes until the state is at its floor once it has reached the tip, because the database it exits with is a publishable artifact and "prunes eventually" is not a property an artifact has. Neither is in the ingest or apply path: a prune costs time proportional to what it drops (1.1 s at 62,553 versions) and a block carrying a median of 7 mutations must not pay for it.

  **The trigger is a FLOOR, not a window.** `revert-only` states a floor too -- the finality depth this deployment protects against -- so it is pruned as well; that is the case a binary window-or-not implementation gets wrong, and getting it wrong leaves the setting a reorg-safe deployment is told to prefer refusing every historical read while retaining every version for ever.

  **Nothing changes for an `unbounded` deployment, which is the default and probably most of them.** A prune with no floor is a no-op, which is exactly why the host may schedule it without first asking what it is holding. `DEFAULT_PRUNE_BUDGET` (10,000 versions per pass, exported from `etherfold`) bounds one pass and is not a way to turn pruning off: `--retention` is where a deployment says what it wants kept.

  `createD1Store`'s docstring now shows that scheduled call with the shared pass (documentation only; no D1 behaviour changed).

  **Not covered:** `etherfold index`, the receiving half, still schedules no prune -- it is fed over the wire and has no cycle of its own, and a prune inside the ingest path is what ADR-0022 refuses. And nothing here `VACUUM`s: SQLite reuses the freed pages, so the file stops growing without shrinking.

- 8b83efb: An operator can now say WHEN a successor takes over answering reads: `etherfold run --promotion <on-catch-up|immediate|manual>`, or `PROMOTION_POLICY` behind it.

  **The capability was built, argued for and unreachable from the shape most people run.** `@etherfold/core` has held three promotion policies since the generation model landed, but no CLI command ever passed a promotion config, so every CLI deployment silently took `on-catch-up` and a developer who wanted `immediate` had no way to ask. This is the input, and it is one more input rather than a special case: one name, a flag that beats the variable, a REFUSAL rather than an invented default for a value nobody recognises, and a row in the same ownership table every other input is resolved through (ADR-0048).

  **The three are three different moments.** `on-catch-up` -- the DEFAULT, everywhere, and unchanged, so no existing deployment moves -- takes the successor over when it reaches the cursor the canonical generation had, so the app keeps rendering complete old answers and switches when the new fold is ready. `immediate` makes it canonical the moment it is registered, before it has folded anything, which is what a developer iterating on a handler wants, because stale-but-complete answers from the fold they just replaced are more confusing than incomplete answers from the new one. `manual` never moves the pointer on its own however level the successor gets, so an operator can inspect one first -- and the explicit `POST /{indexer}/admin/canonical-generation` still moves it under every value, because "only when asked" is not "never".

  **It is a FLAG and it is deliberately never inferred.** The axis that would select between these values is development-versus-production, which is not detectable from inside a runtime, so the safe value is the default everywhere and the others are an opt-in an operator types. There is no `NODE_ENV` sniff, no `import.meta.env.DEV` check and no per-package default, here or anywhere: that is the mistake the shape in `generation/promotion.ts` exists to prevent, and the CLI restates none of that module's default either -- a deployment that configured nothing passes nothing, so the default stays written in exactly one place.

  **`--drop-on-promotion` comes with it**, as the other half of one configuration: discard the superseded generation at the promotion instead of retaining it, OFF by default because the retained generation is what the pointer moves BACK to. `--promotion immediate` together with it is REFUSED at start-up, by the pure resolver, before a module is imported or a database is opened, naming what to use instead -- `immediate` promotes a successor that has caught up to nothing, so the previous generation must be RETAINED until it does (ADR-0046), and that deferral is not built on this runtime. It was already refused from inside the container; now it is a configuration error an operator reads on the command line they typed.

  **Only `run` takes it, and the other four commands REFUSE it by name.** The question a command must answer to own this input is not "do I hold generations" but "can a successor appear here while I am running", and today exactly one command can say yes: `run` re-reads its own configuration on `POST /{indexer}/admin/reconfigure` and carries the successor to level with a bounded rebuild between fetch cycles. A `build` holds exactly ONE generation and exits, `index` registers no successor while it runs, and `serve` reads a pointer something else moves -- so a policy accepted there would be accepted and never applied, which is the one thing this configuration layer forbids by name. Turning any of those refusals into an optional input later is additive; taking an accepted flag away would not be.

  **New on `@etherfold/server`**: `ServerOptions.getPromotionPolicy`, the `PromotionReporter` seam and the `StatusPromotion` envelope, which put `promotion: {reported: true, policy, dropOnPromotion}` on `/status` beside `cursor` and `fetcher`. The RESOLVED value rather than what was configured, so an operator reads what will actually happen; absent entirely on a host that decides no promotion, and degrading to `{reported: false, reason}` exactly as the two reporters beside it do. It is reported because the policy is otherwise observable only as behaviour: watching a successor catch up says nothing about whether it is going to take over by itself.

  **New on `@etherfold/platform-nodejs`**: `StartOptions.getPromotionPolicy`, carried through to the app untouched like every other host capability.

- 9d1d3cd: **A processor no longer DECLARES what it is. The `version` field, `getVersionHash()`, `assertProcessorVersion` and the `PROCESSOR DRIFT` report are DELETED** (ADR-0086).

  An identity is now derived from what a processor IS and is handed to the engine by the ARRIVAL that produced it: the SHA-256 of a bundle's octets wherever a deployment has bytes, and a digest of the handler SOURCES for the one arrival that has none — a module a dev server hands a browser tab. An author cannot state it, so an author cannot forget to bump it, and state computed by logic that has since been replaced can no longer be served as if it were current. This is the CONTRACT step of a six-batch refactor; every caller moved first, so nothing here is a change of behaviour that was not already available.

  **This RETIRES a feature that shipped days ago, and that is its correct end rather than a reversal.** `a-reload-that-changed-nothing-reports-processor-drift` landed the `PROCESSOR DRIFT` report on 2026-09-16. It was the right fix for an author-DECLARED identity: the identity could LIE — a handler edited under a static `version` named the generation already held — so the core said so, loudly, in one phrase an operator could grep for. ADR-0086 deletes the lie instead of reporting it. There is no declared identity left for the code to disagree with, so drift stops being unreported and becomes UNREPRESENTABLE, and the machinery that compensated for it goes with the thing it was compensating for. The unconsumed changeset that announced it has been deleted too: nothing has been released, so amending it would ship a release note for a report that never existed outside this repository, and the history belongs in the work record and the ADR rather than in notes to users.

  What is deleted, by package:
  - **`@etherfold/core`**: `EventProcessor.getVersionHash()`, `assertProcessorVersion`, `ContextIdentifier.processorFingerprint`, `ProcessorDriftReport`, `ProcessorDriftComparison`, `processorDriftReport`, `ProvidedIndexerConfig.strictProcessorDrift`, `Indexer.onProcessorDrift` and `ReceivingIndexer.onProcessorDrift`. `processorIdentity` is now REQUIRED on `IndexerGenerationOptions`, `StreamBuilderOptions` and `GenerationRebuildOptions`, and `updateProcessor` takes one; a `GenerationSpec` that supplies none is REFUSED (a fold with no name cannot be registered), which is typed as optional only because the read order is state → processor → identity, the order that makes a module arrival expressible.
  - **`@etherfold/processor-entities` / `@etherfold/processor-sqlite`**: `EntityProcessor.version` and `entityProcessorVersionHash` are gone, and so is the `identity` option each took — it existed only to answer `getVersionHash()`, and a fold that computes no identity of its own has nothing for a caller to override. A host names its generation, its table namespace (ADR-0053) and its engine from ONE value it was handed.
  - **`@etherfold/server`**: `ReconfigureReport`'s `unchanged` arm no longer carries `drift`, and the admin route no longer returns it. The three outcomes are still three.
  - **`etherfold`**: the reconfigure endpoint's `unchanged` has ONE reading — these are the same bytes, so either the edit is not in them yet or the build has not run — instead of two plus a report to tell them apart.

  **`EventProcessor.getCodeFingerprint()` and `processorCodeFingerprint` SURVIVE, in a different role, and this deviates from ADR-0086's own consequence list.** That list says the fingerprint goes with everything else; it is wrong in two places, and both were settled after it was written. A browser tab is handed an already-built processor with no bytes to hash, so `@etherfold/browser` names that fold by `processor.getCodeFingerprint()` (`moduleProcessorIdentity`) — the SEAM method rather than the standalone function, because the seam is what delegates through a wrapper (`VersionedStateEventProcessor` over `EntityEventProcessor`) to the author's own handlers, while the standalone function applied to a wrapper would fingerprint the wrapper's methods and produce a constant no edit could move. So the derivation stays, as the IDENTITY of the one arrival with no bytes, and what dies is its old role: a second opinion sitting beside a declared identity.

  **A module that cannot be named that way is now REFUSED.** A processor whose handlers are all `bind`-ed or behind a proxy has no readable source, `getCodeFingerprint()` answers `undefined`, and the declared hash it used to fall back on is gone. The alternatives were all lies — a constant no edit can move, a name taken from the application (the author-declared identity through the one door left open), or a generation called `undefined` — so `@etherfold/browser` throws, before anything is registered, naming the two ways out.

  **A `--processor` path that names an UNBUNDLED entry point is refused too, for the same reason**: no bytes describe it and nothing is left to name its fold. That refusal lands where the arrival is resolved, before a database is opened; `a-path-naming-an-unbundled-entry-point-is-refused` is what moves it to configuration resolution and gives it the build command an author needs.

  Determinism moves from a cost concern to a correctness-of-reuse concern: a non-deterministic bundler now gives every deploy a new identity and re-folds for ever, so pinning the bundler version in the lockfile stops being advice.

- ed8e7ff: What the fetcher has learned about your provider is now READABLE, and can be handed BACK on the next start. Nothing persists it, and that is the decision rather than an omission (ADR-0074).

  The range fetcher works out how wide an `eth_getLogs` range a node will answer by asking, being refused and adapting. It tracks three numbers, all in blocks: a `ceiling` it has been refused at (or that the provider wrote out in its refusal), the widest `safeSpan` that has actually been answered, and the `nextSize` it will ask for next. All three lived in private fields, invisible from outside and gone on restart, so every process start re-paid the discovery from the 50-block starting range upwards and an operator could only infer any of it from timings.

  **`LearnedRange` is now a published type, reported and accepted back.** `LogFetcher.learnedRange` reports it, `LogFetcher.limits` reports it beside `suspectResultCount` (the count and its source, which the previous change made readable but left off every status surface), and `fetch.learnedRange` accepts the same object as configuration. A field is ABSENT rather than zero where nothing has been learned, because a ceiling of `0` reads as "this provider serves nothing" and that is not what "nothing learned yet" means.

  **`GET /status` gains `fetcher`**, from a reporter a host injects beside its cursor reporter (`ServerOptions.getFetcherLimits`, carried through `@etherfold/platform-nodejs`): `{reported: true, learnedRange, suspectResultCount}`, or `{reported: false, reason}` when a reporter cannot answer. It is ABSENT entirely on a host that holds no fetcher, which is most of them -- the receiving half of ADR-0003 makes no chain call at all, so `index`, `serve` and the Workers host carry no such field and nothing is invented in its place. `etherfold run` holds both halves and injects one.

  Unlike the `cursor` beside it, the field is TYPED rather than opaque. A cursor's meaning lives behind the storage seam and belongs to a processor (ADR-0027), which is why ADR-0047 has the server carry it verbatim; a learned range is `@etherfold/core`'s, it is three numbers, and it hides behind no seam -- so a dashboard reading `fetcher.learnedRange.ceiling` reads a documented field. What is kept from ADR-0047 is the half that still applies: a reporter that throws, rejects or has nothing to say degrades to a reason rather than to an omission, because "this deployment runs no fetcher" and "this deployment's reporter is broken" are different news, and neither ever fails the request or changes `healthy`.

  **`LEARNED_RANGE` is the door it comes back in by** (`@etherfold/fetcher-host`, so `etherfold run`, `build` and `fetch` all read it): the reported object, pasted back as JSON. Then the first request asks for what the last run found to work. It is a STARTING POINT and never a promise -- every number is still bounded by `MAX_BLOCKS_PER_FETCH`, adaptation runs over it unchanged, and a provider that has tightened since refuses it and lowers the ceiling on that first round trip, so a stale value costs a retry and can never wedge. A partial object is legitimate (`{"ceiling":2000}` alone is a real thing to know), and an unrecognised key is IGNORED rather than refused, so a report that grows a field does not turn a supervisor that pastes it into an outage. What IS refused, at startup and naming the field, is a value that cannot be read at all: not JSON, not an object, or a member that is not a positive whole number of blocks. The startup line says when a range was remembered, so an unexpected first span is attributable.

  **Nothing is written to any store, by design.** `LogFetcher`'s docstring states the test for state the chain-facing half may hold -- losing it must cost ONE extra request and nothing else -- and the learned range fails it, since losing it re-pays the walk up from the starting range. It is still only performance, so the answer is to move the memory OUT of the stateless component rather than to give that component a store: a fetcher that writes something down can be restored from a stale copy of it, owns that copy's lifecycle, and has a place for the next block number to be put, which is the split brain ADR-0004 exists to remove. Pushing it to the receiver was rejected on its own ground: it puts a fact about ONE SENDER'S PROVIDER into a wire contract that deliberately carries no sender identity.

  A deployment that configures nothing behaves exactly as it did before, byte for byte: the discovery spans a fetcher walks through against a refusing provider are asserted unchanged.

- ca315dc: **`etherfold index` now prunes what its retention no longer covers, on a schedule it owns.**

  `--retention` is accepted on `index` exactly as it is on `run`, and the flag's own help text promises that what falls outside the window is "both refused on read and DROPPED from storage". The refusal half always worked. The storage half did not: `run` and `build` prune in the gap their cycle already waits, and a receiver has no cycle, so a bounded `index` deployment got the answers of a windowed store and the footprint of an unbounded one. That is the worst-of-both the retention work exists to kill, and it was reachable from a documented flag.

  The schedule is a TIMER, because a receiver has nothing else to hang it on. ADR-0022 forbids a prune as a side effect of a write, and ingest is the only other thing that happens in this process, so "between batches" would be that side effect under another name. A clock is owned by the HOST, which is what the ADR asks for, and `index` is a long-lived Node process that can hold one: the constraint recorded for Cloudflare Workers is about a STORE on that platform and does not reach a CLI host.

  One bounded pass per tick at `DEFAULT_PRUNE_BUDGET`, defaulting to `DEFAULT_PRUNE_INTERVAL_SECONDS` (60), called unconditionally because a prune with no floor is a no-op. Overlapping ticks are guarded, so a pass slower than the interval cannot stack and spend the budget several times over. The timer is `unref`'d and cleared on stop, so it never holds the process open and never outlives the server.

  A failed prune does not fail the fold: receiving is what the process is for, and a delete that could not run leaves a store larger than it asked to be, which is worth logging and not worth refusing a batch over.

  `deps.pruneIntervalSeconds` is new on `IndexDependencies`, for tests that want to observe a pass without waiting a minute (`0` disables the schedule). A deployment leaves it alone: retention is configured with `--retention`, and starving the schedule is not how a deployment says it wants nothing dropped.

  The `--retention` help text now says "on a schedule it owns" rather than "between cycles", because both are now true and only one was.

- eee7e00: **The storage seam NARROWS: `StateStore` is the reads, and a mutation nobody claimed for is no longer expressible** (ADR-0077 contracted, ADR-0079).

  ADR-0075 put a writer token on every mutating path and ADR-0077 split the seam additively so consumers could migrate one at a time. This is the contract step, and it is one atomic change because narrowing a SHARED TYPE is atomic by construction: the moment `EntityEventProcessor`'s constructor takes the writable shape, every package that constructs it with a seam-typed value stops typechecking.

  **Three names, one hierarchy.** `StateStore` is what a CONSUMER holds and is the reads only (`migrate`, the four reads, `readCursor`, `readRetentionEnforcement`, `capabilities`, `declarations`) -- calling `applyBlock` on one is now a compile error. `StateStoreBackend` is that plus the five mutating verbs: what a backend class declares, what a factory hands over. `WritableStateStore` is a backend plus the `token` a claim minted, and `openForWriting` is the only way to obtain one. The two scaffolding names from the expand phase, `ReadableStateStore` and `StateStoreMutations`, are DELETED.

  **If you hold a store:** decide whether you READ or WRITE, and say so. A reader needs no change and gets a compile error if it tries to mutate. A writer claims: `const store = await openForWriting(await createBrowserStateStore(processor.entities))`. `openForWriting` migrates, so it replaces the `migrate()` you were calling, and it is idempotent per store instance, so the shipped `createState: () => store` pattern takes ONE claim and every generation writes through it. It takes a BACKEND and never a store already narrowed to its reads, so the narrowing is one-way; a demoted writer builds a new store and opens that (ADR-0078).

  **If you implement a backend:** declare `implements StateStoreBackend` instead of `implements StateStore`. The classes themselves are UNCHANGED and keep their full surface, including the SQL tier's `queryCurrent` / `queryAsOf` / `applyBlocks` / `drop`; `createD1Store` still returns the concrete class.

  **If you wire a browser app:** `createBrowserStateStore` still hands back a store and deliberately does NOT claim -- a tab that only renders opens the same database, and claiming there would have every reading tab take the store from the tab that is indexing. `createState` now returns a `WritableStateStore`, so wrap the factory in `openForWriting`. `openForWriting` / `openForReading` are re-exported from `@etherfold/processor-entities` beside the bootstrap primitives, because they are on the same boot path.

  **If you run the conformance suite:** your factory and options are unchanged, and every chapter is asked ONCE again -- the two-shape parameterisation that existed while consumers migrated is gone.

  Two consequences worth knowing before they surprise someone (both ADR-0079). Claiming MIGRATES, and a receiving container builds a generation's state before the generation cap can refuse it (the cap is keyed on the processor's version hash, which needs the processor, which needs the state), so a cap-refused generation now leaves an empty namespace behind; what a refusal still guarantees is no registry record and no state. And `VersionedStateEventProcessor` claims on FIRST USE rather than in its constructor, because claiming is asynchronous and that constructor is not -- still an explicit claim, and safe here because the store is one it built and nothing else holds.

### Patch Changes

- 7f0990a: Correct a comment that said a reconfigure reaches a running `run`, which it does not.

  `driveCycles`' doc opened with "A `run` is a long-running host, **so a reconfigure can reach it**". Read in context that was about having TIME to advance a follower, contrasted with `build`, which "has no reconfigure, holds exactly ONE generation and exits". Read quickly it says a reconfigure arrives at RUNTIME, and it does not: a generation is registered when the container OPENS, from config, so a changed processor or source reaches the process by RESTARTING it. Nothing in the CLI watches a file, and no route adds a generation (the whole admin API is the canonical-pointer move).

  It also credited the wrong mechanism. What makes that restart survivable is not the process being long-lived, it is the registry and the state being ROWS: the new process finds the incumbent already there, still canonical, still answering, and registers the successor beside it. The long-running shape buys the other half, somewhere to put the bounded rebuild that carries the successor to level once it exists.

  No behaviour changes. This is recorded as a release note rather than a silent edit because the comment is load-bearing documentation about how a reconfigure works, and reading it as "a reconfigure arrives at runtime" is a mistake it has already caused.

- d8ce920: **A remote client can be TOLD the state moved: `GET /{indexer}/state-moved`, server-sent events, carrying the same value a browser tab is handed over its port** (ADR-0083, the third transport).

  An app reading from a hosted indexer now runs the notification handler an app indexing in its own browser runs, unchanged. What crosses is `@etherfold/core`'s `StateMoved` serialised as JSON and otherwise untouched (`event: state-moved`), so "one notification model across every transport" is a deployment choice rather than a second semantics: token unchanged, invalidate narrowly using `entities`; token changed, invalidate everything.

  **Sync progress rides the same stream** (`event: progress`, `StateMovedProgress`), because a reader cannot compute it -- the sync cursor is opaque behind the storage seam (ADR-0027) -- and a second mechanism would be two failure modes for one question. It carries `lastToBlock`, `latestBlock` and `blocksBehindTip`, which is the vocabulary a tab already binds to a progress bar, read from the stream's own coverage claim and not from anybody's cursor. A `progress` frame is sent ON CONNECT and again whenever the figures move; a `state-moved` frame is never replayed, which is the same split ADR-0082 already makes on a tab's port (progress is a STATE and answers a late joiner, a notification is a thing that HAPPENED and does not).

  **A connecting client is told the position and the coherence token at once**, which is how a remote reader converges: it has no store to re-read and the query layer is deferred, so it compares the token it holds against the one in force and knows immediately whether it is stale. `ReceivingIndexer.coherenceNow()` / `Indexer.coherenceNow()` are the new reads that answer it (opaque, compared, never parsed; they rotate nothing and publish nothing), forwarded onto a server host through `IndexerRegistryEntry.coherenceNow`, paired with `onStateMoved`.

  **The server holds nothing per client**: one handler reference per open stream and no client identity at all, nothing buffered, nothing retried, nothing replayed. A disconnect detaches. There is deliberately NO heartbeat: an interval invented here is the polling interval the signal exists to replace, and a dropped idle stream costs a reconnect that is answered at once with the position and the token.

  **It REFUSES where it cannot be served, rather than accepting a connection nothing will ever write to.** Two `501`s: `state-moved-unsupported-runtime` when the host has not declared `ServerOptions.holdsStreamsAcrossRequests` (new, absent means no), and `state-moved-not-published` when the name resolves to a host holding a bare receiver and no container. The condition is a capability the HOST declares and never a runtime this package detects, because it names no runtime by test -- and the failure it prevents is exactly the invisible one: a subscriber registry that compiles, passes on Node and silently never fires on a Worker, which a reader cannot tell apart from a quiet chain.

  **If you host the server on Node** (`@etherfold/platform-nodejs`), the capability is now declared for you and `etherfold index` serves the stream. **If you host it on Cloudflare Workers**, it is deliberately not declared and the endpoint refuses: an I/O object created in one request handler is unreachable from another, so an ingest POST could not write into it. The remedy is a Durable Object, which belongs to whoever adds the subscription adapter.

  No GraphQL runtime, schema or subscription is added, and none is needed: the signal is the primitive, a subscription is a derivable adapter over it, and the producer is transport-agnostic -- a second transport subscribes at `IndexerRegistryEntry.onStateMoved` with no change to the code that publishes.

- 382421f: **A published snapshot's `processor` label is the identity its producer's ARRIVAL derived, and the candidate rule that protects a client is exactly as strict as it was** (ADR-0086).

  The rule is unchanged and deliberately so: a snapshot whose label differs from the identity the client was handed IS NOT A CANDIDATE at all (`processor-mismatch`), and one installed anyway is REFUSED rather than translated (`SnapshotProcessorMismatchError`). What moved is only where the VALUE comes from. A deployment running a self-contained bundle is named by the SHA-256 of those octets, so that is what it writes into the snapshots it publishes, and a client running the same bundle derives the same name from the same bytes without being told it.

  That matters most for the client least able to notice it is wrong. A snapshot-seeded generation is a LEAF: it has no stream to re-fold and no history below its own block, and on a public node the historical `eth_getLogs` a backfill would need is frequently refused outright. Such a client cannot recover from a mislabelled snapshot by re-indexing, so a browser app's upgrade path rests on the label being right: a new build already obliges its publisher to ship a matching snapshot, and under hash identity that snapshot is one the new build recognises.

  **The snapshot FORMAT number does NOT move, and the reasoning is recorded beside the constant.** This is a VALUE change, not a FORMAT change. `processor` is the same field in the same place meaning the same thing, opaque on both sides (compared for equality, never parsed), so a label derived the old way is not half-understood by a new reader. It is simply another fold, which the candidate rule already answers precisely. Bumping `ENTITY_SNAPSHOT_FORMAT` would convert that precise refusal into `unreadable-format`, telling a user their app is out of date when the truth is that the snapshot is for another processor, and nothing is published, so there is no such document on either side of the distinction.

  Code changes are documentation and coverage:
  - `createSnapshot`'s `processor` field now says WHERE a producer gets the value: from the fold that wrote the rows (the identity its generation is registered under), never derived a second way beside it;
  - `ENTITY_SNAPSHOT_FORMAT` carries the format-number decision above;
  - `etherfold` gains the end-to-end case the round trip was missing (`test/aSnapshotIsLabelledWithItsBundleIdentity.test.ts`): a deployment folds blocks through a REAL committed bundle and publishes what it computed, a client that loaded the same bytes through the artifact loader installs it and resumes at the snapshot's block, and a client running the edited bundle beside it (one handler line different, nothing declared different) gets `processor-mismatch` and an untouched store. Neither side is handed the other's value, so it asserts that two derivations agree rather than that two constants are spelled the same.

- b647fb8: **A generation is held by a durable named SLOT, and `canonical` is merely the first one** (ADR-0084). Registering a successor while one is already pending REPLACES it, and because the fact is a ROW rather than a memory, that holds ACROSS A RESTART -- so a deployment whose `version` is generated at build time stops accumulating one generation per deploy until a cap refuses it at start-up.

  The registry now holds THREE assignments instead of one:
  - **`canonical`** -- what answers every read. Unchanged: moving it is promotion, moving it back is revert.
  - **`successor`** -- the generation being built beside the incumbent, holding AT MOST ONE. Registering into an occupied `successor` replaces its occupant, whatever stream either sits on, and the replaced generation is dropped: its registry row, its state namespace (ADR-0053 makes that a `DROP`) and its stream where no registered generation is left folding it.
  - **`predecessor`** -- what a revert moves back to. ASSIGNED by the move that creates one, in the SAME commit as the pointer write, and never inferred -- because it cannot be inferred: with the pointer at C and a newer generation N, "N was never canonical" and "N was canonical and the pointer was reverted away from it" are the same rows.

  **A slot is an ASSIGNMENT and never part of `GenerationId`.** The same content under two slots stays ONE generation, one state namespace and one fold of one stream, which is why the slots sit beside the records rather than inside the identity. A generation NO slot names, and that is not canonical, is collectable; the operator verb that reclaims one is `a-generation-no-slot-names-is-reclaimed-on-request` and is not in this change.

  **This is a net DELETION of machinery.** `ReceivingIndexer`'s two in-memory sets are GONE rather than left beside the slot agreeing with it most of the time: `everCanonical` (which generations the pointer had named, as far as one process had seen) and `successorsAddedHere` (which generations this container had registered since it opened). What they approximated, a slot reads -- durably, for every process. Drop-on-promotion now applies to a move onto what `successor` names and to nothing else, which is strictly stronger in the direction ADR-0057 was worried about, since a restarted process no longer forgets and therefore no longer misreads a genuine promotion as a revert.

  **The caps are UNCHANGED** (`SERVER_GENERATION_CAPS` is still four generations and two streams, `BROWSER_GENERATION_CAPS` still two of each), a cap still REFUSES and never evicts, and this is deliberately not cap-pressure eviction: a replaced successor is dead the moment a newer one takes the slot, whether the registry has room or not. The drop is still DECLINED, and said out loud, while the replaced generation WRITES a stream another held fold follows (ADR-0044); it then names no slot, so it is collectable rather than forgotten. Every replacement is reported through `named-logs`, naming what went, what took its place and why it was safe.

  **API, `@etherfold/core`:** `GenerationRegistryState.canonical` becomes `GenerationRegistryState.slots`, and `GenerationRegistryWrite.canonical` becomes `GenerationRegistryWrite.slots`, where an absent slot name LEAVES that slot, `null` CLEARS it and an identity assigns it. `GenerationRegistry` gains `slots()` (every slot resolved against the records, in one read) and `create(id, {slot})`; `canonical()` is unchanged. New exports: `SLOT_NAMES`, `SlotName`, `GenerationSlots`, `SlottedGenerations`, `SlotAssignment` and `slotHolding`. A custom `GenerationRegistryPort` must carry the slots through; the three substrates in this repository do.

  **API, `@etherfold/server`:** the `_generation_pointer` table is RENAMED to `_generation_slots` and carries a column pair per slot (`GENERATION_SLOT_TABLE` replaces `GENERATION_POINTER_TABLE`), so the promotion shuffle stays one guarded write (ADR-0054). `HeldGenerations` gains `slots` beside its `canonical`. `SCHEMA_VERSION` stays 1 and NO migration is provided, deliberately: nothing is published and no database anywhere holds state this must preserve (`CONTEXT.md`), and `predecessor` could not be reconstructed for a registry that predates slots anyway -- the missing fact this change exists to supply is the one its own migration would need.

  **`@etherfold/browser`** carries the IndexedDB substrate's half: one small record per slot beside the entries (`['generation', <name>, 'successor']`), outside the entry key range. The chain-facing `Indexer` is deliberately UNCHANGED and still keeps its in-memory `everCanonical` flag; porting slots to it is `the-chain-facing-container-holds-its-generations-in-slots`. Promotion still arms from the in-memory candidate set; arming from the slot is `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`.

  **`etherfold`** carries no code change: the behaviour is asserted at the seam it actually lives at, which is one container over a REAL database plus a SECOND CONTAINER opened over the same substrate to stand in for the restart (`packages/cli/test/aSuccessorLandsInADurableSlot.test.ts`). That file replaces `anAbandonedSuccessorIsDropped.test.ts`, whose last case asserted the residual this removes.

- a2fc7d7: **A successor that was NEVER canonical is DROPPED when a newer successor takes its role**, so a development loop that changes its mind repeatedly stops accumulating generations nobody will ever want.

  `ReceivingIndexer` knew ONE kind of supersession and it is a PROMOTION: the incumbent becomes the predecessor and is RETAINED, because the pointer must be able to move back to it. The other half was missing. A successor still catching up, that a newer one had just made pointless, kept its registry row, kept its state namespace and kept being advanced by the scheduled rebuild -- re-folding the same stream as the newer one and competing with it for the same database handle. That is wasted work in every case and a WALL in the one that matters: a source change lands first, the processor follows a moment later (possibly after a failed compile), and a few saves reach `maxGenerations` or `maxStreams`, after which an operator has to delete generations by hand. A cap is the right mechanism against slow accumulation and the wrong one against CHURN, so the count is now bounded by dropping what is provably dead rather than by raising a bound, which only moves the wall.

  **The caps are UNCHANGED** (`SERVER_GENERATION_CAPS` is still four generations and two streams), a cap still REFUSES and never evicts, and this is deliberately NOT cap-pressure eviction: an abandoned successor is dead the moment a newer one takes its role, whether the registry holds two generations or none to spare.

  **The predicate is narrow, and the narrowness is the whole safety argument.** "Not canonical right now" is NOT the test -- a predecessor kept for a revert is not canonical right now either. The test is "has NEVER been canonical", and that fact exists only IN MEMORY (ADR-0057): `GenerationRecord` is the identity plus `createdAt`, and with the pointer at C and a newer generation N, "N was never canonical" and "N was canonical and the pointer was reverted away from it" are indistinguishable from the rows. So a fold is dropped only where THIS container registered it, AFTER `open`, it was not canonical when it was registered, and the pointer has not named it since -- where "named" now includes a move another process made that this one has read. A generation this process did not register is NEVER dropped, which means a deployment that reconfigures by RESTARTING still accumulates until a cap refuses at start-up, where an operator reads it and is told what to delete. That is the same safe direction ADR-0057 already records.

  "The same role" means successor to the current incumbent REGARDLESS OF STREAM, because `maxStreams` counts the distinct streams among registered generations and the churn this exists for opens with a source change. The drop is DECLINED, and said out loud, while the abandoned fold WRITES a stream another held fold follows (ADR-0044), which is `dropSuperseded`'s existing rule; the stream is otherwise reaped with it by the registry's own rule, and the generation's state namespace is DROPPED (ADR-0053), so the slot and the disk both come back. Every drop is reported through `named-logs`, naming what went and why.

  **If you hold a `ReceivingIndexer`:** the canonical generation, every generation the pointer has named, and anything registered by another process or an earlier run are untouched, so a revert reaches exactly what it reached before. What changes is that a second `add` of a successor may now delete the first one's row and namespace, and `held()` / `generations()` are correspondingly shorter.

  `@etherfold/server` and `etherfold` carry no code change: the behaviour is asserted at the seam it actually lives at, which is one container over a REAL database (`packages/cli/test/anAbandonedSuccessorIsDropped.test.ts` -- the registry rows, the reaped stream, the dropped table namespace and the revert that still reaches its state), and one server case that reached its cap with a successor the pointer had never named now promotes it first, so the two generations it counts are ones nothing may reclaim.

- afd3da9: `etherfold run` and `etherfold build` no longer refuse to start when `STREAM_FINALITY` is set, and every command now HONOURS the environment's stream settings instead of half-ignoring them.

  The resolved stream config is hashed into the wire identity, so the sending `LogFetcher` and the receiving `StreamBuilder` must reach the same one. `resolveFetcherHostConfig` read three settings from the environment (`STREAM_FINALITY`, `STREAM_ALWAYS_FETCH_TIMESTAMPS`, `STREAM_ALWAYS_FETCH_TRANSACTIONS`) and then merged the caller's override OVER them. The commands that hold both halves in one process passed a hard-coded empty override, and spreading `{}` cannot remove a key the environment has already put there: the sender resolved `finality: 25` while the receiver resolved the default `17`, the digests could never match, and `WireContextMismatchError` is not retryable, so the process exited.

  The split deployment failed the same way and worse, because there the operator is told the two halves must agree: `etherfold fetch` honoured `STREAM_FINALITY` while `etherfold index` was pinned to the default, so setting it on both hosts, which is what a careful operator does, made every push refused.

  The stream config is now derived ONCE from the environment (`streamConfigFromEnv`, newly exported from `@etherfold/fetcher-host`) and handed to both halves, and an override REPLACES the environment's config rather than merging over it, because a spread can add a key but can never say "no finality here".

  The fix deliberately keeps the variable working rather than making both halves ignore it. Agreeing by ignoring would have satisfied the digest comparison while silently discarding a documented setting, and this CLI's rule is that nothing is accepted and ignored. The combined shape and the split shape now read one environment the same way.

  `STREAM_CONFIG`, previously exported from `etherfold`, is replaced by `streamConfigFor(env)`. It could not remain a constant: the value depends on the environment.

- 49e73ae: **A generation's `createdAt` is now strictly increasing within a registry, so no two generations CREATED by this code can tie** (ADR-0072). A registry written by an earlier build can still hold a tied pair; nothing repairs those on open, and they keep resolving by hash as before. Nothing is published, so that set is empty today.

  It was a bare `Date.now()` — milliseconds — and `byAge` broke a tie on the processor HASH. `writerOf` names a stream's writer as the oldest surviving generation registered on it, so two generations registered in the same millisecond were ordered by hash rather than by registration, and a SUCCESSOR could be named the writer of a stream its incumbent already wrote. Measured on `ReceivingIndexer` with a frozen clock: **two folds with `writesStream: true`**, against one for the same fixtures named the other way round. That is the one-writer rule (ADR-0044) broken by a clock resolution, and consecutive `add` calls land in one millisecond routinely.

  `create` takes `max(Date.now(), newest + 1)` inside the same commit that writes the record. No new field and no durable-format change: `createdAt`'s own contract was already "ORDERING only, never identity", and a value nudged forward to stay ordered is more faithful to that than a raw clock reading.

  **The CLI now reads `RebuildReport.stopped`.** It called `rebuildMore()` and discarded the result, so ADR-0070's `retryCanAdvance` had no consumer in this repository — the exact loop that ADR is about. A follower that cannot advance is now reported once, by reason, and stays quiet while it can.

- 1d9be43: Every caller, example and doc now names the GENERATION container: `IndexerGeneration` for one stream plus one fold, and the two FACTORIES for the browser hook.

  This is the MIGRATE batch of the expand → migrate → contract rename the generation container needs. Nothing is removed: `EthereumIndexer` is still exported from `@etherfold/core` as an alias to `IndexerGeneration`, and `createIndexerState` still accepts a processor built over a store. What changed is that nothing in this repository reaches for either any more, so `the-old-indexer-shape-is-deleted` can delete both without a compile error anywhere.

  **`@etherfold/browser` re-exports the class as `IndexerGeneration`, not `EthereumIndexer`.** A caller that imported the type from this package renames the import; the class itself is unchanged, and `@etherfold/core` still exports the old name for now.

  **The browser hook is written against `{createState, createProcessor}` everywhere.** The README, both example apps, the `IndexerState` and `BrowserStateStore` JSDoc examples and every test now hand over the two factories rather than a processor already built over a store:

  ```ts
  const indexer = createIndexerState({
  	createState: () => createBrowserStateStore(myProcessor.entities, {databaseName: 'my-app'}),
  	createProcessor: (store) => fromEntityProcessor(myProcessor)(store),
  });
  ```

  An indexer holds any number of generations and each folds into its OWN state, so the store cannot be a value handed over once — the hook is what calls these, once per generation. An app that needs the store it built (to rebuild a processor over it on a hot reload, or to read its capability report) captures it in the factory's own closure, which is what both examples now do.

  **The CLI's source-text guard is asserted to still bite.** `packages/cli/test/engine.test.ts` enforces that the CLI constructs and imports no browser engine by matching the identifier with regexes. A rename that left those on a name nothing uses any more would keep them green and VACUOUS — enforcing nothing, with nothing going red to say so — so the patterns are now named functions and are asserted against deliberate violations under BOTH spellings, plus the prose and the generation CONTAINER they must not fire on.

- 1a6f68b: Every published package now carries a `description` and its own `README.md`.

  Metadata and docs only: no runtime code changed. Four manifests had no `description` at all (`@etherfold/core`, `@etherfold/browser`, `etherfold`, `@etherfold/utils`), which is the line npm shows in search results and on the package page, and seven packages had no README (the four above plus `@etherfold/server`, `@etherfold/platform-nodejs` and the private Worker host). Each README says what the package is, when to reach for it INSTEAD of its neighbours, a minimal snippet taken from code that runs, and links to the related packages.

  Two summaries are worth calling out because a guessed one would have been wrong. **`etherfold index` is a ONE-SHOT**: it folds to the tip it observed and exits, does not follow the chain and cannot be reconfigured while running, so keeping a database current is running it again; live reconfigure is `@etherfold/browser`'s ability. And **`@etherfold/utils` is not a bag of hashing helpers** any more: what is in it is the Node-side loader that turns a processor PATH into the authoring object plus its indexing source, since `contextFilenames` and the `@etherfold/utils/indexer` subpath went with the blob snapshot (ADR-0037).

  One existing description is CORRECTED rather than added: `@etherfold/state-store-sqlite` called itself a "state store for `@etherfold/core`", which names the wrong seam. It depends on `@etherfold/state-store`, `remote-sql` and `named-logs` and on nothing else, and a test in that package asserts as much, because a storage backend depending on the indexer would invert ADR-0016.

  **`etherfold` no longer publishes the repo's root README.** Its `prepack` copied `../../README.md` into the package, so the npm page for the CLI described the monorepo and documented none of its flags; the package now has a README of its own, committed rather than generated, and `prepack` copies only the LICENSE.

- 6364f5b: **Nothing in the CLI or in the NFT example is named by the author-DECLARED identity any more, except the three sites that exist to witness that the declared path still works** (ADR-0086).

  Four migrate batches moved every place that SOURCES an identity. What they could not see was every place that silently RESTS on the fallback: a deployment stood up through an injected `importModule` supplies no identity, so `processorIdentityOf` falls through to `processor.getVersionHash()` and the fold takes the author's declared `version`. A grep finds nothing there -- those files name no identity at all -- and only running them says otherwise, which is why this remainder outlived the sweep that was meant to catch it. It is correct today and becomes a deployment with no name at all the moment `the-declared-version-and-the-drift-report-are-deleted` removes the declared half.
  - **`IndexingDependencies` and `IndexDependencies` gain `processorIdentity`**, the other half of the seam `importModule` already was. An ARRIVAL derives an identity and the engine is handed one; `importModule` states WHAT comes back for a `--processor` path and this states what that thing is CALLED. BYTES ON A DISK ALWAYS WIN -- where the path names a real self-contained bundle its hash is the identity and this is not consulted -- so it can only supply a derivation where the injected arrival made none, never overrule one. It is not a way to declare an identity: no flag and no environment variable reaches it, and it sits in the type documented as what a TEST substitutes. `ReconfigureContext` carries the same value, so a re-read resolves the identity the process came up with instead of registering a successor on every call.
  - **`FoldParts.generation` now STATES its `processorIdentity`** rather than leaving the container to ask the fold for it. The value is unchanged -- it is the same string the table namespace and the registry record are already named from -- but the container no longer reaches for `EventProcessor.getVersionHash()` to learn it, which is a question a processor built from bytes cannot answer.
  - **`examples/event-processor-nfts` runs from a self-contained BUNDLE.** `etherfold build` and `etherfold run` are pointed at `dist/cli.bundle.js`, produced by `pnpm build:bundle` with the command this family documents (`esbuild --bundle --format=esm --minify`), so the example's identity is the hash of its own bytes and its `version` field names nothing. An example is EVIDENCE, and it was teaching a rule that is being deleted.

  **Nothing is deleted and nothing is refused.** The declared `version`, `getVersionHash()`, `getCodeFingerprint()` and the `PROCESSOR DRIFT` report all still exist and still work, an unbundled configuration still resolves, registers and folds, and the injected-importer affordance is untouched -- whether it remains an accepted arrival is `a-path-naming-an-unbundled-entry-point-is-refused`'s question, and removing it here would have answered it silently and out of order.

  **The three declared-path witnesses are deliberately unchanged**: `anEndpointReconfiguresARunningRun.test.ts` whole (the `PROCESSOR DRIFT` report and the `unchanged` message that names `version` exist only on that route), the two DECLARED cases in `aDeploymentRunsFromABundle.test.ts`, and `nftProcessor.version` in `test/utils/chain.ts`. Migrating a witness does not move coverage, it deletes it while leaving the code standing.

  Demonstrated rather than asserted, because a grep cannot see a fallback: with both halves of the declared fallback made to throw locally, `packages/cli` fails exactly those three witnesses and nothing else, and `packages/utils` and the example pass whole.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- 11481a0: **A restart with a changed processor now FINISHES the upgrade, and a revert still survives one** (ADR-0084's last open consequence, amending ADR-0046). A generation registered at `open` could never be promoted -- not late, ever -- so a developer or a redeploy that restarted with different bytes got a successor that caught up and then sat there for ever, with nothing reported and no policy value that changed it. Three separate things caused that and all three are fixed; none of them alone moves the pointer.

  **1. Promotion arms from the SLOT, not from how a fold arrived.** `ReceivingIndexer` arms exactly what `successor` names, whether that generation arrived at `open` or through `POST /{indexer}/admin/reconfigure`. The gate that used to make the policy silent during `open` is GONE, and so is the reasoning's cost rather than the reasoning: `immediate` still cannot promote the fold a host was merely built with (that fold is what `canonical` names), and `on-catch-up` still cannot undo a revert recorded in a previous session (the generation a revert returned to is what `predecessor` names, and is armed under no policy value). The in-memory `candidates` set and the `opened` flag are DELETED rather than left agreeing with the slot, and `movePointer` loses the held-fold argument it only needed in order to disarm one.

  **2. A generation's position is READ BY NAMESPACE, with no engine.** The trigger compares the successor against the cursor the canonical generation has, and it could not be EVALUATED in the restart shape at all: a redeployed process holds exactly one fold, the new one, and the previous processor's code is not in the build, so a fold for the incumbent is unbuildable by construction. The read now follows the rule the rest of this runtime already follows -- a generation ANSWERS from a table namespace with no engine (ADR-0053), so it can be MEASURED the same way. Nothing retains, re-imports or reconstructs past processor code; the comparison needs one number and the number is a row.

  **3. `etherfold run` calls the settle unconditionally.** It gated its bounded rebuild on holding a FOLLOWER, and a successor registered at `open` is not one -- it is fed by the wire -- so on a restarted deployment the trigger was not merely blocked, it was never reached. The gate asked whether anything is being REBUILT when the question is whether anything might be PROMOTED. What it costs when there is nothing to do is a few registry reads in the gap the loop already waits, which is the bargain the scheduled prune beside it already makes. It decides nothing about `index`, which has no drive loop at all.

  **API, `@etherfold/core`:** `GenerationRegistryPort` gains `readStateCursor(id)`, the symmetric sibling of `dropState` and injected for the same stated reason -- a generation's state is a table namespace named above the registry, so whoever named the tables is the one who can address it. It answers `lastToBlock` as a NUMBER (the cursor itself is an opaque string behind the storage seam, and its codec lives above that seam) and `undefined` for NOT READABLE, which must never be reported as `0` or "has folded nothing" would read as "level at block 0". `GenerationRegistry` forwards it under the same name. A custom port must supply it; `createMemoryGenerationRegistryPort` takes it as an option beside `dropState` and answers `undefined` without one.

  **API, `@etherfold/server`:** `SQLGenerationRegistryOptions` gains `readStateCursor`, optional exactly as `dropState` is and supplied by the host that FOLDS. **`@etherfold/browser`** carries the same option on its IndexedDB port; it is optional there and nothing on that runtime asks for it, because a tab runs the chain-facing container, whose trigger reads the cursor each held engine publishes.

  **`@etherfold/state-store-sqlite`** carries a README line and no code change: `readCursor` under a generation's namespace is what a host wires into `readStateCursor`, exactly as `drop()` is what it wires into `dropState`, and the README already documented one half of that pair.

  **A fold added with its OWN source now has its cursor read with the pair it ACTUALLY folded under** (folded in from the cancelled `a-folds-cursor-is-read-with-the-source-it-folded`). The read this replaced passed the CONTAINER's source with the FOLD's stream config, which is a pair no fold necessarily ran under. It fixes nothing observable today and is a CONTRACT correction rather than a bug fix: neither implementation of `EventProcessor.load` uses `source` to choose a cursor, so the defect was latent. It is gone structurally rather than by a fix, because the new read is addressed by the generation identity, and that identity IS the pair.

  **`etherfold`** supplies the new seam from `openFolding` (the same `stateFor` that supplies `dropState`, built UNCLAIMED so reading a position never takes the writer claim from the fold that is writing it) and drops the follower gate described above. The end-to-end claim is asserted where it lives: a deployment stood up the way the CLI tests stand one up, STOPPED, and re-run over the same libSQL handle with an edited bundle, driven until the pointer moves -- plus the revert case driven through a restart, under the default and under `immediate` (`packages/cli/test/aRestartFinishesTheUpgrade.test.ts`).

- a05ba3d: **The build command an author must run is documented in one place, with the PINNING rule that makes a bundle's identity reproducible** (ADR-0086).

  A processor is named by the sha256 of its bundle, so producing that bundle is the step before every folding command and the flags in the command are part of the name. `packages/cli/README.md` now states it once, under `Building the bundle`, and the rest of the tree points at it rather than repeating it.

  **`--minify` is documented as MANDATORY, and the reason is IDENTITY rather than size.** Un-minified, esbuild opens each bundled module with a `// <path>` banner naming it RELATIVE TO THE DIRECTORY THE BUNDLER RAN IN, so the building machine's layout lands in the bytes. Measured: one source built from a checkout root and from its package directory hashes differently un-minified and identically minified (`docs/spikes/the-build-command-and-its-pinning-rule-are-documented/`, a script that re-runs the measurement). Drop the flag and a laptop and a CI job do not build a bigger bundle, they disagree about which generation they are, so neither reuses the state the other folded.

  **What gets pinned is the bundler's VERSION AND ITS FLAGS, not merely the tool**, because the output is a function of both and the output is the identity. `rollup` is named as the alternative for anyone who wants it; `tsup` is not recommended, being esbuild with a wrapper that adds a version to pin and no determinism. Source maps are covered per spelling rather than with one sentence that is false for the default: `--sourcemap=external` leaves the bundle byte-identical (measured), while plain `--sourcemap` appends a `//# sourceMappingURL=` comment and so names a different generation.

  **The documentation and the refusal cannot drift apart.** An author meets the refusal first and the documentation second, so `packages/cli/test/theDocsAndTheRefusalNameOneBuildCommand.test.ts` holds three copies of the command -- the CLI README's canonical statement, the example's worked instance, and the `build:bundle` script that actually runs -- to the command `refuseUnbundledProcessor` emits, flag for flag and in order.

  The CLI README also gains a migration note for an author who had a working `-p` before bundling was required: what changed, and the one command to run.

  Documentation only; no published behaviour changes.

- 46e1c7c: **The CLI, the server and the state stores now describe a generation's fold half as the identity its ARRIVAL derived, and every call site that sources one takes it from there** (ADR-0086).

  A processor's identity has always been author-declared: `getVersionHash()` is the `version` field plus the entity and config declarations, and the core discards persisted state when it changes. An author who edited a handler and forgot to bump `version` got state computed by the previous logic, served for ever and silently. ADR-0086's invariant removes the possibility rather than reporting it: an author cannot STATE their processor's identity, so a fold is HANDED one, derived from what the processor IS -- the SHA-256 of a self-contained bundle's octets where a deployment read one off disk -- and never asks where it came from.

  This is the last MIGRATE batch of an expand -> migrate -> contract sequence, and it moves CALLERS rather than surfaces. `@etherfold/utils`, `@etherfold/core`, the two processor packages, `@etherfold/browser` and the CLI's own configuration path already carry the inputs; what changes here is that every place in these packages that NAMES a fold reads the value its arrival supplied, and every place that DESCRIBES one says so:
  - `@etherfold/state-store`: `StateSnapshot.processor` and `SnapshotProcessorMismatchError` now document the label as WHICH FOLD computed the rows, as the producing deployment's arrival derived it, compared for equality and never parsed. The candidate rule, the envelope and the format number are untouched; only the vocabulary moves, and the mismatch message says "computed by processor \`x\`" rather than "by processor version \`x\`", matching what `@etherfold/processor-entities` already says. `openSnapshotAware`'s example passes the identity the deployment's arrival handed its fold instead of calling `eventProcessor.getVersionHash()`.
  - `@etherfold/server`: the `_generations.processor` column, the `ReconfigureReport` docstring, the generation-registry note and the README's "what the advertised `generation` is made of" paragraph all describe the fold half in the new vocabulary. The `unchanged` outcome's two readings are now attributed to the arrival that produces them -- a bundle's identity moves with an edited handler, a declared one does not -- rather than stated as a property of every deployment. `POST /{indexer}/admin/canonical-generation`'s refusal asks for `{"stream": "<digest>", "processor": "<fold identity>"}`.
  - `etherfold`: the CLI's promotion-policy suite now ships its processor as a real self-contained BUNDLE on disk, so its successor is one edited handler line rather than a bumped `version` -- which is the change a developer actually makes.

  **Nothing is removed and no deployment has to move.** The declared `version`, `getVersionHash()`, `getCodeFingerprint()` and the `PROCESSOR DRIFT` report all still exist and still work; a configuration naming an unbundled module still resolves, registers and folds exactly as it did. `the-declared-version-and-the-drift-report-are-deleted` is the contract step that removes them, once every batch has landed.

  The declared path keeps its own witnesses on purpose. `aDeploymentRunsFromABundle.test.ts` asserts that an unbundled module still takes its identity from `getVersionHash()`, and `anEndpointReconfiguresARunningRun.test.ts` stays whole on that route because the `PROCESSOR DRIFT` report and the `unchanged` message that names `version` exist ONLY there -- they are the compensation for an identity an author had to remember, so rewriting them onto a bundle would delete their coverage rather than migrate it.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- b824312: **BREAKING: `EthereumIndexer` and the one-generation call shape are DELETED.** There is one name and one call shape. Nothing is kept as an alias, a shim or a deprecation window: nothing is published and the only consumers are repositories we own, so a compatibility path would be a second way to reach what the first one exists to replace.

  This is the CONTRACT batch of the expand → migrate → contract rename the generation container needed. `the-generation-container-expands-beside-the-old-shape` landed the container beside the old shape; `every-caller-moves-onto-the-generation-container` moved every caller, example, README and test onto it; this removes what nothing reads.

  **`@etherfold/core` no longer exports `EthereumIndexer`.** The class is `IndexerGeneration` — one stream, one processor, one state IS a generation, and an **indexer** is the `Indexer` container that holds several and points at the one that answers reads. An import of the old name is a compile error; rename it.

  **`createIndexerState` (`@etherfold/browser`) takes the two FACTORIES a generation is built from, and nothing else.** The shape that was handed one already-built processor over one already-built store is gone:

  ```ts
  // gone
  createIndexerState(fromEntityProcessor(myProcessor)(store));

  // the only shape
  createIndexerState({
  	createState: () => createBrowserStateStore(myProcessor.entities, {databaseName: 'my-app'}),
  	createProcessor: (store) => fromEntityProcessor(myProcessor)(store),
  });
  ```

  An indexer holds any number of generations and each folds into its OWN state, so the store cannot be a value handed over once. A caller that needs the store it built (to rebuild a processor over it on a hot reload, or to read its capability report) captures it in the factory's own closure.

  **A DISCARD IS NOW PUBLISHED BY THE CONTAINER, not by the browser hook.** `Indexer.reset`, `updateIndexer` and `updateProcessor` drop the handle the discarded fold had published and re-announce through `onStateUpdated`, so a subscriber holding the state that just went is told at the moment it goes. This is not new behaviour, it is the same re-seed one level lower: `createIndexerState` did it for its own `state` store, which is deleted here, and the container is what knows a verb discarded. It reaches every consumer of a container now rather than the browser hook's subscribers alone.

  `etherfold` (the CLI) changes only in its own source-text guard, which enforces that the CLI folds through `StreamBuilder` and constructs no browser engine. The guard matched the class under BOTH spellings while the alias existed; with one name left it matches one, and the deliberate violations it is asserted against lose their alias half — a guard left on an identifier nothing can resolve any more would stay green and enforce nothing.

  The verbs still discard exactly when they discarded before. Turning a reconfigure into a NEW GENERATION over the same stream, so nothing is discarded in place at all, is the promotion policy's landable (`the-promotion-policy-moves-the-canonical-pointer`) and needs the shared-stream follower under it.

  **The guard against a rebuild being reported as empty moved down with it.** When the STREAM survives — which a processor swap always leaves it, since the stream verdict is about the source and the config and not the processor — the `load` inside the verb replays the cached events and publishes the rebuilt state before the verb returns. The container counts that publication and stays silent rather than announcing an empty fold over the top of it.

- 3fa4afc: The RECEIVING container publishes what it applied, so a deployment that runs on a server can tell a reader the state moved.

  `Indexer` has published the state-moved signal since `the-fold-publishes-what-it-just-changed`, and that is the CHAIN-FACING container, which is what a browser runs. Every server and CLI deployment applies its blocks in **`ReceivingIndexer`** (the chain-free twin, fed wire batches by a fetcher elsewhere), and that one published nothing. So the signal reached the browser half of ADR-0083 while claiming both. It now publishes too, from the SAME assembly rather than a second implementation: one `StateMovedPublisher`, one union tagged `kind`, one token, one set of rules.

  ```ts
  const detach = container.onStateMoved((moved) => {
  	if (moved.coherence !== held) {
  		held = moved.coherence;
  		return invalidateEverything();
  	}
  	if (moved.kind === 'applied') for (const entity of moved.entities) invalidate(entity);
  });
  ```

  - **`@etherfold/core`** adds `ReceivingIndexer.onStateMoved(handler)`, returning the detach, with the same name and the same shape as the chain-facing container's so a transport adapts to ONE surface. The relay that carries the touched-entity set up from `@etherfold/processor-entities` is attached to every fold this container holds, so an entity-declared processor reports real entity NAMES on a server; a retraction publishes its fork point and ROTATES the token as it publishes; and a POINTER MOVE rotates the token and publishes nothing, exactly as `Indexer.movePointerTo` does.
  - **Only the CANONICAL fold publishes**, and on this container that filter is what stops an upgrade drowning every reader: a follower here re-folds a whole stored stream to catch up, so publishing per block would fire one notification per past block while nothing a reader can see has moved. The filter covers the TOKEN too, so a follower replaying a stored stream's reorg rotates nothing.
  - **`@etherfold/server`** adds `IndexerRegistryEntry.onStateMoved?`, forwarded by `indexerEntryOn`. This package applies no blocks (an ingest route delegates to a receiver the host constructed), so what it holds is the way to REACH the signal, which is the only handle a route has on a name. It is OPTIONAL on the same absent-is-a-capability-statement rule as `generations` and `promote`: a host holding a bare receiver and no container (`singleContextEntry`) reports none, so a transport built over it refuses rather than attaching to silence.
  - **`etherfold`** (the CLI)'s `index` command forwards it on the entry it writes out, so the receiving half of a split deployment is subscribable too.

  **Nothing about the receiving container's deliberate silence on state HANDLES has changed.** It still publishes no read handle and `ReceivedGenerationSpec` still has no `stateOf`, because reads on that runtime resolve the canonical pointer to a table namespace (ADR-0053). A notification is a different thing: it says WHAT MOVED (its case plus four facts, no rows, no mutations, no handle), so a reader re-reads through the surface it already has.

  One thing to know before relying on it, stated rather than discovered: which fold is canonical must be answerable SYNCHRONOUSLY (a fold reports from inside `process()`), so this container keeps the answer in memory and re-reads the durable pointer wherever it already consults it, plus on the two paths that precede a fold (`liveIngestions`, `rebuildMore`). A pointer moved by ANOTHER process is therefore not seen until the next read, which is the same in-process staleness the chain-facing container has and is bounded by the same best-effort delivery decision.

- 7b64e35: **`stream.alwaysFetchTimestamps` and the whole enrichment path under it are DELETED.** Unlike the transaction half of the same decision this is a SWAP rather than a removal: the time axis survives, unconditionally and for free. `blockTimestamp` is on the log itself, standardised in `ethereum/execution-apis#639`, so `event.blockTimestamp` is populated exactly as before at zero extra requests. What goes is the machinery that compensated for its absence at a cost the operator did not choose: `enrichEvents`, `blockFetcherFor`, the reorg-window-bounded block-timestamp cache, and the `eth_getBlockByHash` calls under them, issued one hash at a time in a `for` loop unless the provider advertised `eth_batch`. Neither deployment shape of ADR-0003 can be configured into a per-block request any more: not the single-process `IndexerGeneration`, not the split `LogFetcher`. `ProvidedStreamConfig` is now `{finality, parse}`.

  **THE MINIMUM NODE REQUIREMENT.** The engine reads `blockTimestamp` off the log and has no fallback to fetch it with, so a node that does not serve the field is now REFUSED at the fetch boundary rather than silently compensated for. That requires geth >= 1.16.0, reth, besu, erigon, anvil, ethereumjs, or **`@nomicfoundation/edr >= 0.20.0`** (`NomicFoundation/edr#1644`, released 2026-09-02). The requirement is on the resolved EDR version and never on the Hardhat version: no released Hardhat bundles it yet (3.16.0 ships edr 0.19.0), and EDR is an ordinary npm dependency, so a Hardhat project satisfies this TODAY with a package-manager override (`pnpm.overrides`, npm `overrides`, yarn `resolutions`) pinning `@nomicfoundation/edr` to `>=0.20.0`, rather than waiting for a Hardhat release. An override does force a combination Hardhat did not test, so verify it rather than assuming it just works; the published 0.19-to-0.20 delta is narrow.

  **The refusal is PERMANENT machinery and it fires in two places.** It is not a transitional guard: a timestampless log stays reachable at any version, because a node being FORKED may predate the spec change (EDR types the field `Option<u64>` precisely so a missing timestamp stays distinguishable from a real one) and EDR's on-disk RPC response cache replays such an absence once it has recorded one, until `rpc_cache` is dropped. (Not because pre-change cache entries keep answering: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and ignores the rest.) At the FETCH BOUNDARY the refusal names the NODE and the four things that cause it, one round trip in; at the FOLD, `blockPointer` names the BLOCK, because a stream can reach a fold without passing a fetcher at all (a seed install, a fixture replay). `blockPointer`'s message no longer recommends `stream: {alwaysFetchTimestamps: true}`, which would now be advice to set a flag that does not exist. Neither guess: a zero or interpolated timestamp does not fail, it answers confidently about the wrong block for as long as the store lives, and `getAsOf({timestamp})` has no way to tell a caller it was lied to.

  **What is deliberately NOT deleted.** `blockTimestamp?: number` stays OPTIONAL on the processor-facing event type, because the wire genuinely does not guarantee it and the type says what the wire does. `parseLogBlockTimestamp` and its hex/decimal quantity tolerance stay too: READING the field off the log is the surviving path, and an absent or unreadable value still yields `undefined` rather than a number.

  `@etherfold/fetcher-host` no longer reads `STREAM_ALWAYS_FETCH_TIMESTAMPS`, and `platforms/nodejs-fetcher` no longer documents it: the variable set the flag that no longer exists, so it now names nothing and is ignored like any other unrecognised variable. `STREAM_FINALITY` is the whole of the stream configuration the environment owns.

  **On the stream identity.** The stream config is hashed into the stream digest, so dropping a field from it is an addressing change and not merely an API change. It costs nothing here: `resolveStreamConfig` omits keys whose value is `undefined`, so a deployment that never set the flag contributed no key to the digest preimage and its digest does not move (pinned as recorded bytes in `aDeletedStreamFlagDoesNotMoveTheDigest.test.ts`). A deployment that DID set it re-indexes from block 0, which is the correct outcome. Backward compatibility with what has already been released is not an obligation of this project at its current stage, so there is no deprecation window and no migration path; this entry is a factual record of what changed.

  With this and the transaction half, the engine's entire chain-facing surface is `eth_getLogs` for data, `eth_blockNumber` for the tip and `eth_chainId` for the identity guard, and no configuration can make it call anything else. ADR-0073 records the reasoning; ADR-0002's block-timestamp consequence is updated to match.

- ba5b4ba: **`stream.alwaysFetchTransactions` and the `transaction` field it populated are DELETED, and there is no replacement.** This REMOVES A CAPABILITY. It is not deprecated, not aliased, not stubbed and not warned about: the flag is gone from `ProvidedStreamConfig`, `transaction?: LogTransactionData` is gone from the event type a processor is handed, and `LogTransactionData` itself, `transactionFetcherFor` and the `eth_getTransactionReceipt` calls under them are gone from `@etherfold/core`. Neither deployment shape of ADR-0003 can be configured into a per-transaction request any more: not the single-process `IndexerGeneration`, not the split `LogFetcher`.

  **What went with it, exactly.** `from`, `gasUsed` and `effectiveGasPrice` were the three fields the flag bought, at ONE `eth_getTransactionReceipt` per distinct transaction in every fetched range, issued in a `for` loop unless the provider advertised `eth_batch`. A processor that never set the flag sees no behavioural change at all: it made no such call before and makes none now.

  **What a processor that needed `from` should do instead: get it from somewhere other than this engine.** That is the honest answer and there is no better one hiding behind it. `from` is not on a log, `gasUsed` and `effectiveGasPrice` are not on a log, and no standard proposes putting them there, so this was never a compatibility fallback awaiting an upstream fix (`blockTimestamp` was, and it survives on the log). It was a permanent second data source, of precisely the kind the README's own Caveats tell a processor author not to depend on: anything costing an extra request per block or per transaction is expensive in the browser, which is the primary deployment (ADR-0002). Where the sender genuinely matters, the durable fix is on the CONTRACT side, emitting it in the event: an indexer cannot mint data the chain did not put in the log, and paying a round trip per transaction to fake that it can is what this deletes. ADR-0073 records the reasoning.

  **No migration guide, because there is nothing to migrate to.** Backward compatibility with what has already been released is not an obligation of this project at its current stage, so no consumer is being preserved and no window is being offered. This entry is a factual record of what changed, not a compatibility promise.

  `@etherfold/fetcher-host` no longer reads `STREAM_ALWAYS_FETCH_TRANSACTIONS`, and `platforms/nodejs-fetcher` no longer documents it: the variable set the flag that no longer exists, so it now names nothing and is ignored like any other unrecognised variable. `STREAM_FINALITY` and `STREAM_ALWAYS_FETCH_TIMESTAMPS` are untouched.

  **On the stream identity.** The stream config is hashed into the stream digest, so dropping a field from it is an addressing change and not merely an API change. It costs nothing here: `resolveStreamConfig` omits keys whose value is `undefined`, so a deployment that never set the flag contributed no key to the digest preimage and its digest does not move (pinned as recorded bytes in `aDeletedStreamFlagDoesNotMoveTheDigest.test.ts`). A deployment that DID set it re-indexes from block 0, which is the correct outcome: the stream it stored contains transaction data that nothing reads any more.

  The timestamp half of the enrichment is deliberately still standing and unchanged: `alwaysFetchTimestamps`, `enrichEvents`, `blockFetcherFor` and the block-timestamp cache are removed by a separate change, and the two were split so each lands green on its own.

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
- Updated dependencies [0ba3c60]
- Updated dependencies [9fa7f35]
- Updated dependencies [3e36261]
- Updated dependencies [514c821]
- Updated dependencies [ddcced5]
- Updated dependencies [2b4f3fc]
- Updated dependencies [8a8fe33]
- Updated dependencies [f77f8ea]
- Updated dependencies [61a5462]
- Updated dependencies [3e36261]
- Updated dependencies [a1fccd0]
- Updated dependencies [254a8d7]
- Updated dependencies [882ba22]
- Updated dependencies [5427806]
- Updated dependencies [391dbf8]
- Updated dependencies [c6b5215]
- Updated dependencies [9a10668]
- Updated dependencies [ebb9793]
- Updated dependencies [0f33468]
- Updated dependencies [a64a843]
- Updated dependencies [12cd1ab]
- Updated dependencies [3ce75fd]
- Updated dependencies [1bec395]
- Updated dependencies [d92021c]
- Updated dependencies [23c1eae]
- Updated dependencies [bc63e6b]
- Updated dependencies [5729da5]
- Updated dependencies [ebfa4f0]
- Updated dependencies [56fda62]
- Updated dependencies [2e10f5e]
- Updated dependencies [ce43a7b]
- Updated dependencies [1524a04]
- Updated dependencies [011aa87]
- Updated dependencies [ff167f0]
- Updated dependencies [d8ce920]
- Updated dependencies [a4d106e]
- Updated dependencies [ee8e78d]
- Updated dependencies [9ad39f4]
- Updated dependencies [339d212]
- Updated dependencies [382421f]
- Updated dependencies [4f5588b]
- Updated dependencies [9c15bb8]
- Updated dependencies [351c585]
- Updated dependencies [b647fb8]
- Updated dependencies [6874274]
- Updated dependencies [a448b1b]
- Updated dependencies [a2fc7d7]
- Updated dependencies [839e781]
- Updated dependencies [b82408d]
- Updated dependencies [6b5395e]
- Updated dependencies [f0515f8]
- Updated dependencies [5258a04]
- Updated dependencies [e72cbec]
- Updated dependencies [4e5067e]
- Updated dependencies [dc08d24]
- Updated dependencies [bdbcf26]
- Updated dependencies [29895dc]
- Updated dependencies [e7d06c9]
- Updated dependencies [aa17a93]
- Updated dependencies [da289e2]
- Updated dependencies [053a963]
- Updated dependencies [afd3da9]
- Updated dependencies [e652cde]
- Updated dependencies [49e73ae]
- Updated dependencies [70f98d6]
- Updated dependencies [3e9e9d0]
- Updated dependencies [1d9be43]
- Updated dependencies [ab779b0]
- Updated dependencies [793f3d6]
- Updated dependencies [8bb063e]
- Updated dependencies [d26ada8]
- Updated dependencies [1a6f68b]
- Updated dependencies [56acbef]
- Updated dependencies [ffe7c40]
- Updated dependencies [1d619c9]
- Updated dependencies [d50583b]
- Updated dependencies [37146b2]
- Updated dependencies [f3dc9a5]
- Updated dependencies [74f74f5]
- Updated dependencies [9a41ba3]
- Updated dependencies [74b2889]
- Updated dependencies [7428af8]
- Updated dependencies [114879f]
- Updated dependencies [f5fb4d2]
- Updated dependencies [114879f]
- Updated dependencies [0bf9dc7]
- Updated dependencies [20fecac]
- Updated dependencies [11481a0]
- Updated dependencies [b0e9a0d]
- Updated dependencies [bb86a77]
- Updated dependencies [c670273]
- Updated dependencies [0403310]
- Updated dependencies [0fd7dc9]
- Updated dependencies [2048aa1]
- Updated dependencies [1fa09f5]
- Updated dependencies [08d39d8]
- Updated dependencies [8d1c6c5]
- Updated dependencies [8baecea]
- Updated dependencies [114879f]
- Updated dependencies [5adafa9]
- Updated dependencies [a6963b4]
- Updated dependencies [6c321a1]
- Updated dependencies [49151c3]
- Updated dependencies [2c62a30]
- Updated dependencies [27b6e65]
- Updated dependencies [8b83efb]
- Updated dependencies [46e1c7c]
- Updated dependencies [cb28315]
- Updated dependencies [9d1d3cd]
- Updated dependencies [ad8d8b1]
- Updated dependencies [2e10f5e]
- Updated dependencies [50748cf]
- Updated dependencies [290e827]
- Updated dependencies [d5f1039]
- Updated dependencies [c0d694f]
- Updated dependencies [d10b64e]
- Updated dependencies [01ed0ef]
- Updated dependencies [629dff0]
- Updated dependencies [9e2c66d]
- Updated dependencies [ff8a6d2]
- Updated dependencies [ed8e7ff]
- Updated dependencies [0f33468]
- Updated dependencies [aea6d2a]
- Updated dependencies [b824312]
- Updated dependencies [132cc1c]
- Updated dependencies [2c049bf]
- Updated dependencies [35fc4c2]
- Updated dependencies [4f206c3]
- Updated dependencies [449f6fb]
- Updated dependencies [3fa4afc]
- Updated dependencies [31579cc]
- Updated dependencies [7af8558]
- Updated dependencies [85f1982]
- Updated dependencies [eee7e00]
- Updated dependencies [a28d27e]
- Updated dependencies [41b59fe]
- Updated dependencies [70af4e1]
- Updated dependencies [9229c30]
- Updated dependencies [241e684]
- Updated dependencies [4da7b27]
- Updated dependencies [9229c30]
- Updated dependencies [8c8341a]
- Updated dependencies [40819d3]
- Updated dependencies [628df9d]
- Updated dependencies [9bfc424]
- Updated dependencies [7b64e35]
- Updated dependencies [ba5b4ba]
- Updated dependencies [2c6ef82]
- Updated dependencies [5deb214]
- Updated dependencies [0a53b98]
  - @etherfold/core@1.0.0
  - @etherfold/server@0.2.0
  - @etherfold/state-store@1.0.0
  - @etherfold/utils@1.0.0
  - @etherfold/processor-entities@1.0.0
  - @etherfold/state-store-sqlite@0.2.0
  - @etherfold/fetcher-host@0.2.0
  - @etherfold/platform-nodejs@0.2.0
  - @etherfold/platform-nodejs-fetcher@1.0.0

## 0.7.0

### Minor Changes

- 047cd73: Switch the build from `tsup` to `tsc` and ship ESM-only output. The CommonJS build (`dist/*.cjs`) and the `main` field have been removed; packages are now consumed via the `module`/`exports` ESM entrypoints only. Module resolution moves to `NodeNext` (relative imports now carry explicit `.js` extensions, JSON imports use import attributes).
- bc5d71a: Update all dependencies to their latest versions and fix the resulting build.

  Dependency updates (notable):
  - `viem` 1.x → `^2.52.0` (major), `abitype` → `^1.2.4`
  - `pouchdb` / `pouchdb-find` → `^9.0.0`, `commander` → `^15.0.0`, `koa` → `^3.2.1`
  - `typescript` → `^6.0.3`, `vitest` → `^4.1.8`, plus various `@types/*`, `eip-1193`, `named-logs`, `fs-extra`, etc.

  Fixes required by the updates:
  - `@etherfold/core`: handle viem v2's stricter `encodeEventTopics` return type (`(Hex | Hex[] | null)[]`) and the generic `eventName` returned by `decodeEventLog` over `AbiEvent[]`.
  - `@etherfold/browser`: align `LastSync`/`ExistingStream` generic vs. base `Abi` usage that broke under viem v2's tighter `DecodeEventLogReturnType`.
  - `@etherfold/fs-cache`: spread typed event args safely; make the package explicitly ESM (`type: module`) with `.js` import extensions.
  - All published packages: add a standard `exports` map (ESM-only, no `main`) so modern bundlers/test runners (Vite/Vitest v4) resolve the package entry correctly.

  JS processor authoring keeps full ABI-derived type safety (`event.args` typed from the ABI).

- 086de7b: Adds the platform-agnostic indexer-server and its Node host, and a `serve` command to the CLI.

  `@etherfold/server` is a Hono app that receives its database and environment by injection (`{getDB, getEnv}`) and imports no runtime: no Node built-ins, no Cloudflare types, no concrete driver. It ships the fixed-table schema and a `/status` route reporting database reachability, whether the schema is applied and at which version, and the last error this process saw. `POST /admin/setup` applies the schema. A test asserts the package names no runtime, so the property is checked rather than trusted.

  `@etherfold/platform-nodejs` is the Node host: a libSQL-backed `RemoteSQL`, environment from the process, served over HTTP. It applies the schema at startup by default (one process owning one file), which `autoSetup: false` disables.

  The CLI gains `etherfold serve`, which runs that host, so a project can start an indexer-server without wiring anything. `etherfold index` remains the default command, so existing `etherfold -p <processor> -f <folder>` invocations are unchanged.

  A Cloudflare Worker host also exists, at `platforms/cf-worker`, and is not published: it is a deployable, not a library.

  The server is a skeleton. It serves status and schema only: no chain logic, no store wiring, no feed. Those arrive with the tasks that follow ADR-0003.

- e0e5832: Renamed to the `@etherfold` scope (ADR-0017). `ethereum-indexer` is now `@etherfold/core`, and `ethereum-indexer-browser`, `-js-processor`, `-fs`, `-fs-cache` and `-utils` are now `@etherfold/browser`, `@etherfold/js-processor`, `@etherfold/fs`, `@etherfold/fs-cache` and `@etherfold/utils`. The two previously unpublished `@ethereum-indexer/*` packages move to `@etherfold/*`.

  The CLI is the one exception to the scope: `ethereum-indexer-cli` becomes the flat package **`etherfold`**, because it is the package that installs the `etherfold` command.

  No API changed: update the package name in your imports and the exports are identical.

  **You must migrate to keep receiving updates.** There is no re-export shim under the old names, so nothing further will be published as `ethereum-indexer*` and no version of an old name forwards to the new one. Already-published versions stay installable indefinitely, so existing pins keep resolving, but they are frozen.

  **The CLI command is renamed**: the CLI installs `etherfold` instead of `ei`, so `npm i -g etherfold` then `etherfold -p <processor>`. Update any script that shells out to `ei`.

  `named-logs` namespaces follow the package names, so any log filter matching `ethereum-indexer*` needs updating to `@etherfold/*`. The CLI is the exception: its namespaces follow the command, so `ei` and `ei:keepState` become `etherfold` and `etherfold:keepState`.

  `ethereum-indexer-server` and `ethereum-indexer-db-utils` are deliberately NOT renamed: both are on the retirement path set by ADR-0010, and they have since moved to `archive/` in the repository, outside the workspace. Their published versions stay installable and are not deprecated here.

- 0ac08c0: **One BigInt convention, and it identifies a BigInt instead of guessing at one.** Every storage adapter now tags: `{"__bigint__": "123"}`, the codec the wire and the sync cursor already used. **`bnReplacer`, `bnReviver` and `isBigIntLiteral` are removed from `@etherfold/core`**, and `bnReviver` is removed from `@etherfold/browser`.

  `"123n"` was both what `123n` serializes to and a perfectly legal string for a contract to emit, so the decoder could not tell them apart and silently changed the type of whichever it got wrong. That is silent in both directions: a real BigInt read back as a string breaks arithmetic downstream, a string read back as a BigInt breaks comparisons (including `===` against a hash) and JSON round-trips. It is not hypothetical, and both kinds genuinely coexist in one payload: `LastSync.unconfirmedBlocks` carries decoded `LogEvent`s whose `args` hold a BigInt per `uint256`, and the same document carries the `context` digests. `535ccc1` stopped that decoder THROWING on values that were never numbers and gave `simple_hash` a leading `h`; both were containment, and the guess itself is what this removes.

  Moved onto the tag: **`etherfold`**'s snapshot keeper, **`@etherfold/browser`**'s `keepStateOnIndexedDB` and `keepStateOnLocalStorage`, **`@etherfold/fs`**'s file keeper, and `@etherfold/core`'s captured stream fixture. `@etherfold/processor-entities` was already on it.

  **The legacy suffix form is not read, anywhere, and there is no fallback.** Translating it would be the same guess under a new name, and refusing every string of digits ending in `n` would refuse legitimate event data, so a `"123n"` string is now simply a string. Where a persisted artifact carries a FORMAT number the number was bumped instead, so a file written under the old convention is refused AS A FILE rather than half-decoded:
  - **`STREAM_FIXTURE_FORMAT` is 2.** `parseStreamFixture` refuses a format-1 fixture, naming the file.
  - **`etherfold`'s `SNAPSHOT_FORMAT` is 2, and older snapshots are no longer read.** A snapshot at format 1, or in the bare pre-envelope form, is logged and treated as absent, which cold starts. That is deliberate: its BigInts cannot be recovered by this reader, so resuming from it would resume from state whose every `uint256` had become a string, and re-indexing is the existing recovery for a snapshot that cannot be read. Delete the snapshot folder, or re-index once.
  - The two artifacts with no format number of their own -- `@etherfold/fs`'s keeper blob and `keepStateOnLocalStorage`'s -- are caches whose recovery is a re-index, so a stale one reads back with its BigInts as the `"123n"` strings they now are. Call `clear()`, or clear site data.

  `keepStateOnIndexedDB` needed the codec only on its REMOTE reads: the local half hands the object to `idb-keyval`, and IndexedDB's structured clone stores a BigInt as a BigInt.

  The `"123n"` rendering survives in exactly one place, `simple_hash`, which uses it to have bytes to hash. Nothing decodes those bytes, so there is no guess to make, and changing it would change every digest ever persisted.

### Patch Changes

- 535ccc1: Stop the `"123n"` BigInt convention from mangling the hashes stored beside it.

  Six copies of the same reviver decided a string was a BigInt by testing its FIRST and LAST character, then called `BigInt()` on everything in between:

  ```ts
  (v.startsWith('-') ? !isNaN(parseInt(v.charAt(1))) : !isNaN(parseInt(v.charAt(0)))) && v.charAt(v.length - 1) === 'n';
  ```

  That admits `1x9tbhn`, which is not a BigInt literal but an ordinary base36 `simple_hash` digest, and `context.processor`, `context.config` and `context.source[].hash` are all made of those. `BigInt('1x9tbh')` throws, from inside `JSON.parse`. In the CLI, whose `keepState.fetch` catches parse failures, that meant a perfectly good snapshot being read as corrupt and the whole state re-indexed from scratch, permanently, for roughly 1.25% of config hashes, with a log line blaming the file. The copies without a `try/catch` simply threw.
  - The predicate now lives once, in `@etherfold/core` as `isBigIntLiteral` (with `bnReplacer` / `bnReviver` beside it), and every live copy uses it: the CLI, both browser adapters (including `keepStateOnIndexedDB`, the in-browser path ADR-0002 calls primary) and the fs adapter. A dead copy in `@etherfold/js-processor`'s `history.ts` was deleted.
  - **`simple_hash` now prefixes every digest with `h`, so all hashes change.** A guard cannot rescue a digest of all digits ending in `n` (`8918n`), because that genuinely IS the convention's shape: such a digest came back from storage as a BigInt, and `processorHash === context.processor` then compared a string to a BigInt and discarded state that was fine. The prefix makes the shape unreachable instead of unlikely.
  - **`simple_hash` no longer drops falsy values.** It filtered with a bare `if (value)`, so `{fee: 0}` hashed identically to `{}` and `{enabled: false}` identically to `{}`: a config change to a falsy value could not invalidate the state computed under the old one. `undefined` is still dropped, matching `JSON.stringify`, so a value hashed before and after a round trip still agree.
  - `simple_hash` also accepts BigInt values instead of throwing on them, which a processor config holding a `uint256` would previously have done.

  The suffix convention itself is still a guess: it cannot distinguish a real BigInt from a contract-emitted string that reads like one. `@etherfold/processor-sqlite`'s tagged `{__bigint__: "..."}` codec is the form that can, and is where the remaining adapters should go.

- 5af5f04: Write the snapshot state file atomically. Previously `keepState.save` wrote the `state` and `lastSync` files in place via `fs.writeFileSync` on every `indexMore()`, so a process killed mid-write (CI timeout, OOM, Ctrl-C) could leave a truncated, invalid-JSON snapshot on disk — which a CI snapshot pipeline could then commit and publish. The save now writes each file to a temp file in the same directory, fsyncs, and renames it over the destination (atomic on POSIX same-filesystem), cleaning up the temp file on failure. An interrupted save now leaves the previous valid snapshot intact.

  Internally, the file-backed `keepState` implementation was extracted from `init()` into an exported `createFileKeepState(folder)` (behaviour-preserving) so it can be unit-tested.

- 41370f7: The CLI now resolves a proper process exit code: `0` on success and `1` on failure. Previously `cli.ts` did `run().then(() => console.log('DONE'))` with no `.catch` and no `process.exit`, so a failed index (bad node URL, RPC error, processor throw, write failure) could look like a successful CI step — and on success the process could linger because the provider's rate-limit timers kept the event loop alive. The success/failure-to-exit-code logic is encapsulated in an exported `main(options, deps?)` (with injectable `run`/`exit`/`log`/`error` for testing); `cli.ts` calls it with the real `process.exit`. On failure the error is reported and `DONE` is not printed.
- 39ae6ca: Make the CLI's indexing loop resilient and drop a redundant RPC call. The `run()` loop previously made a standalone `eth_blockNumber` request at startup (immediately made redundant by `indexMore()`, which re-fetches and returns the latest block) and had no retry — a single transient `indexMore()` error (e.g. an RPC blip) aborted the whole batch. The loop is now extracted into an exported, testable `indexToTip(indexer, opts?)` that discovers the tip via `indexMore()` alone and retries transient errors with a bounded number of attempts (default 5) before giving up. Termination contract is unchanged: it indexes up to the live chain tip (suitable for the snapshot-behind-finality use case).
- b1fe882: Add a versioned envelope to the snapshot state file and stop silently swallowing corrupt snapshots. The state file is now written as `{format, processor, savedAt, lastSync, state, history}` (the `processor` is the processor version hash from the lastSync context, `savedAt` is an ISO timestamp). This is backward-compatible: reads accept both the new enveloped form and the legacy bare `{lastSync, state, history}` form, and `state`/`lastSync`/`history` remain at the top level so existing consumers keep working. On read, a missing file is still treated as a normal first run, but a file that exists yet cannot be read or parsed (e.g. truncated by an old non-atomic write, or a bad commit) is now logged via `named-logs` instead of being silently treated as "no snapshot".
- 47252ad: Rewrite `init()` to use the new shared processor/source-resolution helpers from `@etherfold/utils` (`loadProcessorModule` + `instantiateProcessor` + `resolveSource`) instead of its own copy of that logic (LOW-4 in the server/CLI batch audit). Behaviour is preserved exactly: the CLI still constructs its own rate-limited `JSONRPCHTTPProvider`, owns its `keepState` wiring, calls the processor factory with no argument, and — importantly — keeps the original ordering (instantiate processor + `keepState` check happen before any `eth_chainId` RPC). As a side effect the CLI now also benefits from the `createRequire(...).resolve()` module-resolution fallback the server already had.

  (The CLI uses the granular helpers rather than the bundled `resolveProcessorAndSource` precisely to preserve that ordering; the server uses the bundled helper since it has no equivalent intermediate check.)

- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [aeb7843]
- Updated dependencies [0957f8c]
- Updated dependencies [c681b79]
- Updated dependencies [9d21d67]
- Updated dependencies [ca6f981]
- Updated dependencies [31833b6]
- Updated dependencies [047cd73]
- Updated dependencies [eba61c3]
- Updated dependencies [dece521]
- Updated dependencies [939364a]
- Updated dependencies [d24872f]
- Updated dependencies [78d8377]
- Updated dependencies [3de4c35]
- Updated dependencies [bc118e4]
- Updated dependencies [bc5d71a]
- Updated dependencies [086de7b]
- Updated dependencies [e0a6480]
- Updated dependencies [9738f1c]
- Updated dependencies [33afc5b]
- Updated dependencies [4097ccd]
- Updated dependencies [e0e5832]
- Updated dependencies [3a78285]
- Updated dependencies [0ac08c0]
- Updated dependencies [cefe0de]
- Updated dependencies [47252ad]
  - @etherfold/core@0.7.0
  - @etherfold/utils@0.7.0
  - @etherfold/platform-nodejs@0.1.0

## 0.6.30

### Patch Changes

- Updated dependencies
  - ethereum-indexer-utils@0.6.13

## 0.6.29

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.21
  - ethereum-indexer-utils@0.6.12

## 0.6.28

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.20
  - ethereum-indexer-utils@0.6.12

## 0.6.27

### Patch Changes

- remove log

## 0.6.26

### Patch Changes

- support folder export with lastSync + allow fetch lastSync first to get latest sync
- Updated dependencies
  - ethereum-indexer-utils@0.6.12

## 0.6.25

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.19
  - ethereum-indexer-utils@0.6.11

## 0.6.24

### Patch Changes

- make of eip-1193-jsonrpc-provider new name

## 0.6.23

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.18
  - ethereum-indexer-utils@0.6.11

## 0.6.22

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.17
  - ethereum-indexer-utils@0.6.11

## 0.6.21

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.16
  - ethereum-indexer-utils@0.6.11

## 0.6.20

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.15
  - ethereum-indexer-utils@0.6.11

## 0.6.19

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.14
  - ethereum-indexer-utils@0.6.11

## 0.6.18

### Patch Changes

- Updated dependencies
  - ethereum-indexer-utils@0.6.11
  - ethereum-indexer@0.6.13

## 0.6.17

### Patch Changes

- add rps for cli

## 0.6.16

### Patch Changes

- use latest deps

## 0.6.15

### Patch Changes

- latest deps
- Updated dependencies
  - ethereum-indexer-utils@0.6.10
  - ethereum-indexer@0.6.12

## 0.6.14

### Patch Changes

- Updated dependencies
  - ethereum-indexer-utils@0.6.9

## 0.6.13

### Patch Changes

- mkdir for cli

## 0.6.12

### Patch Changes

- fix import

## 0.6.11

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.11
  - ethereum-indexer-utils@0.6.8

## 0.6.10

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.10
  - ethereum-indexer-utils@0.6.8

## 0.6.9

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.9
  - ethereum-indexer-utils@0.6.8

## 0.6.8

### Patch Changes

- reorg + add streams server (wip)
- Updated dependencies
  - ethereum-indexer@0.6.8
  - ethereum-indexer-utils@0.6.8

## 0.6.7

### Patch Changes

- improve processor import to work in pnpm + startBlock fix
- Updated dependencies
  - ethereum-indexer@0.6.7

## 0.6.6

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.6

## 0.6.5

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.5

## 0.6.4

### Patch Changes

- c81fb4d: use state field name instead of data
- Updated dependencies [c81fb4d]
  - ethereum-indexer@0.6.4

## 0.6.3

### Patch Changes

- first release of ethereum-indexer-cli
