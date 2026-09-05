# ethereum-indexer-utils

## 1.0.0

### Major Changes

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

### Minor Changes

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

### Patch Changes

- 1a6f68b: Every published package now carries a `description` and its own `README.md`.

  Metadata and docs only: no runtime code changed. Four manifests had no `description` at all (`@etherfold/core`, `@etherfold/browser`, `etherfold`, `@etherfold/utils`), which is the line npm shows in search results and on the package page, and seven packages had no README (the four above plus `@etherfold/server`, `@etherfold/platform-nodejs` and the private Worker host). Each README says what the package is, when to reach for it INSTEAD of its neighbours, a minimal snippet taken from code that runs, and links to the related packages.

  Two summaries are worth calling out because a guessed one would have been wrong. **`etherfold index` is a ONE-SHOT**: it folds to the tip it observed and exits, does not follow the chain and cannot be reconfigured while running, so keeping a database current is running it again; live reconfigure is `@etherfold/browser`'s ability. And **`@etherfold/utils` is not a bag of hashing helpers** any more: what is in it is the Node-side loader that turns a processor PATH into the authoring object plus its indexing source, since `contextFilenames` and the `@etherfold/utils/indexer` subpath went with the blob snapshot (ADR-0037).

  One existing description is CORRECTED rather than added: `@etherfold/state-store-sqlite` called itself a "state store for `@etherfold/core`", which names the wrong seam. It depends on `@etherfold/state-store`, `remote-sql` and `named-logs` and on nothing else, and a test in that package asserts as much, because a storage backend depending on the indexer would invert ADR-0016.

  **`etherfold` no longer publishes the repo's root README.** Its `prepack` copied `../../README.md` into the package, so the npm page for the CLI described the monorepo and documented none of its flags; the package now has a README of its own, committed rather than generated, and `prepack` copies only the LICENSE.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- Updated dependencies [0ba3c60]
- Updated dependencies [a1fccd0]
- Updated dependencies [5427806]
- Updated dependencies [c6b5215]
- Updated dependencies [0f33468]
- Updated dependencies [a64a843]
- Updated dependencies [5729da5]
- Updated dependencies [2e10f5e]
- Updated dependencies [ce43a7b]
- Updated dependencies [1524a04]
- Updated dependencies [a4d106e]
- Updated dependencies [351c585]
- Updated dependencies [839e781]
- Updated dependencies [4e5067e]
- Updated dependencies [dc08d24]
- Updated dependencies [29895dc]
- Updated dependencies [e7d06c9]
- Updated dependencies [da289e2]
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
- Updated dependencies [0bf9dc7]
- Updated dependencies [b0e9a0d]
- Updated dependencies [bb86a77]
- Updated dependencies [5adafa9]
- Updated dependencies [c0d694f]
- Updated dependencies [d10b64e]
- Updated dependencies [01ed0ef]
- Updated dependencies [9e2c66d]
- Updated dependencies [b824312]
- Updated dependencies [35fc4c2]
- Updated dependencies [4f206c3]
- Updated dependencies [8c8341a]
  - @etherfold/core@1.0.0

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
