# ethereum-indexer-utils

## 0.8.1

### Patch Changes

- Updated dependencies [414576d]
  - @etherfold/core@0.9.0

## 0.8.0

### Minor Changes

- 8a8fe33: **A deployment can now RUN from a BUNDLE, and the generation it registers is identified by that bundle's hash** (ADR-0086).

  `--processor` still names a PATH and that does not change. What changes is what the path may point AT: where it names a SELF-CONTAINED bundle, the CLI reads it, hashes it (`sha256:<hex>` over the octets), instantiates it from those bytes and registers a generation whose `processor` identity IS that hash. An author who edits a handler and forgets to bump anything gets a different generation, because there is nothing left to forget. Two machines building the same source get the same one, because the identity is the bytes and not the path they sit at.

  Nothing bundles anything: reading a file and hashing it is not bundling, and the CLI acquires no bundler.

  **Both shapes work, which is the point of this step.** A path naming an UNBUNDLED module -- one that still expects somebody else to resolve an import -- resolves through the module system exactly as it always did and keeps the author-declared identity from `getVersionHash()`. The declared `version`, `getVersionHash()` and the code fingerprint are all untouched; four migrate batches and a contract task follow and each depends on that.

  **A bundle is a module that expects nobody else to resolve anything**, which is `unresolvedImportsOf`'s existing judgement and not a second one. The consequence worth knowing: a hand-written entry point that imports NOTHING is a bundle by that definition and is identified by its bytes rather than by its `version`.

  New in `@etherfold/utils`: `openProcessorArrival(path, options)`, which lands one operator-supplied path on whichever of the two arrivals it describes and answers with `{processor, processorModule, identity?}` -- `identity` present exactly when the path named a bundle. An injected `importModule` governs the module arm alone; the bundle arm imports a `data:` URL of the bytes it just read, where the module cache is keyed on those bytes and is therefore exactly right.

  New in `@etherfold/processor-entities`: `EntityEventProcessorOptions.identity`, the identity a host HANDS a fold when the arrival derived one. Absent is the ordinary case and means the declared hash, unchanged. It is not the caller-declared version hash ADR-0043 rejected: it is derived from something the class cannot see and REPLACES the computation rather than sitting beside it, so there are still never two live answers.

  Nothing parses a processor identity anywhere in the tree, which is what lets two derivations coexist through the migration and after it.

- 0e53f34: **A Node deployment now KEEPS the bundle that folds each generation it registers, beside that generation's state, and deletes it with the generation** (ADR-0092, the storage half).

  Nothing reads the bytes back into a processor yet: that is the next step. What this makes true is that the code is durably present, is exactly the octets whose hash is the generation's identity (ADR-0086), and is bounded by the registered generations.

  `@etherfold/core`:
  - `GenerationRegistry.create(id, {slot, bundle})` stores `bundle` with the record in the SAME commit, and `GenerationRegistry.bundleOf(id)` reads it back. A registration that RESOLVES an existing generation writes no bytes.
  - `GenerationRegistryWrite.bundle` carries the bytes of `put`, and a `remove` takes EVERYTHING a substrate keeps under the identity, bundle included. So every deletion (`deleteGeneration`, which a reclaim, a replaced successor and a drop on promotion all reach, and `deleteStream`) takes the code by taking the row, with no second deletion path.
  - `GenerationRegistryPort.readBundle(id)` is a new REQUIRED port operation. The memory substrate keeps the bytes in the same entry as the record.
  - `ReceivedGenerationSpec.bundle` is REQUIRED, and `ReceivingIndexer.add` refuses a fold with none before anything is built or registered. Optional bundling would make two invisible classes of generation, resumable and frozen.
  - `ReceivingIndexer.resolveGeneration` now RESOLVES only, and refuses an identity it has not registered (`UnknownGenerationError`). It used to register one, which was a second registration route with no bytes to store.

  `@etherfold/server`: `_generations` gains a nullable `bundle BLOB` column, written by the same guarded `INSERT` as the row and removed by the same `DELETE`. `generationRegistryPortOnSQL` implements `readBundle`. The schema version is unchanged: nothing is published, so no existing database has to be told.

  `@etherfold/browser`: the IndexedDB registry port stores NO bundle, because a tab retains no code (ADR-0089). `readBundle` answers `undefined`, and a registration carrying a bundle is REFUSED rather than stored or silently dropped.

  `@etherfold/utils`: `ProcessorArrival.bundle` carries the octets a bundle arrival read and hashed, present exactly where `identity` is, so the bytes stored are the bytes that were named rather than a second read of the path.

  `etherfold`: the folding wiring hands the container the arrival's bytes with its identity (`requireArrivedBundle`, `ArrivedBundle`). The test seam `IndexingDependencies.processorIdentity` / `IndexDependencies.processorIdentity` is REPLACED by `processorBundle: Uint8Array`: a substituted arrival states the BYTES it stands for, its identity is derived from them and they are stored like any bundle's. A bare name with no bytes behind it can no longer register a Node generation.

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

