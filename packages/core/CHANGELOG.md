# ethereum-indexer

## 1.0.0

### Major Changes

- 74b2889: **BREAKING: the `parse.logValues` knob is DELETED.** No configuration can strip the raw log out of what is stored or sent any more, and the guarantee is STRUCTURAL rather than stated.

  It was never a decoding option: its type was an allowlist over the RAW log's own fields (`address`, `topics`, `data`, `blockNumber`…), and `LogEventFetcher.parse` applied it by keeping `args` UNCONDITIONALLY while dropping every raw field not named — preserving the DERIVATION and discarding the SOURCE. That is backwards for a stream that stores what the node said: an event whose raw half was projected away has nothing left to decode from, which is exactly what makes a cached stream unreadable on replay (ADR-0034). It was also an unfinished stub with zero callers and a live footgun, since the loop iterated the object's KEYS and never read the boolean, so `{topics: false}` KEPT `topics`.

  Gone with it: the `logValues` field on `LogParseConfig`, the `LogValuesFlags` type and the `OptionsFlags` helper it was built from, and the projection branch in `parse`. Every parsed event now carries the whole raw log the node reported. Nothing is published, so this costs a changeset and no migration; the stream-config digest is NOT narrowed, because `parse` belongs to it on the strength of `parseConfig.filters`.

  **The detect-and-clear guard SURVIVES.** `LogEventFetcher.reparse` still answers `undefined` for an event with no raw log to decode, and the indexer's load path still CLEARS such a stream rather than replaying it on trust. It is simply unreachable for anything written from here on: what it now guards is a stream ALREADY ON DISK, written by an older version whose parse config could project `topics` or `data` away. Both halves are pinned by `packages/core/test/rawLogIsNeverStripped.test.ts`.

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

- 9bfc424: **BREAKING: the kept-stream keeper seam now speaks `StoredLogEvent`, so a keeper that would persist a decoded event no longer compiles.** `StreamFetcher` and `StreamSaver` — and therefore `ExistingStream` and `StreamReader` — are declared over the raw log the node reported plus the reorg verdict the indexer derived, with `args` / `eventName` / `decodeError` structurally refused. The strip already happened at runtime; this is the seam saying so, which is what stops the rule drifting across implementations.

  **What a third-party keeper implementor has to change.** Annotations, and nothing else: `saveNewEvents(source, {eventStream, lastSync})` receives `StoredLogEvent[]` and `StoredLastSync` instead of `LogEvent<ABI>[]` and `LastSync<ABI>`, and `fetchFrom` must hand back those same two shapes. Where a keeper reads its own storage back and cannot prove the shape to the compiler — a row from SQL, a record from IndexedDB — asserting the STORED type at that boundary is the sanctioned move and is what the shipped keepers do. What is NOT: widening the seam, or re-typing a keeper to `BaseLogEvent` or `EmittedLog`, both of which a decoded event satisfies, so either would compile while enforcing nothing.

  **The cursor gets a stored variant, and `LastSync` is untouched.** `StoredLastSync` (with `StoredEventBlock`) is `LastSync` with the unconfirmed window's events narrowed the same way, and it is used by these two function types and nowhere else — the processor seam, the load path, the state keepers and the wire all still speak `LastSync<ABI>`. Core strips the window on the way into `saveNewEvents` exactly as it strips the batch, so a seam that still declared `LastSync<ABI>` there would have been promising an implementor a decoded half that is `undefined` at runtime. No keeper stores a window at all (ADR-0035, as amended), so the return side costs an implementation nothing.

  **The stored type governs WRITES; READS tolerate a decoded half; nothing is migrated.** Segments written before this keep their `args` and `eventName` forever, are served rather than treated as damage, and are never rewritten — the re-decode drops and re-derives that half regardless (ADR-0034). Adopting the stricter type therefore costs an existing deployment no rebuild, which is pinned by a test that writes a segment the previous version's way and replays it end to end.

  Also narrowed with them: `StreamSegment` is now `{events: StoredLogEvent[]}` and carries no ABI type parameter, since a segment holds nothing an ABI was needed for. `EmittedLog` keeps its own meaning and its own callers on the emission-append path, unchanged.

### Minor Changes

- ebfa4f0: **`degradingStream` is DELETED, and a stream keeper whose substrate cannot be read now RAISES from `fetchFrom` and `clear` instead of answering absent** (ADR-0068).

  The rule it encoded is unchanged and still enforced: a cache that cannot be read costs a re-index, never the indexer. What moved is WHERE it is applied. It was a wrapper each keeper put around itself, so it bound every caller -- and "absence is safe" is a statement about the LOAD PATH, which responds to an absent stream by re-indexing. It is false for `installStreamSeed`, which responds to absence by WRITING.

  Told "empty" about a subtree that was merely unreadable, the installer appended a seed underneath a stream that was really there. Measured, with a valid seed against a real stream whose reads were failing while its writes worked: `{status: 'installed'}` returned, two segments where there had been one, and the cursor's `lastToBlock` moved backwards from 600 to 200 while `startBlock` stayed at 500. Silent, permanent, and re-folded by every later generation.

  **If you implement `ExistingStream`:** stop wrapping yourself in `degradingStream` (it no longer exists) and let your substrate errors propagate. The write side is unchanged and always raised.

  **If you consume it:** `IndexerGeneration` catches and re-indexes exactly as before, so an app sees no difference. `installStreamSeed` gains one refusal reason, `subtree-unreadable`, deliberately distinct from `subtree-not-empty` -- one says "there is a stream here", the other says "I cannot tell whether there is". It writes nothing and clears nothing, and is usually transient.

  Done now rather than later because nothing is published yet: two implementations and four call sites, all in this repository. After the publish task lands it is a breaking change to a seam with implementors outside our control.

