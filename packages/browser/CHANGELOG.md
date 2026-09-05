# ethereum-indexer-browser

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

### Minor Changes

- 351c585: A cached stream has a real IDENTITY: a digest of its FETCH FILTER plus its stream CONFIG, and that digest fills the address level `the-stream-appends-in-segments-on-indexeddb` left as a placeholder.

  `@etherfold/core` exports `streamDigestOf(source, streamConfig)`: 128 bits of `viem`'s `sha256`, SYNCHRONOUS, rendered as 32 fixed-length lowercase hex characters every substrate can carry as a key element. It is taken over the DEDUPLICATED `streamHash` values SORTED BY THEMSELVES, plus the resolved stream config, and over nothing else. `hash` and `legacyHash` are excluded: they cover the DECODING shape, which is what the stream is deliberately independent of. Sorting the values by themselves rather than rolling the digest up over the entry list is load-bearing — that list is sorted by `(startBlock, hash)`, so a decode-only change (a renamed non-indexed parameter) reorders it while every `streamHash` is unchanged, and a digest over that order would fork a new stream, re-fetch the whole history and orphan the old one, silently.

  `simple_hash`'s canonicalisation is extracted as `canonical_form` and shared rather than copied, so the wide digest and the 32-bit change detector cannot disagree about whether two values are the same; `simple_hash` itself is byte-for-byte unchanged.

  The config is in the digest because it decides what a stream CONTAINS (`alwaysFetchTimestamps`, `alwaysFetchTransactions`, `parse.filters`), and because `sourceInvalidationOf` already invalidates the stream half from block 0 whenever it moves. This is ADR-0006's `{source, config}` stream keying made concrete, narrowed on the source side to the FETCH half per ADR-0034 (ADR-0008's 2026-08-31 amendment records the narrowing).

  **`ExistingStream` gains an optional `setStreamConfig`**, which the indexer calls in `reinit` with the config it RESOLVED, before any other call and again on every reconfigure. A keeper is handed a `source` on every operation and never the config, so without it a keeper that addresses a stream would map two configs onto one subtree. A keeper that addresses nothing (a replayed fixture) omits it.

  **`keepStreamOnIndexedDB` now addresses `['stream', <indexer-name>, <streamDigest>, ...]` with the real digest**, and `placeholderStreamDigest` is deleted. `streamAddress(name, source, streamConfig)` takes the source and the config in place of the `chainId` it used to derive the placeholder from; `chainId` is still not a level of its own, because the digest covers it through the block-0 skeleton entry. The `<indexer-name>` level is untouched, so two names and two chains stay isolated exactly as before.

  **Nothing migrates and no payload is rewritten.** A stream written under the placeholder is simply a stream under a different digest: unreachable by a filter that now resolves elsewhere, so nothing needs to move. Disposing of those subtrees belongs to the unregistered-subtree sweep in the generation registry, which is the only place that can know which digests are registered.

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

- 1d619c9: A non-canonical generation REPORTS ITS PROGRESS, and a generation whose stream is unusable DEGRADES to a full re-index rather than breaking.

  **`SyncingState.nonCanonicalGenerations` (`@etherfold/browser`)** — every generation this indexer holds that is not answering reads, each with `{record, follows, lastToBlock, blocksBehind}`. It is the FACT and the DISTANCE and deliberately nothing else: only the developer knows whether their reconfigure made the old answers WRONG or merely INCOMPLETE, so the app decides whether to render, dim or hide and this library picks none of them. Do not add a `shouldRender`, a `stale` flag or a percentage here — a percentage needs a span to divide by, and which span is a presentation decision the two reported cursors already support.
  - `lastToBlock` is `undefined` before a generation has loaded, which is a different claim from being level at block 0.
  - `blocksBehind` is floored at zero, so a generation AHEAD of the canonical one (which `manual` allows) reads as "not behind" rather than as a negative number.
  - A generation LEAVES the list the moment the canonical pointer names it, and the generation the pointer moved OFF enters it — it is retained, which is what makes moving the pointer BACK a revert, and "a generation you could revert to exists" is the same fact reported the same way.

  **`HeldGeneration.lastSync` (`@etherfold/core`)** — how far ONE held generation's fold has got, or nothing before it has loaded. A getter, like `pauseState`, so a caller holding the object watches a distance close instead of reading the value it had when the object was built. The container already kept every generation's cursor (the promotion trigger is a comparison between two of them); this exposes it rather than recording it twice.

  **`degradingStream` (`@etherfold/core`), applied by every stream keeper** — the READ side of a keeper reports ABSENT instead of raising. `fetchFrom` and `clear` are called on the load path (and by the follower) with no `try`/`catch` anywhere above them, so a keeper that raised there did not degrade a cache: it made `load()` reject on this boot and every boot after it, for a LOCAL CACHE whose correct recovery is to throw the bytes away and index again. Absent is the answer a never-written stream already gives, so the load path clears and re-indexes from the start block — today's behaviour, which is what story 12 asks for. This extends the rule that already covered the damage a keeper can INSPECT (a gap in the ordinals, an unparseable segment, a cursor with no segments) to the damage it cannot: a substrate that is simply unavailable, such as IndexedDB refused in private browsing or a database at a version this build cannot open. It is applied inside `createSegmentedStream`, so every keeper over the segment port inherits it, and again around the browser keeper's own IndexedDB calls (the legacy-blob probe), which run before any port operation does.

  **`saveNewEvents` deliberately raises THROUGH, and that asymmetry must not be "fixed".** Its call site is the one that catches (`IndexerGeneration.promiseToSave`): it counts the failure, paces the retry, freezes the cache after too many — and until then it does not process the batch at all. A swallowed write failure would report success there, so the state would advance past events the stream never received, leaving a HOLE that no later check can see and no reload repairs. A failure is swallowed exactly where nobody is listening for it, and reported exactly where somebody acts on it.