- 3ce75fd: **A processor ARTIFACT is bytes, the identity derived from them, and a loader: `processorArtifactIdentity`, `unresolvedImportsOf` and `loadProcessorArtifact`** (ADR-0086, ADR-0085).

  A processor's identity has always been AUTHOR-DECLARED -- `version`, hashed with the declarations into `getVersionHash()` -- so an author who edited a handler and forgot to bump it got state computed by the previous logic, served for ever and silently. ADR-0086 makes that unrepresentable: a processor IS a self-contained bundle and the hash of its octets IS its name. This is the unit that rests under it.
  - **`processorArtifactIdentity(bytes)`** is SHA-256 over the octets, rendered `sha256:<hex>` -- the convention the stream-seed content hash already established, so a literal pasted into a build says which function produced it. Identical bytes give an identical name and one changed byte gives a different one, with no author action either way.
  - **`unresolvedImportsOf(bytes)`** is what SELF-CONTAINED means, CHECKED rather than promised: a bundle that survived bundling with `import 'viem'` still in it looks exactly like one that did not, until it is instantiated in another process or -- for a specifier only a dynamic `import()` carries -- until the first event it folds. Both are decidable statically, and both are reported, bare specifiers and relative ones alike. A BUILTIN is admitted (`node:crypto` and unprefixed `crypto`), because a `data:` URL really does resolve one; measured against Node rather than assumed, in `docs/spikes/a-processor-artifact-is-bytes-a-hash-and-a-loader/`.
  - **`loadProcessorArtifact(bytes, {processorConfig})`** hashes, admits and then instantiates, in that order, by importing a `data:text/javascript;base64,` URL: no temporary file, no path, no cache-busting query. Everything checkable happens BEFORE evaluation, which is the irreversible act here (the module joins the process registry for the life of the process and its top-level code runs) -- the ordering `installStreamSeed` already makes structural.

  **Refusals are DATA, in that same manner, and never a throw a caller cannot branch on**: `not-self-contained` (naming the unresolved specifiers), `unreadable-module` (the bytes did not become a module, or its body threw) and `not-a-processor` (no `createProcessor`, a factory that made nothing, or the retired `{kind, processor}` tag, refused by the one rule that already owns it). Each carries the artifact's IDENTITY, because bytes have a name whether or not they turn out to be a processor. The module is handed back beside the processor, since `contractsData` rides on it and resolving a source is the caller's step.

  **Nothing consumes this yet, deliberately.** ADR-0086's migration is sequenced (expand, then four migrate batches, then a contract), so `getVersionHash()`, the declared `version` and the code fingerprint are untouched and no caller is migrated: this release only ADDS.

  **There is no browser path and that is a decision.** A tab is handed a processor OBJECT by its own bundler, and where a tab does hold bytes, `data:` and `blob:` module imports are refused by every realistic Content-Security-Policy (measured across three engines in `work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md`). A browser arrival is a service worker serving a same-origin URL, which is its own decision and not this unit's.

  The round trip is asserted against a REAL bundle, built once by the documented command (`esbuild --bundle --format=esm --minify`) and committed at `packages/utils/test/fixtures/processor-artifact/`, because a fixture built another way would not exercise what deployments produce.

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

### Patch Changes