- 3e36261: A changed context CREATES A SUCCESSOR instead of calling `processor.clear()`, on the runtime that receives its stream over the wire.

  `StreamBuilder` DISCARDED a persisted cursor carrying a different source, config or processor version: `currentLastSync` called `processor.clear()`, and both public methods reach it, so a server or CLI whose processor was upgraded wiped the state it answers from and served progressively less until it had caught up. That is the outage, and it had a concrete call site.

  **`ReceivingIndexer` / `openReceivingIndexer` (`receivingContainer.ts`) is the generation container above that receiver** — the chain-free SIBLING of `Indexer`, which cannot serve here because it builds `IndexerGeneration` engines whose `load()` opens with `eth_chainId`. For ONE named indexer it holds the durable registry, the caps that refuse, the canonical pointer reads resolve through, and the fold this host runs, built `createState` then `createProcessor(state)` (ADR-0043) and registered from the processor's own `getVersionHash()`.

  ```ts
  const indexer = await openReceivingIndexer({
  	port: generationRegistryPortOnSQL(db, 'alpha', {dropState}),
  	caps: {maxGenerations: 4, maxStreams: 2}, // defaults to SERVER_GENERATION_CAPS
  	source,
  	stream: {finality: 12},
  	appendEmissions: emissionAppenderFor(db, 'alpha'),
  	generation: {createState, createProcessor},
  });
  indexer.ingestion; // the `LogIngestion` a host registers, wired to the container
  ```

  **The MODEL is consumed unchanged.** Generation identity, stream identity, the caps and their refusal, "creating one already registered RESOLVES it" and "the first generation registered is canonical" are all `openGenerationRegistry`'s; `resolveGeneration` is a memo and a log line over it, not a second copy. The two factories are `GenerationSpec`'s, reached through a `Pick` so the build ORDER and the state-keying rule are inherited rather than restated.

  **`StreamBuilderOptions.container` is what turns the discard into a creation**, and it is ADDITIVE: a `StreamBuilder` built WITHOUT one behaves exactly as it did, discard included, so the Worker host and every existing caller are untouched. With one, the fold is resolved-or-created as a generation before the cursor is read — so a CAP refuses before anything is folded — and a cursor written by another fold is left where it is instead of being cleared.

  **The caps are the container's input, with a documented default.** `SERVER_GENERATION_CAPS` is `{maxGenerations: 4, maxStreams: 2}`: the incumbent, the successor being built beside it, the predecessor kept so a revert stays free, and one spare, over two streams because a generation re-folds a stream that is already stored while a STREAM is the expensive thing to re-fetch. A host states its own and gets the refusal at its own bound.

  **The ONE-WRITER RULE is structural here too.** The emission appender is handed to the WRITER of the stream and to nothing else — `writerOf`, the oldest SURVIVING generation registered on it (ADR-0044) — so a successor over a shared stream stores nothing (`ReceivingIndexer.writesStream`, reported and never set). Without that it would append what the incumbent already stored, a second time, and the stream is the ONE history every generation re-folds, so a duplicate there is not an operational blemish (ADR-0052).

  Three rules of the chain-facing container deliberately do NOT come over, and the JSDoc says why: it does not refuse a canonical generation it holds no engine for (on this runtime a generation's state is a table namespace and the read tier resolves the pointer to name it, ADR-0053, so the canonical generation answers with no engine at all — refusing would make every upgrade the outage again); it holds ONE live wire context (widening that is `one-registry-entry-holds-several-live-wire-contexts`); and it advances nothing but the fold it was given (catching up is the bounded-chunk rebuild).

- f77f8ea: **A fetch range that could never reach the tip is refused, instead of wedging the cursor for ever.**

  Every cycle rewinds by the unconfirmed window before it fetches (`getFromBlock` takes `min(lastToBlock + 1, latestBlock - finality)`), so a range CEILING at or below `stream.finality` re-asks for blocks that are already folded and stops short of the ones that are not. With `finality: 3` and `maxBlocksPerFetch: 2`, a cursor at 103 asks for 102..103, applies nothing, and asks for 102..103 again, for ever -- measured at 50+ identical `eth_getLogs` ranges in three seconds. Nothing refused it and nothing said so: the indexer went on reporting that it was catching up, truthfully, having stopped indexing.

  `fetch.maxBlocksPerFetch` at or below `stream.finality` now throws the new `FetchRangeBelowFinalityError`, which carries both numbers and names both ways out. It is refused at CONSTRUCTION, where the two values are first in hand, and on the reconfigure path too, since that can introduce the same pair.

  It is a refusal rather than a clamp because both numbers are deliberate statements about a deployment -- how deep a reorg it tolerates, and how wide a range its node will serve -- so quietly raising one to satisfy the other would overrule an operator on exactly the axis they were being explicit about.

  Only the CEILING is checked. `fetch.numBlocksToFetchAtStart` may legitimately sit below the finality depth, because the fetcher adapts it upwards towards `maxBlocksPerFetch`; the ceiling is the one it can never grow past. A deployment that configures no ceiling is unaffected, and the narrowest width that still reaches the tip (`finality + 1`) keeps working.

- 61a5462: A captured stream FIXTURE is no longer an `ExistingStream`.

  `replayStream` now returns a **`StreamFixtureReader`** — `fetchFrom` and nothing else — instead of declaring the kept-stream keeper seam, and it is no longer built out of `readOnlyStream`. The fixture FORMAT is untouched: same serialized shape, same format number (2), same provenance block, so an existing capture parses, replays and serializes exactly as before.

  Why they had to separate: a KEEPER stores what the node said, and the seam is narrowing to a stored event that structurally refuses the decoded half (`args`/`eventName`), which is the half that can go stale and is re-derived on read. A FIXTURE holds decoded events on purpose — they are decoded ONCE at capture so a replay does not re-run the decoder. Nothing ever wired a fixture as an indexer's `keepStream`, so the two never met at runtime, but the fixture DECLARED the seam and would have stopped compiling under the narrowing. ADR-0059 records the divergence, and ADR-0044's rule (ONE definition of read-only on the keeper seam) is untouched: `readOnlyStream` is unchanged in behaviour and its callers are all keepers now (a follower, and `@etherfold/server`'s `storedEmissionStream`).

  What a caller has to change:
  - **A fixture cannot be passed as `keepStream`.** It could be before and nothing did; a seeding path must WRITE a capture's events into a keeper instead, which is also the only shape a later generation can re-fold.
  - **There is no `saveNewEvents` and no `clear` on a fixture reader.** "Writing through a fixture does not change what it serves" moves from a swallowed write to a compile-time fact, asserted with `@ts-expect-error` under `pnpm typecheck`.
  - **`fetchFrom` always ANSWERS** rather than possibly reporting ABSENT: its result is no longer `| undefined`, so a `?.` on it is now unnecessary. A fixture captured for another chain is still REFUSED, which is a mistake and not an absence.

  `captureStream`, `parseStreamFixture`, `serializeStreamFixture`, `blocksOf` and `replayFixtureInto` are unchanged; the last of those never went through the seam, driving a processor directly.

- 5427806: A generation PAUSES by capping `toBlock` and DRAINING, and resumes by removing the cap. It truncates nothing and reverts nothing.

  `pause()` sets `maxToBlock` to the generation's cursor and does nothing else. The generation keeps being polled, fetches nothing above the cap but still re-scans the reorg window up to it, and goes idle by itself once the cap falls below `latestBlock - finality`. At that point every block it holds is FINAL and it is genuinely idle.

  **It needs no new mechanism, which is the strongest argument for it.** The cap goes on `toBlock` BEFORE the existing `fromBlock > toBlock` guard, and the existing `getFromBlock` produces the whole behaviour: while `latestBlock - finality <= cap` it returns `latestBlock - finality`, so each round re-scans a SHRINKING `[latestBlock - finality, cap]` and corrects a reorg striking at or below the cap; once `latestBlock - finality > cap` it returns `cap + 1`, which is above the capped `toBlock`, so the indexer takes its existing "no new block" branch and fetches nothing. There is no timer, no new branch and no state machine. `lastSync.latestBlock` deliberately keeps tracking the REAL head — cap that too and the drain never idles.

  The hazard this removes is real: a generation that simply STOPS carries an unconfirmed window it can no longer correct, so a reorg inside it is never found and the state permanently holds events from blocks that no longer exist. Draining waits that out instead of cutting it off — which is also what keeps a paused generation revertible-TO: moving the canonical pointer back to it restores its answers EXACTLY, minus nothing.

  New API:
  - **`IndexerGeneration.pause()` / `resume()`** — cap at the current cursor, and remove the cap. The cap is PINNED by the first paused cycle rather than by `pause()` itself, so a fetch in flight cannot leave the cursor above the cap with an unconfirmed window nothing re-scans.
  - **`IndexerGeneration.pauseState`** and **`PauseState`** (`'running' | 'draining' | 'drained'`) — where a pause has got to, DERIVED from the cap and `getFromBlock` rather than stored, so `drained` is true exactly when the fetch loop takes its no-new-block branch. A pause is NOT instant: it takes up to `finality` blocks of continued light polling, and a driver that stops calling `indexMore()` when it pauses never completes it.
  - **`IndexerGeneration.maxToBlock`** — the block a paused generation will not fetch above.
  - **`Indexer.pause(id)` / `Indexer.resume(id)`** — the same, naming WHICH generation. Synchronous, because a pause is in memory and is deliberately not recorded in the registry: the registry holds what a generation IS, a pause is what one is DOING, so a reload comes back running.
  - **`HeldGeneration.pauseState`** — read afresh from the engine on every access, so a consumer holding the object sees the drain complete.
  - **`CannotPauseFollowerError`** — a FOLLOWER is refused: it fetches nothing and advances exactly as far as the stream it folds (ADR-0044), so a cap would govern a verb that never runs and `pauseState` would report a drain that is not happening. What stops a follower is stopping its stream's writer, or deleting it.

  Two things this deliberately does NOT claim. `unconfirmedBlocks` may still LIST blocks once drained, because the re-add rule compares against the frozen `lastToBlock`; that is cosmetic, since every block it lists is final. And `revertTo` is never called on this path at all — it is destructive and capability-gated, and draining does not need it. See ADR-0045.

- 391dbf8: **`ExistingStream.fetchFrom` returns a VERDICT and no longer CLEARS anything** (ADR-0069).

  It was `Promise<{lastSync, eventStream} | undefined>`. It is now `Promise<StreamRead>`:

  ```ts
  type StreamRead =
  	| {status: 'stream'; lastSync: StoredLastSync; eventStream: StoredLogEvent[]}
  	| {status: 'absent'}
  	| {status: 'inconsistent'; reason: string}
  	| {status: 'does-not-reach-back'; startBlock: number};
  ```

  That `undefined` carried five meanings, four of which the keeper had just DESTROYED the subtree over, while the SQL reader used the same value for the same shapes having deleted nothing. Two implementations of one seam, opposite contracts, one return value. Three defects came out of it, and all three close here:
  - **A follower could delete its writer's stream.** `readOnlyStream` no-ops `clear` so a follower cannot damage the stream the indexing generation owns, but the clear happened inside `fetchFrom`, beneath the view. A snapshot-seeded generation keeps a stream starting at block N; its follower asks from the source's start block, hits `startBlock > fromBlock`, and wiped the writer's history. The guarantee ADR-0044 documented is now actually delivered.
  - **`installStreamSeed` had to probe from `Number.MAX_SAFE_INTEGER`** purely to avoid that branch. The probe is no longer destructive at any block.
  - **Damage and emptiness were the same answer to an installer**, masked only because the keeper destroyed the damage first. Damage is now refused rather than repaired-then-installed-over.

  **If you implement `ExistingStream`:** return the verdict, and stop clearing on a read. Report `inconsistent` with a reason and let the caller decide; the caller that wants a repair calls `clear` itself.

  **If you consume it:** narrow on `status`. `IndexerGeneration` is unchanged in behaviour -- it clears and re-indexes on every non-`stream` verdict, exactly as it did when the keeper did it for it -- so an app sees no difference.

  The write side is untouched: `saveNewEvents` still raises through to the caller that counts, paces and freezes, because a swallowed write failure would leave a HOLE.

- c6b5215: A stream keeper that DECLINES a batch now says so, instead of returning as though it had written it.

  `createSegmentedStream.saveNewEvents` refuses a batch that does not continue what is stored, because appending it would leave a hole behind a cursor claiming to cover it. That refusal was a log line and an ordinary return, so the indexer could not tell it from a write: it advanced `streamLastToBlock` to a block the stream never received, and from then on its own hole-check compared against a mark that had already lied, so every later decline went unnoticed too. The whole write-outcome apparatus, which exists for exactly this failure, was bypassed by it.

  `StreamSaver` may now return `'declined'`. Returning nothing still means "written", so existing keepers are unaffected and the change is additive.

  A decline remains a cache degradation and not an indexing failure: unlike a FAILED write, it is not retried and it does not stop the fold, because retrying cannot help and the batch is wrong for this stream rather than the write being broken. What is stored stays the contiguous prefix it already was, and is replayed with the remainder re-fetched the next time the state is rebuilt. What changes is only that the indexer no longer records coverage it does not have.

- 0f33468: A NAMED INDEXER IS A ROUTE SEGMENT AND A REGISTRY ENTRY, on both halves of the wire.

  An indexer-server hosted exactly one indexer: `ServerOptions.getIngestion` resolved a single `LogIngestion`, and the ingest routes were the unnamespaced `/ingest` and `/ingest/expected-from-block`. It now hosts SEVERAL, each under a NAME an operator supplies at deploy time (ADR-0036).

  **`/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block` replace the unnamespaced pair, which is GONE rather than kept beside them.** The name is a ROUTE SEGMENT and is deliberately NOT a field in the envelope: putting tenancy in the wire format would turn a misdirected batch into a payload error rather than a routing one. ADR-0004's `{source, config}` envelope and its refusal families (`409` resumable, `400` otherwise) are untouched.

  **`ServerOptions.getIndexer` replaces `getIngestion`, and resolves a registry ENTRY per name.** The entry is an object (`{ingestion}`) so that what a name holds can grow — a later generation model gives one entry several live wire contexts — without every host's resolver changing its return type. `indexerRegistry({name: streamBuilder})` builds one from a plain record for a host that knows its names up front; a host whose names depend on the request writes the function itself. Two named indexers on one server are isolated: a batch pushed to one is not visible to the other.

  **An unknown name is REFUSED, never defaulted: `404 unknown-indexer`.** A routing refusal, matching what the name is, and distinct from `501 ingestion-not-configured`, which a host with NO registry at all still answers under every name (a read tier, or a combined `run`). Both are in the non-retryable 4xx family a sender must not re-send into.

  **`createHttpIngestion` takes the indexer name beside the endpoint** (`@etherfold/core`) and posts to the namespaced routes; it refuses to be built without one rather than addressing nobody. `@etherfold/fetcher-host` reads it from `INDEXER_NAME` and demands it wherever it demands `INGEST_ENDPOINT` and `INGEST_TOKEN`, so a combined host that configures no wire is still asked for nothing.

  **The CLI grows `--indexer <name>` / `INDEXER_NAME`, REQUIRED on `fetch` and `index` and refused on `run`, `build` and `serve`.** The two halves of a split deployment agree on one name the way they already agree on one secret: `fetch` addresses `/{indexer}/ingest`, `index` registers exactly that name and refuses every other. The three commands with no wire route no batch by name, and refuse the flag with that reason rather than accepting and ignoring it.

  `StartOptions.getIngestion` on `@etherfold/platform-nodejs` becomes `getIndexer`, carried through unchanged as before.

- a64a843: A non-canonical generation ACTUALLY ADVANCES, and HOW it advances is DETERMINED by whether it shares a stream — never configured.

  An `Indexer` now advances EVERY generation it holds, not just the canonical one. `load()` loads all of them (a fold that never loaded has no state and no cursor to advance from) and `indexMore()` steps all of them, in the order they were built, each by the verb its stream decides. Which generation ANSWERS is still the canonical pointer's decision and nothing else's.

  **A generation that SHARES a stream with one already held is a FOLLOWER: it fetches nothing at all.** It re-folds the stored stream from the start and then follows it as the indexing generation appends. Zero `eth_getLogs`, not fewer, and zero segments written. A generation naming its own `source` is on its own stream and is an ordinary indexer at a different address, fetching its own history into its own keyspace.

  There is no flag for this and there must never be one (ADR-0044), because a flag would be wrong in both positions. "Follow a stream nobody writes" never advances. "Fetch a stream somebody else writes" is a second writer — and, worse, it makes that generation's state a function of ITS OWN FETCH rather than of the stream, so re-folding the stored stream later would yield a DIFFERENT state. A generation would stop being "a stream plus a fold over it", and the promise that moving the canonical pointer BACK restores answers exactly would go with it.

  New and changed API:
  - **`readOnlyStream(reader)`** (`@etherfold/core`) — an `ExistingStream` whose `saveNewEvents` and `clear` are no-ops. This is what makes the one-writer rule STRUCTURAL rather than a convention: read and write share one seam, and `promiseToSave` calls `saveNewEvents` unconditionally, so a pure reader is not expressible by declining to write. Only the generation that INDEXES a stream is handed the keeper; every other generation folding it is handed one of these. `clear` is a no-op for a sharper reason than symmetry — the load path clears on every stream shape it cannot use, and a follower takes those branches over a stream another generation is still indexing into. `replayStream` is now built out of it rather than being a second implementation of the same idea; its behaviour is unchanged.
  - **`IndexerGeneration.followMore()`** — advance from the STORED STREAM alone, fetching nothing. The catch-up branch of `load` made repeatable: the first call re-folds the whole stored stream, every call after it replays what is new. Every branch that cannot proceed simply returns; a stream this generation does not own is not its to clear.
  - **`GenerationSpec.source`** — the fetch filter THIS generation folds, when it is not the container's own. A stream IS its fetch filter, so this is the only way to say "a different stream", and saying it is what makes the follow-or-fetch rule determined. The stream CONFIG is deliberately not settable per generation: `setStreamConfig` is a single mutable value on the ONE keeper a container holds, so two generations under different configs would clobber each other's address.
  - **`HeldGeneration.follows`** — whether a held generation follows a stream another one writes. Reported, never set.
  - `Indexer.disableProcessing()` / `reenableProcessing()` now apply to every held generation rather than to the canonical one alone, which is the honest meaning now that every generation advances.

- d92021c: A provider's refusal of an oversized `eth_getLogs` is now read from its STRUCTURED data before its prose, and `-32000` is read at all.

  `getNewToBlockFromError` decides how far a refused range shrinks before the retry. It read the error's MESSAGE with a regex and never looked at `error.data`, even where the provider had put the answer there. Three additive changes, none of which touches the halving fallback:

  **`error.data` is read first.** Infura sends `{"code":-32005,"data":{"from":"0xBDE5F8","limit":10000,"to":"0x102DBCC"},"message":"query returned more than 10000 results. Try with this block range [0xBDE5F8, 0x102DBCC]."}` — the same instruction twice, once as a descriptor and once as English, and only the English was being read. `data.to` is now taken when `data` carries a `to` and a `limit`, and `limit` is required rather than decorative: it is the node's own cap, so an object carrying it is describing a REFUSAL, while an object with a bare `to` may be a provider echoing the request back, and reading that would hand the retry the very range that was just refused.

  `data` is also read when it is PROSE. Nethermind puts the entire hint there and leaves the message at a bare `"invalid params"` (`{"code":-32602,"message":"invalid params","data":"Query returned more than 50000 results. Try with this block range [0x1000000, 0x1080000]."}`, Gnosis and Fraxtal, captured 2026-09-08), so a reader that only looked at the message discarded a complete, machine-readable answer and halved blindly against a node that had already said what to ask for.

  **`-32000` is accepted under the same hint gate as `-32602`.** It is a widely used generic server-error code and providers do put range complaints behind it: Polygon zkEVM, PulseChain, Merlin and Immutable all state one there. Before this the code alone discarded them.

  **The `looksLikeRangeHint` gate stays, and is now pinned by tests.** It looks like a redundant guard beside two specific error codes and it is not: `-32602` and `-32000` are GENERIC, so a refusal under one may be about anything at all. `ethereum-rpc.publicnode.com` refuses history with `-32602 "Archive requests require a personal token..."`, and Cronos refuses a wide range with `-32000 "maximum [from, to] blocks distance: 2000"` — a bracketed pair that is a parameter-name list, not blocks. Without the gate a bracketed pair from an unrelated complaint becomes a `toBlock` the fetcher then retries against, for a refusal no range size can ever satisfy. Widening the accepted CODES was deliberately not a licence to widen the two markers, and each piece of text is gated ON ITS OWN, so a hint in `data` never licenses lifting a pair out of the message.

  Every parse path is now tested against a response a real provider really sent, with the endpoint named beside it, re-captured live across 60+ keyless public endpoints on 2026-09-08; the probe script and the raw output are in `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`. Two things that re-run turned up: `rpc.mevblocker.io` no longer sends the structured shape the original capture came from (it enforces a block-span cap now), and no reachable `-32000` carries a machine-readable suggestion today, so the widened code changes no answer yet and only stops the hint being thrown away on its code.

  **Nothing here makes an unknown endpoint worse.** A provider that says nothing useful still halves, which is what makes the fetcher work against an endpoint whose cap nobody knows, and that path is asserted end to end rather than assumed.

- bc63e6b: A published STREAM SEED has a shape, its own format number and a content hash both ends compute the same way.

  `StreamSeed` (`stream/seed.ts`) is the artifact a publisher emits and a client installs. It carries `STREAM_SEED_FORMAT` (1) and deliberately NOT `STREAM_FIXTURE_FORMAT`: a fixture is a CAPTURE holding decoded events and the source they were decoded against, a seed holds the STORED half only plus what a client needs to establish what the artifact is without trusting the host that served it. Two numbers is what makes each reader REFUSE the other's document instead of half-parsing it.

  ```ts
  const seed = parseStreamSeed(text); // THROWS on a format this build does not read
  seed.streamConfig; // RESOLVED, so the client can compute the 128-bit digest itself (ADR-0064)
  seed.streamDigest; // a label the client VERIFIES, never trusts
  seed.coverage; // how far it REACHES, not where its events are (ADR-0055)
  seed.context; // the seed's OWN stored context, installed verbatim (ADR-0063)
  seed.chainHeadAtCapture; // what the capture-depth check reads
  seed.producer; // TYPED, because the retraction rule is stated against it (ADR-0065)
  ```

  **The content hash is a contract between a producer and a loader, so its two halves are pinned in one function.** `streamSeedContentHash(payload)` is SHA-256 over the DECOMPRESSED payload octets, taken after any transfer decoding and before `JSON.parse`, rendered `sha256:<64 lowercase hex>`. That domain is ADR-0066's and it is transport-invariant: a host may serve the file opaque or with `Content-Encoding: gzip` and a client reaches the same value either way. It takes BYTES rather than a string or a parsed seed, so hashing a re-serialisation is not expressible. If the two ends hashed different bytes, every pinned install would refuse with an integrity mismatch while each side's own tests stayed green.

  **`streamDigestOfSourceHashes` is the existing digest rule, rephrased over the entries it already consumes.** A seed carries its publisher's source HASH ENTRIES in its stored context and ships no `IndexingSource`, so a client checking one has the entries and cannot have the source. Nothing about what enters the digest, how wide it is or how it renders is different, and `streamDigestOf` is now defined in terms of it so the two cannot drift.

  **`StreamFixtureProvenance` gains two OPTIONAL typed keys**, `chainHeadAtCapture` and `capturedBy`, which the committed captures already carry through its free-form index signature. Typing them lets a producer read them instead of casting; neither is REQUIRED and neither can become so, because that would force a fixture-format bump ADR-0063 forbids. `STREAM_FIXTURE_FORMAT` is unchanged.

  The PRODUCER lives outside this package, applying the exported `storedStreamOf` rather than a copy of it, and refuses to emit under a stream config its capture was not taken under.

- 5729da5: A block range now requests only the events that CAN occur in it: a fetched range carries only the topics whose declared block ranges intersect it.

  ```ts
  const abi = [
  	{...transferV1, firstBlock: 100, lastBlock: 900}, // the pre-upgrade signature
  	{...transferV2, firstBlock: 900}, // the post-upgrade one
  ] as const satisfies RangedAbi;
  ```

  Blocks `100..899` are now fetched without the post-upgrade `topic0`, and blocks `901..` without the pre-upgrade one. Under argument filters that is a request the range no longer makes at all, because `eth_getLogs` is issued once per (event topic × filter), run sequentially; without filters the topic simply leaves the single request's topic set. Where NO declared event can occur in a range, no `eth_getLogs` call is made for it at all, rather than one with an empty topic list, which a node reads as a wildcard.

  This is the half of the ranged model that pays even on a FULL re-index, since every range below a version's `firstBlock` is fetched without its topic, and it needs no cursor relationship and no kept stream.

  **Nothing is narrowed that was not DECLARED.** This is the one operation in the ranged design that removes a topic from a request, and an unrequested topic produces no error, no log and no fetch, so afterwards a chain that had none and a request nobody made look identical. Therefore:
  - an event with no `lastBlock` is open-ended and is present at EVERY height at or above its `firstBlock`;
  - an event that declares NO range is treated as open-ended from block 0, so it is never dropped anywhere — in particular it is NOT narrowed on its contract's `startBlock`, which means "do not look before here" per contract and is minimised across contracts by `defaultFromBlockOf`. Adding a range to one event never changes what an unrelated event fetches;
  - a range that CROSSES a boundary requests the union of everything live anywhere in it, and at the upgrade block itself BOTH versions are requested, keeping the one-block overlap that an upgrade at block `b` (`A.lastBlock = b` with `B.firstBlock = b`) is declared with;
  - ranges are unioned per `topic0` ACROSS contracts, because the topic filter of a request is global to the request while a range is declared per contract: one address going quiet is not a hole in another address's coverage;
  - narrowing is computed on the range actually REQUESTED, which may be smaller than the one asked for when the fetcher adapts to a node's limits;
  - nothing is inferred: no narrowing follows from an observed first appearance, from logs seen, or from anything but a declaration.

  **A source declaring no range requests exactly what it requested before, topic for topic and request for request, at every height.**

  What is measured here is the REQUEST COUNT (see `packages/core/test/fetchFilter.test.ts`). The node's own work — a topic that cannot match still widens the `logsBloom` screen, and so the set of blocks whose receipts are loaded and scanned — is how nodes implement the method and is not a measurement taken against this repository.

- 2e10f5e: A receiver now says WHAT it emitted and WHICH STREAM it folds, so a host can store the emission stream without deriving either for itself.

  `LogIngestion` gains `streamDigest`, the wide `streamDigestOf` value over the fetch filter plus the resolved stream config: the same name a stream has in the browser's stream address (ADR-0035), so one stream is one name everywhere. It is deliberately not `context`: the wire identity is a CHANGE DETECTOR between the two halves of one deployment, 32-bit per entry and over the whole entry on purpose (ADR-0034), so it moves on a decode-only change the fetch filter never saw and it collides. Neither is survivable in a KEY.

  `IngestionOutcome` gains `emissions`, the ordered stream of what was applied and what was taken back, with retractions carrying their original block. It is REPORTED for the same reason `reorg` is: `StreamBuilder.receive` is the one place that knows what the fold concluded, and a host that re-derived it would be holding a second answer. The `applied` / `retracted` counts are that list partitioned on `removed` and stay, so a caller that only reports progress need not walk it.

  `EmittedLog` is exported: one entry of that stream with the ABI taken away, which is to say the raw log the node reported plus the verdict. Taking the ABI away is the point, since a host that STORES logs is not a host that decodes them, and the decoded `args` are what some earlier ABI made of those bytes and are re-derived on replay against the source running now.

  Breaking for anyone implementing `LogIngestion` by hand (a fake in a test): both new members are required. Neither is optional, deliberately. An optional field on the fold's output is a hole with a polite name, and a receiver that quietly omitted one would leave a host storing nothing under a key it could not form. The Node adapter's own fake receiver is updated for that reason and its behaviour is otherwise unchanged.

- 011aa87: **A store refusal that waiting cannot fix now says so, and the browser indexing loop stops instead of retrying it for ever.**

  The auto-index loop swallows a failure and comes back a few seconds later, which is right for a rate limit or a dropped socket and catastrophic for a refusal the store will repeat identically. A tab whose store had been moved ahead by another writer before it ever wrote got `block N is not above the recorded tip M`, treated it as transient, and re-fetched the whole range from the node on every tick: measured at ~90 `eth_getLogs` per second of wall clock, with the cursor pinned and nothing reported. The work was invisible precisely because each attempt merely failed again.

  **The three block refusals are now errors carrying `retryable: false`** (`StoreWriteRefusedError`, `@etherfold/state-store`): a height already recorded, a hash already recorded, and a height the tip has passed. `StoreWriterChangedError` carries it too. They are read STRUCTURALLY (`err.retryable === false`), which is why `@etherfold/state-store` declares the flag while importing nothing — it has no dependencies, and an error crossing a package boundary still classifies correctly. The three messages also stop being copied into four backends: `blockNotAboveTip`, `blockAlreadyRecorded` and `blockHashAlreadyRecorded` are the one place that spells them.

  `isRetryable` is now exported from `@etherfold/core` beside `RetryableError`, rather than being a private helper in `logFetcher.ts`, so every driver that retries on a timer asks the question the same way.

  **If you catch these:** the messages and the class of failure are unchanged, and the refusals are still refusals — what is new is the flag and the shared `StoreWriteRefusedError` type. A loop of your own should ask `isRetryable(err)` before re-arming.

  **A refused write stops the browser loop and is NOT a demotion.** It reports through `syncing.error` with id `WriteRefused` and leaves `syncing.demotion` alone, because the two mean opposite things: a demotion says this tab lost a race and should become a reader, while this says the write itself is wrong and the remedy is to revert first or stop. An app can tell them apart.

- a4d106e: Fix: rebuilding off a cached event stream no longer throws away the retractions that stream carries.

  A stored stream is an EMISSION stream: a reorged-out block is in it TWICE, once as it was emitted and once at its original block flagged `removed`. `EthereumIndexer.feed()` handed whatever it was given to `generateStreamToAppend`, which is FETCH-shaped -- it derives retractions from the cursor's unconfirmed window, and `groupLogsPerBlock` drops `removed` events out of its input, both of which are right for raw logs from a stateless `eth_getLogs`. A rebuild starts from a fresh cursor whose window is EMPTY, so a stream containing a reorg replayed as BOTH branches applied as live blocks with no revert at all: refused by the entity store (`block 104 is already recorded`), and silently wrong state derived partly from a dead branch on any path that tolerated the double-apply. ADR-0008 rests a processor upgrade on that replay, so its fidelity is load-bearing.

  **New: `EthereumIndexer.replay(eventStream, lastSyncStored)`**, the entry for a stream that carries its own verdicts, and what `load()` now uses for both the rebuild and the catch-up shape of a kept-stream replay. `feed()` keeps its meaning -- a FETCH, complete over its range, whose retractions this engine derives -- and now REFUSES a batch carrying `removed` markers with an `InvalidBatchError` naming `replay()`, instead of accepting it and dropping them.

  **The cursor a replay leaves behind is the one the live run held, window included.** The window is rebuilt by WALKING the stream (an applied block enters it, a retracted block leaves it, keyed by block HASH), not by filtering out its `removed` entries -- which would leave both branches of a reorg at one height and make the first tip cycle after the rebuild apply the replacement block a SECOND time. No stream keeper stores `unconfirmedBlocks` and none needs to; see ADR-0042.

  `groupStreamPerBlock` now groups CONSECUTIVE runs rather than keying a map over the whole list, so a stream that applies a block, retracts it and applies it again under the same hash is delivered in that order.

- 339d212: A published stream seed is now ADMITTED or REFUSED on everything a client can establish by itself, all of it BEFORE the first write, and `installStreamSeed` is a PUBLIC entry point of `@etherfold/core`.

  `installStreamSeed` (`stream/seedInstall.ts`) is exported from the package entry for the first time. It was deliberately unexported while it verified nothing; the checks below are what earn the export, so a public entry point never means "fetched and hoped".

  **Identity** (ADR-0064). Admission is EXACT stream-digest equality: the client recomputes the publisher's 128-bit digest from the artifact's own resolved config and stored context and compares it with its own, so the seed's `streamDigest` is a LABEL it verifies rather than a claim it trusts. A publisher whose filter is a strict SUPERSET is refused even though the invalidation model calls such a stream reusable, because those extra events would be stored under the CLIENT's digest, re-folded by every later generation, and delivered to a processor implementing `handleUnparsedEvent`. The refusal names the DIRECTION (`seed-covers-more` / `seed-covers-less`) and nothing infers "you are out of date": a deliberately narrower client is indistinguishable from a stale one, and only the application can tell. A `chain-mismatch` and a `stream-config` mismatch are reported separately even though the digest subsumes both, because telling a developer who pointed at the wrong chain that an entry moved at block 0 is useless.

  **An OPTIONAL content hash** (ADR-0066), through the new `expectedContentHash` option: SHA-256 over the DECOMPRESSED payload octets, taken after any transfer decoding and before `JSON.parse`, so it is TRANSPORT-INVARIANT and imposes no rule on how a host serves the file. Optional because a build cannot know the hash of a ROLLING artifact, and rolling is how this is deployed; where an artifact is immutable and release-tied a pin is the strongest thing available. A pin that is not in the rendering `streamSeedContentHash` prints RAISES before anything is fetched, because a malformed pin is a mistake in the caller's own source rather than an ordinary condition.

  **Structural coherence and capture depth** (ADR-0065), O(n) over the events and needing no node: block numbers non-decreasing and `(blockNumber, logIndex)` strictly increasing, one `blockHash` per block number, no duplicate `(blockHash, logIndex)`, every event inside the coverage the artifact claims, retractions COHERENT rather than absent (preceded by a standing application AND admitted by the artifact's declared producer, so a server's append-only emission stream stays publishable), and a coverage that ends at least `finality` blocks below the head the producer OBSERVED -- the stream analogue of the snapshot path's `inside-reorg-window`, and the check most easily missed because a capture taken near the tip can record a branch that later lost while being perfectly coherent.

  `StreamSeed` gains an OPTIONAL `chain` declaration (`StreamSeedChain`), which exists only so a chain disagreement can be NAMED: the digest already refuses a foreign chain, but a skeleton hash is one-way and cannot say which part of it moved. A seed that omits it is admitted or refused exactly as before, with the direction as its reason.

  Every refusal is DATA, never a throw, and `NotInstalledReason` gains `chain-mismatch`, `stream-config`, `seed-covers-more`, `seed-covers-less`, `integrity-mismatch`, `incoherent` and `inside-reorg-window`. There is deliberately NO location-based refusal: the loader fetches what it was pointed at, so there is no admission decision about location to make.

  What is deliberately NOT built, and must not be added: chain anchoring, bloom consistency, publisher signing, and any attempt at OMISSION detection. A seed that simply leaves logs out is structurally perfect and passes every check above, and detecting it needs the historical logs a public node will not serve -- which is why the host a build names must be trusted the way the build pipeline is trusted, and why the loader's JSDoc says so out loud.

- 4f5588b: A cap a provider writes out in its refusal is now believed: it becomes a CEILING on every range the fetcher asks that endpoint for, instead of being dropped while the fetcher halves blindly towards a limit it has just been told.

  Providers state their `eth_getLogs` block-span cap in prose all the time, and the number was going straight in the bin. Alchemy answers `"Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response. Based on your parameters ... [0x0, 0xd043b8]"` (ethers-io/ethers.js#4703) — and note what that suggestion is: a range honouring the 10K LOG cap and ignoring the 2K BLOCK one, 13.6 million blocks wide, against an endpoint whose maximum is 2,000. Others state a cap and suggest nothing at all, so the fetcher halved from wherever it happened to be: `"block range too large, max range: 10000"` (Polygon zkEVM), `"exceeded maximum block range: 5000"` (Immutable, and the same sentence in ethers-io/ethers.js#1816), `"requested too many blocks from 50331648 to 51380224, maximum is set to 2048"` (Avalanche), `"maximum [from, to] blocks distance: 2000"` (Cronos), `"eth_getLogs is limited to 0 - 50 blocks range"` (1rpc), all captured 2026-09-08.

  **`statedBlockCapFromError` is the third reader of one refusal**, beside `getNewToBlockFromError` (how far to shrink THIS retry) and `archiveRefusalFromError` (stop, this endpoint serves no history). What it produces is neither of those: it lowers the SAME discovered upper bound a `-32603` "block range too wide" already lowers, and it is emphatically **not the size of the next request**, which is computed from the log density the fetcher has observed. A block-span cap says nothing about how many logs those blocks hold, so a ceiling bounds the request and never sets it. Against the Alchemy body above, the retry now asks for 1,999 blocks rather than the 10.9 million the suggested range alone produced.

  **It may only ever LOWER, and that is structural rather than intended.** Parsing English is guessing, and the whole design follows from what a wrong guess costs: guessing low costs a few extra round trips and corrects itself as the fetcher succeeds and bisects back up, while guessing high produces a request the provider refuses and the same limit is discovered again the slow way. So `foundNumBlockToHigh` now has exactly ONE writer, `lowerBlockCeilingTo`, a single `Math.min` that every path goes through — the `-32603` path included — and there is no expression anywhere that can raise it. A cap arriving after a smaller one is asserted to change nothing, both in the field and in what the fetcher asks for next.

  **A number is read only where the words next to it name the UNIT.** The real hazard is not missing a cap, it is reading the WRONG KIND: providers cap this method by block span or by result count, the two differ by orders of magnitude, and the sentences look alike (`exceeded maximum block range: 5000` beside `logs matched by query exceeds limit of 10000`, which is a result cap and is deliberately not read). Each accepted phrasing is a tight pattern taken from a captured refusal and carrying its own block anchor; the LOWEST plausible candidate in a refusal wins, so a message stating two caps yields the block one whichever matched first, and the answer does not depend on pattern order. Shapes whose unit is unstated are left unread on purpose (`range 16777216 exceeds limit of 10000`, Linea), because a miss costs only the halving path we would have taken anyway. A number that could not be a block count — zero, negative, fractional, or larger than 10,000,000 when the widest cap in the whole sweep was 10,000 — is dropped rather than trusted.

  **No error CODE gates it**, for the reason `archiveRefusalFromError` takes none either: the 2026-09-08 sweep found stated caps under `-32000`, `-32602`, `-32614`, `-32600` and `-32047`, and the identifying evidence is the text. That is affordable here precisely because the value can only lower a ceiling. The text is read from `error.data` before the message, like both siblings, because a Nethermind-style node puts its whole complaint there (Ronin states its 200-block cap in `data` behind a bare `"Invalid params"`).

  A refusal that states no cap is untouched and still halves, asserted end to end. One further edge is now closed rather than left to arithmetic: a ceiling of a single block used to compute a zero-width, backwards range, and the range asked for is now never below one block.

- 351c585: A cached stream has a real IDENTITY: a digest of its FETCH FILTER plus its stream CONFIG, and that digest fills the address level `the-stream-appends-in-segments-on-indexeddb` left as a placeholder.

  `@etherfold/core` exports `streamDigestOf(source, streamConfig)`: 128 bits of `viem`'s `sha256`, SYNCHRONOUS, rendered as 32 fixed-length lowercase hex characters every substrate can carry as a key element. It is taken over the DEDUPLICATED `streamHash` values SORTED BY THEMSELVES, plus the resolved stream config, and over nothing else. `hash` and `legacyHash` are excluded: they cover the DECODING shape, which is what the stream is deliberately independent of. Sorting the values by themselves rather than rolling the digest up over the entry list is load-bearing — that list is sorted by `(startBlock, hash)`, so a decode-only change (a renamed non-indexed parameter) reorders it while every `streamHash` is unchanged, and a digest over that order would fork a new stream, re-fetch the whole history and orphan the old one, silently.

  `simple_hash`'s canonicalisation is extracted as `canonical_form` and shared rather than copied, so the wide digest and the 32-bit change detector cannot disagree about whether two values are the same; `simple_hash` itself is byte-for-byte unchanged.

  The config is in the digest because it decides what a stream CONTAINS (`alwaysFetchTimestamps`, `alwaysFetchTransactions`, `parse.filters`), and because `sourceInvalidationOf` already invalidates the stream half from block 0 whenever it moves. This is ADR-0006's `{source, config}` stream keying made concrete, narrowed on the source side to the FETCH half per ADR-0034 (ADR-0008's 2026-08-31 amendment records the narrowing).

  **`ExistingStream` gains an optional `setStreamConfig`**, which the indexer calls in `reinit` with the config it RESOLVED, before any other call and again on every reconfigure. A keeper is handed a `source` on every operation and never the config, so without it a keeper that addresses a stream would map two configs onto one subtree. A keeper that addresses nothing (a replayed fixture) omits it.

  **`keepStreamOnIndexedDB` now addresses `['stream', <indexer-name>, <streamDigest>, ...]` with the real digest**, and `placeholderStreamDigest` is deleted. `streamAddress(name, source, streamConfig)` takes the source and the config in place of the `chainId` it used to derive the placeholder from; `chainId` is still not a level of its own, because the digest covers it through the block-0 skeleton entry. The `<indexer-name>` level is untouched, so two names and two chains stay isolated exactly as before.

  **Nothing migrates and no payload is rewritten.** A stream written under the placeholder is simply a stream under a different digest: unreachable by a filter that now resolves elsewhere, so nothing needs to move. Disposing of those subtrees belongs to the unregistered-subtree sweep in the generation registry, which is the only place that can know which digests are registered.

- a448b1b: **A fetched range holding a log with no readable `blockTimestamp` is now REFUSED at the fetch boundary, naming the NODE.** Both deployment shapes refuse it: the single-process `IndexerGeneration` on the node's answer, and the split `LogFetcher` before it pushes anything to a receiver that could not have caught it. The new error is `TimestamplessLogError`, exported from `@etherfold/core` and carrying `retryable: false`, so a fetcher host stops and tells somebody instead of asking a node forever for a field it does not serve.

  `blockTimestamp` on the log is `ethereum/execution-apis#639`, served by geth >= 1.16.0, reth, besu, erigon, anvil and `@nomicfoundation/edr >= 0.20.0`. A node that serves it is entirely unaffected by this: no new call, no new failure, nothing about the cycle changes. What changes is that a node which does NOT serve it is refused one round trip in, rather than silently compensated for at a request per event-bearing block, or refused a whole range later at the fold.

  **The message is long on purpose.** Every cause is node-level and each has a DIFFERENT fix, so "missing blockTimestamp" alone would send an operator to the wrong one. It names the standard, the minimum implementations that serve it, and the four situations an operator can be in: the node predates the change; it is a Hardhat version bundling an older EDR (3.16.0 still ships edr 0.19.0, and the fix is a package-manager override to `@nomicfoundation/edr@>=0.20.0`, not waiting for a Hardhat release); it is forking a node that predates the change; or it is replaying an EDR RPC response cache entry that recorded the absence from such a node, which needs its `rpc_cache` dropped.

  The refusal is PERMANENT machinery rather than a transitional guard (ADR-0073), because the last two of those causes survive any version bump: a forked node's history predates the change whatever version forks it, and EDR's on-disk RPC cache replays such an absence once recorded, until `rpc_cache` is dropped. (Not because pre-change entries keep answering: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and ignores the rest.)

  **While `stream.alwaysFetchTimestamps` is set the refusal does not fire**, because the fallback resolves the timestamp and there is nothing to refuse. That flag, and this condition with it, are deleted by a later change; the refusal itself stays.

  `blockPointer`'s fold-time refusal in `@etherfold/processor-entities` is UNCHANGED and is not replaced by this one. The two guards sit on different entry points: a stream can reach a fold without passing a fetcher at all -- a seed install writes through the keeper seam, a fixture reader replays a captured stream -- so a fetch-boundary check would never see either. Neither of them guesses a value: a zero or interpolated timestamp does not fail, it answers confidently about the wrong block for as long as the store lives.

  The tolerant reading of the field is untouched (`parseLogBlockTimestamp`: a 0x-prefixed hex quantity or a bare decimal one, and anything else dropped rather than coerced). "Unreadable" and "absent" therefore reach the refusal as one outcome, which is the intent: neither may become a number.

  `@etherfold/processor-entities` and `@etherfold/browser` carry TEST-ONLY changes here and no API or behaviour change of their own: the first gains the case pinning that the two guards are not redundant, the second has a fake node that now serves the field, as every supported node does.

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

- 6b5395e: An endpoint that refuses to serve HISTORY is now terminal for that endpoint, instead of being halved at until the retry budget runs out.

  Serving logs for old blocks needs an archive node, and public endpoints commonly token-gate it: `ethereum-rpc.publicnode.com` answers a backfill with `{"code":-32602,"message":"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"}` (captured 2026-06-30 and again, byte-identical, on 2026-09-08). Every other refusal the range fetcher meets is a complaint about the RANGE, answered by asking for less, so that is what it did here too: it halved 1000 -> 499 -> 249, spent the whole budget shrinking a window the endpoint was never going to serve, and then failed with whatever the last error happened to be. An operator read a range error and tuned `maxBlocksPerFetch`, when what they had was an endpoint that does not serve history at all.

  **`RangeLogFetcher` now stops on the first such refusal and throws the new `ArchiveRefusedError`**, which names archive access as the cause, quotes the provider's own words verbatim, and says what to do about it (point at an archive endpoint, authenticate this one, or start from a block it still serves). It carries `retryable: false`, so it is read STRUCTURALLY by the same mechanism every other refusal in `@etherfold/core` is read by: the log-fetcher's retry loop and `@etherfold/fetcher-host`'s backoff both stop rather than waiting out a delay for an endpoint whose answer will not change. Nothing matches on message text.

  **The classifier is deliberately narrow, and its width is the whole judgement here.** A refusal qualifies only when it IDENTIFIES itself: the text must mention `archive` AND carry an entitlement word (a token, an API key, a plan, an upgrade, "not supported", "not enabled"). Both halves are load-bearing. `archive` alone would swallow "archive node is syncing" and "archive backend temporarily unavailable", which are transient; an entitlement word alone would swallow `rpc.ankr.com`'s "You must authenticate your request with an API key", which is about the endpoint rather than about serving history. A false terminal is a worse failure than the grinding this replaces -- grinding is slow and visible, a false terminal is fast and wrong -- so **anything ambiguous keeps today's behaviour and still halves**, asserted end to end rather than assumed, including a dropped socket, which still spends its retries and still reaches the caller carrying no `retryable` opinion at all.

  The text is read from `error.data` before `error.message`, the same order the range-hint parser reads them in, because a Nethermind-style node puts its whole complaint in `data` behind a message that says only `"invalid params"`. No error CODE is required: the captured refusal is a `-32602`, but providers are as inconsistent about the code they put this behind as they are about range complaints (the 2026-09-08 sweep found those under seven different codes), so the identifying evidence is the text.

  `getNewToBlockFromError` is untouched, and the two functions cannot overlap: `looksLikeRangeHint` already rejects the archive body, which is the case that gate earns its keep on.

- f0515f8: An argument filter restricts a (contract, topic0) pair, not a topic0

  `LogParseConfig.filters` is now a LIST of rules instead of a map keyed by event name. This is a BREAKING type change, pre-1.0, and it replaces a shape that could not express its own primary use case.

  ```ts
  export type ArgumentFilter = (`0x${string}` | `0x${string}`[] | null)[];

  export type FilterRule = {
  	/** An event NAME (every topic0 it covers) or a canonical SIGNATURE (exactly one). */
  	event: string;
  	/** WHICH contracts. OMITTED means every contract in the source that declares it. */
  	contracts?: `0x${string}`[];
  	/** OR across the entries, AND within one entry's slots. Slots start at topics[1]. */
  	match: ArgumentFilter[];
  };
  ```

  ```ts
  // a set of NFTs and ERC-20s, anything involving me
  filters: [
  	{
  		event: 'Transfer',
  		match: [
  			[me, null],
  			[null, me],
  		],
  	},
  ];

  // scoped to where a token id exists at all
  filters: [{event: 'Transfer', contracts: [nft], match: [[null, null, tokenId]]}];
  ```

  WHAT MOVED, and why the old shape had to go:
  - `null` is now writable. It is what `eth_getLogs` defines as "match anything in this slot" and the only way to constrain the second or later indexed argument, so "Transfers TO me" was previously inexpressible. The runtime always passed it through; only the type forbade it.
  - A filter now restricts a (contract, topic0) pair. A filtered topic0 used to be removed from the shared request outright, so "filter the NFT's Transfers and leave the ERC-20's alone" was inexpressible even in principle. The rule is now that AN ADDRESS NOBODY FILTERED IS NOT FILTERED: every address a rule did not reach is collected into a leftover request that asks for that topic0 unfiltered.
  - `event` may be a canonical SIGNATURE as well as a NAME, discriminated on `(`, which an identifier can never contain. A name covers every topic0 it declares (both sides of an upgrade); a signature covers exactly one. The signature comparison is strict byte equality with viem's `toEventSignature`.
  - Eight misconfigurations are REFUSED at construction, each naming a remedy, rather than silently widening or narrowing the stream.

  MIGRATION. `{Transfer: [[a], [b]]}` becomes `[{event: 'Transfer', match: [[a], [b]]}]`. `filters` had exactly one consumer in this repository (`examples/event-processor-nfts`) and it is migrated in the same change, with its `as unknown as` cast deleted.

  STREAM IDENTITY. The rules are canonicalised inside `resolveStreamConfig` before anything hashes them, so two spellings of one filter are one stream. A config that sets no `filters` hashes IDENTICALLY to before, pinned by a literal digest, so nothing a deployment without filters holds is re-fetched. A deployment that DOES set filters gets a new stream digest and re-fetches, which is correct rather than collateral damage: under the previous release its stream was missing every event that had no filter.

  Recorded in ADR-0062, which also supersedes ADR-0031 in part, on the clause that filters are keyed by event name.

- 4e5067e: An event is never silently dropped from the fetch filter: duplicate detection is keyed on `topic0`, and the verdict no longer depends on `parseAllEventsIrrespectiveOfAddresses`.

  `deleteDuplicateEvents` keyed on the event NAME and took a `failOnIdenticalNameButDifferentInputs` flag, and the two call sites passed different values for the same ABI. The per-address merge passed `true` and threw `two events with same name but different inputs`; the global list -- the one the fetch filter is built from -- passed `false` and **spliced the second event out with no error, no log and no metric**. So the same ABI was refused or quietly truncated depending on a parse-config flag, and a parse-config flag decided which events existed.

  The silent branch was the dangerous one. The dropped event's `topic0` never entered the topic list, so its logs were never requested, and afterwards nothing distinguished "the chain had none" from "we never asked" -- an absence inferred from a request that was never made, the same failure class as `absence` versus `contradiction` in the reorg model and as `SuspectedTruncationError`.

  There is now ONE rule, applied to every ABI list, per-address and global alike, and keyed on the canonical signature (so on `topic0`, which is its hash) rather than on the name:
  - **different `topic0` -> both events are KEPT**, whatever their names, and both topics are requested. That covers two contracts declaring same-named events with different inputs, and two versions of one contract's event across an upgrade (`Transfer(address,address,uint256)` and `Transfer(address,address,uint256,bytes)`), which at the upgrade block can both legitimately occur, since the upgrade transaction sits mid-block and a transaction before it still fires the old event;
  - **same `topic0`, identical definition -> collapsed to one**, with no error. Two contracts sharing an identical event de-duplicate exactly as before;
  - **same `topic0`, different definition -> REFUSED at construction**, with a message naming both declarations and the topic they collide on. Nothing on the wire tells those apart, and no block boundary helps either.

  Two smaller consequences of keying on `topic0`. An argument filter is configured by event NAME, so it now applies to EVERY `topic0` that name covers; previously one topic took the filter and any other went into the shared, unfiltered request. And the definitions are compared on what DECODING reads (parameter names, types, `indexed` flags, tuple components, `anonymous`) rather than with a whole-object comparison, so two compilations of the same event that disagree only on `internalType` still collapse instead of being refused.

  Asserted against the topics the fetcher REQUESTS (`packages/core/test/fetchFilter.test.ts`), not against the ABI it accepted, because what it accepted was never the thing that was wrong.

  This unblocks `abi-versions-are-block-ranged`: with no per-range ABI buckets, two versions of one event land in the same flat list, and a source carrying both could not be constructed at all until this landed.

- e7d06c9: A payload whose blocks do not ascend is now REFUSED, where it used to be silently partly discarded. `feed()`'s cursor argument is now required.

  The engine reads a payload in order. With an empty unconfirmed window the FIRST group's block number becomes the boundary above which events are new, and the next window is built in payload order, so a block arriving after a higher-numbered one was dropped without a word, and the window left behind was unordered, which made the following cycle's boundary wrong too. `assertWellFormed` checked that every log sat inside the batch's range but said nothing about their order, so an out-of-order payload crossed the wire and lost logs on arrival.

  The check is applied at all three entry points: the wire (`assertWellFormed`), the host-fetch path (`feed()`), and the engine's own answer from the node. Equal block numbers are accepted, since a block holds many logs and their order within it is the node's `logIndex`.

  **Refused rather than sorted, deliberately.** `eth_getLogs` answers in ascending order and nothing legitimate reorders it, so an unordered payload means something upstream is wrong: a merging proxy, a sharded provider reassembling shards, a host building a batch by hand. Sorting would paper over that and let the real fault resurface later as missing data; failing names it while it can still be traced. If a provider is found doing this legitimately, that is the point to revisit the decision with the evidence in hand.

  `feed(events, cursor)`'s second argument is no longer optional. Omitting it substituted a fresh cursor with `latestBlock: 0`, which made every block unconfirmed regardless of depth and left `lastToBlock` at 0 for ever, so the generation never advanced. No caller omitted it, and its sibling `replay()` already required it.

- da289e2: A published snapshot a client cannot read is REFUSED, never installed as state — closing the last corner `tagged-bigint-codec-across-storage-adapters` left open knowingly (ADR-0040).

  The blob snapshot's format number now lives in `@etherfold/core` as `BLOB_SNAPSHOT_FORMAT`, beside the codec it versions, so the WRITER (`@etherfold/cli`'s keeper) and every READER import one number. It used to be the CLI's own `SNAPSHOT_FORMAT`, which the browser could not see (`@etherfold/browser` must not depend on the CLI and still bundles for a tab), so the CLI refused a format-1 file locally while `keepStateOnIndexedDB` installed the same bytes — whose every `uint256`, with no fallback reviver left, arrived as the string `"123n"` instead of a BigInt. `isReadableBlobSnapshot` and the `BlobSnapshotEnvelope` type are exported alongside it; the CLI no longer exports a format constant of its own.

  `keepStateOnIndexedDB` now checks the number on every remote fetch: an unreadable snapshot is refused whole (never translated, never half-read) and the refusal is logged with the location and both numbers. An unreadable mirror is treated exactly as an unreachable one already was — skipped when it loses selection, failed over from when it wins — and local state that is already ahead still wins over any remote, readable or not. A prefix-form mirror's bare `lastSync` file carries no format and is read as SELECTION data only: nothing from it is installed, and the state file it selects for carries the check.

  The ENTITY snapshot envelope's constant is renamed `ENTITY_SNAPSHOT_FORMAT` (`@etherfold/state-store`; re-exported by `@etherfold/processor-entities`) so the two envelopes — which version different file shapes and revise independently — are distinguishable by NAME at a call site that can hold both. They are not merged.

  Nothing is published under `@etherfold/*` yet, so no format-1 snapshot exists in the wild: this is a guard added before the first release rather than a breaking correction to one already shipped.

- ab779b0: Every deployment shape stores the emission stream it folded, not only the one behind an HTTP route.

  `appendEmissions` had exactly one call site, the HTTP ingest route, so `etherfold run` and `etherfold build` -- which fold through the direct in-process wire and touch no route -- produced databases whose `_emissions` table was EMPTY. That made the stored stream a fact about the TRANSPORT, exactly as the reorg counters were one task earlier (ADR-0050), and on worse ground: a `build` artifact is a publishable database later fed into another process, so without a stored stream a processor-logic change has to re-fetch the whole history from the node rather than re-fold what is already on disk, and both of ADR-0006's feed views were a split-shape-only surface.

  **The append is a port on the FOLD, supplied by whoever owns the store** (ADR-0052). `StreamBuilder.receive` hands each batch's emissions to an `EmissionAppender` once, whichever entrance the batch arrived through, and the ingest route is a CALLER of `receive` rather than the owner of a write -- so a receiver that both concludes a batch and serves the request that carried it stores it once, and `run`, `build` and `index` all store what they fold.

  **This write is NOT best-effort, and it is ordered BEFORE the fold.** A reorg count that cannot be persisted is a logged miscount; a stream that cannot be persisted is a HOLE -- a state that advanced past events the stream never received, which is silent, permanent, self-consistent and invisible to the gap check. So a store that cannot take the batch refuses the batch: nothing is processed, the cursor does not move, and the next cycle re-derives the same delta.
  - **`@etherfold/core`** gains `EmissionAppender` and `EmissionWrite`, plus `StreamBuilderOptions.appendEmissions`. Like `recordReorg` it is not hashed into the wire identity, and it is optional: a host that supplies none stores no stream, and folds identically. `IngestionOutcome.emissions` is unchanged and is still REPORTED, but a caller that stored it would now be storing a second copy.
  - **`@etherfold/server`** exports `emissionAppenderFor(db, indexer)`, which binds the append to a database and a named indexer. Its ingest route performs no durable write at all now: everything a batch costs happens inside `receive`, and the route decides who may call it and which status code each refusal is. A store failure is a `500` with `lastError` set, and the sender's own recovery is unaffected -- nothing was applied, so its next attempt meets the cursor it already had.
  - **`etherfold`** builds the appender in `buildProcessor`, beside the reorg recorder and against the same handle, so no folding command can store into a database it does not fold into. **`--indexer` becomes OPTIONAL on `run` and `build`, defaulting to `default`**, and stays REQUIRED and never defaulted on `fetch` and `index`. The never-defaulted rule protects the WIRE (a name a host was not built with must be a routing error, ADR-0036), and a combined process routes nothing: it needs a name only to KEY the stream it stores, which is `NOT NULL` on every emission row. `serve` still refuses the flag.

  **One behaviour change worth reading before upgrading:** `--no-auto-setup` against a database nobody has migrated now STOPS a fold rather than degrading it, because the fixed tables carry `_emissions` and a fold that cannot store what it folded must not advance past it. The cycle is retried and the deployment catches up when the schema arrives.

  `packages/cli/test/equivalence.test.ts` compares the stored streams of `run` and `fetch` plus `index` row for row and column for column, asserts the `build` artifact carries the same seven rows under the default name, drives a refused append and asserts it leaves no hole, and serves both feed views over a database a combined process folded. `packages/server/test/oneEmissionAppendSite.test.ts` scans the workspace and asserts there is no second site appending to that table.

- 793f3d6: EVERY FEED RESPONSE SAYS WHICH GENERATION ANSWERED IT.

  Both views over the stored emission stream (`GET /{indexer}/feed` and `GET /{indexer}/canonical`) now carry `generation` on every answer they give, pages and refusals alike, beside the `stream` they already carried.

  ```json
  {"success": true, "stream": "…", "generation": "<opaque>", "entries": [], "cursor": "<opaque>", "hasMore": false}
  ```

  **It exists for the one change no cursor check can catch.** A `seq` is a position in a STREAM, so a move to a generation over the SAME stream leaves every cursor valid, and a move to one on a DIFFERENT stream is already refused by the cursor's stream component. What is left is SAME LOGS, DIFFERENT FOLD: nothing in a cursor can see it, and a consumer reading state alongside the feed has to be told. The cursor is opaque, so a readable field beside it is the only thing a consumer can compare across polls.

  **The value is OPAQUE: compared, never parsed.** `generationDigestOf` (`@etherfold/core`) renders a `GenerationId` -- the stream digest plus the processor's version hash -- as one 128-bit hex digest, so what a generation is composed of can change without a consumer noticing. The registry keeps the two halves as separate fields because it KEYS on them; a value reported outward is not a key, and a consumer handed two named fields would read one of them.

  **A processor change costs a feed consumer nothing but the notice.** Its cursor stays valid, the delivered logs are byte-identical, and no generation column is added to the log table -- which is exactly what makes such a change free.

  **The platform ADVERTISES and does not DICTATE.** There is no rule about what a consumer does when the value moves: pausing, re-scanning and carrying on are all legitimate, and only the consumer knows whether its own actions can be taken back.

  **`LogIngestion` grows `generation`** (`@etherfold/core`), the `{stream, processor}` identity of the receiver, derived on every read rather than snapshotted: `getVersionHash()` covers a processor's configuration as well as its version, so a value captured at construction can stop being true. `StreamBuilder` supplies it; a host that implements the interface itself now supplies one too.

- 56acbef: Every deployment shape counts the reorgs it concluded, not only the one behind an HTTP route.

  `etherfold run` reverted state on a reorg correctly and then reported `{absence: 0, contradiction: 0}` on `/status` for ever, because the counter was written by the HTTP ingest route and a combined process folds through the direct in-process wire and never touches it. `etherfold build` had no `Meta` table at all. So an operational counter was a fact about the TRANSPORT, and the shape the milestone calls the default was the one that could not report it. Nothing was mis-indexed: the fold was already correct in both shapes, and the equivalence suite proved it. What was missing was the observability, on the one `/status` field the two shapes did not agree about.

  **The count is taken where the reorg is CONCLUDED, and written by whoever OWNS the store** (ADR-0050). `StreamBuilder.receive` reports a concluded revert to a `ReorgRecorder` exactly once, whichever entrance the batch arrived through, and the deployment that opened the database supplies that recorder. The ingest route is a CALLER of `receive` now rather than the owner of a write, so a receiver that both concludes a revert and serves the request that carried it counts it once, and `run`, `build` and `index` all count.
  - **`@etherfold/core`** gains `ReorgRecorder`, `ReorgCounters`, `RecordedReorg` and the durable key names (`REORG_COUNTER_KEY`, `REORG_LAST_KEY`), plus `StreamBuilderOptions.recordReorg`. The keys live here because the writer and the reader are deliberately in different packages: a read tier owns no store and still has to answer "how many reverts does this database record". `recordReorg` is not hashed into the wire identity, since where a count goes is not something a sender asserts. `IngestionOutcome.reorg` is unchanged and is REPORTED rather than delegated: a caller that counted from it would count only on the shape it happens to be, and twice on the shape that is both.
  - **`@etherfold/server`** no longer exports `recordReorg` and writes no counters. It reads them (`readReorgCounters`) for `/status`, including on a read tier that folds nothing, and `ReorgCounters` is re-exported from core. Its dependency posture is unchanged: it still owns no store package.
  - **`@etherfold/platform-nodejs`** exports `ensureFixedSchema(db)`, the auto-setup step `startServer` already performed, so a process that binds no port can still create the fixed tables.
  - **`etherfold`** owns the one writer (`recordReorg`, `reorgRecorderFor`), built by `buildProcessor` against the handle the command folds into, so no folding command can count into a database it does not fold into. **`build` applies the fixed-table schema**, which it never did: it binds no port, so nothing else ever would, and a database it emits is a publishable ARTIFACT that must carry its provenance the moment it becomes an INPUT rather than an output.

  **A counter that cannot be persisted never takes down a fold or a request**, on any shape. That guarantee belonged to the route (`recordReorgSafely`); it lives in `StreamBuilder` now, so it is owed by every shape that counts.

  `packages/cli/test/equivalence.test.ts` drops the exception it carried and compares the `/status` counters between `run` and `fetch` plus `index` directly, through the reorg it already drives: the same counts, the same classification, the same block, and once each. `packages/core/test/oneReorgWriteSite.test.ts` scans the workspace and asserts there is no second site recording a reorg.

- 1d619c9: A non-canonical generation REPORTS ITS PROGRESS, and a generation whose stream is unusable DEGRADES to a full re-index rather than breaking.

  **`SyncingState.nonCanonicalGenerations` (`@etherfold/browser`)** — every generation this indexer holds that is not answering reads, each with `{record, follows, lastToBlock, blocksBehind}`. It is the FACT and the DISTANCE and deliberately nothing else: only the developer knows whether their reconfigure made the old answers WRONG or merely INCOMPLETE, so the app decides whether to render, dim or hide and this library picks none of them. Do not add a `shouldRender`, a `stale` flag or a percentage here — a percentage needs a span to divide by, and which span is a presentation decision the two reported cursors already support.
  - `lastToBlock` is `undefined` before a generation has loaded, which is a different claim from being level at block 0.
  - `blocksBehind` is floored at zero, so a generation AHEAD of the canonical one (which `manual` allows) reads as "not behind" rather than as a negative number.
  - A generation LEAVES the list the moment the canonical pointer names it, and the generation the pointer moved OFF enters it — it is retained, which is what makes moving the pointer BACK a revert, and "a generation you could revert to exists" is the same fact reported the same way.

  **`HeldGeneration.lastSync` (`@etherfold/core`)** — how far ONE held generation's fold has got, or nothing before it has loaded. A getter, like `pauseState`, so a caller holding the object watches a distance close instead of reading the value it had when the object was built. The container already kept every generation's cursor (the promotion trigger is a comparison between two of them); this exposes it rather than recording it twice.

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

- b0e9a0d: A reconfigure now REPORTS whether it discarded the state, and the browser hook stops publishing state the core has thrown away.

  `updateProcessor`, `updateIndexer` and `reset` decide between two very different outcomes -- the computed state survives, or it is gone and being rebuilt -- and used to tell nobody. They now return `ReconfigureOutcome` (`{stateDiscarded: boolean}`). The widening is additive: a caller that ignored the resolved value still compiles and still behaves identically.

  That silence was a live defect for any caller holding a COPY of the state, which is every UI. `onStateUpdated` fires when a state is ADOPTED or PRODUCED, and a discard is neither, so `createIndexerState(...).state` went on publishing the discarded state until the next event happened to arrive and overwrite it. On the free-form path that is the old state VALUE: stale numbers, rendered by every subscriber, looking exactly like a working app.

  The wait was unbounded, and the case that makes it unbounded is the ordinary local-development one. These apps redeploy behind a proxy, so the address does not move and the regenerated ABI is what changes; the indexer correctly discards, correctly re-indexes, and correctly finds NOTHING, because a freshly redeployed implementation has not emitted anything yet. With no event to overwrite it, the tab showed state computed from the contract that is no longer deployed for the rest of the session. The same held for an edited processor swapped in under a bumped version, and for an explicit `reset()`.

  The hook now re-seeds `$state` at the moment of the discard, and only then: a reconfigure that KEPT the state must not blank it, or saving a file that changed nothing would empty the UI. Both directions are pinned in `packages/browser/test/reconfigure.test.ts` and driven in Chromium, Firefox and WebKit in `packages/browser/browser/indexing.spec.ts`.

  Note what did NOT change, because it is the trap an integrator meets first: a version hash is AUTHOR-DECLARED (`version`, the entity declarations, the config, and nothing derived from handler code). An edited handler under an unchanged `version` is not a change the core can see, so `updateProcessor` skips the swap and the edit never runs. Bump `version`, or pass `{force: true}`.

- 8d1c6c5: **A DOCUMENTED DEPLOYMENT VARIABLE IS REMOVED, not an internal flag.** `PROVIDER_SUPPORTS_ETH_BATCH` was an environment variable `platforms/nodejs-fetcher` documented in its configuration table, and it is gone from that table, from `@etherfold/fetcher-host`'s resolved config and overrides, and from `@etherfold/core`'s `ProvidedIndexerConfig` and `ProvidedLogFetcherConfig` as `providerSupportsETHBatch`. An operator who sets it now sets nothing: it is ignored like any other unrecognised variable, with no warning, no alias and no deprecation period, on the same ground as `STREAM_ALWAYS_FETCH_TIMESTAMPS` before it (CONTEXT.md: nothing is published, so backward compatibility with what was released is not an obligation, and a variable that is read and ignored is indistinguishable from one that works).

  **Why it buys nothing any more.** The knob existed so the per-hash block and transaction fetches could go out as ONE batched request instead of N. Those fetches are DELETED (ADR-0073), so the engine's whole chain-facing surface is one `eth_getLogs` per range, one `eth_blockNumber` for the tip and one `eth_chainId` for the identity guard: there is no request left that a batch could carry, and therefore nothing for a deployment to tell the engine about its provider's batch support.

  **This is NOT a re-prohibition of batch RPC.** A caller's provider may batch whatever it likes, transparently, and the engine neither knows nor cares. ADR-0002's consequence bullet is rewritten to say exactly that rather than deleted, because a bullet that simply disappeared would read as a reversal of the correction it was written to make.

  **No stream forks and no history is re-fetched.** The flag was a SIBLING of `stream` rather than a member of it, so it was never part of the resolved stream config and never in the digest taken over it. Unlike the `stream` flags removed alongside it, this one is digest-neutral for every deployment, including one that set it.

- 114879f: **`ReplaySource.readChunk` returns a VERDICT, and `RebuildReport` says WHY a chunk stopped** (ADR-0070). This finishes ADR-0069, which corrected `ExistingStream.fetchFrom` and missed its bounded sibling reading the same `_emissions` rows.

  ```ts
  type ReplayRead<ABI> =
  	| ({status: 'chunk'} & ReplayChunk<ABI>)
  	| {status: 'absent'}
  	| {status: 'does-not-reach-back'; startBlock: number}
  	| {status: 'inconsistent'; reason: string};
  ```

  `readChunk` returned `undefined` both for "nothing has ever been stored here" and for "a perfectly good stream that starts ABOVE where this fold resumes". The first is transient -- the writer may append. The second recurs on every call for ever, because the resume point comes from the fold's own durable checkpoint, and a **seeded** stream is the shape that produces it. Collapsed, a host could only keep polling: `origin.level` stayed false, so the follower never inherited a vacant write duty and never promoted, while burning a scheduled invocation per cycle and reporting it as an ordinary "not finished yet".

  `RebuildReport.absent` is **replaced** by `stopped: RebuildStop` (`stream-consumed` / `budget` / `nothing-stored` / `does-not-reach-back` / `undecodable` / `inconsistent`). `complete` now answers one question, as `PruneReport.complete` does. Three stop reasons cannot be fixed by retrying, and **`retryCanAdvance(stopped)`** is the exported derivation that says which -- previously the only discriminator was an undocumented `toBlock === undefined && !absent`.

  **If you implement `ReplaySource`:** return the verdict. `inconsistent` has no in-repo producer and exists so a third-party store has somewhere to report damage.

  **If you schedule `rebuildMore`:** loop while `!report.complete && retryCanAdvance(report.stopped)`. Both halves matter -- `complete === false` alone spins for ever on three of the six reasons, and `retryCanAdvance` alone never stops, since it is true once the stream is consumed too.

- 5adafa9: The indexer and its cached event stream agree on which of them is ahead, so the cache can be behind or ahead but never HOLED.

  A **hole** is a range of blocks the stream never RECEIVED, hidden behind a cursor that claims to cover them (`[100..5000]` then `[6001..7000]`, cursor at 7000). It was reachable in one ordinary session with no crash and no reload, and nothing detected it afterwards: segments are keyed by save rather than by block, so a save that never happened leaves no trace, and the next state discard replayed the stream as though it were whole.

  **The stream is now written BEFORE the processor is called, and a batch that was not written is not processed.** `promiseToIndex` processed and then saved; the processor persists its own state inside `process()`, so a failed save left the stream a batch behind, and the next cycle computed its delta from the already-advanced cursor and jumped over a range whose events the stream never got. A failed write now means the cycle achieves nothing and the next one tries again from the same cursor: nothing is lost, nothing is skipped. It also makes a second invariant free — **a retraction is never written into a stream that lacks the event it retracts**, because the unconfirmed window cannot advance past the stream.

  **A cache can no longer wedge the indexer, and the retry is bounded and paced.** After `streamWriteRetry.maxConsecutiveFailures` consecutive failed writes (default 3, one attempt every `streamWriteRetry.delaySeconds`, default 1) the cache is FROZEN, said loudly through `named-logs`, and indexing carries on without it. Frozen means frozen, not cleared: what is on disk is a contiguous prefix with a cursor that describes it honestly, so it still seeds a rebuild, and throwing it away would cost a re-fetch from the source's first block. The one cause that DOES clear is a store that is out of SPACE, since there the cache is itself the problem; keepers say so on the error they throw and `isOutOfSpace` reads it structurally (the flag, or the Web platform's own `QuotaExceededError`), exactly as `retryable` is read.

  **A stream that is AHEAD of the state is now REPLAYED rather than re-fetched.** The state-DISCARDED load branch always fed the cached stream; the state-KEPT branch only validated it and had no `else`, so a tab that closed between the two writes caught up from the NODE and appended those blocks to the stream a second time — and the next rebuild saw them twice. It now feeds them, re-decoded against the source running now (ADR-0034), which turns a node re-fetch into a local replay.

  **A stream holding a CURSOR and no events now resumes from that cursor.** The fetched cursor used to be adopted only as a side effect of feeding events, so a deployment whose contracts have emitted nothing left the in-memory cursor at `freshLastSync` and re-scanned from the start block on every reload, forever.

  Two mechanisms are DELETED rather than fixed. `streamNotYetSaved`, the in-memory carry-forward of unsaved events, never fired: it lived on the save action's promise CONTEXT, which is reset unless a save is queued onto one still in flight, and the index cycle awaits its save. It existed only to compensate for processing first, and it appended without de-duplicating. With it gone, `createAction`'s `setContext`/`getContext` had no callers and are gone too. What replaces it is the inverse: the extent of the last SUCCESSFUL write, held in memory, so a processor that throws deterministically cannot grow the cache by one duplicate copy per retry — and where the chain reorged under events the processor never accepted, they are RETRACTED into the stream, because the state cannot retract what it never applied.

  `@etherfold/browser` gains all of this through the core it drives; `ProvidedIndexerConfig.streamWriteRetry` reaches it through `createIndexerState(...).init`. See `docs/adr/0038` for why a frozen stream is never appended to again and why that decision cannot be the keeper's.