- 37146b2: An indexer REGISTERS its generations, ONE canonical pointer names the one that answers reads, a cap REFUSES rather than evicting, and a stream subtree no generation claims is SWEPT on registry open.

  A **generation** is a stream plus a fold over it, identified by its stream digest plus the processor's version hash. `@etherfold/core` exports `openGenerationRegistry(port, caps)`: the rules over a five-operation port, exactly as `createSegmentedStream` is, so a second substrate supplies the operations and inherits all of them. It is BOOKKEEPING and nothing else — it never fetches, never folds, never opens a state store, and every one of its operations is exercisable with no indexer running.

  **Creating a generation TAKES ITS STARTING STREAM AS AN INPUT.** It names the stream it folds rather than deriving one it would then have to fetch, which is what makes a processor-only change a new generation over the existing stream that re-fetches nothing, and what leaves `a-generation-can-be-seeded-from-a-published-artifact` a seam to hand a stream some published artifact wrote. Creating an identity that is already registered RESOLVES it, so a boot that names its own generation on every start neither accumulates duplicates nor is refused by a cap it does not push against.

  **Moving the pointer is promotion; moving it BACK is revert**, and the revert is exact because the generation it names was never touched — nothing is re-indexed and nothing is fetched. `moveCanonicalTo` is one small record write carrying the identity alone. WHEN the pointer moves automatically is the promotion policy and is deliberately not here; what is here is the mechanism. The FIRST generation created becomes canonical, because a registry that holds generations and points at none of them answers nothing.

  **Two caps, and they REFUSE.** `maxGenerations` is a TOTAL per indexer and never per stream (per-stream would let total storage grow with the stream count); `maxStreams` bounds distinct filters. Reaching either throws `GenerationCapReachedError`, which NAMES every generation and every stream that could be deleted and evicts nothing: an old generation is what the pointer moves back to, and no policy can know which one an operator was keeping. They are CONFIGURED numbers and are never derived from `navigator.storage.estimate()` — WebKit does not implement it, `quota` varies four-fold between engines, and with a real quota forced to 8 MB it still reported 6.45 GB of headroom while writes were failing (`work/notes/findings/browser-storage-headroom-for-generations.md`). `@etherfold/browser` exports `BROWSER_GENERATION_CAPS` (two and two: the previous generation and the new one, transiently); a server or CLI should be far more generous and sets its own.

  **Deleting a generation drops its state store and REAPS its stream when the last generation on it goes**; `deleteStream` takes every generation on a stream and its keyspace in one call. The record goes before the bytes, so a crash leaks rather than leaves the registry claiming a generation whose state has gone. The CANONICAL generation cannot be deleted while it is canonical (`GenerationIsCanonicalError`) — move the pointer first, which is one write — and a generation or stream the registry does not hold is refused (`UnknownGenerationError` / `UnknownStreamError`) rather than reported as a silent success.

  **The UNREGISTERED-SUBTREE SWEEP** runs on `openGenerationRegistryOnIndexedDB`, as a scoped listing of the `['stream', <indexer-name>]` level that drops every digest subtree no registered generation claims. It exists because ordinary reaping cannot reach an orphan: reaping fires when a stream's last GENERATION goes, and a subtree written before generations existed — under the `chain-<chainId>` placeholder the segmented-stream work left behind — has none, so nothing enumerated it, nothing deleted it, and it did not even count against a cap. It is keyed on "the registry does not know this digest" and on no particular value, so it collects an orphan from any cause, including a later redefinition of the digest rule and a crash between a generation's record going and its stream being dropped. It runs on OPEN, the one moment the known set is authoritative and nothing is mid-write, and there is deliberately no second entry point to put on a timer.

  `@etherfold/browser` also gains `generationAddress(name)` (`['generation', <name>, 'entry', <streamDigest>, <processor>]` plus the pointer at `['generation', <name>, 'canonical']`, hierarchical for the reason the stream address is), `streamSubtree(name, digest)` and `streamsUnder(name)`. `streamAddress` is unchanged for its callers and is now `streamSubtree` plus the legacy key. `KEYVAL_DATABASE`, `KEYVAL_OBJECT_STORE` and the memoised store move to `src/storage/keyval.ts` and are exported unchanged, because the registry writes into the very store the streams live in — deliberately, since the sweep has to SEE those subtrees.

  Where a generation's state store LIVES is not decided here: `dropState` is injected, because the container above `StateStore` that owns that is a later task and a registry must not fork a naming convention the rest of the system does not share.

- b0e9a0d: A reconfigure now REPORTS whether it discarded the state, and the browser hook stops publishing state the core has thrown away.

  `updateProcessor`, `updateIndexer` and `reset` decide between two very different outcomes -- the computed state survives, or it is gone and being rebuilt -- and used to tell nobody. They now return `ReconfigureOutcome` (`{stateDiscarded: boolean}`). The widening is additive: a caller that ignored the resolved value still compiles and still behaves identically.

  That silence was a live defect for any caller holding a COPY of the state, which is every UI. `onStateUpdated` fires when a state is ADOPTED or PRODUCED, and a discard is neither, so `createIndexerState(...).state` went on publishing the discarded state until the next event happened to arrive and overwrite it. On the free-form path that is the old state VALUE: stale numbers, rendered by every subscriber, looking exactly like a working app.

  The wait was unbounded, and the case that makes it unbounded is the ordinary local-development one. These apps redeploy behind a proxy, so the address does not move and the regenerated ABI is what changes; the indexer correctly discards, correctly re-indexes, and correctly finds NOTHING, because a freshly redeployed implementation has not emitted anything yet. With no event to overwrite it, the tab showed state computed from the contract that is no longer deployed for the rest of the session. The same held for an edited processor swapped in under a bumped version, and for an explicit `reset()`.

  The hook now re-seeds `$state` at the moment of the discard, and only then: a reconfigure that KEPT the state must not blank it, or saving a file that changed nothing would empty the UI. Both directions are pinned in `packages/browser/test/reconfigure.test.ts` and driven in Chromium, Firefox and WebKit in `packages/browser/browser/indexing.spec.ts`.

  Note what did NOT change, because it is the trap an integrator meets first: a version hash is AUTHOR-DECLARED (`version`, the entity declarations, the config, and nothing derived from handler code). An edited handler under an unchanged `version` is not a change the core can see, so `updateProcessor` skips the swap and the edit never runs. Bump `version`, or pass `{force: true}`.

- d10b64e: The GENERATION CONTAINER lands BESIDE the single-generation shape: `Indexer` holds the generations, `IndexerGeneration` is one of them, and `EthereumIndexer` still names the generation it always named.

  This is the EXPAND batch of an expand → migrate → contract rename (`TASKING-PROTOCOL` §3a): the class name is read at dozens of sites across four packages, so nothing is removed here and every existing caller compiles untouched.

  **`EthereumIndexer` is renamed to `IndexerGeneration`, and the old identifier stays as an ALIAS to it.** One source plus one processor plus one state is a GENERATION under this model, not the container, which `CONTEXT.md` has said since ADR-0036. The alias points at the GENERATION and deliberately never at the container: `new EthereumIndexer(provider, processor, source, config)` is handed one already-constructed processor over one already-constructed store, which is exactly what a container holding N generations cannot be handed, so re-pointing that identifier would silently re-mean every existing site. It carries no `@deprecated` marker either — nothing is published, so it is scaffolding for one refactor rather than a compatibility promise, and `the-old-indexer-shape-is-deleted` removes it.

  **New: `Indexer` (`openIndexer`), the container.** It holds any number of generations, registers them in a `GenerationRegistry`, and points at the one that answers reads. It adds three things and no fourth:
  - **Generations are BUILT from factories.** A generation arrives as a `GenerationSpec`: `createState` then `createProcessor` over that state, called once each. The order is what the identity forces — the stream half is known from the source and the stream config, and the FOLD half is the processor's own `getVersionHash()`, so the state cannot be keyed on the finished name (a design that tried would deadlock on the first reload: find the record to learn the store to build the processor to compute the record's key). The factories are supplied PER GENERATION, so the caller's own closure is what distinguishes this generation's state from the next one's, and nothing has to be declared twice.
  - **Reads resolve through the canonical pointer, INDIRECTLY.** `Indexer.state` is a handle with stable identity that answers from whichever generation is canonical NOW, so a consumer holding one across a promotion can never read a retired generation (story 6). The entity path hands out a read HANDLE rather than a state object, which is exactly the reference that would otherwise stay bound to a store nobody is writing to any more.
  - **A pointer move is APPLIED AT A NOTIFICATION.** The registry records the decision when `promote` is called; the READ PATH follows it inside the state notification and nowhere else. So every read between two notifications answers from ONE generation, with no scope API, no transaction handle and no timer: the boundary already existed, because an app already treats a notification as "the world moved, re-read". The stated residual is that a caller reading outside any subscription gets per-call resolution, so two such reads either side of a promotion can straddle it — each is answered by a generation that was canonical when it was made.

  **New: `createMemoryGenerationRegistryPort` / `openMemoryGenerationRegistry`**, the reference substrate for the registry, for the same reason `MemoryStateStore` is one at the storage seam. It reports no stream subtrees, because it stores none.

  **`createIndexerState` (`@etherfold/browser`) now accepts BOTH call shapes.** The old one — a built processor over a built store — is unchanged. The new one takes a `BrowserGenerationSpec` (`{createState, createProcessor, registry?}`) and builds the container, publishing the INDIRECT handle into the `state` store. Its registry defaults to a memory one under `BROWSER_GENERATION_CAPS`, because this hook knows no indexer NAME and a durable registry is addressed under one; an app that keeps a superseded generation to move the pointer back to it passes `openGenerationRegistryOnIndexedDB(name, {dropState})`.

  Nothing is removed and no behaviour changes: `updateIndexer` and `updateProcessor` still reconfigure the canonical generation IN PLACE, discard and all. Turning a reconfigure into a new generation beside the live one is `the-promotion-policy-moves-the-canonical-pointer`; a non-canonical generation that ADVANCES is `a-non-canonical-generation-advances-on-a-shared-stream`; and the `stateDiscarded` discard goes in the contract batch.