- ebb9793: **A processor module that exists and THREW now reports its own error, instead of the package resolver's "Cannot find module".**

  `loadProcessorModule` imports a relative path and, on ANY failure, fell back to resolving the specifier through `createRequire(cwd/node_modules).resolve(...)` with the first error discarded. So an operator whose module was found and then failed -- a syntax error, a top-level throw, an import IT makes that does not resolve -- was told `Cannot find module './dist/processor.js'`, which sends them to look at their path when the fault is inside their code.

  The fallback exists for ONE condition: the specifier named no file, so it might name a package instead. That is now the only condition under which it is taken (`ERR_MODULE_NOT_FOUND`), and even then the ORIGINAL error is what propagates if the fallback also fails, because the original is the one that describes what the operator actually asked for. A bare package specifier still resolves exactly as before.

  The discriminator is the error CODE and deliberately not a match on the message text: a module whose own missing sibling raises the same code names both the sibling and the module it was imported from, so no text match can tell that apart from a missing entry point. Such a module still takes the fallback, the fallback still fails, and the error shown is still the one naming the sibling.

- 1a6f68b: Every published package now carries a `description` and its own `README.md`.

  Metadata and docs only: no runtime code changed. Four manifests had no `description` at all (`@etherfold/core`, `@etherfold/browser`, `etherfold`, `@etherfold/utils`), which is the line npm shows in search results and on the package page, and seven packages had no README (the four above plus `@etherfold/server`, `@etherfold/platform-nodejs` and the private Worker host). Each README says what the package is, when to reach for it INSTEAD of its neighbours, a minimal snippet taken from code that runs, and links to the related packages.

  Two summaries are worth calling out because a guessed one would have been wrong. **`etherfold index` is a ONE-SHOT**: it folds to the tip it observed and exits, does not follow the chain and cannot be reconfigured while running, so keeping a database current is running it again; live reconfigure is `@etherfold/browser`'s ability. And **`@etherfold/utils` is not a bag of hashing helpers** any more: what is in it is the Node-side loader that turns a processor PATH into the authoring object plus its indexing source, since `contextFilenames` and the `@etherfold/utils/indexer` subpath went with the blob snapshot (ADR-0037).

  One existing description is CORRECTED rather than added: `@etherfold/state-store-sqlite` called itself a "state store for `@etherfold/core`", which names the wrong seam. It depends on `@etherfold/state-store`, `remote-sql` and `named-logs` and on nothing else, and a test in that package asserts as much, because a storage backend depending on the indexer would invert ADR-0016.

  **`etherfold` no longer publishes the repo's root README.** Its `prepack` copied `../../README.md` into the package, so the npm page for the CLI described the monorepo and documented none of its flags; the package now has a README of its own, committed rather than generated, and `prepack` copies only the LICENSE.