- a6963b4: The canonical pointer moves BACK: an operator undoes a bad upgrade with one small write, and the previous generation answers exactly as before, with no re-index and no re-fetch.

  **`POST /{indexer}/admin/canonical-generation` (`@etherfold/server`) is the operator's affordance** (ADR-0057), guarded by a NEW `ADMIN_TOKEN` that FAILS CLOSED when unset. Forwards it promotes, BACKWARDS it reverts, and there is deliberately no second verb for the second direction: it is one record write.

  ```
  POST /alpha/admin/canonical-generation      Authorization: Bearer $ADMIN_TOKEN
  {"stream": "<stream digest>", "processor": "<version hash>"}
  -> 200 {"previous": {...}, "canonical": {"stream", "processor", "digest"}}
  ```

  `GET` on the same path is how an operator learns what there is to point AT: which generation answers reads now, and every generation this name holds, each with the OPAQUE `digest` a feed response advertises it by (compared, never parsed), so the advertised value is matched against the listing rather than taken apart.

  **It is an HTTP route because that is the only affordance every deployment shape has.** A Cloudflare Worker is reachable only over HTTP, so a flag on a command could never serve one, and the command set is pinned at five verbs. The CLI inherits the route by hosting the same app.

  **`ADMIN_TOKEN` is a SECOND credential and deliberately not `INGEST_TOKEN`.** That one is handed to a log shipper and guards the WRITE path; letting it also decide which generation answers reads would give a fetcher control-plane authority. The two guards now share ONE constant-time comparison (`api/auth.ts`), so "is a token accepted" has one answer rather than two that drift. `POST /admin/setup` is untouched and stays unauthenticated.

  **`ReceivingIndexer.promote` no longer requires this host to hold a FOLD for the target** (`@etherfold/core`). Reads on this runtime resolve the pointer to a table NAMESPACE (ADR-0053), so the generation reverted to answers with no engine at all -- which is the ORDINARY case, since a host redeployed with the new processor holds only the new fold. Requiring one would have meant a revert could only be performed by a process first rebuilt with the OLD processor, which is the re-index the design exists to remove. The refusal is now the registry's `UnknownGenerationError` (surfaced as `400 unknown-generation`, naming every generation the name holds) instead of a container-level "holds no fold" error.

  **A BACKWARDS move drops NOTHING, under any promotion config.** `ReceivingIndexer` now tracks whether the pointer has EVER named a held fold -- the chain-facing container's `everCanonical` flag, as a set -- and drop-on-promotion applies only to a FORWARD move: a revert supersedes nothing, and dropping what it moved away from would delete the very generation a second move forward wants (ADR-0046).

  **`IndexerRegistryEntry` gains two OPTIONAL questions**, `generations()` and `promote(id)`, which `ReceivingIndexer` already answers and `indexerEntryOn` forwards. A host holding one fold and no registry (`singleContextEntry`) answers `501 generations-not-held` on the admin surface: a capability that deployment lacks, not a route that is missing.

