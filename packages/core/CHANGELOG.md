# ethereum-indexer

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

- a4d106e: Fix: rebuilding off a cached event stream no longer throws away the retractions that stream carries.

  A stored stream is an EMISSION stream: a reorged-out block is in it TWICE, once as it was emitted and once at its original block flagged `removed`. `EthereumIndexer.feed()` handed whatever it was given to `generateStreamToAppend`, which is FETCH-shaped -- it derives retractions from the cursor's unconfirmed window, and `groupLogsPerBlock` drops `removed` events out of its input, both of which are right for raw logs from a stateless `eth_getLogs`. A rebuild starts from a fresh cursor whose window is EMPTY, so a stream containing a reorg replayed as BOTH branches applied as live blocks with no revert at all: refused by the entity store (`block 104 is already recorded`), and silently wrong state derived partly from a dead branch on any path that tolerated the double-apply. ADR-0008 rests a processor upgrade on that replay, so its fidelity is load-bearing.

  **New: `EthereumIndexer.replay(eventStream, lastSyncStored)`**, the entry for a stream that carries its own verdicts, and what `load()` now uses for both the rebuild and the catch-up shape of a kept-stream replay. `feed()` keeps its meaning -- a FETCH, complete over its range, whose retractions this engine derives -- and now REFUSES a batch carrying `removed` markers with an `InvalidBatchError` naming `replay()`, instead of accepting it and dropping them.

  **The cursor a replay leaves behind is the one the live run held, window included.** The window is rebuilt by WALKING the stream (an applied block enters it, a retracted block leaves it, keyed by block HASH), not by filtering out its `removed` entries -- which would leave both branches of a reorg at one height and make the first tip cycle after the rebuild apply the replacement block a SECOND time. No stream keeper stores `unconfirmedBlocks` and none needs to; see ADR-0042.

  `groupStreamPerBlock` now groups CONSECUTIVE runs rather than keying a map over the whole list, so a stream that applies a block, retracts it and applies it again under the same hash is delivered in that order.

- 351c585: A cached stream has a real IDENTITY: a digest of its FETCH FILTER plus its stream CONFIG, and that digest fills the address level `the-stream-appends-in-segments-on-indexeddb` left as a placeholder.

  `@etherfold/core` exports `streamDigestOf(source, streamConfig)`: 128 bits of `viem`'s `sha256`, SYNCHRONOUS, rendered as 32 fixed-length lowercase hex characters every substrate can carry as a key element. It is taken over the DEDUPLICATED `streamHash` values SORTED BY THEMSELVES, plus the resolved stream config, and over nothing else. `hash` and `legacyHash` are excluded: they cover the DECODING shape, which is what the stream is deliberately independent of. Sorting the values by themselves rather than rolling the digest up over the entry list is load-bearing — that list is sorted by `(startBlock, hash)`, so a decode-only change (a renamed non-indexed parameter) reorders it while every `streamHash` is unchanged, and a digest over that order would fork a new stream, re-fetch the whole history and orphan the old one, silently.

  `simple_hash`'s canonicalisation is extracted as `canonical_form` and shared rather than copied, so the wide digest and the 32-bit change detector cannot disagree about whether two values are the same; `simple_hash` itself is byte-for-byte unchanged.

  The config is in the digest because it decides what a stream CONTAINS (`alwaysFetchTimestamps`, `alwaysFetchTransactions`, `parse.filters`), and because `sourceInvalidationOf` already invalidates the stream half from block 0 whenever it moves. This is ADR-0006's `{source, config}` stream keying made concrete, narrowed on the source side to the FETCH half per ADR-0034 (ADR-0008's 2026-08-31 amendment records the narrowing).

  **`ExistingStream` gains an optional `setStreamConfig`**, which the indexer calls in `reinit` with the config it RESOLVED, before any other call and again on every reconfigure. A keeper is handed a `source` on every operation and never the config, so without it a keeper that addresses a stream would map two configs onto one subtree. A keeper that addresses nothing (a replayed fixture) omits it.

  **`keepStreamOnIndexedDB` now addresses `['stream', <indexer-name>, <streamDigest>, ...]` with the real digest**, and `placeholderStreamDigest` is deleted. `streamAddress(name, source, streamConfig)` takes the source and the config in place of the `chainId` it used to derive the placeholder from; `chainId` is still not a level of its own, because the digest covers it through the block-0 skeleton entry. The `<indexer-name>` level is untouched, so two names and two chains stay isolated exactly as before.

  **Nothing migrates and no payload is rewritten.** A stream written under the placeholder is simply a stream under a different digest: unreachable by a filter that now resolves elsewhere, so nothing needs to move. Disposing of those subtrees belongs to the unregistered-subtree sweep in the generation registry, which is the only place that can know which digests are registered.

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