- 9e2c66d: The invalidation verdict is PUBLISHED instead of computed and thrown away.

  `updateIndexer` has always asked `sourceInvalidationOf` whether the stored data still describes the source being run now, and has always dropped the answer: the two halves and the block each of them names reached a log line and nothing else. What the caller got was `stateDiscarded`, that verdict collapsed into one bit -- and one bit cannot say WHICH half died or FROM WHICH block.

  `ReconfigureOutcome` now carries `sourceInvalidation`, and `SourceInvalidation` / `InvalidationVerdict` / `InvalidationReason` are exported from `@etherfold/core`, so a consumer across the package boundary can read the verdict and act on it:

  ```ts
  const outcome = await indexer.updateIndexer({source});
  outcome.sourceInvalidation;
  // {state: {valid: false, invalidFromBlock: 780, reason: 'entry-added'}, stream: {valid: true}}
  ```

  Two halves because the fetch and the fold do not depend on the same thing (ADR-0034): an invalid STREAM half means the filter moved and the logs have to come from the node again, while a stream that stands under an invalid STATE half is a new fold over logs already on disk. Each half names the block it stopped being valid from, which is the point a rebuild can start at rather than block 0.

  It is `undefined` on `updateProcessor` and on `reset`, which ask no source question. A processor swap moves neither the fetch filter nor the decoding shape; `reset` is a discard by fiat that also CLEARS the cached stream, so reporting "both halves valid" there would be true of the source and read as "the stream stands" about a stream it has just deleted.

  THE VERBS STILL DISCARD EXACTLY AS THEY DID. This is additive on purpose: the verdict is published now, and the consumer that acts on it instead of discarding is the generation container, which lands separately. Nothing about what a reconfigure DOES changed, and the existing `stateDiscarded` branch in `@etherfold/browser` is untouched.

  Note what the verdict is NOT: a digest comparison. `streamDigestOf` MOVES when an event is appended above the cursor, because that append adds a `streamHash` to the filter set -- and that append is FREE (ADR-0034). The verdict decides WHETHER a reconfigure invalidates anything; the stream digest decides WHICH stream a result belongs to. `packages/browser/test/eventRanges.test.ts` pins exactly that: the digest moves, the verdict says both halves valid, and not one block below the cursor is re-fetched.

- 35fc4c2: The PROMOTION POLICY: when the canonical pointer moves on its own, and what happens to the generation left behind.

  The registry already owned the pointer as a MECHANISM (move it, read it, move it back). What was decided in prose and owned by nothing is WHEN it moves, and that is here now: `IndexerOptions.promotion` (`@etherfold/core`) and the `promotion` option on `createIndexerState` (`@etherfold/browser`), resolved by `resolvePromotionConfig` and reported back as `Indexer.promotion`.

  **Three values, and `on-catch-up` is the DEFAULT IN EVERY RUNTIME.** There is deliberately no per-runtime and no per-environment default, because the axis that would select one is not detectable: choosing between these wants a DEVELOPMENT-versus-PRODUCTION distinction, and nothing in a browser build can tell which it is in. So the safe value is the default everywhere and the dangerous one is a deliberate opt-in. Do not add an `import.meta.env.DEV` sniff to any runtime to "improve" this.
  - **`on-catch-up`** (the default) — the pointer moves when the successor reaches the cursor the canonical generation has. The app goes on rendering complete answers from the generation that is canonical and switches when the new fold is ready, so a user who did not ask for the reconfigure never sees the state go backwards.
  - **`immediate`** — canonical the moment it is created, before it has caught up. For a developer iterating on a fold, where stale-but-complete answers from the processor they just replaced are more confusing than incomplete answers from the new one.
  - **`manual`** — it moves only when asked.

  **`Indexer.promote` is never gated by the policy, under any value.** The policy governs the move the container makes ON ITS OWN; an explicit promotion is somebody's decision, and moving the pointer BACK is how a promotion is reverted.

  **New: `Indexer.onPromoted`**, fired for every move, BEFORE the state notification that applies it on the read path — so a consumer can drop what it derived from the retired generation (a cursor, a progress figure, a `checkTxInclusion` window) before it is told to re-read. The container also re-publishes the newly canonical generation's own cursor through `onLastSyncUpdated` when it has one.

  **New: `createIndexerState(...).addGeneration(...)`, `.promote(id)`, `.generations` and `.canonical` (`@etherfold/browser`).** `addGeneration` is a reconfigure that is not an outage: it builds a generation BESIDE the live one, which goes on answering every read until the policy moves the pointer. A generation on the same stream — a processor change, the common case — fetches not one log. This is distinct from `updateProcessor`, which still reconfigures the canonical generation IN PLACE and still costs the discard and rebuild it always did.

  **`checkTxInclusion` in the browser stops answering from the retired generation at a promotion.** Its verdicts come from the cursor the hook holds, and under `immediate` the generation that now answers has no cursor at all — so the answer is `unknown` / `not-synced` rather than a confident `included` from a window nothing is maintaining. Note the verdict shape this exposes, which is easy to assert wrongly: a caller WITH a `minedAtBlock` above the cursor is answered `absent` with basis `ahead-of-cursor`, because that branch is tested before the window-not-covering one. Switch on the BASIS, never on the status alone.

  **Drop-on-promotion (`promotion.dropOnPromotion`, default `false`) applies only under `on-catch-up` and `manual`.** Under `immediate` the previous generation is RETAINED until the successor reaches the cursor it had at the promotion, and only then dropped — an `immediate` promotion demonstrates nothing, so dropping there would discard a complete state for an empty one with no fallback. Two rules are recorded in ADR-0046 because they are surprising from the code alone: a generation becomes a candidate for automatic promotion when it is ADDED beside a live one (not merely by being level with the canonical one, which would undo a revert on the next cycle), and drop-on-promotion never drops a generation that WRITES a stream another held generation follows.