- 50748cf: The engine now DECLARES the provider methods it asks for, and holds itself to them.

  `ENGINE_PROVIDER_METHODS` is the declared set and it is stated once, in the engine: `eth_getLogs` for the logs, `eth_blockNumber` for the tip, `eth_chainId` for the identity guard, and `eth_getBlockByNumber` at the chain's first block when a source declares a `genesisHash`. One data call, the rest identity and tip, which is ADR-0073's sentence made checkable rather than aspirational, and the EIP-1193-only constraint of ADR-0002 with it.

  `declaredMethodsOnly(provider)` is the wrapper that enforces it. `IndexerGeneration` (including the reconfigure path), `LogFetcher` and `captureStream` now hold their provider behind it, so ONE seam sees every call each of them makes: it RECORDS the methods requested (`methodsRequested`, which is what a test asserts the subset against) and REFUSES anything else with an `UnexpectedProviderMethodError` naming the method and what it would cost. The wrapper is idempotent, so a reconfigure does not stack guards.

  Why a refusal rather than a note. Deleting the enrichment path made the claim true; nothing in a deletion keeps it true. A reintroduced `eth_getBlockByHash` breaks nothing and returns the right answer. It just costs a round trip per block against a provider a browser user is rate-limited on, so it surfaces in a profile months later rather than in CI in seconds. Refusing at the seam is what makes it fail wherever it is added, over any node or test double that would have answered it.

  The one method that can read a block is narrowed further, by the same argument: `eth_getBlockByNumber` is allowed at the chain's FIRST block (`0x0`) and refused at a height, because a block read at a height is the deleted per-block cost wearing a different method name.

  What a caller has to know:
  - **Nothing changes for a well-behaved deployment.** The engine asks for exactly what it asked for before; no call is added, removed or reordered, and no identity, digest or stored byte moves.
  - **A provider given to the engine is not the object the engine holds.** It is wrapped. A caller keeping its own reference is unaffected; a caller reaching into the engine for `provider` gets the guarded one.
  - **The declared set is exported**, so a deployment reasoning about what its node will be asked for, or a proxy deciding what to allow through, reads the set rather than a sentence in a README. The READMEs state the same set and a test holds them to it, so widening it is a documented act rather than a quiet one.

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

- 01ed0ef: The generation registry is DURABLE on SQL: which generations a named indexer holds and which one is CANONICAL are now rows in the database the server and the CLI already own, so a restarted process comes back holding what it held and pointing where it last pointed.

  `openGenerationRegistryOnSQL(db, indexer, {caps, dropState?})` (`@etherfold/server`) is the third substrate for the port `openGenerationRegistry` already defines, after the reference one in memory and the IndexedDB one in `@etherfold/browser`. It supplies rows and inherits every rule: registration resolving an already-registered generation, the caps that REFUSE at the bound and evict nothing, the deletion that refuses the canonical generation, the reaping of a stream whose last generation goes, and the sweep of subtrees no registered generation claims. Two fixed tables carry it, in the reserved `_` namespace and in the static schema file both application paths share (`SCHEMA_VERSION` is now 3): `_generations` (the records) and `_generation_pointer` (one small row per named indexer: the canonical identity, and the guard below). `listStreamDigests` and `dropStreamSubtree` answer over `_emissions`, which is where a stream physically lives on this runtime, scoped to one indexer name.

  **A commit is atomic over a seam that cannot hold a transaction open across a decision** (ADR-0054). `RemoteSQL` is `prepare` + `batch`, and a batch is a pre-built statement list, so a commit reads the state together with a REVISION token, guards every statement it writes on that token, swaps it for a fresh unique one as the last write of the same batch, and reads it back inside that batch to learn whether it won. A loser's whole batch applies to nothing and it re-reads, re-decides and retries; after `MAX_COMMIT_ATTEMPTS` losses it refuses with `GenerationCommitContentionError` rather than looping. So a cap decided by two writers at once cannot be beaten: the refusal is always made from the state the write actually lands on, never from one that had moved on.

  **The WRITER of a stream is now the OLDEST SURVIVING generation held on it** (`writerOf`, `@etherfold/core`; `GenerationRegistry.writerOf`). ADR-0044 said the writer is the first generation held on a stream and never the canonical one, and said nothing about that generation being DELETED, which unhandled is a silent stall: the receiver for a shared stream's wire context is the writer. The rule is RESTATED rather than replaced (at the start the oldest survivor IS the first one held) and succession is atomic with the delete because it is stored NOWHERE: there is no writer column to move in a second write, so the commit that removes the record is already the one that hands the duty on. See ADR-0044's amendment, which also names where the engine half lands.

  The CAPS are stored nowhere by this substrate: no caps table, no caps column, no sixth port operation, and `openGenerationRegistryOnSQL` defaults none, because how generous a server or a CLI should be is a deployment's statement and not a substrate's.

- 629dff0: The load-time genesis check now asks for block `0x0` instead of the `earliest` tag, and tells its three failures apart.

  `earliest` is not genesis. The JSON-RPC tag means the lowest block the CLIENT HAS, which is block 0 only when the client happens to have block 0. A pruned or partially-synced node's lowest block is wherever its history begins, and a chain that has had a REGENESIS has nodes whose earliest block IS the regenesis point, by design, and several L2s have done exactly that. Both answer the tag with a real block whose hash is not the genesis hash, so a source declaring a `genesisHash` refused to start against a perfectly healthy node on the RIGHT chain, and the message said it was connected to a DIFFERENT one. That is a false positive whose wording actively misleads, on the one check whose entire job is to be trustworthy about identity. The check now names the bottom of the CHAIN (`0x0`) rather than the bottom of that node's history, with the reason written at the site so it does not get tidied back.

  Fixing the tag alone would have moved the problem rather than removed it, because the check could not tell a wrong chain from a node that would not answer. It now refuses in three named ways, and a caller does something different about each:
  - `GenesisHashMismatchError`: the node served block 0 and it is not the declared genesis. The only one of the three that is a claim about WHICH CHAIN the node is on. It carries `expectedGenesisHash` and `receivedGenesisHash`, so the numbers an operator compares against their contracts file are in the error rather than only in an English sentence. `retryable: false`.
  - `GenesisBlockNotServedError`: the node answered with no block, which is ordinary on a pruned node and says nothing about the chain. The message is about not being able to CHECK, and names the two remedies (a node that serves block 0, or `skipGenesisCheck`). `retryable: false`, because a node does not acquire history while a caller waits.
  - `GenesisCheckUnavailableError`: the request itself failed: a timeout, a rate limit, a dropped connection. Previously nothing caught this at all, so a flaky endpoint at startup propagated out of the load path exactly as a real mismatch did. It carries the underlying `cause` and is `retryable: true`, the position `IngestionUnavailableError` already holds on the ingestion path.

  All three are exported from `@etherfold/core` and follow the package's `retryable` convention, so a host reads the flag structurally rather than matching on a message.

  Two smaller things ride along. The commented-out per-cycle genesis check, which carried the same `earliest` mistake and would have reintroduced the bug the day anyone uncommented it, is DELETED rather than repaired: reviving a per-cycle genesis read is a decision about cost per cycle, not a line to uncomment, and the one place that asks the question is now `checkGenesisHash`. And the provider-surface guard's genesis probe (`isGenesisProbe`) is narrowed to `0x0` alone: it accepted both spellings only so this fix could land as the small change it is, and `earliest` is no longer a question this engine asks.

  `skipGenesisCheck` also gains the docstring it never had, including what turning it off actually costs: a fork answering the right `eth_chainId` is then indexed as the chain it claims to be.

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

- ed8e7ff: What the fetcher has learned about your provider is now READABLE, and can be handed BACK on the next start. Nothing persists it, and that is the decision rather than an omission (ADR-0074).

  The range fetcher works out how wide an `eth_getLogs` range a node will answer by asking, being refused and adapting. It tracks three numbers, all in blocks: a `ceiling` it has been refused at (or that the provider wrote out in its refusal), the widest `safeSpan` that has actually been answered, and the `nextSize` it will ask for next. All three lived in private fields, invisible from outside and gone on restart, so every process start re-paid the discovery from the 50-block starting range upwards and an operator could only infer any of it from timings.

  **`LearnedRange` is now a published type, reported and accepted back.** `LogFetcher.learnedRange` reports it, `LogFetcher.limits` reports it beside `suspectResultCount` (the count and its source, which the previous change made readable but left off every status surface), and `fetch.learnedRange` accepts the same object as configuration. A field is ABSENT rather than zero where nothing has been learned, because a ceiling of `0` reads as "this provider serves nothing" and that is not what "nothing learned yet" means.

  **`GET /status` gains `fetcher`**, from a reporter a host injects beside its cursor reporter (`ServerOptions.getFetcherLimits`, carried through `@etherfold/platform-nodejs`): `{reported: true, learnedRange, suspectResultCount}`, or `{reported: false, reason}` when a reporter cannot answer. It is ABSENT entirely on a host that holds no fetcher, which is most of them -- the receiving half of ADR-0003 makes no chain call at all, so `index`, `serve` and the Workers host carry no such field and nothing is invented in its place. `etherfold run` holds both halves and injects one.

  Unlike the `cursor` beside it, the field is TYPED rather than opaque. A cursor's meaning lives behind the storage seam and belongs to a processor (ADR-0027), which is why ADR-0047 has the server carry it verbatim; a learned range is `@etherfold/core`'s, it is three numbers, and it hides behind no seam -- so a dashboard reading `fetcher.learnedRange.ceiling` reads a documented field. What is kept from ADR-0047 is the half that still applies: a reporter that throws, rejects or has nothing to say degrades to a reason rather than to an omission, because "this deployment runs no fetcher" and "this deployment's reporter is broken" are different news, and neither ever fails the request or changes `healthy`.

  **`LEARNED_RANGE` is the door it comes back in by** (`@etherfold/fetcher-host`, so `etherfold run`, `build` and `fetch` all read it): the reported object, pasted back as JSON. Then the first request asks for what the last run found to work. It is a STARTING POINT and never a promise -- every number is still bounded by `MAX_BLOCKS_PER_FETCH`, adaptation runs over it unchanged, and a provider that has tightened since refuses it and lowers the ceiling on that first round trip, so a stale value costs a retry and can never wedge. A partial object is legitimate (`{"ceiling":2000}` alone is a real thing to know), and an unrecognised key is IGNORED rather than refused, so a report that grows a field does not turn a supervisor that pastes it into an outage. What IS refused, at startup and naming the field, is a value that cannot be read at all: not JSON, not an object, or a member that is not a positive whole number of blocks. The startup line says when a range was remembered, so an unexpected first span is attributable.

  **Nothing is written to any store, by design.** `LogFetcher`'s docstring states the test for state the chain-facing half may hold -- losing it must cost ONE extra request and nothing else -- and the learned range fails it, since losing it re-pays the walk up from the starting range. It is still only performance, so the answer is to move the memory OUT of the stateless component rather than to give that component a store: a fetcher that writes something down can be restored from a stale copy of it, owns that copy's lifecycle, and has a place for the next block number to be put, which is the split brain ADR-0004 exists to remove. Pushing it to the receiver was rejected on its own ground: it puts a fact about ONE SENDER'S PROVIDER into a wire contract that deliberately carries no sender identity.

  A deployment that configures nothing behaves exactly as it did before, byte for byte: the discovery spans a fetcher walks through against a refusing provider are asserted unchanged.

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