- b0e9a0d: A reconfigure now REPORTS whether it discarded the state, and the browser hook stops publishing state the core has thrown away.

  `updateProcessor`, `updateIndexer` and `reset` decide between two very different outcomes -- the computed state survives, or it is gone and being rebuilt -- and used to tell nobody. They now return `ReconfigureOutcome` (`{stateDiscarded: boolean}`). The widening is additive: a caller that ignored the resolved value still compiles and still behaves identically.

  That silence was a live defect for any caller holding a COPY of the state, which is every UI. `onStateUpdated` fires when a state is ADOPTED or PRODUCED, and a discard is neither, so `createIndexerState(...).state` went on publishing the discarded state until the next event happened to arrive and overwrite it. On the free-form path that is the old state VALUE: stale numbers, rendered by every subscriber, looking exactly like a working app.

  The wait was unbounded, and the case that makes it unbounded is the ordinary local-development one. These apps redeploy behind a proxy, so the address does not move and the regenerated ABI is what changes; the indexer correctly discards, correctly re-indexes, and correctly finds NOTHING, because a freshly redeployed implementation has not emitted anything yet. With no event to overwrite it, the tab showed state computed from the contract that is no longer deployed for the rest of the session. The same held for an edited processor swapped in under a bumped version, and for an explicit `reset()`.

  The hook now re-seeds `$state` at the moment of the discard, and only then: a reconfigure that KEPT the state must not blank it, or saving a file that changed nothing would empty the UI. Both directions are pinned in `packages/browser/test/reconfigure.test.ts` and driven in Chromium, Firefox and WebKit in `packages/browser/browser/indexing.spec.ts`.

  Note what did NOT change, because it is the trap an integrator meets first: a version hash is AUTHOR-DECLARED (`version`, the entity declarations, the config, and nothing derived from handler code). An edited handler under an unchanged `version` is not a change the core can see, so `updateProcessor` skips the swap and the edit never runs. Bump `version`, or pass `{force: true}`.