- 8c8341a: The cached event stream appends in SEGMENTS, so a save costs its batch and not the history.

  `keepStreamOnIndexedDB` used to read the whole stream, concatenate and write all of it back on every `saveNewEvents` — a full structured clone of the accumulated history per index cycle, which made a backfill QUADRATIC and charged an empty batch the same price purely to move the cursor. It now writes one immutable SEGMENT per batch, at the next ordinal, together with a CURSOR RECORD, in one `readwrite` transaction; nothing already written is ever touched again, and an empty save writes only the small cursor record.

  The rules live once, in `@etherfold/core`'s new `createSegmentedStream`, over a five-operation `StreamSegmentPort` a keeper supplies (`commitSegmentWithCursor` / `readCursor` / `writeCursorOnly`, plus a scoped segment read and a scoped delete). A SQL keeper and an OPFS keeper are the expected next consumers, and they inherit every rule: the ordinal allocated from the cursor record INSIDE the commit, the full ordered scan on the way back, the one comparison that refuses a write which would leave a hole, and the one rule for damage.

  **A stream is now addressed HIERARCHICALLY**, as IndexedDB array keys in `idb-keyval`'s default store: `['stream', <indexer-name>, <digest>, <ordinal>]` for a segment and `['stream', <indexer-name>, <digest>, 'cursor']` for the cursor record. The digest level carries a PLACEHOLDER derived from `chainId` until the real stream digest lands, so two chains under one indexer name stay isolated exactly as `stream_<name>_<chainId>` kept them. Segments are read with a key RANGE, never a whole-store scan.

  **A stream stored in the previous whole-blob format is DELETED and re-indexed, not adopted**, and the deletion is logged. Nothing is published and no disk anywhere holds state this had to preserve, so the cheap branch is the right one.

  **An inconsistent stream is CLEARED rather than repaired** — a gap in the ordinals, segments with no cursor, an unparseable segment, or a stream that does not reach back to the block a rebuild asks for. Nothing raises: the indexer takes its existing clear branch and re-fetches. A cursor with NO segments is not damage and is kept, because that is the ordinary state of a deployment whose contracts have not emitted anything yet.

  **The stream keeper stores no `unconfirmedBlocks`**, in a segment or in the cursor record, and `fetchFrom` returns a `LastSync` whose window is `[]`. The window's two homes that are actually READ (the state keeper's saved cursor, and the entity path's serialized sync cursor) are unchanged.

### Patch Changes

- 839e781: An ABI event can declare the BLOCK RANGES it is live over, so an upgrade APPENDS an entry instead of re-fetching every block ever indexed.

  An event entry may now carry `firstBlock` and an optional `lastBlock`, both INCLUSIVE. Write `as const satisfies RangedAbi` (exported from `@etherfold/core`) instead of `satisfies Abi` on an ABI that declares them; an ABI that declares none needs no change at all.

  ```ts
  const abi = [
  	{...transferV1, firstBlock: 100, lastBlock: 900}, // the pre-upgrade signature
  	{...transferV2, firstBlock: 900}, // the post-upgrade one
  ] as const satisfies RangedAbi;
  ```

  **The same number on both sides is the CORRECT declaration for an upgrade at block 900**, because a transaction earlier in that block still fires the old event while the upgrade transaction later in it starts the new one. That one-block overlap is preserved, not normalised away. An exclusive end would make the correct declaration read `901`, and the obvious thing to type would silently drop every pre-upgrade log in block 900.

  **What the ranges are for is INVALIDATION**, and the win is not that state survives — it is that nothing is re-fetched. `ContextIdentifier.source` now carries one entry per event per live range, ordered so an append lands at the END of the list, which `indexerMatches` reads as "the stored context simply did not have this yet". So, with the cursor at 500:
  - append an event live from 900: the state AND the cached event stream are both kept, and the next fetch resumes rather than going back to the start block;
  - append one live from 400, or edit an entry already below the cursor: discard and re-index, because those blocks were indexed without that event in the filter;
  - remove an entry from below the cursor: discard, because state derived from an event we no longer index is stale.

  **Entries are computed on the NORMALISED ranges**, which is what makes a naive generator cheap. Whatever produces a source usually cannot tell an upgrade from a cancellation: it appends on a proxy upgrade and appends again on a rollback, so a source legitimately reads `[A@a, B@b, A@c]`. If any occurrence of an event is open-ended it is live from the MINIMUM `firstBlock` onward and the rest are absorbed; otherwise the ranges are unioned. The redundant append therefore produces a byte-identical list and costs nothing.

  A **GAP** between two ranges of one event is refused at construction, naming the event and the uncovered span, since a hole is a span nobody requests. Overlap is not a gap and is never refused.

  Two things that did NOT change. **Decoding has no block axis**: a log is decoded by its `topic0` exactly as before, a true `topic0` collision is still refused on every path (ADR-0031), and the boundary was never what told two versions apart. And **a source declaring no range behaves exactly as it did**, down to the persisted context bytes — one whole-source entry at block 0 — so every stored `ContextIdentifier` stays readable and no deployment changes behaviour merely by upgrading.

  `ContractData.history` is REMOVED. It was a declared-but-never-implemented placeholder (`{abi, startBlock}[]`, marked `// TODO handle history (in reverse order)` at both `reinit` call sites) for exactly this feature, and it read the block off a field named `startBlock`. Nothing consumed it, so declaring one has never done anything; block ranges on the event entries are what it was waiting to become.

  Two smaller consequences. `updateIndexer` now judges an appended entry against the CURSOR rather than against block 0, which it was doing before and which answered "absorb it" for every entry; and a state that survives a source change now adopts the new entries into its persisted context, so an absorbed append is not re-judged (and re-indexed) on the next page load once the cursor has moved past it.

  `@etherfold/browser` gains the behaviour through the core it drives: `createIndexerState(...).updateIndexer` now reports `{stateDiscarded: false}` for an append above the cursor and resumes instead of going back to the start block. Its shared test workload carries the ranged sources this is asserted against.

  What this does NOT do yet is narrow what the fetcher REQUESTS: every range still carries every topic, which is wasteful and correct. `firstBlock`/`lastBlock` are deliberately NOT `startBlock` and never reach `defaultFromBlockOf`, which minimises across contracts and would otherwise be dragged down by a range. See `docs/adr/0033`.

- da289e2: A published snapshot a client cannot read is REFUSED, never installed as state — closing the last corner `tagged-bigint-codec-across-storage-adapters` left open knowingly (ADR-0040).

  The blob snapshot's format number now lives in `@etherfold/core` as `BLOB_SNAPSHOT_FORMAT`, beside the codec it versions, so the WRITER (`@etherfold/cli`'s keeper) and every READER import one number. It used to be the CLI's own `SNAPSHOT_FORMAT`, which the browser could not see (`@etherfold/browser` must not depend on the CLI and still bundles for a tab), so the CLI refused a format-1 file locally while `keepStateOnIndexedDB` installed the same bytes — whose every `uint256`, with no fallback reviver left, arrived as the string `"123n"` instead of a BigInt. `isReadableBlobSnapshot` and the `BlobSnapshotEnvelope` type are exported alongside it; the CLI no longer exports a format constant of its own.

  `keepStateOnIndexedDB` now checks the number on every remote fetch: an unreadable snapshot is refused whole (never translated, never half-read) and the refusal is logged with the location and both numbers. An unreadable mirror is treated exactly as an unreachable one already was — skipped when it loses selection, failed over from when it wins — and local state that is already ahead still wins over any remote, readable or not. A prefix-form mirror's bare `lastSync` file carries no format and is read as SELECTION data only: nothing from it is installed, and the state file it selects for carries the check.

  The ENTITY snapshot envelope's constant is renamed `ENTITY_SNAPSHOT_FORMAT` (`@etherfold/state-store`; re-exported by `@etherfold/processor-entities`) so the two envelopes — which version different file shapes and revise independently — are distinguishable by NAME at a call site that can hold both. They are not merged.

  Nothing is published under `@etherfold/*` yet, so no format-1 snapshot exists in the wild: this is a guard added before the first release rather than a breaking correction to one already shipped.