- ffe7c40: **Four defects that had been sitting in `work/notes/observations/` are fixed.**

  **An id VALUE containing U+0000 is refused instead of silently merging two rows.** `entityKey` joins the entity name and the id values with U+0000, and the memory and patch backends key rows on that string, so for `id: ['x', 'y']` the distinct keys `{x: 'a\0b', y: 'c'}` and `{x: 'a', y: 'b\0c'}` produced the SAME string: the second write overwrote the first and both reads answered with it. Reproduced before and after -- on `MemoryStateStore` the two writes were accepted and both reads returned `"second"`; they are now refused by name. The SQL backend kept them apart (separate columns) and IndexedDB did too (an array key), so the same processor meant different things per backend, which is the divergence the seam exists to prevent. Refused in `idValues`, beside the existing id-is-required refusal, rather than escaped: a length-prefixed join would change every key string for data that has never had this problem, to keep admitting a value no chain produces -- an id comes from decoded event args, where a string is an address, a hash or a decimal.

  **A `contractsData`-only processor module can resolve a source.** `resolveSource` fetched `eth_chainId` only inside the `contractsDataPerChain` branch, so a module exporting only `contractsData` -- the shape the docs describe as the fallback, and the one `--deployments` calls optional "where the processor module supplies its own contract data" -- always threw `no chainId found`, on the CLI and the server alike. It now asks for the id it needs, and only when it needs it: a module supplying no contract data at all still refuses without touching the chain. The test that had locked this in as "quirky, but preserved exactly" is replaced; it was not a quirk, it was a dead path.

  **An indexer-server can state a byte ceiling on an ingest batch, and refuse an oversized one with `413`.** A wire batch is bounded by block range and by event count, and neither is a bound in BYTES: the size of a decoded batch is not known until it is built, so an ABI with large `bytes` arguments defeats a count at any setting. A receiver read the whole body into memory before it could check anything about it and answered no `413`, so its limit was whatever its runtime died at. `ServerOptions.maxIngestBytes` is optional and has NO default, deliberately: only a host knows its own ceiling (a Worker has a request limit, a Node process does not), and nothing has measured what a decoded batch costs per log for a realistic ABI, so a number invented here would be a guess. When set, the declared `Content-Length` is checked before the body is buffered, with the actual size as a backstop for a chunked request. The WHOLE batch is refused and the limit is named, because ADR-0004 forbids delivering part of a range -- a short payload is read as an absence, concluded as a reorg, and reverts state -- so the sender lowers `toBlock` and re-sends from the same `fromBlock`. It is deliberately not a `409`, which means "re-send from THIS block" and would have the sender skip the range it never delivered.

  The remaining half of that last one is unchanged and still open: bounding a batch by bytes at the SENDER needs an estimate computed where the payload is built, next to the truncation guard that already lowers `toBlock`. What this adds is the receiving half, so the ceiling is stated rather than discovered.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- 84930e2: **Two package READMEs stop telling a reader they can declare a processor's identity**, which is the exact thing ADR-0086 removed.

  `packages/browser/README.md` closed its `processorIdentity` paragraph with "Leave it off and the generation keeps the author-declared identity the processor computes from its `version`, exactly as before" -- a sentence that cited ADR-0086 one clause earlier and then contradicted it, and did so at the point where the API is described, which is where most readers stop. The paragraph now says what omitting the field actually DOES: the identity is still DERIVED, a fold that arrived as a MODULE is named by a digest of its HANDLER SOURCES (`moduleProcessorIdentity`), so an edit moves it and a save that changed nothing does not and is answered `{stateDiscarded: false}`. It also states the two things the deleted clause left a reader to guess at: there is no declared `version` field to fall back on, because ADR-0086 deleted the field and the `getVersionHash()` that composed it, and a processor whose handlers have no readable source is REFUSED rather than named something no edit could move. The `processorIdentity` paragraph, the `updateProcessor` bullet and the derivation paragraph now say one thing.

  `packages/utils/README.md` carried the same retired rule on the other arm of `openProcessorArrival`: an arrival with no `identity` was said to leave "the author's declared one" naming the fold. There is none, so such a deployment is refused -- at configuration resolution with the build command in it (`refuseUnbundledProcessor`), with `requireArrivalIdentity` as the structural backstop -- and the README now says so and says why neither refusal lives in the loader.

  Documentation only; no published behaviour changes.

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

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- 9e5dc0d: The re-read endpoint is DELETED (ADR-0094): code reaches a running Node process only by an UPLOAD to `etherfold node`, and a configured `etherfold run` changes its code by restarting. The dev loop is `etherfold node` plus a watcher that calls `etherfold upload` on each build.

  `@etherfold/core`: `ReconfigureArrival` loses its `re-read` value and is now `'upload' | 'hot-update'`. `ReconfigureReport` keeps its name.

  `@etherfold/server`: `POST /{indexer}/admin/reconfigure` is gone from every host (it now answers as a route that does not exist), together with its `reconfigure-not-held` and `reconfigure-failed` answers and the `IndexerRegistryEntry.reconfigure` seam. The upload route documents the three answers and the `409` it spends on a failed arrival on its own account.

  `etherfold`: the reconfigurer is deleted with its exports (`reconfigurerFor`, `ReconfigureContext`) and `PreparedIndexing.reconfigure`. `arrivalQueue` and `ArrivalQueue` are kept (the upload's arrivals still wait in one line) and are now exported from their own module. The `--promotion` rationale, the `--override` help and the `build` / `index` promotion refusals no longer cite the deleted route: `run` takes `--promotion` because a successor registered at START still catches up while it runs, and `node` because uploads register successors while it runs.

  `@etherfold/browser`: documentation only. `reconfigureFromHotUpdate` answers the same `ReconfigureReport` the upload route answers, now one of two arrivals.

  `@etherfold/utils`: a comment only.

- Updated dependencies [1ad2d4a]
- Updated dependencies [ebfa4f0]
- Updated dependencies [0ba3c60]
- Updated dependencies [9fa7f35]
- Updated dependencies [3e36261]
- Updated dependencies [852da39]
- Updated dependencies [2b4f3fc]
- Updated dependencies [f77f8ea]
- Updated dependencies [61a5462]
- Updated dependencies [a1fccd0]
- Updated dependencies [e8cc627]
- Updated dependencies [0e53f34]
- Updated dependencies [882ba22]
- Updated dependencies [5427806]
- Updated dependencies [450494a]
- Updated dependencies [93eef2e]
- Updated dependencies [391dbf8]
- Updated dependencies [c6b5215]
- Updated dependencies [9a10668]
- Updated dependencies [0f33468]
- Updated dependencies [a64a843]
- Updated dependencies [57697f6]
- Updated dependencies [2021f99]
- Updated dependencies [1bec395]
- Updated dependencies [d92021c]
- Updated dependencies [23c1eae]
- Updated dependencies [bc63e6b]
- Updated dependencies [5729da5]
- Updated dependencies [ebfa4f0]
- Updated dependencies [2e10f5e]
- Updated dependencies [ce43a7b]
- Updated dependencies [1524a04]
- Updated dependencies [011aa87]
- Updated dependencies [fc95435]
- Updated dependencies [d8ce920]
- Updated dependencies [a4d106e]
- Updated dependencies [ee8e78d]
- Updated dependencies [1af43de]
- Updated dependencies [9ad39f4]
- Updated dependencies [af6a85a]
- Updated dependencies [72297c8]
- Updated dependencies [339d212]
- Updated dependencies [4f5588b]
- Updated dependencies [351c585]
- Updated dependencies [b647fb8]
- Updated dependencies [02f46ca]
- Updated dependencies [a448b1b]
- Updated dependencies [a2fc7d7]
- Updated dependencies [839e781]
- Updated dependencies [6b5395e]
- Updated dependencies [f0515f8]
- Updated dependencies [1769d1a]
- Updated dependencies [e72cbec]
- Updated dependencies [4e5067e]
- Updated dependencies [dc08d24]
- Updated dependencies [bdbcf26]
- Updated dependencies [29895dc]
- Updated dependencies [e7d06c9]
- Updated dependencies [aa17a93]
- Updated dependencies [da289e2]
- Updated dependencies [1c1bf33]
- Updated dependencies [c30070a]
- Updated dependencies [e652cde]
- Updated dependencies [49e73ae]
- Updated dependencies [70f98d6]
- Updated dependencies [3e9e9d0]
- Updated dependencies [9f693f3]
- Updated dependencies [1d9be43]
- Updated dependencies [ab779b0]
- Updated dependencies [793f3d6]
- Updated dependencies [1a6f68b]
- Updated dependencies [56acbef]
- Updated dependencies [1d619c9]
- Updated dependencies [d50583b]
- Updated dependencies [37146b2]
- Updated dependencies [74f74f5]
- Updated dependencies [9a41ba3]
- Updated dependencies [74b2889]
- Updated dependencies [f5fb4d2]
- Updated dependencies [114879f]
- Updated dependencies [0bf9dc7]
- Updated dependencies [11481a0]
- Updated dependencies [b0e9a0d]
- Updated dependencies [bb86a77]
- Updated dependencies [0403310]
- Updated dependencies [1ed2b80]
- Updated dependencies [8d1c6c5]
- Updated dependencies [8baecea]
- Updated dependencies [114879f]
- Updated dependencies [5adafa9]
- Updated dependencies [a6963b4]
- Updated dependencies [49151c3]
- Updated dependencies [cf1d4d5]
- Updated dependencies [cb28315]
- Updated dependencies [9d1d3cd]
- Updated dependencies [ad8d8b1]
- Updated dependencies [50748cf]
- Updated dependencies [290e827]
- Updated dependencies [d5f1039]
- Updated dependencies [c0d694f]
- Updated dependencies [d10b64e]
- Updated dependencies [01ed0ef]
- Updated dependencies [629dff0]
- Updated dependencies [9e2c66d]
- Updated dependencies [ed8e7ff]
- Updated dependencies [b824312]
- Updated dependencies [35fc4c2]
- Updated dependencies [4f206c3]
- Updated dependencies [9e5dc0d]
- Updated dependencies [449f6fb]
- Updated dependencies [3fa4afc]
- Updated dependencies [31579cc]
- Updated dependencies [7af8558]
- Updated dependencies [eee7e00]
- Updated dependencies [241e684]
- Updated dependencies [4da7b27]
- Updated dependencies [9229c30]
- Updated dependencies [8c8341a]
- Updated dependencies [40819d3]
- Updated dependencies [628df9d]
- Updated dependencies [9bfc424]
- Updated dependencies [7b64e35]
- Updated dependencies [ba5b4ba]
- Updated dependencies [5deb214]
- Updated dependencies [6d3df30]
- Updated dependencies [0a53b98]
  - @etherfold/core@0.8.0

## 0.7.0

### Minor Changes

- aeb7843: **`createIndexerState` takes an entity processor, so a tab can index into the store the application chose.**

  The two halves existed and nothing joined them: `createBrowserStateStore` built a browser `StateStore` and was referenced by nothing except its own test, while the hook's processor type was `EventProcessorWithInitialState` — the free-form-object interface — so an entity processor could not be handed to it at all.

  ```ts
  const store = await createBrowserStateStore(myProcessor.entities); // one line picks the backend
  const indexer = createIndexerState({kind: 'entities', processor: fromEntityProcessor(myProcessor)(store)});
  ```

  **Both kinds are accepted and the caller SAYS which**, in a tag the compiler checks (`ProcessorKind` = `'js-object' | 'entities'`, `TaggedProcessor`, `IndexerStateProcessor`). A bare `EventProcessorWithInitialState` still means `'js-object'` and every existing call site keeps working untouched; passing the wrong processor under a tag is a compile error rather than a missing method three calls later. The discrimination is deliberately never a sniff for `createInitialState`, which a wrapper, a proxy or a decorator can make wrong in silence.
  - The free-form path CREATES its initial state; the entity path READS its store through the handle the processor already exposes (`processor.state`), because there is nothing to seed — the state is in the store.
  - **`keepState` on the entity path is refused**, with a message naming the store: an entity deployment persists through its `StateStore`, cursor included (ADR-0027), so a keeper there is a second place to persist rather than a second opinion. `keepState` stays optional and unchanged for the free-form path.
  - `updateProcessor` takes either kind, tagged the same way.
  - `options.createIndexer` now receives the processor as `EventProcessor<ABI, ProcessResultType>` — what `new EthereumIndexer(...)` takes, and the one thing both kinds have in common. A caller that annotated that parameter as `EventProcessorWithInitialState` has to widen it.

  **Reload continuity is the browser-specific risk and it is now tested on a real engine.** `pnpm --filter @etherfold/browser test:browser` runs the hook through a captured stream in Chromium, Firefox and WebKit, including a REAL page reload: a tab that indexed, closed and reopened resumes from its cursor rather than re-indexing from the start block. On `@etherfold/state-store-patch` a reload legitimately starts over (memory-only, ADR-0023), and the store says so in `capabilities.durability` before it happens.

  **`@etherfold/browser` bundles for a browser again, and `@etherfold/utils` gained a `./indexer` subpath to make that true.** The barrel re-exports the CLI-side modules, whose top-level `node:fs` / `node:path` / `node:module` imports made `import '@etherfold/browser'` unresolvable for esbuild and for vite, before tree-shaking could help. `storage/state/OnIndexedDB.ts` now imports `contextFilenames` from `@etherfold/utils/indexer` (platform-free by construction), and a test bundles the package with `platform: 'browser'` on every commit so it cannot come back. `@etherfold/utils`' existing barrel is unchanged.

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

- e0e5832: Renamed to the `@etherfold` scope (ADR-0017). `ethereum-indexer` is now `@etherfold/core`, and `ethereum-indexer-browser`, `-js-processor`, `-fs`, `-fs-cache` and `-utils` are now `@etherfold/browser`, `@etherfold/js-processor`, `@etherfold/fs`, `@etherfold/fs-cache` and `@etherfold/utils`. The two previously unpublished `@ethereum-indexer/*` packages move to `@etherfold/*`.

  The CLI is the one exception to the scope: `ethereum-indexer-cli` becomes the flat package **`etherfold`**, because it is the package that installs the `etherfold` command.

  No API changed: update the package name in your imports and the exports are identical.

  **You must migrate to keep receiving updates.** There is no re-export shim under the old names, so nothing further will be published as `ethereum-indexer*` and no version of an old name forwards to the new one. Already-published versions stay installable indefinitely, so existing pins keep resolving, but they are frozen.

  **The CLI command is renamed**: the CLI installs `etherfold` instead of `ei`, so `npm i -g etherfold` then `etherfold -p <processor>`. Update any script that shells out to `ei`.

  `named-logs` namespaces follow the package names, so any log filter matching `ethereum-indexer*` needs updating to `@etherfold/*`. The CLI is the exception: its namespaces follow the command, so `ei` and `ei:keepState` become `etherfold` and `etherfold:keepState`.

  `ethereum-indexer-server` and `ethereum-indexer-db-utils` are deliberately NOT renamed: both are on the retirement path set by ADR-0010, and they have since moved to `archive/` in the repository, outside the workspace. Their published versions stay installable and are not deprecated here.

- 47252ad: Add a shared `resolveProcessorAndSource` helper (plus the smaller `loadProcessorModule`, `instantiateProcessor` and `resolveSource` building blocks) that turns a processor module path + options into `{processor, processorModule, source}`. This extracts the near-identical processor/source setup that was previously copy-pasted between the CLI's `init()` and the server's `setupIndexing()` (LOW-4 in the server/CLI batch audit), removing the divergence risk between the two copies.

  Behaviour is the superset of the previous copies: module resolution keeps the server's `createRequire(...).resolve()` fallback for bare package specifiers (the CLI lacked it), and the processor-factory argument is now an explicit `processorConfig` parameter so the intentional CLI/server difference (CLI calls the factory with no args, the server passes its folder) is documented rather than accidental. The helpers are pure and unit-tested (module-resolution paths, the `contractsDataPerChain`/`contractsData` resolution, the provided-source path, and the no-factory / no-chainId / no-contracts error cases).

### Patch Changes

- bc118e4: Declare the packages the published types import, so installing them actually typechecks.

  A type-only import is erased from the emitted `.js` but survives in the emitted `.d.ts`. These packages name types from `abitype`, `eip-1193` and `@etherfold/core` in their public declarations while listing those as `devDependencies`, so a consumer installing them got declaration files importing packages that were never installed.

  Moved to `dependencies`: `abitype` and `eip-1193` in `@etherfold/core`, `eip-1193` in `@etherfold/browser`, and `@etherfold/core` in `@etherfold/utils`.

  Measured against a packed tarball installed under pnpm's isolated linker with `hoist=false`, `tsc --strict --skipLibCheck false` reported 11 errors (6 for `abitype`, 5 for `eip-1193`) before and none after.

  The bug was hard to see from inside the workspace, which is why it lasted. pnpm keeps a hoisted fallback directory holding every transitive package, so an undeclared import still resolves as long as anything else in the tree depends on it: `abitype` was masked that way by viem and failed only with hoisting off, while `eip-1193`, which nothing else depends on, failed everywhere. `skipLibCheck: true`, which most consumers set, suppresses the diagnostics entirely and silently degrades the affected types instead.

  A test now asserts, for every package in the workspace, that each bare specifier in its built `.d.ts` files is a declared dependency. It found the `@etherfold/utils` case, which a search for the two known package names had missed.

- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
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
- Updated dependencies [e0a6480]
- Updated dependencies [9738f1c]
- Updated dependencies [33afc5b]
- Updated dependencies [4097ccd]
- Updated dependencies [e0e5832]
- Updated dependencies [3a78285]
- Updated dependencies [0ac08c0]
- Updated dependencies [cefe0de]
  - @etherfold/core@0.7.0

## 0.6.13

### Patch Changes

- use source hash in generated file names for indexed state

## 0.6.12

### Patch Changes

- support folder export with lastSync + allow fetch lastSync first to get latest sync

## 0.6.11

### Patch Changes

- let specify genesisHash as source param, useful for local chain

## 0.6.10

### Patch Changes

- latest deps

## 0.6.9

### Patch Changes

- allow reading from file for deployments

## 0.6.8

### Patch Changes

- reorg + add streams server (wip)