- 5adafa9: The indexer and its cached event stream agree on which of them is ahead, so the cache can be behind or ahead but never HOLED.

  A **hole** is a range of blocks the stream never RECEIVED, hidden behind a cursor that claims to cover them (`[100..5000]` then `[6001..7000]`, cursor at 7000). It was reachable in one ordinary session with no crash and no reload, and nothing detected it afterwards: segments are keyed by save rather than by block, so a save that never happened leaves no trace, and the next state discard replayed the stream as though it were whole.

  **The stream is now written BEFORE the processor is called, and a batch that was not written is not processed.** `promiseToIndex` processed and then saved; the processor persists its own state inside `process()`, so a failed save left the stream a batch behind, and the next cycle computed its delta from the already-advanced cursor and jumped over a range whose events the stream never got. A failed write now means the cycle achieves nothing and the next one tries again from the same cursor: nothing is lost, nothing is skipped. It also makes a second invariant free — **a retraction is never written into a stream that lacks the event it retracts**, because the unconfirmed window cannot advance past the stream.

  **A cache can no longer wedge the indexer, and the retry is bounded and paced.** After `streamWriteRetry.maxConsecutiveFailures` consecutive failed writes (default 3, one attempt every `streamWriteRetry.delaySeconds`, default 1) the cache is FROZEN, said loudly through `named-logs`, and indexing carries on without it. Frozen means frozen, not cleared: what is on disk is a contiguous prefix with a cursor that describes it honestly, so it still seeds a rebuild, and throwing it away would cost a re-fetch from the source's first block. The one cause that DOES clear is a store that is out of SPACE, since there the cache is itself the problem; keepers say so on the error they throw and `isOutOfSpace` reads it structurally (the flag, or the Web platform's own `QuotaExceededError`), exactly as `retryable` is read.

  **A stream that is AHEAD of the state is now REPLAYED rather than re-fetched.** The state-DISCARDED load branch always fed the cached stream; the state-KEPT branch only validated it and had no `else`, so a tab that closed between the two writes caught up from the NODE and appended those blocks to the stream a second time — and the next rebuild saw them twice. It now feeds them, re-decoded against the source running now (ADR-0034), which turns a node re-fetch into a local replay.

  **A stream holding a CURSOR and no events now resumes from that cursor.** The fetched cursor used to be adopted only as a side effect of feeding events, so a deployment whose contracts have emitted nothing left the in-memory cursor at `freshLastSync` and re-scanned from the start block on every reload, forever.

  Two mechanisms are DELETED rather than fixed. `streamNotYetSaved`, the in-memory carry-forward of unsaved events, never fired: it lived on the save action's promise CONTEXT, which is reset unless a save is queued onto one still in flight, and the index cycle awaits its save. It existed only to compensate for processing first, and it appended without de-duplicating. With it gone, `createAction`'s `setContext`/`getContext` had no callers and are gone too. What replaces it is the inverse: the extent of the last SUCCESSFUL write, held in memory, so a processor that throws deterministically cannot grow the cache by one duplicate copy per retry — and where the chain reorged under events the processor never accepted, they are RETRACTED into the stream, because the state cannot retract what it never applied.

  `@etherfold/browser` gains all of this through the core it drives; `ProvidedIndexerConfig.streamWriteRetry` reaches it through `createIndexerState(...).init`. See `docs/adr/0038` for why a frozen stream is never appended to again and why that decision cannot be the keeper's.

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

- 0ba3c60: A cancellation arriving while the processor is applying a batch no longer makes the next cycle deliver the same events twice.

  `unlessCancelled(p)` rejects the CALLER; it cannot stop `p`, and it only throws once `p` has RESOLVED. So when a cancellation fired during `process`, the batch had already been applied and persisted, state and cursor together in one transaction (ADR-0027), and the engine threw before its in-memory cursor moved. The next cycle re-derived the same range and handed the same events over again: on a store that refuses a re-applied block that is a wedge no number of cycles clears, and on one that accepts it, a silent double-apply.

  This is the ordinary path rather than an exotic one: every reconfigure verb calls `disableProcessing()` first, and the cancellation lands in exactly this window.

  The completed batch is now recorded before the cancellation is honoured, in both the `indexMore` path and the `feed`/`replay` batch loop, so the in-memory cursor agrees with what is on disk.

  **Why the work is kept rather than reverted.** Reverting would be the intuitive fix and is not available: `process` is the processor's own transaction, its write is already durable, and the `EventProcessor` interface has no per-batch undo, only `reset`/`clear`, which discard everything. Keeping a completed batch and recording it is both the smaller change and the one that leaves the two halves consistent.

- a1fccd0: A FOLLOWER now notices a retraction the writer it follows appended while PAUSED, instead of silently keeping a branch the chain abandoned.

  A follower (a generation on a SHARED stream, ADR-0044) decided there was nothing to follow by comparing the stored stream's cursor against its own (`lastSyncStored.lastToBlock <= current.lastToBlock`). That is sound for a RUNNING writer, whose `lastToBlock` rises with the tip on every cycle, and WRONG for a paused one: a pause caps `toBlock` at the cursor it paused on (ADR-0045), so a reorg the writer detects at or below the cap during its drain is appended to the stream — retraction and replacement both — while `lastToBlock` never moves. A follower level with the cap took the early return and never replayed either, so its state stopped being a fold of the stream it claims to fold, and nothing reported it.

  The follow path now asks the question of the STREAM instead of a summary of it: a follower remembers the emissions it last folded over the range it resumes from (block hash, index in the block, application or retraction) and does nothing only while what the stream holds there is emission-for-emission the same list. The stored cursor still contributes the half it cannot be wrong about — a stream reaching past this fold is new by definition. An idle follower therefore still re-walks nothing and re-delivers nothing, and a follower still issues zero `eth_getLogs`, writes zero segments and clears nothing. See ADR-0049.

  Nothing about PAUSE changes: the cap and the frozen `lastToBlock` are the drain's own termination condition, and a paused writer is behaving correctly. No public API changes; a follower simply lands where a from-scratch fold of its stream lands, which is what it always promised.