- 1a6f68b: Every published package now carries a `description` and its own `README.md`.

  Metadata and docs only: no runtime code changed. Four manifests had no `description` at all (`@etherfold/core`, `@etherfold/browser`, `etherfold`, `@etherfold/utils`), which is the line npm shows in search results and on the package page, and seven packages had no README (the four above plus `@etherfold/server`, `@etherfold/platform-nodejs` and the private Worker host). Each README says what the package is, when to reach for it INSTEAD of its neighbours, a minimal snippet taken from code that runs, and links to the related packages.

  Two summaries are worth calling out because a guessed one would have been wrong. **`etherfold index` is a ONE-SHOT**: it folds to the tip it observed and exits, does not follow the chain and cannot be reconfigured while running, so keeping a database current is running it again; live reconfigure is `@etherfold/browser`'s ability. And **`@etherfold/utils` is not a bag of hashing helpers** any more: what is in it is the Node-side loader that turns a processor PATH into the authoring object plus its indexing source, since `contextFilenames` and the `@etherfold/utils/indexer` subpath went with the blob snapshot (ADR-0037).

  One existing description is CORRECTED rather than added: `@etherfold/state-store-sqlite` called itself a "state store for `@etherfold/core`", which names the wrong seam. It depends on `@etherfold/state-store`, `remote-sql` and `named-logs` and on nothing else, and a test in that package asserts as much, because a storage backend depending on the indexer would invert ADR-0016.

  **`etherfold` no longer publishes the repo's root README.** Its `prepack` copied `../../README.md` into the package, so the npm page for the CLI described the monorepo and documented none of its flags; the package now has a README of its own, committed rather than generated, and `prepack` copies only the LICENSE.

- d50583b: `GenerationContext` is now exported from `@etherfold/browser`, and the documentation no longer claims per-generation state is structural when it is a convention.

  `GenerationSpec.createState` said the separate step made "each generation has its own state" structural rather than a convention a caller may forget. It does not and cannot: `State` is opaque to the container, so it cannot tell two stores apart, and two distinct store objects can address one underlying database anyway, which is invisible from there by construction and is the way this actually goes wrong.

  The documentation now states the rule the caller has to keep: key the state on `context.stream`. Two generations under one storage location are ONE store by that backend's own definition, and they collide on the sync cursor as well as on the rows, because the cursor lives under a fixed key. The successor model, where the canonical generation keeps answering complete old answers while the new fold catches up, does not survive that.

  `GenerationContext` is re-exported from `@etherfold/browser` because that package's own public `createState` signature names it, so a consumer could not write the factory with an explicit annotation.

- 9a41ba3: Invalidation is computed on what each thing actually depends on, instead of one hash over the whole source.

  An ABI is REGENERATED, not hand-edited, so the members that move in it most often are the ones nothing depends on. Until now a source that declared no event block range hashed WHOLESALE into a single context entry, so any difference anywhere in it discarded the state and the cached event stream and re-fetched all history.

  **What now costs nothing:**
  - **adding a view function, an error or a constructor.** A non-event ABI member is not indexed, does not enter the fetch filter and cannot change what a log decodes to, so it contributes to no entry at all;
  - **reordering the events** in the ABI array, which regeneration does routinely. The entry list is sorted into a canonical order rather than transcribed, so the persisted bytes are identical and not merely the verdict;
  - **recompiling into a different `internalType`.** An entry is hashed on what DECODING reads, which deliberately excludes it.

  The rest of the source is NOT free: `chainId`, `genesisHash`, a contract's `address` and a contract's `startBlock` still invalidate everything, exactly as before.

  **The verdict is now TWO verdicts**, because the fetch and the fold do not depend on the same thing:
  - the **stream** is raw logs fetched under a topic-and-address filter, so it survives anything that did not GROW that filter. A shrunken topic set leaves a strict SUPERSET, which is reusable by decoding less;
  - the **state** is a fold over decoded events, so it must be recomputed whenever the decoding shape moved, even if not one log needs re-fetching.

  A renamed non-indexed parameter is the case that proves it: `topic0` hashes types and not names, so the stream is KEPT and the state is DISCARDED, and the rebuild happens from the cache without going back to the node. Removing an event does the same. Both halves still name the block they are invalid from.

  **A cached stream is decoded again on replay.** Its `args` and `eventName` are what some earlier ABI made of the raw log, so keeping a stream across a source change keeps the raw half and recomputes the rest, against the source running now. Where a `logValues` projection dropped `topics` or `data` there is nothing to re-read, and the stream is cleared rather than replayed on trust.

  **Nothing to do on upgrade.** `ContextIdentifier` is persisted, and a context written by any earlier version is still read correctly: a per-range context matches byte for byte, and a whole-source context is compared against a bridge digest carried on the block-0 entry, so an unchanged source invalidates nothing. The first save afterwards rewrites the context in the new shape.

  `ContextIdentifier.source` and `WireContext.source` are now typed as `SourceHashEntry[]`, which is the shape they already had plus two optional digests. `wireContextOf` is unchanged.