- 449f6fb: A processor upgrade costs a LOCAL SCAN: a successor catches up by REPLAYING the stored emission stream, in bounded chunks against a durable checkpoint, and the canonical pointer moves once at the end.

  **`GenerationRebuild` (`@etherfold/core`, `generation/rebuild.ts`) is the driver**, and it is platform-neutral: a Node cron, a CLI loop, a browser idle callback and a Cloudflare queue can each drive it. One call does a bounded amount of work and REPORTS whether it finished, which is the shape `prune` and `compactEmissionPairs` already have (ADR-0022) — never a side effect of a write.

  ```ts
  const [report] = await indexer.rebuildMore({maxEmissions: 500});
  // {generation, fromBlock, toBlock, scanned, replayed, retracted, highWater, complete, absent}
  while (!report.complete) {
  	/* re-invoke; a serverless host enqueues itself instead of looping */
  }
  ```

  **The CHECKPOINT is the successor's own sync cursor, and there is no second durable value.** A chunk is applied through `EventProcessor.process`, which persists the `LastSync` describing each block in the SAME transaction as that block (ADR-0027), so "the state and the checkpoint commit together" is the guarantee the storage seam already makes rather than one this driver arranges. `GenerationRebuild` holds NO position between calls: a new process, a new isolate or a new container over the same database resumes from what the store committed.

  **A chunk is a budget in EMISSIONS, cut on a BLOCK boundary, and always ending ABOVE the fold's own position (ADR-0056).** The stored stream is `seq`-ordered and a reorg puts an application, its retraction and its replacement at ONE block at arbitrarily separated `seq` values, so a chunk ending mid-block would leave rows below its own resume point and skip them for ever. And a resume point REACHES BACK over the reorg window, so a budget spent inside blocks the fold already covers would cut the chunk where the fold already is and the same chunk would be asked for for ever — hence `ReplayChunkQuery.foldedThrough`. The budget is therefore advisory in those two places, both bounded by something else, and `RebuildReport.scanned` says how many rows were really read. `DEFAULT_MAX_EMISSIONS_PER_CHUNK` is 2000.

  **"Caught up" is measured against the stream's own COVERAGE CLAIM**, which moves on every batch including the quiet ones (ADR-0055), and therefore in the same space the promotion trigger already compares in. The emission `seq` high-water is READ and REPORTED on every chunk (`RebuildReport.highWater`) as the honest size of what is being folded, but it is not the predicate: see ADR-0056 for why it cannot be one without a second durable checkpoint.

  **`storedEmissionReplaySource` (`@etherfold/server`) is the read it consumes**: the same `_emissions` rows as `storedEmissionStream`, in bounded slices, over the coverage claim (ADR-0055) so a fold resumes past a quiet range rather than at its last log. It is read-only by construction — the port has no write on it at all — which is the one-writer rule (ADR-0044) as a type rather than as a no-op.

  **`ReceivingIndexer` now DETERMINES follower-or-receiver from the stream, and never from a flag** (ADR-0044). A fold on a stream the container already holds is a FOLLOWER: no receiver (a stream is ONE address on the wire), a `GenerationRebuild` instead, and `HeldFold.follows` reports it. `ReceivingIndexerOptions.replay` supplies the stream to re-fold, and a container given none REFUSES such a fold rather than registering a generation that could never advance. `HeldFold.ingestion` is consequently optional; `liveIngestions()` is unchanged for callers, and `ReceivingIndexer.ingestion` still answers for the fold a host opened with.

  **The pointer moves ONCE, at the end, and the generation left behind is RETAINED.** `ReceivingIndexer` applies the promotion policy (`promotion`, defaulting to `on-catch-up` with nothing dropped, as in every runtime) and exposes `promote(id)`, which no policy value gates. The TRIGGER is lifted rather than copied: `readyForPromotion` and `promotionOnAdd` are new exports of `generation/promotion.ts` and both containers now go through them, so there is one answer to "when does the pointer move on its own". `immediate` together with `dropOnPromotion` is REFUSED on this runtime, because the deferred drop that setting requires is not built here and accepting it would discard a complete state for one that has proved nothing.

  **`batchStreamForDelivery` (internal) is the delivery cut, now shared by the engine and the rebuild.** A replayed stream can carry an application, its retraction and the replacement at one block; handing all three to a single `process()` call reverts to the fork and then applies two blocks at the same height, which is a primary-key collision and not a fold. `IndexerGeneration.promiseToFeed` keeps its notifications, cancellation window and pacing and now takes the cut from this one function.