- ce43a7b: A reconfigure that changed nothing no longer re-indexes: the stream config is RESOLVED before it is hashed, everywhere.

  The stream-config hash meant two different things. `reinit` stored the digest of the config `resolveStreamConfig` had filled in, so the persisted `context.config` always carried `finality`; `updateIndexer` digested the config exactly as the caller PASSED it. A caller who left `finality` unset — which is the ordinary case, and the whole reason the resolver exists — therefore produced a hash that could never match the stored one, whatever else that reconfigure changed or did not change. `sourceInvalidationOf` reported `reason: 'stream-config'`, which invalidates the STREAM half from block 0 as well as the state half, so the fold was discarded and, with no stream cache to rebuild from, the entire history was re-fetched from the node.

  The resolve-then-hash step is now ONE function, **`streamConfigHashOf(stream)`**, exported from `@etherfold/core` beside `resolveStreamConfig` and for the same reason: a caller that builds a `ContextIdentifier` or a `WireContext` of its own has to reach the same digest the engine stored, and hashing the config a user passed instead of the config that runs is exactly how that goes wrong. Every site in the package goes through it — both verbs of the indexer, `wireContextOf`, and `captureStream`, which had the same defect and would write a fixture cursor no indexer running the default `finality` could match. A test asserts there is no second site in `packages/core/src` hashing a config.

  **No digest moves and nothing is re-keyed.** `resolveStreamConfig` is idempotent, so a caller already holding a `UsedStreamConfig` (the wire identity) reaches the byte-identical digest it did before; `simple_hash` and the shared `canonical_form` are untouched; `streamDigestOf` already resolved and is unchanged. What a genuinely moved config does is unchanged too: `alwaysFetchTimestamps`, `alwaysFetchTransactions`, `parse.filters` and an explicitly different `finality` each still invalidate both halves from block 0. This removes a false positive, not the rule.

- 1524a04: A concluded reorg no longer DROPS the logs the replacement branch carries below the lowest block we held logs for. They were fetched, discarded in memory and never fetched again, because the next range starts above them: silent, permanent loss, reaching the stored emission stream and both feed views and not only the in-memory stream.

  `generateStreamToAppend` admitted an incoming block only at or above a HEIGHT (`reorgBlock.number` on a reorg, the window's top plus one otherwise). That threshold claims "we already hold everything below this", and `unconfirmedBlocks` holds only EVENT-BEARING blocks, so the window is SPARSE and its lowest entry is usually far above the height the chain actually forked at. Fork at 195 while the lowest block we held logs for is 200, and every log the new branch carries in 195..199 is inside the re-fetched range, dropped by the comparison, and gone.

  The rule is now MEMBERSHIP of the retained window, by `(number, hash)`: a re-fetched block is NEW unless the window that survived this cycle's retraction already holds it. Nothing is delivered twice, which is the job the threshold was really doing — a re-fetch never starts below `latestBlock - finality`, and a block that carried events inside that window entered `unconfirmedBlocks` when it was applied, so anything we already applied is still there unless it was retracted. It is also the rule the REPLAY path in the same file already applied, by hash, for the same de-duplication reason; the two entries now agree.

  Reorg DETECTION is untouched: the absence-versus-contradiction classification (ADR-0004), the retractions from the reorged block onward, the finality prune and the reorg counters (ADR-0050) all behave exactly as before, and no re-fetched range was widened.

  Two deliberate consequences. The no-reorg path changed on the same ground: a block inside the re-fetched range the window does not hold is now delivered even when nothing reorged and it sits below the window's top (by the same invariant, we never applied it). And the rebuilt `unconfirmedBlocks` is sorted ascending, which a height threshold used to guarantee for free and the readers of that window still assume. See ADR-0051.

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

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

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