- c2fdef5: Fix: a reconfigure that rebuilt its state from a CACHED STREAM no longer reports that state as empty.

  The re-seed added alongside `ReconfigureOutcome` assumed a discard always leaves nothing to publish. It does not. When a kept stream is still valid -- which a processor swap always leaves it, since `indexerMatches` compares the source and the config and not the processor -- `load` REPLAYS the cached events and publishes the rebuilt state before the reconfigure returns. The re-seed then ran and overwrote it with the processor's empty initial state.

  So the one case the stream cache exists for (re-index without re-fetching) reported a correct rebuild to every subscriber as an empty state, with the cursor already advanced past the blocks, so nothing arrived later to correct it.

  The hook now re-seeds only when the core published no state during the call. Both directions are pinned: a discard with nothing to replay still blanks, and a discard that replayed a cached stream keeps what the replay produced, without going back to the node for history it already had.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- 5adafa9: The indexer and its cached event stream agree on which of them is ahead, so the cache can be behind or ahead but never HOLED.

  A **hole** is a range of blocks the stream never RECEIVED, hidden behind a cursor that claims to cover them (`[100..5000]` then `[6001..7000]`, cursor at 7000). It was reachable in one ordinary session with no crash and no reload, and nothing detected it afterwards: segments are keyed by save rather than by block, so a save that never happened leaves no trace, and the next state discard replayed the stream as though it were whole.

  **The stream is now written BEFORE the processor is called, and a batch that was not written is not processed.** `promiseToIndex` processed and then saved; the processor persists its own state inside `process()`, so a failed save left the stream a batch behind, and the next cycle computed its delta from the already-advanced cursor and jumped over a range whose events the stream never got. A failed write now means the cycle achieves nothing and the next one tries again from the same cursor: nothing is lost, nothing is skipped. It also makes a second invariant free — **a retraction is never written into a stream that lacks the event it retracts**, because the unconfirmed window cannot advance past the stream.

  **A cache can no longer wedge the indexer, and the retry is bounded and paced.** After `streamWriteRetry.maxConsecutiveFailures` consecutive failed writes (default 3, one attempt every `streamWriteRetry.delaySeconds`, default 1) the cache is FROZEN, said loudly through `named-logs`, and indexing carries on without it. Frozen means frozen, not cleared: what is on disk is a contiguous prefix with a cursor that describes it honestly, so it still seeds a rebuild, and throwing it away would cost a re-fetch from the source's first block. The one cause that DOES clear is a store that is out of SPACE, since there the cache is itself the problem; keepers say so on the error they throw and `isOutOfSpace` reads it structurally (the flag, or the Web platform's own `QuotaExceededError`), exactly as `retryable` is read.

  **A stream that is AHEAD of the state is now REPLAYED rather than re-fetched.** The state-DISCARDED load branch always fed the cached stream; the state-KEPT branch only validated it and had no `else`, so a tab that closed between the two writes caught up from the NODE and appended those blocks to the stream a second time — and the next rebuild saw them twice. It now feeds them, re-decoded against the source running now (ADR-0034), which turns a node re-fetch into a local replay.

  **A stream holding a CURSOR and no events now resumes from that cursor.** The fetched cursor used to be adopted only as a side effect of feeding events, so a deployment whose contracts have emitted nothing left the in-memory cursor at `freshLastSync` and re-scanned from the start block on every reload, forever.

  Two mechanisms are DELETED rather than fixed. `streamNotYetSaved`, the in-memory carry-forward of unsaved events, never fired: it lived on the save action's promise CONTEXT, which is reset unless a save is queued onto one still in flight, and the index cycle awaits its save. It existed only to compensate for processing first, and it appended without de-duplicating. With it gone, `createAction`'s `setContext`/`getContext` had no callers and are gone too. What replaces it is the inverse: the extent of the last SUCCESSFUL write, held in memory, so a processor that throws deterministically cannot grow the cache by one duplicate copy per retry — and where the chain reorged under events the processor never accepted, they are RETRACTED into the stream, because the state cannot retract what it never applied.

  `@etherfold/browser` gains all of this through the core it drives; `ProvidedIndexerConfig.streamWriteRetry` reaches it through `createIndexerState(...).init`. See `docs/adr/0038` for why a frozen stream is never appended to again and why that decision cannot be the keeper's.

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
- Updated dependencies [8bb063e]
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
  - @etherfold/state-store@1.0.0
  - @etherfold/state-store-indexeddb@0.1.1

## 0.8.0

### Minor Changes

- 8ed9af3: Add a `dispose()` method to the object returned by `createIndexerState`. It stops the auto-index loop and clears any armed timer (previously the self-re-arming `setTimeout(_auto_index, ...)` would keep firing forever if the consumer dropped its references without calling `stopAutoIndexing()`), detaches the `onLoad`/`onLastSyncUpdated`/`onStateUpdated` callbacks (which closed over the stores), drops the underlying `EthereumIndexer` reference, and resets the syncing/status state. It is idempotent. After `dispose()`, `init(...)` may be called again to re-initialise — note this reuses the same stores and processor instance rather than performing a full fresh start.
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

- d45f11d: The browser backend, behind the same seam: `@etherfold/state-store-indexeddb`, and it is the browser DEFAULT.

  **A new package.** Versioned rows in IndexedDB, so a tab keeps history, reverts a reorg, starts cold by reading one row instead of all of them, and pays a write cost proportional to what CHANGED. The same processor that runs on a server against `@etherfold/state-store-sqlite` runs on it unchanged, and `@etherfold/browser` gains the one line where a browser deployment chooses:

  ```ts
  const store = await createBrowserStateStore(processor.entities); // IndexedDB, the default
  const light = await createBrowserStateStore(processor.entities, {
  	backend: (entities) => new PatchStateStore(entities, {retention: 'revert-only', finalityDepth: 64}),
  });
  ```

  Choosing the second one touches no processor code: a processor is entity declarations plus `on<EventName>` handlers over a `MutationContext`, and it names no backend.

  **The default is a CONDITION, not a preference, and it is written down as one** (`docs/adr/0024`). On the real workload (the launched stratagems game on Base: 31,332 events, 4,072 live rows) IndexedDB beat wasm SQLite on writes by 1.6x to 6.9x and on reads by 4x to 14x on every engine that can run both, WebKit cannot run the SQLite route at all, and three of four tabs FAIL AT OPEN on both SQLite VFSs. The ADR records the four things that would all have to be true for wasm SQLite to win, and the five that would overturn the choice, from `work/notes/findings/sqlite-in-the-browser.md`.

  **It is not a speed-up.** The incumbent whole-state blob (`keepStateOnIndexedDB`) is the FASTEST writer at today's sizes: 2.0 ms/block on Chromium against 45.6 for row-level writes, a 20x throughput loss at 4,072 live rows. What row-level writes buy is what the blob cannot do at any speed: an as-of read, a revert, a bounded cold start, and a per-write cost that stops tracking total state.
  - **It passes `@etherfold/state-store-conformance`** under all three retention claims, in node under `fake-indexeddb` on every commit and in **Chromium, Firefox and WebKit** via `pnpm --filter @etherfold/state-store-indexeddb test:browser` (the same suite, not a browser-flavoured copy). Evidence in `docs/spikes/indexeddb-row-backend-browser-default/results/`.
  - **The bounded id-prefix listing is one `IDBKeyRange.bound([entity, ...prefix], [entity, ...prefix, []])` cursor**, asserted rather than assumed: the tests record the range the store handed IndexedDB and how many records it walked, because a scan-and-filter returns the same rows.
  - **Retention is enforced on both halves**, so what it reports is what it does: an as-of read outside the window throws `BlockNotRetainedError` and never the tip value, and `prune` walks the `upper` index — where a LIVE version cannot appear at all, because `null` is not a valid IndexedDB key — so the row that IS the current state cannot be dropped however old it is. The window is measured against the tip read from the database, so it is right after a reload and right when another tab moved it.
  - **`revertTo` is two index range scans** (drop what the fork opened, reopen what it closed) rather than a per-block undo journal, and `getAsOf` is one backwards cursor over that key's versions.
  - **Four tabs against one database complete with zero row mismatches**, which is the case both wasm-SQLite VFSs fail at open.

- 4097ccd: Rename misspelled public types `StreamFecther` → `StreamFetcher` and `ExistingStateFecther` → `ExistingStateFetcher`.

  This is a breaking change for any code importing these types by name (no deprecated aliases are kept). Update your imports accordingly.

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

- cefe0de: Answer "does the indexed state already account for this transaction?", so an app can lay an optimistic update over indexed state without counting it twice.

  `checkTxInclusion(lastSync, queries, finality)` (`@etherfold/core`) returns one verdict per transaction hash: `included`, `absent` or `unknown`, with the basis it was concluded on. `createIndexerState(...).checkTxInclusion(queries)` (`@etherfold/browser`) is the same thing against the cursor the hook is holding and the finality depth the indexer actually runs with, which is also newly exposed as `EthereumIndexer.finalityDepth`.

  Nothing is stored for this and no processor declares anything for it: the answer comes out of `LastSync.unconfirmedBlocks`, which already holds the reorg-eligible window as whole blocks with their events, and every event carries its `transactionHash`. The set maintains itself under reorg, since a reorged-out block leaves the window and a re-included transaction re-enters it.

  The comparison is deliberately NOT against the caller's own receipt. A block height is a local opinion about a chain rather than an identity, and the receipt's block hash is the wrong identity: after a reorg the same transaction can be re-included in a different block, so comparing hashes reports "not indexed" for a transaction that is indexed, which is exactly the double-count. A window hit must also be behind `lastToBlock`, because `feed` publishes the whole new window before it walks the cursor through it.

  Two limits are documented on the function: only transactions that emitted events this indexer indexes can hit (the window is sparse), and `absent` means "not in the window", so a caller must not ask about a transaction older than it, which a transaction the app itself just submitted cannot be.

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