- 7af8558: `suspectResultCount` is now DISCOVERED from the provider where the provider reports it, instead of being a number an operator has to guess about their own node. An explicitly configured value still wins.

  This is the sharpest correctness knob in the fetcher. It is the count at which a result set is treated as SUSPECT rather than complete, and the detection is exact-count matching because it cannot be anything else: a capped answer and a complete one differ in nothing. Set it wrong and a node capping silently at 5000 hands back 5000 logs, the guard does not fire, a short range is pushed as a complete one, and the receiver reads the missing logs as an absence — an absence is a reorg, and a reorg deletes state (ADR-0004). It defaulted to 10000 and was otherwise a guess, while several providers state their real cap in every refusal.

  **Three tiers, most specific first: `configured` → `reported` → `default`.** A configured value is an ASSERTION about your node and outranks everything, because a number parsed out of an error message is weaker evidence than a deployment saying what it knows; a reported cap may only FILL the gap an unconfigured deployment leaves; the default is unchanged (`fetch.maxEventsPerFetch`, itself 10000, in core — and 10000 flat in `@etherfold/fetcher-host`, which still refuses to let the suspect count follow how much a fetcher asks for).

  **`reportedResultCapFromError` is the fourth reader of one refusal**, beside `getNewToBlockFromError` (how far to shrink this retry), `statedBlockCapFromError` (a ceiling on every range from now on) and `archiveRefusalFromError` (stop, this endpoint serves no history) — and the only one whose answer is not about a range at all. It reads two shapes, structured before prose as the others do: the `limit` of a `{from, to, limit}` descriptor (`{"code":-32005,"data":{"from":"0xBDE5F8","limit":10000,"to":"0x102DBCC"}}`, Infura, quoted verbatim in ethers-io/ethers.js#4703), and a count written out beside what it counts — `Query returned more than 50000 results` (Gnosis, Chiado, Fraxtal, zkSync Era, Abstract), `logs matched by query exceeds limit of 10000` (Arbitrum One and Nova), `a cap of 10K logs in the response` (Alchemy), all captured 2026-09-08 in `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.

  **The two fields of the structured descriptor gate each other.** `getNewToBlockFromError` already required `limit` before believing a `to`, because a bare `to` may be a provider echoing the request back; this requires `to` before believing a `limit`, because a bare `limit` is also what a provider calls a request-RATE allowance, and a rate limit read as a result cap would make the fetcher suspect every answer of 100 logs and stop outright on a block holding exactly that many.

  **A cap is read only where the words name what is COUNTED.** Providers cap this method by block SPAN or by RESULT COUNT, the numbers differ by orders of magnitude, and the sentences look alike, so the result patterns anchor on `results`/`logs` exactly as the block ones anchor on `block range`: `exceeded maximum block range: 5000` reaches neither this reader nor `suspectResultCount`, and `logs matched by query exceeds limit of 10000` — which the block reader deliberately refuses — is exactly what this one takes. The LOWEST plausible candidate in a refusal wins, and a later, HIGHER report never raises an earlier one, both for the same asymmetry: a suspect count below the node's real cap costs a re-fetched half-range, while one above it misses the truncation entirely and pays for it in deleted state. A number that could not be a count of logs (zero, negative, fractional, above 10,000,000) is ignored and logged rather than trusted.

  **What is in force, and where it came from, is now readable rather than inferred.** `LogFetcher.suspectResultCount` is a public getter returning `{count, source}` with `source` one of `configured` / `reported` / `default`, re-resolved per fetch so a cap learned from the very refusal that provoked it applies immediately. A discovered cap taking effect is logged, and so is a configured value overriding a reported one — the line an operator needs when telling "my configuration is wrong" from "my provider says this". `SuspectedTruncationError` carries the same `source` and names it in its message, with the fix that follows from it (a REPORTED count is overridden by configuring one). `@etherfold/fetcher-host` prints which tier its startup number is.

  **Two shapes changed:** `SuspectedTruncationError`'s constructor takes the source as a third argument, and `FetcherHostConfig` carries `suspectResultCountSource: 'configured' | 'default'` beside the number. The second is what makes the whole thing work on the deployed path: the host resolved its default into the same field an operator's value goes in, so every deployment looked configured to core and no reported cap could ever have filled the gap.

  Scope: `suspectResultCount` exists only on the split fetcher path. The single-process indexer has no equivalent truncation guard, and this change does not add one.

- 4da7b27: `storedEventOf` and `storedStreamOf` are exported from the package entry, so code OUTSIDE the package reduces a decoded event to a stored one through the ONE implementation of that rule.

  ```ts
  import {storedEventOf, storedStreamOf} from '@etherfold/core';

  await keeper.saveNewEvents(source, {
  	eventStream: storedStreamOf(events), // no local copy of the three-key destructure
  	lastSync: {context, latestBlock, lastFromBlock, lastToBlock, unconfirmedBlocks: []},
  });
  ```

  **What justifies the export, because it decides how far it goes.** The keeper seam takes only what the node said and the decoded half (`args` / `eventName` / `decodeError`) is a cache re-derived on read (ADR-0060), so anything that WRITES a stream applies this strip. The engine's own writes reach it internally; what could not was a seed PRODUCER or an installer written outside core, and the evidence is committed — `docs/spikes/pin-the-seam-a-published-stream-arrives-through/install.mjs` copied the destructure, which is the duplication ADR-0060 exists to prevent. ADR-0063 names publishing these as a build item.

  **The cursor strip stays internal.** `storedLastSyncOf` is not published: an installer BUILDS the cursor it writes (an empty window and the capture's own block numbers, ADR-0063) rather than stripping a live one, so publishing it would offer an outside caller a tool for a job it does not have. It is one addition to widen if a producer turns out to need it.

  Nothing inside core changed: this is a re-export of the module the engine already uses, so the strip still happens once, on the way into `saveNewEvents`, and no existing behaviour or test moves. Reachability THROUGH THE ENTRY is pinned from a consumer's suite (`@etherfold/browser`'s `storedStripIsPublished.test.ts`), because a test beside the function cannot see it — which is the whole of that package's change here, and why it is a patch with no runtime difference.

- 9229c30: The emission-stream write port now carries the stream's COVERAGE CLAIM, and it is handed over on EVERY batch rather than only on the ones that emitted something.

  `EmissionWrite` gains `coverage` (`StreamCoverage`): the FETCH-filter half of the identity these logs were fetched under, plus `latestBlock` / `lastFromBlock` / `lastToBlock`. It is the cursor record ADR-0035 says a keeper keeps beside its stream, in the shape that ADR ended up with — no unconfirmed window, because a keeper's copy of the window is read by nobody and a replay rebuilds it by walking the events.

  **Why a store cannot derive it.** `MAX(blockNumber)` is the highest block that carried a LOG; the fetch cursor is the highest block that was SCANNED. A range that carried no logs moves the second and not the first, so a stream whose coverage is derived from its rows under-claims for as long as the chain is quiet. A successor re-folding it sits permanently behind the incumbent, and at promotion the canonical generation presents an `expectedFromBlock` too far back — whose re-sent batches ADR-0052 appends a SECOND time. See ADR-0055.

  **Why the empty batch is no longer skipped.** `StreamBuilder` used to return early for a batch that emitted nothing, on the reasoning that "there is nothing about it for a stream to hold". There is exactly one thing, and the quiet cycle is the only place it can come from. So the appender is called with an empty `emissions` array and a moved `coverage`, which is the shape ADR-0035's empty save already has on the segment keeper (`writeCursorOnly`): one small write, nothing proportional to the history.

  The visible edge of that: the append is deliberately not best-effort (ADR-0052), so a store that cannot be written now refuses a QUIET batch too. That is the correct direction — a fold that cannot record how far it got must not advance past it.

- 8c8341a: The cached event stream appends in SEGMENTS, so a save costs its batch and not the history.

  `keepStreamOnIndexedDB` used to read the whole stream, concatenate and write all of it back on every `saveNewEvents` — a full structured clone of the accumulated history per index cycle, which made a backfill QUADRATIC and charged an empty batch the same price purely to move the cursor. It now writes one immutable SEGMENT per batch, at the next ordinal, together with a CURSOR RECORD, in one `readwrite` transaction; nothing already written is ever touched again, and an empty save writes only the small cursor record.

  The rules live once, in `@etherfold/core`'s new `createSegmentedStream`, over a five-operation `StreamSegmentPort` a keeper supplies (`commitSegmentWithCursor` / `readCursor` / `writeCursorOnly`, plus a scoped segment read and a scoped delete). A SQL keeper and an OPFS keeper are the expected next consumers, and they inherit every rule: the ordinal allocated from the cursor record INSIDE the commit, the full ordered scan on the way back, the one comparison that refuses a write which would leave a hole, and the one rule for damage.

  **A stream is now addressed HIERARCHICALLY**, as IndexedDB array keys in `idb-keyval`'s default store: `['stream', <indexer-name>, <digest>, <ordinal>]` for a segment and `['stream', <indexer-name>, <digest>, 'cursor']` for the cursor record. The digest level carries a PLACEHOLDER derived from `chainId` until the real stream digest lands, so two chains under one indexer name stay isolated exactly as `stream_<name>_<chainId>` kept them. Segments are read with a key RANGE, never a whole-store scan.

  **A stream stored in the previous whole-blob format is DELETED and re-indexed, not adopted**, and the deletion is logged. Nothing is published and no disk anywhere holds state this had to preserve, so the cheap branch is the right one.

  **An inconsistent stream is CLEARED rather than repaired** — a gap in the ordinals, segments with no cursor, an unparseable segment, or a stream that does not reach back to the block a rebuild asks for. Nothing raises: the indexer takes its existing clear branch and re-fetches. A cursor with NO segments is not damage and is kept, because that is the ordinary state of a deployment whose contracts have not emitted anything yet.

  **The stream keeper stores no `unconfirmedBlocks`**, in a segment or in the cursor record, and `fetchFrom` returns a `LastSync` whose window is `[]`. The window's two homes that are actually READ (the state keeper's saved cursor, and the entity path's serialized sync cursor) are unchanged.

- 628df9d: **What a stream keeper is handed to persist no longer carries a decoded half.** The indexer strips `args`, `eventName` and `decodeError` on the way into `saveNewEvents`, so a keeper receives the raw log the node reported plus the reorg verdict the indexer derived, and nothing an ABI made of those bytes.

  This is a BEHAVIOUR change to what `@etherfold/core` persists, not a type change: the keeper seam still declares what it declared before, and narrowing it is a follow-on change. Nothing on disk is rewritten and no migration runs — segments written before this keep their decoded half forever, and a read tolerates it and ignores it, because `LogEventFetcher.reparse` drops and re-derives that half against the source running now regardless (ADR-0034). Reuse across a decode-only change is therefore unaffected: a renamed non-indexed parameter still replays the cached stream instead of re-fetching a block.

  The strip lives ONCE, in core, at the save call site. `ExistingStream` is third-party-implementable and has several implementations already, so a rule each keeper had to remember would drift; a third-party keeper needs no change and simply stops seeing fields it was never allowed to trust.

  Both halves of what the saver takes are stripped, the batch and the `lastSync`'s unconfirmed window. The window is worth stripping because a keeper's copy of it is never read back AS EVENTS — the load path takes a stored cursor for its three block numbers and its context only, the live reorg window is the indexer's in-memory one, and a transaction-inclusion question is answered from the state keeper's copy — so leaving it decoded would leave the one stale thing in the stream. Both strips build NEW objects: the events are the ones the processor is about to fold, and the same `lastSync` object is handed to the state keeper on the same tick, so stripping in place would corrupt the fold's input and silently empty the live reorg window.

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

- 0a53b98: Close the residue the generation work left behind: writer succession is real in a running process, a reaped stream takes its coverage claim with it, and a container no longer answers reads from a generation the pointer does not name.

  **WRITER SUCCESSION now moves the ENGINE, not only the records** (`@etherfold/core`, ADR-0044's second 2026-09-06 amendment). ADR-0044 says the writer of a stream is the oldest SURVIVING generation on it, and that succession is atomic with a delete because it is stored nowhere — but only the durable half was built. In a running process, deleting a writer removed the only RECEIVER its stream had: an incoming batch resolved to nothing, nothing appended, and `/status` went on looking healthy while the cursor stopped. `ReceivingIndexer` now re-derives which held fold writes each stream from the records it is already reading, and hands the survivor the engine — the fold stops following, its bounded rebuild is retired, and it gets a receiver carrying the emission appender. It is a reconciliation rather than an event handler, because a generation can be deleted by another process, and it costs nothing when nothing moved.

  **A survivor that has not caught up does NOT take the wire.** A receiver asks `expectedFromBlock` from its own fold position and ADR-0052 appends a re-sent batch again, so handing the wire to a follower mid-rebuild would store a second copy of everything back to its cursor — indistinguishable afterwards from real emissions. It keeps following until its rebuild reports level, then takes over. An unfed stream is visible and recoverable; a duplicated range is neither.

  **`ReceivingIndexer.canonicalGeneration()` now returns `GenerationId | undefined`** rather than falling back to the fold it opened with. `openGenerationRegistry.canonical()` resolves the pointer against the RECORDS, so it answers nothing when the pointer names a generation whose record has gone. The fallback served reads from a generation nobody asked for, silently, where a read tier over the same rows refuses (`503 no-canonical-generation`, ADR-0058) — one database with two answers depending on who was asking. The registry's answer is now passed through, so every host agrees. `IndexerRegistryEntry.canonicalGeneration` already had this shape and the feed already refused on it, so no call site changes.

  **`dropStreamSubtree` deletes the stream's COVERAGE CLAIM with its rows** (`@etherfold/server`). A stream lives in two tables — its emissions, and the `_stream_coverage` row saying how far they reach — and they are written in one batch. They are now deleted in one batch too. PRESENCE is the claim and never the rows, so a reap that took the rows and left the claim left a stream reading as PRESENT AND COMPLETE with nothing in it: a generation folding it would be told it had re-folded the whole history and could resume at the old tip, with empty state, durably, with no error anywhere. That is the whole-history form of the hazard `startBlock` exists to prevent, and it was reachable through the ordinary unregistered-subtree sweep.

  **`VersionedStateProcessorOptions` accepts `tableNamespace`** (`@etherfold/processor-sqlite`). A generation's state is a table-name namespace (ADR-0053), so without it two generations built through this convenience class over one handle landed on the same tables and shared rows silently. The entity-path assembly the CLI folds through always took the option; the narrow `Pick` predated the namespace.

### Patch Changes

- 0ba3c60: A cancellation arriving while the processor is applying a batch no longer makes the next cycle deliver the same events twice.

  `unlessCancelled(p)` rejects the CALLER; it cannot stop `p`, and it only throws once `p` has RESOLVED. So when a cancellation fired during `process`, the batch had already been applied and persisted, state and cursor together in one transaction (ADR-0027), and the engine threw before its in-memory cursor moved. The next cycle re-derived the same range and handed the same events over again: on a store that refuses a re-applied block that is a wedge no number of cycles clears, and on one that accepts it, a silent double-apply.

  This is the ordinary path rather than an exotic one: every reconfigure verb calls `disableProcessing()` first, and the cancellation lands in exactly this window.

  The completed batch is now recorded before the cancellation is honoured, in both the `indexMore` path and the `feed`/`replay` batch loop, so the in-memory cursor agrees with what is on disk.

  **Why the work is kept rather than reverted.** Reverting would be the intuitive fix and is not available: `process` is the processor's own transaction, its write is already durable, and the `EventProcessor` interface has no per-batch undo, only `reset`/`clear`, which discard everything. Keeping a completed batch and recording it is both the smaller change and the one that leaves the two halves consistent.

- 9fa7f35: A provider on the wrong chain is refused with `UnexpectedChainError` everywhere the question is asked, and the refusal names the chain the source indexes, the chain that answered, and where it was caught (ADR-0081).

  The split deployment's fetcher already threw that type. The in-process engine threw three hand-written bare `Error`s instead: one at LOAD, one at RECONFIGURE (a multi-line template literal, indentation and all), and a per-cycle one that said only `chainId changed after fetch` -- which tells an operator nothing about which chain anything is on, and which nothing could catch except by matching a sentence. All three now throw `UnexpectedChainError`, so one condition has one type, one `retryable` answer (`false`, read structurally by `@etherfold/fetcher-host`) and one thing for a host to classify, and all three read the chain id through the same internal helper as the fetcher rather than through a fourth copy of the hex parse.

  **A refusal states only consequences that hold on the path that threw it.** The fetcher's message ends with "nothing is pushed: the receiver makes no chain calls, so it could not catch this", which is the whole reason that check exists there (ADR-0003) and is meaningless on the engine's three paths, where there is no receiver and nothing is pushed. So the CHECK POINT is what the constructor takes, and the message is built from it: the per-cycle refusal says the fetched logs were dropped and the cursor stayed put, the load refusal says nothing was loaded and what to point where, and the reconfigure refusal keeps the old prose's remedy (a provider on another chain needs a source for that chain).

  **What changes for a caller:** these three failures are now catchable by type and carry `expectedChainId` / `actualChainId` as fields. `UnexpectedChainError`'s constructor is unchanged for the fetcher path -- the same three arguments, and `'before'` / `'after'` produce byte-identical messages -- and its third parameter is WIDENED to `ChainIdentityCheckPoint` (`'before' | 'after' | 'cycle' | 'load' | 'reconfigure'`), which is additive. Code matching the old engine messages (`chainId changed after fetch`, `Connected to a different chain`) has to match on the type instead.

- 2b4f3fc: A decode failure now records the REAL error instead of one constant string.

  `LogEventFetcher.decodeOnto` assigned `decoding error: <the actual error>` in its catch and then fell through to a block whose `else` overwrote it with `parsing did not return any results`, because `parsed` is null on exactly the path that had just set the message. The informative branch was therefore unreachable in the OUTPUT, and every failure — a `topic0` the ABI does not declare, data that does not fit the member its `topic0` names, a log carrying no topics at all — recorded the same uninformative sentence. Those are three different faults with three different fixes, and `decodeError` is STORED on the event (`LogEventWithParsingFailure`), so that sentence is what an operator reads back off a stream long afterwards.

  The catch now RETURNS, so the real error survives. What is stored is the error's FIRST LINE, which is `<ErrorName>: <what went wrong>`: a stringified viem error runs to several lines carrying a docs URL and `Version: viem@x.y.z`, and persisting that would put a dependency's version number into stored data and churn it on every bump. So a failure reads `decoding error: AbiEventSignatureNotFoundError: Encoded event signature "0x..." not found on ABI.` rather than `parsing did not return any results`.

  The `parsing did not return any results` branch is kept for a decoder that returns something falsy without throwing, which viem does not do today.

  No API changes: `decodeError` is still a string on the same type, and `apply.ts` — the only reader in the tree — tests for its presence rather than its value.

- a1fccd0: A FOLLOWER now notices a retraction the writer it follows appended while PAUSED, instead of silently keeping a branch the chain abandoned.

  A follower (a generation on a SHARED stream, ADR-0044) decided there was nothing to follow by comparing the stored stream's cursor against its own (`lastSyncStored.lastToBlock <= current.lastToBlock`). That is sound for a RUNNING writer, whose `lastToBlock` rises with the tip on every cycle, and WRONG for a paused one: a pause caps `toBlock` at the cursor it paused on (ADR-0045), so a reorg the writer detects at or below the cap during its drain is appended to the stream — retraction and replacement both — while `lastToBlock` never moves. A follower level with the cap took the early return and never replayed either, so its state stopped being a fold of the stream it claims to fold, and nothing reported it.

  The follow path now asks the question of the STREAM instead of a summary of it: a follower remembers the emissions it last folded over the range it resumes from (block hash, index in the block, application or retraction) and does nothing only while what the stream holds there is emission-for-emission the same list. The stored cursor still contributes the half it cannot be wrong about — a stream reaching past this fold is new by definition. An idle follower therefore still re-walks nothing and re-delivers nothing, and a follower still issues zero `eth_getLogs`, writes zero segments and clears nothing. See ADR-0049.

  Nothing about PAUSE changes: the cap and the frozen `lastToBlock` are the drain's own termination condition, and a paused writer is behaving correctly. No public API changes; a follower simply lands where a from-scratch fold of its stream lands, which is what it always promised.

- 23c1eae: A published stream seed can now be FETCHED from a list of locations and INSTALLED by writing through the public keeper seam, so a generation folds it with `eth_chainId` as the only call a node ever sees.

  `installStreamSeed` (`stream/seedInstall.ts`) takes an ORDERED list of locations, the keeper the generation will be handed, and the RESOLVED stream config, and returns an outcome as DATA: installed, with where it came from and how far it reaches, or not installed with a reason (`no-locations`, `unreachable`, `unreadable-format`, `does-not-reach-back`, `subtree-not-empty`). Failover walks the list, so an unreachable mirror is logged and skipped and a BUILD-EMBEDDED artifact at a relative, hostless path listed last is reached like any other location (ADR-0066).

  Installing is a run of ordinary `saveNewEvents` calls and nothing else (ADR-0063): no new keeper operation, no substrate access, and no second copy of the segmentation rules. The block arithmetic is the whole of it -- the first batch carries the seed's own coverage start, each later batch continues the previous exactly, and the last claims the coverage END above the last event-bearing block -- and the stored `context` is the seed's own, verbatim.

  An install goes only into an EMPTY subtree and refuses anything else, including its own half-written prefix, which a caller CLEARS deliberately before installing again (ADR-0067). The refusal is non-destructive as well as non-writing: the keeper's only read CLEARS a subtree whose stored `startBlock` is above the block it was asked from, so the emptiness probe asks from a block no cursor can start above, and refusing an install can never be what deletes the stream it refused.

  **It is deliberately NOT exported from the package entry yet**, because it verifies nothing: it does not check that the seed is for this stream, that its bytes match a pin, that its events are coherent, or that the capture was taken far enough below the chain head. Those admission checks all run before the first write, and the export lands with them.

  Nothing existing changes; this is additive and reachable only from core's own tests for now.

- ebfa4f0: A stream seed whose body cannot be DECOMPRESSED is now refused `unreadable-format` rather than `unreachable`.

  Both reasons were already in `NotInstalledReason`, so nothing about the type changes; what changes is which one a corrupt or truncated artifact produces. The fetch now stops at the transport and the inflate happens under its own refusal, because the two reasons send someone to different places: a host that answers `200` with a half-uploaded file has been REACHED, and calling that "could not reach it" points an operator at their network while the artifact is what is broken. `unreadable-format` already means "something was fetched and it is not a seed this build reads", which a body that will not inflate is. Failover is unaffected — either reason walks to the next location.

  The `@etherfold/browser` entry is for tests only, with no runtime change: the snapshot-only mode's fixture now publishes a cursor whose observed tip is the finality depth above the snapshot's own block, and the client passes `finalityDepth`, so the consumer half of ADR-0028's two-sided defence is actually exercised. Previously the publisher reported the snapshot's own block as the tip it had seen — which is what indexing straight to the tip produces — and against that `insideReorgWindow` is true for any positive depth, so the guard could never have been on. A new case asserts a snapshot taken at its producer's tip is refused `inside-reorg-window` and installs nothing, and that the same document one finality depth deeper is admitted.

- ce43a7b: A reconfigure that changed nothing no longer re-indexes: the stream config is RESOLVED before it is hashed, everywhere.

  The stream-config hash meant two different things. `reinit` stored the digest of the config `resolveStreamConfig` had filled in, so the persisted `context.config` always carried `finality`; `updateIndexer` digested the config exactly as the caller PASSED it. A caller who left `finality` unset — which is the ordinary case, and the whole reason the resolver exists — therefore produced a hash that could never match the stored one, whatever else that reconfigure changed or did not change. `sourceInvalidationOf` reported `reason: 'stream-config'`, which invalidates the STREAM half from block 0 as well as the state half, so the fold was discarded and, with no stream cache to rebuild from, the entire history was re-fetched from the node.

  The resolve-then-hash step is now ONE function, **`streamConfigHashOf(stream)`**, exported from `@etherfold/core` beside `resolveStreamConfig` and for the same reason: a caller that builds a `ContextIdentifier` or a `WireContext` of its own has to reach the same digest the engine stored, and hashing the config a user passed instead of the config that runs is exactly how that goes wrong. Every site in the package goes through it — both verbs of the indexer, `wireContextOf`, and `captureStream`, which had the same defect and would write a fixture cursor no indexer running the default `finality` could match. A test asserts there is no second site in `packages/core/src` hashing a config.

  **No digest moves and nothing is re-keyed.** `resolveStreamConfig` is idempotent, so a caller already holding a `UsedStreamConfig` (the wire identity) reaches the byte-identical digest it did before; `simple_hash` and the shared `canonical_form` are untouched; `streamDigestOf` already resolved and is unchanged. What a genuinely moved config does is unchanged too: `alwaysFetchTimestamps`, `alwaysFetchTransactions`, `parse.filters` and an explicitly different `finality` each still invalidate both halves from block 0. This removes a false positive, not the rule.

- 1524a04: A concluded reorg no longer DROPS the logs the replacement branch carries below the lowest block we held logs for. They were fetched, discarded in memory and never fetched again, because the next range starts above them: silent, permanent loss, reaching the stored emission stream and both feed views and not only the in-memory stream.

  `generateStreamToAppend` admitted an incoming block only at or above a HEIGHT (`reorgBlock.number` on a reorg, the window's top plus one otherwise). That threshold claims "we already hold everything below this", and `unconfirmedBlocks` holds only EVENT-BEARING blocks, so the window is SPARSE and its lowest entry is usually far above the height the chain actually forked at. Fork at 195 while the lowest block we held logs for is 200, and every log the new branch carries in 195..199 is inside the re-fetched range, dropped by the comparison, and gone.

  The rule is now MEMBERSHIP of the retained window, by `(number, hash)`: a re-fetched block is NEW unless the window that survived this cycle's retraction already holds it. Nothing is delivered twice, which is the job the threshold was really doing — a re-fetch never starts below `latestBlock - finality`, and a block that carried events inside that window entered `unconfirmedBlocks` when it was applied, so anything we already applied is still there unless it was retracted. It is also the rule the REPLAY path in the same file already applied, by hash, for the same de-duplication reason; the two entries now agree.

  Reorg DETECTION is untouched: the absence-versus-contradiction classification (ADR-0004), the retractions from the reorged block onward, the finality prune and the reorg counters (ADR-0050) all behave exactly as before, and no re-fetched range was widened.

  Two deliberate consequences. The no-reorg path changed on the same ground: a block inside the re-fetched range the window does not hold is now delivered even when nothing reorged and it sits below the window's top (by the same invariant, we never applied it). And the rebuilt `unconfirmedBlocks` is sorted ascending, which a height threshold used to guarantee for free and the readers of that window still assume. See ADR-0051.

- e72cbec: An ERC-721 and an ERC-20 in one source no longer refuse to construct a fetcher.

  `LogEventFetcher`'s constructor ran its ambiguity guard over the MERGED event list of every contract, and that guard throws "ambiguous ABI" when one canonical signature is declared twice with different decoding shapes. Both standards declare `Transfer(address,address,uint256)` and `Approval(address,address,uint256)`, differing only in their `indexed` flags, so mixing the two in one source refused to construct at all. That took out `new IndexerGeneration(...)`, `captureStream` and the load and replay path over any such source, including this repository's own conformance workload (Stratagems as ERC-721 plus Gems and GemsGenerator as ERC-20).

  The refusal now follows the DECODE path (ADR-0061). Per ADDRESS it is unchanged and unconditional, because within one address the ambiguity is real and undecidable. On the merged list it applies only where that list is what decodes a log: when no contract is declared per address, or when `parseAllEventsIrrespectiveOfAddresses` ignores the address. Otherwise a shared `topic0` with two shapes is tolerated, each declaration reachable only at its own address, and the shared `topic0` enters the fetch filter ONCE rather than throwing on the second sighting.

  Which events EXIST is untouched, which is what ADR-0031 protects: every `topic0` is still requested on either path and nothing is spliced out of the filter.

  Two honest consequences. Turning `parseAllEventsIrrespectiveOfAddresses` ON for such a source now REFUSES at construction, since with the address ignored the ambiguity is genuine. And a `LogParseConfig.filters` entry is keyed by event NAME, so on a tolerated collision one name covers one `topic0` and two indexed layouts: a filter constraining a position only one of them indexes (an ERC-721 `Transfer`'s token id sits in `topics[3]`, where an ERC-20 `Transfer` log has nothing) reaches the other address too and matches nothing there. That configuration was previously unreachable, because construction threw.

- dc08d24: `resolveStreamConfig` now treats an explicit `undefined` as an ABSENT KEY, so `{finality: undefined}` resolves to the default instead of to no finality at all.

  Every field of a `ProvidedStreamConfig` is optional, so `{finality: undefined}` type-checks, and it is exactly what a JSON round-trip or an options object built as `{finality: opts.finality}` produces. The resolver spread it straight over the default, and the damage was silent on three axes at once: `finality` became `undefined`, so `getFromBlock`'s `latestBlock - finality` evaluated to `NaN` and poisoned the block the next round asked from; the config hashed as though no default applied; and it therefore read as a DIFFERENT stream config from every other spelling of the same default, which is a full re-index on a reconfigure that changed nothing.

  The digest this feeds already collapses an explicit `undefined` to an absent key (`canonical_form`/`simple_hash`, pinned by `test/hash.test.ts` as "treats an explicit undefined as absent, exactly as JSON does"). The resolver disagreeing with the digest it feeds is what made the disagreement reachable, so the resolver is made to agree: any explicitly-undefined key is dropped before the default is applied, not just `finality`.

  **One consequence worth stating.** A caller that passed `{finality: undefined}` now hashes as the default rather than as `{}`, so its stored stream and state are re-keyed once. That case was already broken — its reorg window was `NaN` — so this converts a silent corruption into a single re-index, and no working configuration moves: `undefined`, `{}`, `{finality: 17}` and `{finality: undefined}` are now one config and one digest. A real value still wins, including the falsy `finality: 0`.

- 29895dc: Fixed silent, permanent event loss when a `feed`/`replay` batch loop is interrupted: every intermediate cursor is now true on its own.

  `promiseToFeed` hands the processor one batch at a time, and the processor PERSISTS the cursor it is given (`applyEventStream` writes it verbatim for the batch's last block). Those cursors were built by copying the FINAL cursor and walking `lastToBlock` forward, so every intermediate batch carried the final unconfirmed WINDOW: a cursor claiming to have synced through block X while listing blocks above X as already folded.

  That is unresumable. The engine treats the top of the window as the boundary above which events are new, so a run resuming from such a cursor skips every block between `lastToBlock` and the top of the window: they are neither below the resume point nor above the window, and nothing ever delivers them again. The loss is bounded by the finality window, permanent, and completely silent.

  The same defect handed a RETRACTION-ONLY batch the extent of the whole scan. A batch that reverts blocks 101 to 103 and applies nothing was told `lastToBlock: 103` while the fold was back at 100, with the replacement blocks still queued behind it. A crash between the revert and the re-apply left state reverted and a cursor claiming completeness, so the resumed run applied nothing and the replacement branch was lost outright.

  Both are reachable on the ordinary path, not only on a crash: every reconfigure verb calls `disableProcessing()` first, and a cancellation lands in exactly this loop.

  Now each batch is handed a cursor narrowed to what IT has folded, and only the LAST batch gets the stream's own cursor, at which point the whole stream is folded and the claim is true. A retraction-only batch reports the fork point, which is a genuine move backwards and the correct one: the state really is back there until the replacements land. A retraction-only batch that is the last one still takes the stream's cursor, so a scan that legitimately found nothing continues to advance.

  The narrowing rule now exists ONCE, as `cursorSyncedThrough`, newly exported from `@etherfold/core`. `@etherfold/processor-entities` re-exports it as `syncedThrough`, the name its callers already use: the engine narrows per batch and the processor narrows per block, and two copies of a rule this subtle is how the two halves drift apart.

- aa17a93: An unfiltered event is still requested when another event is filtered

  Configuring `parse.filters` for even one event silently stopped every OTHER event being fetched, whenever two or more events were left without a filter. Their logs were never asked for, so nothing downstream could tell "the chain had none" from "we never asked".

  An `eth_getLogs` topics array is POSITIONAL: slot 0 is the event selector, every later slot constrains an INDEXED ARGUMENT, and an array WITHIN a slot is an OR list. The shared request for the unfiltered topic0s was built by pushing them FLAT into one array, so `{topics: [approvalSelector, approvalForAllSelector]}` asked for a log whose selector is `Approval` AND whose first indexed argument equals the `ApprovalForAll` selector. Nothing can satisfy that, and a node answers it with an empty result rather than an error. They are now emitted NESTED in slot 0, which is what the no-filter path already did.

  WHO IS AFFECTED, and what to do. Any deployment that set `parse.filters` and left two or more event topic0s unfiltered has a stream with those events missing from it, from the first block it indexed. An ordinary ERC-721 filtered on `Transfer` lost `Approval` and `ApprovalForAll` entirely. The stored logs are wrong rather than merely stale, so the remedy is to re-index that stream rather than to resume it. With exactly ONE unfiltered topic0 the flat form was accidentally correct and nothing was lost.

  The test helper that could not see this is fixed too: `topicsRequested` read `request.topics?.[0]` alone, so a flattened conjunction read back as a single topic0 and the extra positional constraint was invisible to every assertion in a file whose subject is that an event is never silently dropped. It now reads the whole topics array and refuses a request carrying an event selector below slot 0.

- 49e73ae: **A generation's `createdAt` is now strictly increasing within a registry, so no two generations CREATED by this code can tie** (ADR-0072). A registry written by an earlier build can still hold a tied pair; nothing repairs those on open, and they keep resolving by hash as before. Nothing is published, so that set is empty today.

  It was a bare `Date.now()` — milliseconds — and `byAge` broke a tie on the processor HASH. `writerOf` names a stream's writer as the oldest surviving generation registered on it, so two generations registered in the same millisecond were ordered by hash rather than by registration, and a SUCCESSOR could be named the writer of a stream its incumbent already wrote. Measured on `ReceivingIndexer` with a frozen clock: **two folds with `writesStream: true`**, against one for the same fixtures named the other way round. That is the one-writer rule (ADR-0044) broken by a clock resolution, and consecutive `add` calls land in one millisecond routinely.

  `create` takes `max(Date.now(), newest + 1)` inside the same commit that writes the record. No new field and no durable-format change: `createdAt`'s own contract was already "ORDERING only, never identity", and a value nudged forward to stay ordered is more faithful to that than a raw clock reading.

  **The CLI now reads `RebuildReport.stopped`.** It called `rebuildMore()` and discarded the result, so ADR-0070's `retryCanAdvance` had no consumer in this repository — the exact loop that ADR is about. A follower that cannot advance is now reported once, by reason, and stays quiet while it can.

- 70f98d6: **Comments and docstrings that cited a `work/` artifact by a path it no longer has now cite one that resolves, and a gate keeps it that way.**

  No behaviour changes here at all: every source edit is inside a comment. What changed is that the citations were dead. A spec moving `work/specs/proposed/` to `work/specs/tasked/`, or a task moving to `work/tasks/done/`, is the workflow working as designed, and it silently breaks every reference to the old path. Thirty-four such references had accumulated across ADRs, guides, spike READMEs, findings, ideas, specs and seven packages' source, and nothing in the acceptance gate had ever read a path written in prose, so all of them were green.

  `pnpm check:refs` (`scripts/check-work-refs.mjs`) now resolves every `work/{specs,tasks,notes}/<folder>/<slug>.md` written in a navigable surface, and distinguishes the two failures that need different fixes: an artifact that MOVED (it names where it went) and one that is GONE (it tells you to cite what replaced it). Historical and terminal surfaces are exempt by design, because a dead path is CORRECT in a frozen record: `.changeset/`, `CHANGELOG.md`, `work/tasks/done/`, `work/tasks/cancelled/`, `work/specs/dropped/`, and `work/notes/observations/` (an observation whose subject is a broken reference has to be able to quote it).

  Eleven of the dead references were a second, sharper shape worth naming: they pointed at OBSERVATIONS that had been correctly deleted. The work contract discharges a spent observation by deleting it, with git history as the archive, so a durable comment that cites one by path is a dangling pointer by construction, created by the protocol working rather than by anyone forgetting. Those now cite the observation's SLUG, which is stable, greppable in history, and makes no claim that a file is there to open.

  Two were not observations and got real answers instead: `InvalidationVerdict`'s docstring pointed at an idea note retired in `8549133f` and now points at `stream-grafting-what-we-established`, which superseded it; and an idea note pointed at a task rewritten into `abi-versions-are-block-ranged` by `6f2c905b`.

- 3e9e9d0: Decoding a log is 3.2x faster: `LogEventFetcher` preselects the ABI event by `topic0` instead of letting viem re-search the whole ABI on every log.

  `decodeOnto` handed `decodeEventLog` every event member declared at the log's address, once per log, and viem then found the member the log names by re-deriving each candidate's event selector — a keccak per candidate, per call, memoised by nothing. Over a replay that search, and not the decoding, was where most of the decode time went.

  The fetcher now builds a `${address}:${topic0}` map ONCE, from the same de-duplicated per-address lists it already decodes against, and a hit passes a one-member ABI. Measured through the shipped path over the 31,330 real Base logs of `docs/spikes/replay-decode-cache/decode-breakdown.ts`: **58.2 µs/event before, 18.4 µs/event after, for a map that costs 0.24 ms to build** (`work/notes/findings/decoding-is-3x-faster-with-a-memoised-topic0-map.md`).

  **No published surface moves.** The map and the lookup are private, `reparse` and `parse` return exactly what they returned, and the same 31,330 logs are asserted to decode identically both ways. It is a memoised lookup and not a cache of a derivation: nothing is stored, and the map is rebuilt from the source whenever a fetcher is constructed.

  Two inputs deliberately keep the whole-ABI route, with a fallback rather than a refusal, so nothing can reach a path that did not exist before: an ANONYMOUS event, which carries no `topic0` to be keyed by, and a log naming an event the address does not declare. `parseAllEventsIrrespectiveOfAddresses` keeps its existing route too and grows no map of its own, because ADR-0031 is that it decides which ABI decodes a log and must never decide which events exist.

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

- d50583b: `GenerationContext` is now exported from `@etherfold/browser`, and the documentation no longer claims per-generation state is structural when it is a convention.

  `GenerationSpec.createState` said the separate step made "each generation has its own state" structural rather than a convention a caller may forget. It does not and cannot: `State` is opaque to the container, so it cannot tell two stores apart, and two distinct store objects can address one underlying database anyway, which is invisible from there by construction and is the way this actually goes wrong.

  The documentation now states the rule the caller has to keep: key the state on `context.stream`. Two generations under one storage location are ONE store by that backend's own definition, and they collide on the sync cursor as well as on the rows, because the cursor lives under a fixed key. The successor model, where the canonical generation keeps answering complete old answers while the new fold catches up, does not survive that.

  `GenerationContext` is re-exported from `@etherfold/browser` because that package's own public `createState` signature names it, so a consumer could not write the factory with an explicit annotation.

- 114879f: **Two rules that had two homes now have one** (ADR-0071).

  **`Indexer` asks the registry, not its own array.** Whether a new generation FOLLOWS its stream was decided from the order of the container's in-memory `held` array — whatever order the caller passed its specs in, and not durable across a restart. It now asks the durable registry whether any OTHER generation is already registered on that stream.

  Deliberately NOT `writerOf`, which looks like the unification and creates TWO WRITERS: `follows` is frozen per generation at add time (`readOnlyStream` is baked into the engine's config) while `writerOf` is a function of the whole record set at a moment, and `createdAt` is milliseconds with a processor-HASH tie-break — so two generations added in one millisecond can each see `writerOf` name themselves. Measured at 20/20 runs. No behaviour change on any path where the two agree, which is every path with a distinguishable `createdAt`.

  **`NotBootstrappedReason` gains `unreadable-format`.** `bootstrapFromSnapshot` reported `'unreachable'` both for a fetch that failed and for a document that WAS fetched and is not an envelope this build reads. The remedies are opposite: a host that did not answer may answer next time, so retrying is right; a document this build cannot read means the app or the publisher is out of date and retrying never helps. This is the reason an app renders to a user. The stream-seed path — the deliberate analogue, with the same failover and refusal-as-data vocabulary — has split the two since it was written; this union drifted.

  If you `switch` exhaustively on `NotBootstrappedReason`, add the new member. `pickReason` reports it above `unreachable` and below the two content checks: most specific first.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- 8baecea: **The `blockTimestamp` holdout has shipped, so four places stop naming it as open.** Documentation and one error message only: nothing is deleted, no flag is removed, no behaviour changes.

  `blockTimestamp` on the log (`ethereum/execution-apis#639`) was served by geth, reth, besu, erigon, anvil and ethereumjs, and the README, ADR-0002, `blockPointer`'s refusal and the `blockTimestamp?` docstring all named Hardhat's EDR as the one implementation that did not. It does now: `NomicFoundation/edr#1644` merged 2026-08-26 and released in `@nomicfoundation/edr@0.20.0` on 2026-09-02.

  Hardhat has not bumped to it (3.16.0 still bundles edr 0.19.0), but that is not a wait: EDR is an ordinary dependency, so a project can pull it forward with a package-manager override (`pnpm.overrides`, npm `overrides`, yarn `resolutions`). The requirement is therefore on the EDR version resolved, never on the Hardhat version, and the docs now say so.

  `stream.alwaysFetchTimestamps` STAYS, because two cases survive any version bump and neither improves with time: a node being FORKED that predates the spec change keeps the field absent rather than defaulting it (EDR's `Option<u64>` is deliberate, so a missing timestamp stays distinguishable from a real one), and EDR's on-disk RPC response cache replays such an absence once it has recorded one, until `rpc_cache` is dropped. (Not, as an earlier draft of this entry said, because pre-change cache entries keep answering: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and ignores the rest. Same conclusion, corrected mechanism.)

  `blockPointer`'s refusal now names the likely CAUSE rather than only the missing field, so an operator can act on it: an old node, a Hardhat bundling an older EDR (with the override as the fix), a forked node predating the change, or a stale EDR RPC cache.

  Whether the fallback is eventually DELETED is not decided here. That is argued in `work/specs/proposed/etherfold-is-a-fold-over-logs.md`.

- cb28315: The in-process engine's cycle makes ONE `eth_chainId` call instead of two, and it is the one AFTER the fetch (ADR-0081).

  `promiseToIndex` bracketed every log fetch with two identity calls and refused the cycle if either answer was not the chain the source names. The pair looked symmetric and was not: only the AFTER call is a guard, because the window that can corrupt anything is the fetch itself, where logs from chain B would be folded into chain A's stream and written to its cache. The BEFORE call only failed fast (it saved a wasted range when the provider had already moved between cycles) and caught nothing the after call does not. It is deleted, so every cycle costs one fewer round trip, in every deployment, with nothing new configured and nothing left undetected.

  **What changes for a caller:** a provider that moved BETWEEN cycles is still refused and still folds nothing, but the range is now fetched before the refusal rather than after, and the cursor does not move either way, so the next cycle re-derives the same range. A provider that moves DURING the fetch is refused exactly as before.

  The surviving call is unconditional and has no flag; making it optional was proposed and withdrawn, because nothing has measured its cost and it is the ONLY chain-swap detection that exists. The `chainChanged` event the old comment promised was never built: no listener exists anywhere, `EIP1193ProviderWithoutEvents` cannot structurally carry a subscription, and an asynchronously delivered event could not replace a check that runs at a known point, after the fetch and before anything is applied. The comment beside the surviving call now says that instead of promising a second line of defence.

- ad8d8b1: **A tightened provider cap no longer collapses the next request to a single block, and two refusal messages stop naming a mechanism that does not exist.**

  `RangeLogFetcher` learns two numbers about a provider: a CEILING it has been refused at, and the largest span it has been SERVED. Those two could go incoherent. A provider that tightens mid-run, or that states a cap smaller than a span it has already answered, left the ceiling BELOW the safe span, and the error-path bisection then read `Math.floor((ceiling - safeSpan) / 2)` -- a negative step, so the `Math.max(1, ...)` guard fired and the fetcher asked for ONE BLOCK, paying a round trip per block until it climbed back. `lowerBlockCeilingTo`, the only writer of the ceiling, now drops a safe span the new ceiling contradicts: the ceiling is the fresher evidence, and a width cannot be both known-safe and at or above a width that is refused. This is the rule the configured-range path already applied to a seeded `learnedRange`, now stated once at the only place the pair can go wrong.

  The same bisection was also missing its BASE. The error path asked for `floor((ceiling - safeSpan) / 2)` where the success path asks for `safeSpan + floor((ceiling - safeSpan) / 2)`, so a fetcher that knew a safe span asked for less than one that knew nothing (the no-safe-span branch asks for `ceiling - 1`). Knowing more made it slower. It now bisects up from the safe span at both sites.

  Neither is a correctness bug -- both cost round trips and recover on the following call -- but the first is the shape that makes a backfill against a tightening endpoint look wedged.

  **The `blockTimestamp` refusals no longer tell an operator to look for the wrong thing.** `TimestamplessLogError` (`@etherfold/core`) and `blockPointer`'s fold-time refusal (`@etherfold/processor-entities`) both listed, among the causes of an absent `blockTimestamp`, "an EDR RPC response cache written before the change". That reads backwards: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and IGNORES everything else in `rpc_cache`, so pre-change entries are not served at all. The real hazard is a CURRENT-format entry that recorded an absence from a FORKED remote predating the spec change, and it persists until `rpc_cache` is dropped. Both messages now say that, as do ADR-0073 and ADR-0002. The conclusion is unchanged -- the refusal is still permanent machinery, because the forked-node cause stands on its own -- but an operator following the old wording would have gone looking for a stale cache that EDR had already stopped reading.

  Also removed: `packages/core/src/internal/utils/extra.ts`, imported by nothing and holding the only `eth_call` in the package. It was built and typechecked but unreachable, and it was the one place a reader grepping the core for provider calls found a method the engine does not declare.

- 290e827: The split deployment's `LogFetcher` makes ONE `eth_chainId` call per cycle instead of two, and it is the one AFTER the fetch (ADR-0081).

  `fetchAndPush` opened every cycle with a chain-identity assertion and made a second one between the fetched range and the push. The pair looked symmetric and was not: only the AFTER call is a guard, because the window that can corrupt anything is the fetch itself, where chain B's logs would cross the wire under chain A's `{source, config}` and be indexed as ours by a receiver that makes no chain calls at all (ADR-0003) and so cannot check. The opening call only failed fast (it saved a wasted range when the provider had already moved between cycles) and caught nothing the surviving one does not. It is deleted, so every fetch cycle costs one fewer round trip with nothing new configured and nothing left undetected.

  **What changes for a caller:** a provider serving the wrong chain is still refused with `UnexpectedChainError` and still pushes nothing, but the range is now fetched before the refusal rather than skipped by it, and the fetcher holds no cursor, so the next cycle asks the receiver and re-derives the same range. A provider that moves DURING the fetch is refused exactly as before. A host counting a cycle's chain calls sees `eth_getLogs` then `eth_chainId`, in that order.

  `UnexpectedChainError`'s exported signature is unchanged: it still takes the expected chain, the actual one and which side of the fetch caught it. `'before'` is no longer reachable from a fetch cycle, and narrowing the constructor would be a breaking change on an exported type that buys nothing, so the parameter keeps both values and says so.

  The surviving call is unconditional and has no flag; making it optional was proposed and withdrawn, because nothing has measured its cost and it is the only chain-swap detection this deployment shape has.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- 4f206c3: The published-type dependency scanner reads declarations rather than text.

  `packages/core/test/publishedTypeDependencies.test.ts` asserts that every package a published `.d.ts` imports from is a real dependency, which is a good claim: a type-only import is erased from the emitted `.js` but SURVIVES in the emitted `.d.ts`, so a package whose public types name `abitype` or `eip-1193` and declares neither is broken for whoever installs it. What was wrong was only HOW it read the file. It pattern-matched `from '...'` over the raw text, where a sentence is indistinguishable from a declaration, so a doc comment reading `nothing distinguishes "the chain had none" from "we never asked"` was reported as `core/dist/types.d.ts imports 'we never asked', which is not declared at all` and turned the acceptance gate red.

  A false positive that fails a gate is the expensive direction, and this one taught the wrong lesson: the author reworded the COMMENT to get past a test that was never about comments, in a repository whose whole documentation style is long explanatory comments. It would have recurred on every one of them.

  The scan now parses the declaration file with TypeScript (already a dependency here) and reads module specifiers out of the four positions a `.d.ts` can actually name a module in: `import`/`export ... from`, `import('x')` types, `import x = require('x')`, and a dynamic `import()` call. Those are positions no comment and no string literal can occupy. The claim is unchanged and a genuine undeclared import still fails with the same message.

  The only published change is a doc comment: `RangedAbiEvent`'s explanation of which way to err on `firstBlock` says `nothing distinguishes "the chain had none" from "we never asked"` again, which is the phrase used for this failure class everywhere else in the repo (ADR-0031, ADR-0033). Its presence in the emitted `dist/types.d.ts` is now what proves the scanner no longer cares.

- 31579cc: The request planner's list is issued concurrently, bounded

  With `parseConfig.filters` configured, the planner turns one logical fetch into several `eth_getLogs` calls: one per (rule, `match` entry) plus the leftover groups. They were awaited one at a time, so N filters cost N round trips of LATENCY in sequence even though they are independent questions about the same block range. They are now issued together, bounded by `MAX_CONCURRENT_LOG_REQUESTS` (4).

  THIS CHANGES NO ANSWER. The results were already unioned, sorted by (block, log index) and de-duplicated afterwards, precisely because overlapping filters can return one log twice or out of order; the union is now fed the per-request results in REQUEST order rather than in arrival order, so the list it produces is byte-for-byte the list the sequential loop produced.

  WHAT IS DELIBERATELY UNTOUCHED:
  - **The single-request path.** With no filter configured the planner emits exactly one request and its result is returned as the node answered it, with no sort and no de-duplication. That is the unfiltered case, which is most deployments, and it acquires no merge step here.
  - **Failing on a partial union.** The bound is a worker pool and not a `Promise.all`: a rejection fails the whole fetch, the error that surfaces is the LOWEST-INDEXED failure (the one the sequential loop would have thrown, and the one `RangeLogFetcher` reads its range, result-cap and archive hints out of), no further request is started once a failure is known, and the requests already in flight are awaited before the error is rethrown so none is orphaned. A partial range is what ADR-0004 turns into a false reorg, which is paid for by deleting state, so returning what it managed to collect is never an option.

  The bound is a stated constant rather than the length of the request list, because that length is caller-controlled and an unbounded fan-out at a public provider is a rate-limit incident. It is not configurable.

  Covered by `packages/core/test/theRequestListIsIssuedConcurrently.test.ts`.

- eee7e00: **The storage seam NARROWS: `StateStore` is the reads, and a mutation nobody claimed for is no longer expressible** (ADR-0077 contracted, ADR-0079).

  ADR-0075 put a writer token on every mutating path and ADR-0077 split the seam additively so consumers could migrate one at a time. This is the contract step, and it is one atomic change because narrowing a SHARED TYPE is atomic by construction: the moment `EntityEventProcessor`'s constructor takes the writable shape, every package that constructs it with a seam-typed value stops typechecking.

  **Three names, one hierarchy.** `StateStore` is what a CONSUMER holds and is the reads only (`migrate`, the four reads, `readCursor`, `readRetentionEnforcement`, `capabilities`, `declarations`) -- calling `applyBlock` on one is now a compile error. `StateStoreBackend` is that plus the five mutating verbs: what a backend class declares, what a factory hands over. `WritableStateStore` is a backend plus the `token` a claim minted, and `openForWriting` is the only way to obtain one. The two scaffolding names from the expand phase, `ReadableStateStore` and `StateStoreMutations`, are DELETED.

  **If you hold a store:** decide whether you READ or WRITE, and say so. A reader needs no change and gets a compile error if it tries to mutate. A writer claims: `const store = await openForWriting(await createBrowserStateStore(processor.entities))`. `openForWriting` migrates, so it replaces the `migrate()` you were calling, and it is idempotent per store instance, so the shipped `createState: () => store` pattern takes ONE claim and every generation writes through it. It takes a BACKEND and never a store already narrowed to its reads, so the narrowing is one-way; a demoted writer builds a new store and opens that (ADR-0078).

  **If you implement a backend:** declare `implements StateStoreBackend` instead of `implements StateStore`. The classes themselves are UNCHANGED and keep their full surface, including the SQL tier's `queryCurrent` / `queryAsOf` / `applyBlocks` / `drop`; `createD1Store` still returns the concrete class.

  **If you wire a browser app:** `createBrowserStateStore` still hands back a store and deliberately does NOT claim -- a tab that only renders opens the same database, and claiming there would have every reading tab take the store from the tab that is indexing. `createState` now returns a `WritableStateStore`, so wrap the factory in `openForWriting`. `openForWriting` / `openForReading` are re-exported from `@etherfold/processor-entities` beside the bootstrap primitives, because they are on the same boot path.

  **If you run the conformance suite:** your factory and options are unchanged, and every chapter is asked ONCE again -- the two-shape parameterisation that existed while consumers migrated is gone.

  Two consequences worth knowing before they surprise someone (both ADR-0079). Claiming MIGRATES, and a receiving container builds a generation's state before the generation cap can refuse it (the cap is keyed on the processor's version hash, which needs the processor, which needs the state), so a cap-refused generation now leaves an empty namespace behind; what a refusal still guarantees is no registry record and no state. And `VersionedStateEventProcessor` claims on FIRST USE rather than in its constructor, because claiming is asynchronous and that constructor is not -- still an explicit claim, and safe here because the store is one it built and nothing else holds.

- 241e684: `StoredLogEvent` is exported: the shape of what the stream stores, which is the raw log the node reported plus the reorg flag the indexer derived, and nothing an ABI made of those bytes.

  `args` / `eventName` are one ABI's reading of a log and `decodeError` is one ABI's failure to read it, so all three are a CACHE that `LogEventFetcher.reparse` re-derives on read against the source running now (ADR-0034). The new type says so rather than merely omitting them: it is `BaseLogEvent` intersected with `{args?: never; eventName?: never; decodeError?: never}`, so a parsed event, a parsing failure and the `LogEvent` union are each REFUSED where it is expected.

  It is a distinct name rather than a reuse of `BaseLogEvent`, which is the supertype every decoded event extends and therefore enforces nothing: a decoded `LogEvent[]` is assignable to a `BaseLogEvent[]`, and excess-property checks fire only on fresh object literals, so a keeper declared over the supertype could receive, hold and persist decoded events in silence. `EmittedLog` is untouched and both survive with a stated relation, in the new type's docstring: `EmittedLog` is the server's emission-row shape, free of an ABI type parameter and permissive, while this one is what a `keepStream` keeper persists, carries `extra` and `removedStreamID`, and refuses a decoded event.

  ADDITIVE: nothing has narrowed. `LogEventFetcher.reparse` widened to accept a stored array as readily as a decoded one -- it dropped the decoded half before decoding either way, so its runtime behaviour is unchanged and it still returns decoded events, because a READ produces `LogEvent`s. The keeper seam still declares what it declared before; moving it onto the stored type is a follow-on change.

  The type governs WRITES from here on. Segments written before it existed still hold their decoded half forever, no migration rewrites them, and a read tolerates that half and ignores it.

- 40819d3: **The answer, pinned as a test: deleting `alwaysFetchTimestamps` and `alwaysFetchTransactions` does NOT move the stream digest of a deployment that never set them.** No stream forks, nothing is orphaned, and no history is re-fetched from the node.

  The mechanism, which is what `packages/core/test/aDeletedStreamFlagDoesNotMoveTheDigest.test.ts` asserts rather than assumes: `resolveStreamConfig` omits a key whose value is `undefined`, so an unset flag contributes NO KEY to the resolved config, and the stream digest is taken over that config's canonical bytes. A field that puts nothing into the preimage takes nothing out of it when it goes. Written out, the resolved config of a no-flag deployment is `{finality}` and nothing else, both before the deletion and after it.

  The digest half asserts against LITERAL RECORDED BYTES and never against a recomputation, and that is the whole point of it: a test that computes both sides passes happily when the digest FUNCTION moves, which is precisely the failure worth catching, since a moved digest re-addresses every stored stream in existence and reports nothing while doing it. Those constants are not to be updated to match a new answer. The other half is the same claim where it bites -- a stored stream written under a no-flag config, read back through the ordinary load path against a keeper that ADDRESSES by the digest, landing on the same subtree with no fork, no clear and no re-fetch.

  What does NOT survive, and is stated rather than engineered around (ADR-0073): a deployment that DID set one of the flags stored its stream at a different address, so it re-fetches from the source's start block and its old subtree is left where it is. Nothing is owed to it -- nothing is published, and a change that re-indexes is acceptable so long as it is known rather than discovered.

  Tests only; no API, no behaviour and no stored format changes here. The deletion itself is a separate change.

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

## 0.7.0

### Minor Changes

- 6c875dd: The stateless log-fetcher, and the sending half of the wire contract (ADR-0003, ADR-0004).

  `@etherfold/core` gains **`LogFetcher`**: the chain-facing half of a split deployment, whose one operation is `fetchAndPush()` -- work out where to start, fetch a contiguous range of logs over EIP-1193, and push it. WHEN that runs is a host's business, so nothing in it schedules anything and it names no runtime (a test reads the sources and asserts that, along with the rest below).

  It holds **no cursor**. The receiver is authoritative, and a `409 {expectedFromBlock}` is not an error but the normal correction path: after a restart, after a lost acknowledgement, or when a second fetcher pushed in between, the fetcher is told where it really is and re-sends from there inside the same cycle. What it keeps between cycles is a HINT -- the last value the receiver reported -- which saves one round-trip, is dropped the moment a push fails, and is never persisted. Losing it costs one extra request and nothing else, which is the test for whether state is safe to hold on this side.

  It holds **no reorg logic** either. Nothing it sends carries a `removed` marker or an unconfirmed window; it re-delivers the window the receiver asks for and the receiver derives every retraction. The round-trip test drives a real fetcher against a real `StreamBuilder` over a real database through the real HTTP routes, and asserts that a reorg is concluded correctly from raw ranges alone -- and that the pair lands on the same state a single-process `EthereumIndexer` reaches from the same chain.

  **A partial range is never pushed**, which is the one thing this component must not get wrong: the receiver cannot tell a short payload from "no logs there", so it would read the gap as a reorg and delete state. A provider that ANNOUNCES a result cap makes `toBlock` shrink (the range fetcher already reports how far it really got). A provider that truncates SILENTLY -- exactly the cap back, no error -- is not believed: the range is halved until the answer is under the cap, and a single block that still lands exactly on it throws the new **`SuspectedTruncationError`** rather than delivering something that might be short.

  **Set `suspectResultCount` to your node's real `eth_getLogs` cap.** Silent truncation can only be detected by matching the cap EXACTLY -- a capped answer and a complete one differ in nothing else -- so the option defaults to 10000 (the most common cap) and a node that silently caps at some other number is not caught by the default. Do not try to reach the same effect by raising `fetch.maxEventsPerFetch`: that also widens the span each fetch asks for, which makes truncation more likely rather than less. The two knobs mean different things: one is what this fetcher asks for, the other is what the node will silently refuse to exceed.

  Also new: **`createHttpIngestion`**, the HTTP transport, which maps status codes onto the two refusal families a sender must tell apart -- `409` is the only resumable one, everything else in the 4xx family is an **`IngestionRefusedError`** that is surfaced immediately instead of retried forever, and a `5xx` or an unreachable server is an **`IngestionUnavailableError`** that is retried with bounded backoff. Batches are written with `serializeWireBatch`, so BigInt event arguments cross intact. The `INGEST_TOKEN` is sent as a bearer token and never appears in a message or a log line. **`UnexpectedChainError`** covers the check only this side can make: the receiver holds no provider, so a fetcher pointed at the wrong chain is the one corruption it could never catch.

  Internally, the timestamp/transaction enrichment moved out of `EthereumIndexer` into one shared implementation, so both deployment shapes honour `alwaysFetchTimestamps` / `alwaysFetchTransactions` identically, and the private `LogFetcher` class behind `eth_getLogs` is now `RangeLogFetcher`, since the public name belongs to the component ADR-0003 names.

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

- 0957f8c: Read `blockTimestamp` off the log, and only fetch the blocks that are missing one.

  `ethereum/execution-apis#639` (merged 2025-08-25) puts `blockTimestamp` on every log object, and geth (>= 1.16.0), reth, besu, erigon and anvil all serve it. The fetcher was dropping the field during decoding, so `alwaysFetchTimestamps` always paid for a second `eth_getBlockByHash` per block even when the timestamp had already arrived with the log.

  `NumberifiedLog` now carries an optional `blockTimestamp`, populated from the log when the node provides it (hex QUANTITY or decimal, per `parseLogBlockTimestamp`; anything unreadable is treated as absent rather than coerced to 0). `alwaysFetchTimestamps` becomes a fallback: the block-fetch list is built only from the blocks whose logs carried no timestamp, so it costs nothing on a compliant node and behaves exactly as before on one that is not. Hardhat's EDR does not emit the field as of hardhat 3.14.0, which is why the fallback stays.

  Verified end to end against a real anvil 1.5.1 (indexing three blocks of real events uses `eth_chainId`, `eth_blockNumber` and `eth_getLogs` only, with zero block fetches) and against a real Hardhat node (the fallback engages and timestamps are still correct). This matters most for the in-browser path ADR-0002 makes primary, where a provider frequently cannot batch those calls and each one is its own round-trip.

- 31833b6: `createDirectIngestion`: the ADR-0004 wire, with no wire.

  The split of ADR-0003 was always meant to be a DEPLOYMENT choice rather than two implementations, and this is the eighteen lines that make that literally true. Both sides of the contract are interfaces (`IngestionTarget` for the sender, `LogIngestion` for the receiver), so `createDirectIngestion(streamBuilder)` hands a `LogFetcher` straight to a `StreamBuilder` in the same process, and one deployable fetches and processes while running exactly the code a split deployment runs.

  What survives is nearly all of it, because none of it came from HTTP: the receiver is still authoritative about the cursor, still derives every reorg, and still refuses a batch that does not start where it says; the fetcher still holds no cursor, still asks before its first fetch, and is still corrected rather than crashed when it asks from the wrong place. What is lost is what the transport was carrying: a network hop, a shared secret, and the two failure modes that go with them.

  **The one thing it must get right is that a cursor refusal is a correction and not a fault.** Over HTTP that is the `409`; here it is a thrown `UnexpectedFromBlockError`, and a sender that received it as an exception would treat the ordinary case (a restart, a lost acknowledgement, a second fetcher) as a crash. It is recognised STRUCTURALLY rather than with `instanceof`, for the same reason `retryable` is read structurally: two copies of this package in one dependency tree would otherwise turn the resumable refusal into a fault, and only in the deployments that bundle awkwardly. Every other refusal passes through untouched, `retryable` flag included, since there is no status code here to flatten it into.

  Which deployment this is for: one that can hold a PROCESS, since that is what driving the chain needs. A serverless runtime is a good home for the receiving half and a poor one for the fetching half, so the two shapes worth having are a Node process that pushes over HTTP to an indexer-server anywhere (a Worker among them), and a Node process that runs both halves with this in the middle.

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

- e0a6480: The log ingestion endpoint, and the receiving half of the wire contract (ADR-0004).

  `@etherfold/core` gains **`StreamBuilder`**: the stream-builder of ADR-0003, as an object. It takes contiguous ranges of raw logs from a stateless log-fetcher, derives every retraction itself, drives an `EventProcessor`, and is authoritative about where the next range must start. It makes no chain calls at all, which is why it is not `EthereumIndexer`: that class opens `load()` with `eth_chainId`, so the half of a split deployment that hosts the processor could never use it. It reads the persisted cursor on every call rather than caching one, because the intended host is serverless and an in-memory cursor is one isolate's private opinion of a value the database owns.

  `@etherfold/server` gains **`GET` and `POST /ingest`**, behind an `INGEST_TOKEN` bearer token. The stream-builder is injected exactly like the database (`getIngestion` alongside `getDB` / `getEnv`), so which processor runs against which source stays a deployment's choice; a server with none answers `501` rather than pretending to have a cursor.

  The cursor is the idempotency key, so there is no dedupe table and no idempotency header. A batch whose `fromBlock` is not the server's `expectedFromBlock` is refused with **`409` carrying that value**, and the sender re-sends from there; a batch re-sent after a lost acknowledgement takes exactly that path, so at-least-once on the wire is exactly-once in effect. `409` is the only resumable refusal: a foreign `{source, config}`, a malformed range, or a payload that is not the range it claims are `400`, because no block number makes them right and a sender must not retry them forever.

  `generateStreamToAppend` now throws a typed `UnexpectedFromBlockError` carrying `expectedFromBlock`, instead of an `Error` whose message had to be parsed. Same rule, same message, one place: the HTTP layer reads the number off the error rather than re-deriving it, so the wire and the engine cannot drift apart.

  A revert concluded from **absence** is surfaced and counted apart from one concluded from a hash **contradiction**. Absence is an inference and is indistinguishable from a sender that under-delivered a range, so `/status` now reports `reorgs: {absence, contradiction, last}` from the database (not from process memory, since a rate is the point and isolates are recycled), and an absence-driven revert is logged at `error` level naming the range. It does not make the server unhealthy: it is a signal to investigate, not a fault.

  Wire batches are serialized with `serializeWireBatch` / `parseWireBatch`, which tag BigInts as `{__bigint__: "..."}`. A decoded log's `args` hold a BigInt for every `uint256` an ABI declares and `JSON.stringify` throws on those, while the older `"123n"` suffix convention would revive a contract-emitted string ending in `n` as a number. The tagged codec now lives once, in `@etherfold/core` (`taggedBnReplacer` / `taggedBnReviver`), and `@etherfold/processor-entities`' sync-cursor codec uses it instead of its own copy.

- 9738f1c: One processor, run under the single-process CLI and under the split indexer-server, is now a test rather than an assurance.

  `packages/processor-sqlite/test/deployment-shapes.test.ts` takes ONE `EntityProcessor` (one `version`, one set of entity declarations, imported and not rewritten) and runs it two ways over the same captured chain: as a single `EthereumIndexer` doing fetch, stream-building and processing in one process (what `etherfold serve` is, and the intended CLI shape), and as a split deployment where a stateless log-fetcher pushes contiguous ranges across a wire to an indexer-server that hosts the stream-builder and the processor. Both land on the same state, including through a reorg whose replacement branch carries fewer events, so the global counter comes DOWN and an entity the replacement never mentions goes back to what the confirmed block wrote. Both are run against two storage backends (versioned rows in libSQL, versioned rows in a Map), so the four states have to agree and the backend is the only line that differs.

  The input is a replayed stream fixture: the chain is captured once with `captureStream`, serialized once, and every run re-parses the same text, so the comparison is against identical bytes rather than two chain reads.

  **The seam boundary is encoded so that closing it goes red**, since "the boundary is intact" is not otherwise checkable. Four ways, and the first is the load-bearing one: the indexer-server half is constructed with a provider that THROWS on every JSON-RPC method, naming the boundary. Because the same processor and the same core run both ways, a convenience added on the single-process path -- where one would be added -- is exercised again on the split path, where it cannot be answered. The other three: everything crossing the wire is JSON and is asserted to survive the crossing unchanged; the envelope is asserted to be ADR-0004's and to carry no `removed` markers and no `unconfirmedBlocks`, so all reorg information is derived by the receiver; and the receiver is authoritative about the cursor, with a batch starting anywhere else refused and nothing applied.
  - **`EthereumIndexer.expectedFromBlock` is new**, and it is the ADR-0004 primitive the split shape needs: the block the next batch must start at, which a stateless log-fetcher cannot compute because it holds no cursor. `feed()` already refused a batch that started anywhere else (`generateStreamToAppend` enforces it internally); what was missing was a way to ASK, without which the sender would have to hold the cursor itself. It reaches back over the unconfirmed window rather than answering `lastToBlock + 1`, because re-fetching that window is how a reorg is detected at all.

- 33afc5b: A processor's `version` is now REQUIRED, and the indexer reports when the declared version no longer matches the code.

  **Breaking for processor authors, in both authoring surfaces.** `version` becomes a required field on `JSProcessor` (`@etherfold/js-processor`) and on `SQLProcessor` (`@etherfold/processor-sqlite`), and a processor without a non-empty one now throws at construction, naming the processor by its handlers. Add a `version` to each processor object, ideally generated (as `examples/event-processor-nfts` does, from a hash of its own built file) so it cannot be forgotten.

  **Breaking for `EventProcessor` implementors.** `getCodeFingerprint(): string | undefined` is a REQUIRED method, not an optional one. An optional method would be a hole with a polite name: an implementation that never wrote one, or a wrapper that forgot to forward it, would lose drift detection with nothing to show for it. Returning `undefined` is still a valid answer and means "cannot tell", which is never reported as drift. Both cache wrappers (`EventCache`, `ProcessorFilesystemCache`) forward it.

  **Breaking for stored state: every version hash changes, so existing state is discarded once.** Both implementations dropped their fallback constants entirely rather than merely making them unreachable. `${version || 'unknown'}` is gone with the optional version, and `configHash || 'not-configured'` is gone too: the config is now hashed the same way whether or not `configure()` was called, so an unconfigured processor and one configured with `undefined` no longer get different hashes and no longer discard each other's state.

  **New: advisory drift detection for the version an author forgot to bump.** `getCodeFingerprint()` is derived from the processor's own handler sources and persisted as `LastSync.context.processorFingerprint`. On load, when the version hash is UNCHANGED but the fingerprint is not, the core reports at error level through `named-logs` and through a new `indexer.onProcessorDrift` callback, and keeps going. Set `strictProcessorDrift: true` in the indexer config to refuse to start instead.
  - The fingerprint is deliberately NOT part of `getVersionHash()`. A minifier or a transpiler change moves it without changing behaviour, and folding that in would force a full state rebuild on a deploy that changed no logic.
  - **Absence is never drift.** A cursor with no fingerprint, and a processor that answers `undefined`, both report nothing.
  - `processorCodeFingerprint(processor)` and `assertProcessorVersion(processor, implementation)` are exported from `@etherfold/core` for anyone implementing their own `EventProcessor`.
  - `ProcessorContext.version` is now required, since every processor has one.

- 4097ccd: Rename misspelled public types `StreamFecther` → `StreamFetcher` and `ExistingStateFecther` → `ExistingStateFetcher`.

  This is a breaking change for any code importing these types by name (no deprecated aliases are kept). Update your imports accordingly.

- e0e5832: Renamed to the `@etherfold` scope (ADR-0017). `ethereum-indexer` is now `@etherfold/core`, and `ethereum-indexer-browser`, `-js-processor`, `-fs`, `-fs-cache` and `-utils` are now `@etherfold/browser`, `@etherfold/js-processor`, `@etherfold/fs`, `@etherfold/fs-cache` and `@etherfold/utils`. The two previously unpublished `@ethereum-indexer/*` packages move to `@etherfold/*`.

  The CLI is the one exception to the scope: `ethereum-indexer-cli` becomes the flat package **`etherfold`**, because it is the package that installs the `etherfold` command.

  No API changed: update the package name in your imports and the exports are identical.

  **You must migrate to keep receiving updates.** There is no re-export shim under the old names, so nothing further will be published as `ethereum-indexer*` and no version of an old name forwards to the new one. Already-published versions stay installable indefinitely, so existing pins keep resolving, but they are frozen.

  **The CLI command is renamed**: the CLI installs `etherfold` instead of `ei`, so `npm i -g etherfold` then `etherfold -p <processor>`. Update any script that shells out to `ei`.

  `named-logs` namespaces follow the package names, so any log filter matching `ethereum-indexer*` needs updating to `@etherfold/*`. The CLI is the exception: its namespaces follow the command, so `ei` and `ei:keepState` become `etherfold` and `etherfold:keepState`.

  `ethereum-indexer-server` and `ethereum-indexer-db-utils` are deliberately NOT renamed: both are on the retirement path set by ADR-0010, and they have since moved to `archive/` in the repository, outside the workspace. Their published versions stay installable and are not deprecated here.

- 3a78285: Capture an event stream once, replay it forever, with no node in the loop.

  Indexing was reproducible only in the sense that the chain does not change: every run re-fetched, so two runs saw different bytes whenever a node paginated differently, rate-limited, or simply moved on. That makes a benchmark unfair between candidates, a processor test slow and flaky, and "the same input" impossible to say out loud.
  - **`captureStream(provider, source, {toBlock, ...})`** fetches a range once through the same `LogEventFetcher` the live path uses, and returns a `StreamFixture`: format version, provenance (`capturedAt`, chain, block range, plus whatever the caller adds (contracts commit, node, run)), the `IndexingSource` it was captured for, the cursor, and the decoded events. `toBlock` must be a number, never `'latest'`: a snapshot whose upper bound was "whenever it ran" cannot be re-captured and compared against itself.
  - **`serializeStreamFixture` / `parseStreamFixture`** move it as text, with BigInt event arguments surviving via the `"123n"` convention already used by every storage adapter here. Parsing refuses an unknown format or a missing field up front, where the message can still name the fixture.
  - **`replayStream(fixture)`** is an `ExistingStream` over a fixture, so the seam the indexer already consults before fetching can be pointed at a file. It never writes: a replay that appended to its own input would stop being a replay of the thing whose provenance is recorded at the top of it.
  - **`replayFixtureInto(processor, fixture, streamConfig)`** drives a processor over the fixture with no provider at all, **one block per `process` call**, because that is how blocks arrive and how they are applied. `chainTip: 'live' | 'final'` chooses whether each block is presented as the tip (keeping the processor's reorg-eligible path, and so its history, doing what it did live) or as already final.
  - **`blocksOf(fixture)`** groups a fixture into the blocks it contains, in order, for callers that want to drive the batching themselves.
  - **`@etherfold/fs`** gains `saveStreamFixture` / `loadStreamFixture`, indented by default because a fixture is a committed artifact that gets read and diffed, and **gzipped when the path ends in `.gz`**. That last part is not a convenience: a real capture is 20.5 MB of JSON and 0.6 MB gzipped, git stores both at about 0.6 MB, so the compressed form costs nothing in the repository and saves 20 MB in every working tree.

  Additive: nothing existing changes behaviour.

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

- c681b79: Cache fetched block timestamps, so the unconfirmed window is not re-fetched every round.

  On a node that does not put `blockTimestamp` on the log, `alwaysFetchTimestamps` costs one `eth_getBlockByHash` per block. `getFromBlock` deliberately re-scans back to `latestBlock - finality` on every round to catch reorgs, so the same unconfirmed blocks were fetched again on every single round: indexing 3 blocks over 5 rounds against a Hardhat node cost 15 block fetches, and it now costs 3.

  The cache is keyed by block **hash**, and that is what makes it safe rather than merely smaller: a hash uniquely determines a block, so a cached timestamp cannot become wrong and a reorged-out block's hash simply never appears again. Keying by height would answer a replaced block with the dead branch's timestamp, silently, across exactly the reorgs the re-scan window exists to detect.

  It is bounded by the reorg window rather than by the length of the chain: entries below `latestBlock - finality` are evicted, since `getFromBlock` can never ask for them again, and that is also what evicts reorged-out hashes. A node that supplies timestamps on the log populates nothing at all.

- 9d21d67: Take `blockTimestamp` from `eip-1193`'s own type, dropping the local widening.

  `eip-1193@0.6.6` adds the optional `blockTimestamp` to `EIP1193Log`, so the local intersection type that existed only because the upstream type predated `execution-apis#639` is gone, and the log is read as `IncludedEIP1193Log` directly. The dependency range moves to `^0.6.6`, since the source now relies on that field being declared rather than merely being on the wire.

  No behaviour change. `parseLogBlockTimestamp` still takes `unknown` rather than `EIP1193QUANTITY`, deliberately: the spec (and therefore the type) says hex QUANTITY, while at least one client serves decimal. The type states the contract, the parser handles what actually arrives.

- ca6f981: Distinguish the two ways a reorg is concluded, and report the dangerous one loudly. `generateStreamToAppend` now returns an optional `reorg: {cause, blockNumber, blockHash}` alongside the stream, where `cause` is either `contradiction` (the same height now carries a different hash, which is proof) or `absence` (a block we held is simply not in the re-fetched range, which is an inference).

  The distinction matters because absence is indistinguishable from a sender that under-delivered the range: a truncated `eth_getLogs`, a wrong address or topic filter, a misconfigured chain. Both causes revert state, so an absence-driven revert is logged at `error` level with the range that produced it, while an ordinary hash contradiction stays at `info`. A rising rate of absence-driven reverts means truncation or misconfiguration rather than chain activity.

  Purely additive: the returned object gains a field, and existing destructuring is unaffected.

- eba61c3: Fix typo (`conext` -> `context`) in the chain-mismatch error message thrown by `updateIndexer` when the connected chain differs from the previous indexer context.
- dece521: Fix `createAction` losing its executor's parameter types when the action's argument type is a union.

  `createAction<T, U>` chose the executor signature with `U extends undefined ? ... : ...`. `U` is a NAKED type parameter there, so the conditional DISTRIBUTES: for a union argument type such as `boolean` (`true | false`) it produced a UNION of two signatures rather than one signature taking the union. A union of signatures has no single call signature, so the executor's parameters silently fell back to implicit `any` and `next(...)` demanded the INTERSECTION of the constituents (`never`), refusing every real argument.

  Both conditionals (`Func` and the `execute` parameter) now use the non-distributive `[U] extends [undefined]` form, which keeps `U` whole. No runtime behaviour changes and the public declarations are byte-identical; the internal module's `.d.ts` is the only emitted file that moves.

  Found by the new `pnpm typecheck`, which is the first thing in this repo to typecheck `test/`: `test/promises.test.ts` had been calling `createAction<string, boolean>` since it was written, and nothing checked it.

- 939364a: fix(core): `feed()` dropped every retraction, so the feed path could not revert

  `promiseToFeed` batched the generated stream with `groupLogsPerBlock`, which deliberately skips `removed: true` events. That is correct for logs coming IN from a fetch, where a retraction has no business existing, and wrong for the stream going OUT to a processor, where a `removed` marker is the only instruction a processor ever gets to revert.

  The consequence was that the same stream produced two different states depending on which entry point delivered it: reverted correctly through `indexMore()`, and silently derived from a dead branch through `feed()`. `feed()` is the kept-stream replay on load and the indexer-server's import route, so a reorg that arrived through either was applied and never taken back.

  Retractions are now grouped and delivered by `groupStreamPerBlock`, which keeps them, and keeps a retracted block apart from a re-applied one when they share a hash (which happens when a reorg is detected at the first unconfirmed block and a later one is re-applied unchanged). All retractions in a stream go in a single `process` call regardless of `feedBatchSize`, since a revert is one decision about one fork point and a processor that reverts to the lowest retracted block must not compute it from a partial view. A retraction-only batch no longer drags `lastToBlock` backwards.

- d24872f: Fix a reorg that silently kept dead-branch events in the state. `generateStreamToAppend` detected reorgs by walking the **incoming** block list and comparing it position-by-position against `unconfirmedBlocks`. When a reorg removed a block's logs without replacing them at another block-with-logs (for example the transaction went back to the mempool and was not re-mined yet), the re-fetch legitimately returned a **shorter** list, so the vanished block was never compared with anything: no `removed: true` marker was emitted, the processor kept the state derived from a block that no longer existed, and the block lingered in `unconfirmedBlocks` until it fell outside the finality window and was pruned without ever being retracted, making the corruption permanent. It self-healed only if another block with logs happened to land in the unconfirmed window first, so low-traffic sources were the most exposed.

  Reorg detection is now driven by `unconfirmedBlocks` and matches incoming blocks by block **number**: a missing entry (the block no longer carries any of our logs) and a differing hash (the block was replaced) are both treated as a reorg at that block. Blocks outside the re-fetched `[fromBlock, toBlock]` range are skipped rather than judged missing, since the re-fetch proves nothing about them. Behaviour for the already-covered case (same height, new hash) is unchanged.

- 78d8377: Align `EthereumIndexer.updateProcessor` with `updateIndexer`: it now calls `disableProcessing()` first (so a racing index/feed tick cannot interleave with the processor swap) and re-enables processing afterwards. The processor instance is now swapped only once a change has been decided, instead of being replaced before the version-hash check — so a no-op (same-version) update no longer replaces the running instance mid-flight.

  When the new processor has the same version hash as the current one, the swap is skipped and a warning is logged (in case the developer changed the processor but forgot to bump its version hash). A new `updateProcessor(newProcessor, {force: true})` option swaps, clears, and reloads regardless of the version hash.

- 3de4c35: Several bug fixes in the core indexer:
  - `getNewToBlockFromError`: only treat `-32602` errors as block-range hints when the message actually looks like one (avoids mis-parsing unrelated "invalid params" errors), and fix the `"block range too large"` detection that always evaluated truthy.
  - `fetchLogsFromProvider`: deduplicate block/transaction extra-data fetches by hash instead of by block number, so every distinct block hash gets its timestamp (fixes missing `blockTimestamp` when two hashes share a block number, e.g. after a reorg in the unconfirmed window).
  - `createAction`: forward falsy-but-valid arguments (`0`, `''`, `false`) to the executor instead of dropping them based on truthiness; and fix the `next()` (queue) path that fell through and executed the queued action twice / broke serialization.
  - Log previously-swallowed listener and `tokenURI` fetch errors via `named-logs` instead of empty `catch {}`.

- bc118e4: Declare the packages the published types import, so installing them actually typechecks.

  A type-only import is erased from the emitted `.js` but survives in the emitted `.d.ts`. These packages name types from `abitype`, `eip-1193` and `@etherfold/core` in their public declarations while listing those as `devDependencies`, so a consumer installing them got declaration files importing packages that were never installed.

  Moved to `dependencies`: `abitype` and `eip-1193` in `@etherfold/core`, `eip-1193` in `@etherfold/browser`, and `@etherfold/core` in `@etherfold/utils`.

  Measured against a packed tarball installed under pnpm's isolated linker with `hoist=false`, `tsc --strict --skipLibCheck false` reported 11 errors (6 for `abitype`, 5 for `eip-1193`) before and none after.

  The bug was hard to see from inside the workspace, which is why it lasted. pnpm keeps a hoisted fallback directory holding every transitive package, so an undeclared import still resolves as long as anything else in the tree depends on it: `abitype` was masked that way by viem and failed only with hoisting off, while `eip-1193`, which nothing else depends on, failed everywhere. `skipLibCheck: true`, which most consumers set, suppresses the diagnostics entirely and silently degrades the affected types instead.

  A test now asserts, for every package in the workspace, that each bare specifier in its built `.d.ts` files is a declared dependency. It found the `@etherfold/utils` case, which a search for the two known package names had missed.

## 0.6.21

### Patch Changes

- forgot to build

## 0.6.20

### Patch Changes

- base rpc range to large

## 0.6.19

### Patch Changes

- new loading state + CatchingUp for browser-indexer

## 0.6.18

### Patch Changes

- allow to reset indexer

## 0.6.17

### Patch Changes

- log when reset logLevel

## 0.6.16

### Patch Changes

- skipGenesisCheck

## 0.6.15

### Patch Changes

- fix typo

## 0.6.14

### Patch Changes

- fix genesisHash fetch

## 0.6.13

### Patch Changes

- let specify genesisHash as source param, useful for local chain

## 0.6.12

### Patch Changes

- latest deps

## 0.6.11

### Patch Changes

- fix fromBlockFromContracts

## 0.6.10

### Patch Changes

- fix fromBlock computation

## 0.6.9

### Patch Changes

- fix history splice

## 0.6.8

### Patch Changes

- reorg + add streams server (wip)

## 0.6.7

### Patch Changes

- improve processor import to work in pnpm + startBlock fix

## 0.6.6

### Patch Changes

- do not trigger subscribe when zero event stream

## 0.6.5

### Patch Changes

- fix duplicate event name issue

## 0.6.4

### Patch Changes

- c81fb4d: use state field name instead of data

## 0.6.3

### Patch Changes

- further chainId check

## 0.6.2

### Patch Changes

- fix fromBlock negative

## 0.6.1

### Patch Changes

- cleanup exports

## 0.6.0

### Minor Changes

- release

## 0.5.6

### Patch Changes

- fixes

## 0.5.5

### Patch Changes

- fix

## 0.5.4

### Patch Changes

- fix

## 0.5.3

### Patch Changes

- fixes + implement filters option

## 0.5.2

### Patch Changes

- fix

## 0.5.1

### Patch Changes

- remove duplicate contract addresses and topics for log fetching

## 0.5.0

### Minor Changes

- use viem + aitype for type-safe experience

## 0.4.3

### Patch Changes

- fix

## 0.4.2

### Patch Changes

- reorg

## 0.4.1

### Patch Changes

- allow access to state from processors that declare it

## 0.4.0

### Minor Changes

- chainId specified

## 0.3.11

### Patch Changes

- fix again

## 0.3.10

### Patch Changes

- fix

## 0.3.9

### Patch Changes

- fix

## 0.3.8

### Patch Changes

- typings

## 0.3.7

### Patch Changes

- types

## 0.3.6

### Patch Changes

- fix topics

## 0.3.5

### Patch Changes

- use eip-1193 types

## 0.3.4

### Patch Changes

- force new version

## 0.3.3

### Patch Changes

- republish with new types

## 0.3.2

### Patch Changes

- export type as types

## 0.3.1

### Patch Changes

- allow to specify type on EventWithId

## 0.3.0

### Minor Changes

- new release

## 0.0.15

### Patch Changes

- use monorepo