- 4e75014: **An entity store can start from state somebody else computed, and it stays honest about the history it never received** (ADR-0028).

  This is the entity path's half of a capability the free-form path has always had: `keepStateOnIndexedDB(name, remote)` takes one or more published locations, asks each how far it has got, uses the furthest, prefers LOCAL state when local is already ahead, and skips an unreachable mirror rather than dying. A client that bootstraps comes up near the tip instead of replaying every log the contract ever emitted.

  **`@etherfold/state-store`** gains the snapshot envelope and the store handle that keeps it honest:
  - `StateSnapshot` -- `{format, processor, savedAt, takenAt, cursor, rows}`, deliberately shaped like the CLI's file envelope so a reader of one recognises the other. `rows` are the LIVE rows at `takenAt`, and `SnapshotHead` is the same envelope without them, which is what a client fetches to choose between mirrors.
  - `openSnapshotAware(store)` -- the handle a deployment that may bootstrap uses on EVERY boot (it migrates the store itself). `.bootstrap(snapshot, {processor})` installs the rows and their cursor as one `applyBlock`, and records where the contents came from under a second cursor-port key (`SNAPSHOT_ORIGIN_KEY`), so a reload is as honest as the first run.
  - The honesty: a bootstrapped store reports its retention as a **window whose oldest block is the snapshot's**, never the `unbounded` a freshly migrated store would claim, and an as-of read below that block is refused with `BlockNotRetainedError` instead of answering `undefined` -- which would read as "the entity was absent then", an ordinary answer a caller acts on normally, and wrong. The floor is intersected with whatever the deployment configured, and a store that answers no historical read at all is left saying exactly that.
  - `RevertBeyondSnapshotError` -- a reorg reaching below the snapshot is refused loudly and changes nothing. There are no superseded versions under the snapshot to reopen at any price, and a partly undone reorg is a plausible state nothing downstream can tell apart from a correct one.
  - `SnapshotProcessorMismatchError` / `SnapshotFormatError` -- a snapshot computed by another processor version, or in an envelope this build does not read, is refused rather than loaded.

  **`@etherfold/processor-entities`** gains the client side:
  - `bootstrapFromSnapshot(store, locations, {processor, finalityDepth?, fetch?})` -- mirrors, most-advanced-wins, prefer-local, fail over on error. Two deliberate differences from the free-form keeper: failover walks EVERY remaining candidate in descending order (the keeper tries the winner and one more), and a snapshot from another processor version is not a candidate at all. Given a `finalityDepth`, a snapshot taken inside the reorg-eligible window of the tip its producer had observed is declined, so the revert that could not be undone is avoided as well as refused. It returns a `BootstrapOutcome` rather than throwing when nothing is usable: indexing from the start block is the correct answer to "no snapshot is available".
  - `openAndBootstrap(store, locations, options)` -- the boot path, which keeps the SAFE order the short one: open snapshot-aware first, then bootstrap only if the store has never synced.
  - `createSnapshot(...)` -- the MINIMAL producer, and it says so. Publishing snapshots as a first-class artifact (a publish command, format versioning, mirror layout, pruning old ones) is a design of its own.

  **`@etherfold/browser`** gains no API and one piece of documentation that matters: `createBrowserStateStore` now says how a browser deployment bootstraps, and that the store must be opened through `openSnapshotAware` on EVERY boot rather than only on the boot that installs a snapshot. The mechanism deliberately does not live here -- deciding whether local is already ahead means reading `lastToBlock` out of a stored cursor, and the cursor's codec belongs to the entity runtime (ADR-0027), which this package does not depend on so that it stays free of any one processor package.

  **`@etherfold/state-store-conformance`** gains a `bootstrapping from a snapshot` group, so every backend inherits the obligation rather than rediscovering the trap in somebody's browser tab: rows and cursor installing as one unit, the origin surviving a fresh handle over the same storage, the revert refusal, the wipe still working, and -- selected on what the backend claims -- the floor being refused below and answered at and above.

- a19abb9: Add an optional `createIndexer` factory to `createIndexerState` options. When provided it is used to construct the underlying `EthereumIndexer`, receiving the same arguments (request-tracked/logged provider, configured processor, source, config) that the default `new EthereumIndexer(...)` would. Useful for injecting a subclass, a shared instance, or a spy/fake (e.g. in tests). Defaults to the existing behaviour when omitted.
- a4d840a: `updateProcessor` now accepts an optional `{force?: boolean}` argument that is forwarded to the core `EthereumIndexer.updateProcessor`, allowing a processor swap (clear + reload) even when the new processor has the same version hash as the current one.
- 01b2a0c: Clear stale `$syncing.lastSync` after a successful `updateIndexer` / `updateProcessor`. Previously `setupIndexing()` would early-return on the leftover `lastSync` from the old configuration, so after a live reload (new contracts / event ABIs / processor) progress was computed against the old start block and setup did not re-run. State is only cleared on success — a failed reconfigure keeps the previous valid progress and surfaces `$syncing.error`. Status is left untouched and corrects itself on the next indexing operation.
- 30ca765: Pause auto-indexing during `updateIndexer` / `updateProcessor` and resume it afterwards. Previously the auto-index timer kept firing while the core was mid-reinit, so a tick could call `indexMore` against a blocked/half-reconfigured indexer (throwing `Blocked` → retry → re-arm, racing the reconfigure). Now the loop is stopped before the awaited core call and resumed (even if the reconfigure fails) once it settles. On success, stale syncing state is cleared before the loop resumes so it does not early-return on the old `lastSync`.
- 7b01126: Serialize reconfiguration so overlapping `updateIndexer` / `updateProcessor` calls no longer interleave. Source changes (new contracts / event ABIs) and processor changes (new handler logic) are independent events that can arrive close together and in either order (e.g. a slow deploy's source change racing a processor edit). Previously each call ran its own reset/reinit/load asynchronously, so two overlapping calls could interleave on the same indexer instance. They now run through an internal queue — each reconfigure runs only after the previous one has fully settled (success or failure), preserving arrival order — while remaining independently usable. The pause/resume of auto-indexing and the clear-on-success of stale syncing state happen inside the serialized section.
- 149fdc3: Fix `setupIndexing` reporting a `FAILED_TO_LOAD` error on every call. The error was set in a `finally` block, so it ran even when loading succeeded. Use a `catch` (re-throwing the error) so the error flag is only set on an actual failure.
- 9b062f4: Make the browser `updateIndexer` / `updateProcessor` `async` and await the underlying core call, returning a promise callers can await before re-indexing. Errors from the core reconfiguration are now routed into `$syncing.error` (`FAILED_TO_UPDATE_INDEXER` / `FAILED_TO_UPDATE_PROCESSOR`) and re-thrown, instead of surfacing as an unhandled promise rejection.
- bc118e4: Declare the packages the published types import, so installing them actually typechecks.

  A type-only import is erased from the emitted `.js` but survives in the emitted `.d.ts`. These packages name types from `abitype`, `eip-1193` and `@etherfold/core` in their public declarations while listing those as `devDependencies`, so a consumer installing them got declaration files importing packages that were never installed.

  Moved to `dependencies`: `abitype` and `eip-1193` in `@etherfold/core`, `eip-1193` in `@etherfold/browser`, and `@etherfold/core` in `@etherfold/utils`.

  Measured against a packed tarball installed under pnpm's isolated linker with `hoist=false`, `tsc --strict --skipLibCheck false` reported 11 errors (6 for `abitype`, 5 for `eip-1193`) before and none after.

  The bug was hard to see from inside the workspace, which is why it lasted. pnpm keeps a hoisted fallback directory holding every transitive package, so an undeclared import still resolves as long as anything else in the tree depends on it: `abitype` was masked that way by viem and failed only with hoisting off, while `eip-1193`, which nothing else depends on, failed everywhere. `skipLibCheck: true`, which most consumers set, suppresses the diagnostics entirely and silently degrades the affected types instead.

  A test now asserts, for every package in the workspace, that each bare specifier in its built `.d.ts` files is a declared dependency. It found the `@etherfold/utils` case, which a search for the two known package names had missed.

- Updated dependencies [ff393f7]
- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [4e75014]
- Updated dependencies [ce8f7d2]
- Updated dependencies [aeb7843]
- Updated dependencies [0957f8c]
- Updated dependencies [c681b79]
- Updated dependencies [9d21d67]
- Updated dependencies [ca6f981]
- Updated dependencies [b61de79]
- Updated dependencies [31833b6]
- Updated dependencies [2a4e6ed]
- Updated dependencies [047cd73]
- Updated dependencies [eba61c3]
- Updated dependencies [dece521]
- Updated dependencies [939364a]
- Updated dependencies [d24872f]
- Updated dependencies [78d8377]
- Updated dependencies [3de4c35]
- Updated dependencies [bc118e4]
- Updated dependencies [bc5d71a]
- Updated dependencies [d45f11d]
- Updated dependencies [e0a6480]
- Updated dependencies [9738f1c]
- Updated dependencies [879c4fe]
- Updated dependencies [33afc5b]
- Updated dependencies [01ab642]
- Updated dependencies [18c6876]
- Updated dependencies [4097ccd]
- Updated dependencies [e0e5832]
- Updated dependencies [ab45129]
- Updated dependencies [ebf9690]
- Updated dependencies [5854d60]
- Updated dependencies [3a78285]
- Updated dependencies [0ac08c0]
- Updated dependencies [cefe0de]
- Updated dependencies [47252ad]
  - @etherfold/state-store@0.1.0
  - @etherfold/core@0.7.0
  - @etherfold/utils@0.7.0
  - @etherfold/state-store-indexeddb@0.1.0

## 0.7.7

### Patch Changes

- prevent re-initialization

## 0.7.6

### Patch Changes

- use source hash in generated file names for indexed state
- Updated dependencies
  - ethereum-indexer-utils@0.6.13

## 0.7.5

### Patch Changes

- parseJson if lastSync via bnReviver too

## 0.7.4

### Patch Changes

- fix: bnReviver for all remote fetch

## 0.7.3

### Patch Changes

- bnRevivier for snapshots

## 0.7.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.21
  - ethereum-indexer-utils@0.6.12

## 0.7.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.20
  - ethereum-indexer-utils@0.6.12

## 0.7.0

### Minor Changes

- support url

## 0.6.30

### Patch Changes

- support folder export with lastSync + allow fetch lastSync first to get latest sync
- Updated dependencies
  - ethereum-indexer-utils@0.6.12

## 0.6.29

### Patch Changes

- new loading state + CatchingUp for browser-indexer
- Updated dependencies
  - ethereum-indexer@0.6.19

## 0.6.28

### Patch Changes

- allow to reset indexer
- Updated dependencies
  - ethereum-indexer@0.6.18

## 0.6.27

### Patch Changes

- revert freeze logs

## 0.6.26

### Patch Changes

- tmp: copy before store

## 0.6.25

### Patch Changes

- tmp: forgot to build

## 0.6.24

### Patch Changes

- tmp: more logs

## 0.6.23

### Patch Changes

- tmp more logs

## 0.6.22

### Patch Changes

- tmp : forzen in browser state handler

## 0.6.21

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.17

## 0.6.20

### Patch Changes

- show response/error when logRequests == true

## 0.6.19

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.16

## 0.6.18

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.15

## 0.6.17

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.14

## 0.6.16

### Patch Changes

- option to log all requests

## 0.6.15

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.13

## 0.6.14

### Patch Changes

- latest deps
- Updated dependencies
  - ethereum-indexer@0.6.12

## 0.6.13

### Patch Changes

- allow reading from file for deployments

## 0.6.12

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.11

## 0.6.11

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.10

## 0.6.10

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.9

## 0.6.9

### Patch Changes

- reorg + add streams server (wip)
- Updated dependencies
  - ethereum-indexer@0.6.8

## 0.6.8

### Patch Changes

- improve processor import to work in pnpm + startBlock fix
- Updated dependencies
  - ethereum-indexer@0.6.7

## 0.6.7

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.6

## 0.6.6

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.5

## 0.6.5

### Patch Changes

- fix state direct access

## 0.6.4

### Patch Changes

- c81fb4d: use state field name instead of data
- Updated dependencies [c81fb4d]
  - ethereum-indexer@0.6.4

## 0.6.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.2

## 0.6.1

### Patch Changes

- cleanup exports
- Updated dependencies
  - ethereum-indexer@0.6.1

## 0.6.0

### Minor Changes

- release

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.6.0

## 0.5.6

### Patch Changes

- fixes
- Updated dependencies
  - ethereum-indexer@0.5.6

## 0.5.5

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.1

## 0.5.0

### Minor Changes

- use viem + aitype for type-safe experience

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.5.0

## 0.4.3

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.4.3

## 0.4.2

### Patch Changes

- reorg
- Updated dependencies
  - ethereum-indexer@0.4.2

## 0.4.1

### Patch Changes

- allow access to state from processors that declare it
- Updated dependencies
  - ethereum-indexer@0.4.1

## 0.4.0

### Minor Changes

- chainId specified

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.4.0

## 0.3.12

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.11

## 0.3.11

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.10

## 0.3.10

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.9

## 0.3.9

### Patch Changes

- typings
- Updated dependencies
  - ethereum-indexer@0.3.8

## 0.3.8

### Patch Changes

- types
- Updated dependencies
  - ethereum-indexer@0.3.7

## 0.3.7

### Patch Changes

- browser indexer can be initialised any time

## 0.3.6

### Patch Changes

- Updated dependencies
  - ethereum-indexer@0.3.6

## 0.3.5

### Patch Changes

- use eip-1193 types
- Updated dependencies
  - ethereum-indexer@0.3.5

## 0.3.4

### Patch Changes

- force new version
- Updated dependencies
  - ethereum-indexer@0.3.4

## 0.3.3

### Patch Changes

- republish with new types
- Updated dependencies
  - ethereum-indexer@0.3.3
