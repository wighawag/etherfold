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

- eee7e00: **The storage seam NARROWS: `StateStore` is the reads, and a mutation nobody claimed for is no longer expressible** (ADR-0077 contracted, ADR-0079).

  ADR-0075 put a writer token on every mutating path and ADR-0077 split the seam additively so consumers could migrate one at a time. This is the contract step, and it is one atomic change because narrowing a SHARED TYPE is atomic by construction: the moment `EntityEventProcessor`'s constructor takes the writable shape, every package that constructs it with a seam-typed value stops typechecking.

  **Three names, one hierarchy.** `StateStore` is what a CONSUMER holds and is the reads only (`migrate`, the four reads, `readCursor`, `readRetentionEnforcement`, `capabilities`, `declarations`) -- calling `applyBlock` on one is now a compile error. `StateStoreBackend` is that plus the five mutating verbs: what a backend class declares, what a factory hands over. `WritableStateStore` is a backend plus the `token` a claim minted, and `openForWriting` is the only way to obtain one. The two scaffolding names from the expand phase, `ReadableStateStore` and `StateStoreMutations`, are DELETED.

  **If you hold a store:** decide whether you READ or WRITE, and say so. A reader needs no change and gets a compile error if it tries to mutate. A writer claims: `const store = await openForWriting(await createBrowserStateStore(processor.entities))`. `openForWriting` migrates, so it replaces the `migrate()` you were calling, and it is idempotent per store instance, so the shipped `createState: () => store` pattern takes ONE claim and every generation writes through it. It takes a BACKEND and never a store already narrowed to its reads, so the narrowing is one-way; a demoted writer builds a new store and opens that (ADR-0078).

  **If you implement a backend:** declare `implements StateStoreBackend` instead of `implements StateStore`. The classes themselves are UNCHANGED and keep their full surface, including the SQL tier's `queryCurrent` / `queryAsOf` / `applyBlocks` / `drop`; `createD1Store` still returns the concrete class.

  **If you wire a browser app:** `createBrowserStateStore` still hands back a store and deliberately does NOT claim -- a tab that only renders opens the same database, and claiming there would have every reading tab take the store from the tab that is indexing. `createState` now returns a `WritableStateStore`, so wrap the factory in `openForWriting`. `openForWriting` / `openForReading` are re-exported from `@etherfold/processor-entities` beside the bootstrap primitives, because they are on the same boot path.

  **If you run the conformance suite:** your factory and options are unchanged, and every chapter is asked ONCE again -- the two-shape parameterisation that existed while consumers migrated is gone.

  Two consequences worth knowing before they surprise someone (both ADR-0079). Claiming MIGRATES, and a receiving container builds a generation's state before the generation cap can refuse it (the cap is keyed on the processor's version hash, which needs the processor, which needs the state), so a cap-refused generation now leaves an empty namespace behind; what a refusal still guarantees is no registry record and no state. And `VersionedStateEventProcessor` claims on FIRST USE rather than in its constructor, because claiming is asynchronous and that constructor is not -- still an explicit claim, and safe here because the store is one it built and nothing else holds.

### Minor Changes

- ebfa4f0: **`degradingStream` is DELETED, and a stream keeper whose substrate cannot be read now RAISES from `fetchFrom` and `clear` instead of answering absent** (ADR-0068).

  The rule it encoded is unchanged and still enforced: a cache that cannot be read costs a re-index, never the indexer. What moved is WHERE it is applied. It was a wrapper each keeper put around itself, so it bound every caller -- and "absence is safe" is a statement about the LOAD PATH, which responds to an absent stream by re-indexing. It is false for `installStreamSeed`, which responds to absence by WRITING.

  Told "empty" about a subtree that was merely unreadable, the installer appended a seed underneath a stream that was really there. Measured, with a valid seed against a real stream whose reads were failing while its writes worked: `{status: 'installed'}` returned, two segments where there had been one, and the cursor's `lastToBlock` moved backwards from 600 to 200 while `startBlock` stayed at 500. Silent, permanent, and re-folded by every later generation.

  **If you implement `ExistingStream`:** stop wrapping yourself in `degradingStream` (it no longer exists) and let your substrate errors propagate. The write side is unchanged and always raised.

  **If you consume it:** `IndexerGeneration` catches and re-indexes exactly as before, so an app sees no difference. `installStreamSeed` gains one refusal reason, `subtree-unreadable`, deliberately distinct from `subtree-not-empty` -- one says "there is a stream here", the other says "I cannot tell whether there is". It writes nothing and clears nothing, and is usually transient.

  Done now rather than later because nothing is published yet: two implementations and four call sites, all in this repository. After the publish task lands it is a breaking change to a seam with implementors outside our control.

- 514c821: **A claim can be abandoned, and a host is no longer killed unless it is known to be quiet.** Two halves of the same failure: a store that can never answer, and the port that was helping to create it.

  ## `openForWriting(store, {signal})`

  `openForWriting` claimed and its contract said it "does not block and it does not wait". That was true of the QUEUE -- there is no lease and no turn to take -- and false of the call, which awaits one round trip to the storage. A storage that never answers made it hang for ever, and there was no vocabulary for that: an application sat in `phase: 'waiting'` with nothing to render, nothing to act on and nothing a reload would fix.

  ```ts
  try {
  	const store = await openForWriting(backend, {signal: AbortSignal.timeout(10_000)});
  } catch (error) {
  	if (error instanceof StoreClaimAbandonedError) {
  		// the storage did not answer. Render something; offer a rebuild.
  	}
  }
  ```

  **The bound is the caller's and the seam invents none.** No timeout is defaulted anywhere, because there is no number that is right for a cold mobile browser, a contended database and a server at once, and turning "slow" into "failed" on a guess is how a working deployment acquires a mystery.

  **Abandoning does not cancel the claim.** There is nothing to cancel an issued IndexedDB mutation with, and a claim that lands late is still a claim, so a second `openForWriting` joins the same attempt rather than issuing a second one -- a caller that retries cannot take the store from itself. The signal applies per CALL rather than to the shared attempt, so one caller giving up never shortens another's wait, and an attempt that is walked away from and later fails leaves no unhandled rejection behind.

  `StoreClaimAbandonedError.retryable` is **`true`**, unlike `StoreWriterChangedError` and the caller-bug refusals. Abandoning proves nothing about the storage: a slow open, a contended database and a permanently wedged one are indistinguishable from outside, and only the first two are helped by asking again. Its message says so, and says that a store which never answers is not always recoverable, because on the measured case it is not: no reload, no new tab, and `deleteDatabase` never completes.

  This is at the SEAM, above every backend, so no store implements anything and no conformance case changes.

  ## The port stops killing hosts it only suspects are dead

  `HostAccess.close` now takes `{quiesced}`, and `dedicatedWorkerHost` calls `Worker.terminate()` only when it is `true`.

  The port used to kill on both release paths. The justification was that a dedicated worker belongs to the tab that made it, so killing it is free, and that killing before a restart is what stops a second writer. The second half was never load-bearing -- ADR-0075's writer token is what stops a second writer, and it stops one that survived a failed kill too -- and the first half is measurably false: ending a worker that has a `readwrite` and a `readonly` transaction in flight can leave its IndexedDB database permanently unable to run any transaction on WebKit. A death is concluded from SILENCE, so the host being killed was overwhelmingly likely to be one that was BUSY. The port was manufacturing the failure mode it exists to survive.
  - **`port.close()`** now asks the host to `stopIndexing` first and releases it with `{quiesced: true}` when it answers. That answer is a promise that the cycle in flight LANDED and no other will start, which is exactly the quiet a shape needs before it may kill anything. It still returns immediately and everything an app can observe is unchanged: no further events, every call in flight rejected at once.
  - **A concluded death** releases with `{quiesced: false}`, and a shape that would otherwise kill declines. The worker is abandoned instead.

  Abandoning leaks a thread, and the leak is bounded by a fact worth stating: a dedicated worker cannot outlive the document that created it. One idle worker until the page goes away, against a local index the user cannot get back. A SharedWorker is unaffected -- it has no kill to gate, since it is serving other tabs.

  `close` gaining a required argument is the only breaking edge, and only for code that implements `HostAccess` by hand; the three shapes this package ships handle it.

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

- ff167f0: **A writer whose mutation is refused now DEMOTES itself to a reader instead of raising at your app** (ADR-0078).

  Losing the store is not an application error: it is a writer learning it lost a race it could not have avoided (ADR-0075). So `@etherfold/browser` stops fetching and folding, DROPS the in-memory `LastSync` that is now a lie, narrows every store it was folding into to `openForReading`, and goes on ANSWERING READS from the store the winner is writing. The tab that lost keeps showing correct data.

  **New: `demoteToReader`**, one exported function for the two ways of losing -- a refused write (`'write-refused'`, which the hook calls for itself) and a lost lease (`'lease-lost'`, which a caller electing one indexing tab calls through `indexer.demoteToReader(...)`). It is not the inverse of `promote`: that moves the canonical pointer between generations, this drops the write duty over the storage they fold into.

  **New: `syncing.demotion`** (`{reason, reading}`), reported beside `syncing.streamSeed` and deliberately NOT inside `syncing.error`, plus a `named-logs` warning -- because a tab that silently stops indexing for ever is the quiet failure the writer guard exists to end. `status` returns to `Idle`. It clears on `dispose()`.

  **BREAKING: `indexMore()`, `indexMoreAndCatchupIfNeeded()` and `indexToLatest()` now answer `Promise<LastSync | undefined>`.** `undefined` means DEMOTED and means nothing else. Throwing was rejected because both browser loops swallow exceptions and retry on a timer, so the refusal would be retried for ever against a store that will never accept it again; returning the last cursor was rejected because that is the very value the demotion exists to drop (`checkTxInclusion` answers from it). A caller that ignores the return value needs no change.

  **`startAutoIndexing()` on a demoted tab returns `false` and starts nothing.** A demoted writer never re-claims on its own: a backend does not re-mint a claim it has committed, so indexing again means `dispose()` plus a fresh `init` over a store built FRESH, which re-reads everything.

  A demoted writer is deliberately NOT a follower. A follower is read-only on the STREAM axis and a full writer of STATE (it re-folds through `EventProcessor.process`, so it calls `applyBlock` constantly); a demoted writer must stop writing state, so "become a follower" would keep mutating, keep being refused, and loop.

  `@etherfold/state-store` is unchanged in behaviour: what is new there is the assertion that the refusal a lost writer meets stays OUTSIDE the `BlockUnavailableError` family (that family is a read this store cannot answer; this is the write path, and the mutation did not happen).

- ce6cd80: **A SharedWorker is now a hosting shape: several tabs attach to ONE host, and an app chooses it with one constructor argument** (ADR-0082).

  Dedicated stays the DEFAULT and nothing changes for an app that says nothing. Shared is opt-in and wins a narrow prize -- one store connection, and no election needed at all -- while paying for it: no devtools panel (it needs `chrome://inspect`), no way for a client to terminate it, and every tab's reads funnel through the one instance instead of parallelising across a worker per tab.

  The tab side is one argument:

  ```ts
  const indexer = connectToIndexerHost(
  	sharedWorkerHost(
  		() => new SharedWorker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module', name: 'my-app-indexer'}),
  	),
  );
  ```

  ...and the entry point is the same file with one call changed:

  ```ts
  // indexer.worker.ts -- `hostIndexerInThisWorker` becomes `hostIndexerInThisSharedWorker`
  hostIndexerInThisSharedWorker({
  	createState: async () => openForWriting(await createBrowserStateStore(processor.entities)),
  	createProcessor: (store) => new EntityEventProcessor(store, processor),
  	provider,
  	source,
  });
  ```

  **NAME the worker.** A SharedWorker is identified by its SCRIPT URL plus its name, so two tabs of one app reach one host and two different apps on one origin get different hosts with nothing to configure -- the same scoping the writer guard arrives at from the storage side (ADR-0075). Leaving it unnamed makes every SharedWorker loaded from that script URL the same one. That property is verified rather than built: a second name is a second host, folding elsewhere, observed on Chromium, Firefox and WebKit.

  **Nothing inside the host changed.** `serve.ts` was not touched: the container, the store, the driving loop, the envelope and every case on it are the same code in both shapes, and the browser run proves it by loading ONE built entry file first as a `Worker` and then as a `SharedWorker` and running one piece of app code against both ports (everything it reports matches except the two fields that SAY which shape answered). What the new shape adds is inside `sharedWorker.ts`, where a shape belongs: a SharedWorker is handed a wire per CLIENT, so those wires are presented to the host as the single endpoint every shape gives it.

  That fan-in has one job that is not optional. A correlation id is unique per PORT and not globally, which is exactly right and becomes load-bearing the moment there are several ports: two tabs are two documents, each counting from one, so their ids COLLIDE by construction. Answers are therefore re-numbered into one id space on the way in and posted back to the one client that asked -- broadcasting them would RESOLVE one tab's `progress()` with the rows another tab asked for. Pushes go to the tabs that subscribed and to no others.

  **A runtime without SharedWorker is TOLD.** `sharedWorkerHost` refuses before it calls your factory, naming what is missing and the shape that works everywhere. It deliberately does not fall back on its own: the shape decides how many writers an app has, so swapping it silently would change that without saying so (`typeof SharedWorker === 'undefined'` is the whole of the check, for an app that wants to branch). Calling the wrong entry helper for the scope is refused too, in both directions, because a mix-up is otherwise SILENT -- a shared scope has no `postMessage` of its own and a dedicated one never fires `connect`, so what an app would see is a host that never answers.

  **Lifecycle.** One tab closing is not the host closing: `close()` releases that tab's own port and the fold goes on for whoever is left. The browser ends the worker when its LAST client is gone, and the next tab RESUMES from the cursor rather than re-indexing, because the cursor is written in the same transaction as the block it describes (ADR-0027) -- measured on the ranges the node was asked for, not on the resulting rows, which a re-index would reproduce exactly.

  WHICH tab indexes, and what happens when it goes away, is still `one-tab-indexes-and-the-others-read`'s decision. This makes its first rung possible and takes no position on it.

- 91cb92c: **`oneTransactionAtATime`: an opt-in refusal to hold two IndexedDB transactions open at once, because on WebKit ending a worker with two in flight can wedge the database for ever.**

  On WebKit only, terminating a dedicated worker that has BOTH a `readwrite` and a `readonly` transaction in flight on one database can leave that database permanently unable to run any transaction. `indexedDB.open` keeps succeeding and reports every object store; every transaction taken afterwards then hangs with no `complete`, no `abort` and no `error`, `readonly` as hard as `readwrite`, in the tab as much as in a replacement worker. An unrelated database in the same origin stays healthy, a reload does not clear it, a NEW TAB does not clear it, and `deleteDatabase` reports `blocked` and never completes -- so an application has no recovery available to it short of choosing a different database name and re-indexing from scratch.

  It is not a harness artefact: an **iPhone 12 on iOS 18.3.2 / Safari 18.3.1 wedged 12 databases in 200 runs** of a framework-free page, and a much newer upstream build wedges 7 to 13 in 200. Chromium 141 and Firefox 145 are 0 in 200 on the same page, and on all eleven variants of the automated probe. The reproduction, the results and the report body are in `docs/spikes/webkit-terminated-worker-wedges-indexeddb/`.

  **Why this package is exposed to it at all:** every read here opens a transaction, awaits the REQUEST, and returns -- which is what every IndexedDB wrapper does and is perfectly legal -- so a read's `readonly` transaction is still committing under the write that follows it. A call trace of a wedging run shows exactly that and nothing else. Since ADR-0082 treats worker eviction as an EXPECTED event, an app folding in a worker can meet this.

  ```ts
  // decide it in the TAB, where a WebKit engine can actually be identified
  const webkit = navigator.vendor === 'Apple Computer, Inc.' || 'GestureEvent' in window;
  const worker = new Worker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module'});
  worker.postMessage({oneTransactionAtATime: webkit});

  // ...and in the worker, pass it to the store
  const store = await createBrowserStateStore(processor.entities, {oneTransactionAtATime});
  ```

  **It is OFF by default and this package will not decide it for you.** That is not timidity, it is measurement. The option makes every read await its transaction's COMMIT and serialises operations, and a commit round trip is the same order of magnitude as a small read: `getCurrent` costs x1.37 (chromium), x1.84 (firefox), x1.37 (webkit); `getAsOf` x1.48 / x1.88 / x1.33; a fold under concurrent read load x1.11 / x1.21 / x1.11. A `listCurrent` barely moves (x1.03 to x1.16) because its many requests share one transaction -- the cost is charged per TRANSACTION, so what it taxes is a pattern of many small reads. Chromium and Firefox would pay all of that for a defect they do not have, which is why "just do it everywhere" was measured and rejected rather than assumed.

  **Nor can it be auto-detected where it would have to run.** Inside a `DedicatedWorkerGlobalScope` every WebKit tell is gone: `navigator.vendor` is `[Exposed=Window]` and absent on all three engines, and `GestureEvent`, `CSSPrimitiveValue` and `webkitConvertPointFromNodeToPage` are `true` only in WebKit's window and `false` in WebKit's own worker. Only the user-agent string separates the engines there. In the TAB both `navigator.vendor` and `GestureEvent` work, and both were checked on an iPhone against Safari, Chrome for iOS (`CriOS`) and Firefox for iOS (`FxiOS`) -- all three are WebKit, all three are caught, which matters because on iOS every browser is WebKit and therefore affected.

  **It changes no answer.** `@etherfold/state-store-conformance` runs a fourth time against a store with the option set, and the whole contract passes identically: awaiting a read's commit before returning it is a latency change and nothing else. Nothing about the default path moved -- the option defaults to `false` on `IndexedDBStateStore` and is simply forwarded by `createBrowserStateStore`.

  Nothing has been filed against WebKit yet; `docs/spikes/webkit-terminated-worker-wedges-indexeddb/bug-report/` holds the standalone reproduction and the report body ready to submit.

- 351c585: A cached stream has a real IDENTITY: a digest of its FETCH FILTER plus its stream CONFIG, and that digest fills the address level `the-stream-appends-in-segments-on-indexeddb` left as a placeholder.

  `@etherfold/core` exports `streamDigestOf(source, streamConfig)`: 128 bits of `viem`'s `sha256`, SYNCHRONOUS, rendered as 32 fixed-length lowercase hex characters every substrate can carry as a key element. It is taken over the DEDUPLICATED `streamHash` values SORTED BY THEMSELVES, plus the resolved stream config, and over nothing else. `hash` and `legacyHash` are excluded: they cover the DECODING shape, which is what the stream is deliberately independent of. Sorting the values by themselves rather than rolling the digest up over the entry list is load-bearing — that list is sorted by `(startBlock, hash)`, so a decode-only change (a renamed non-indexed parameter) reorders it while every `streamHash` is unchanged, and a digest over that order would fork a new stream, re-fetch the whole history and orphan the old one, silently.

  `simple_hash`'s canonicalisation is extracted as `canonical_form` and shared rather than copied, so the wide digest and the 32-bit change detector cannot disagree about whether two values are the same; `simple_hash` itself is byte-for-byte unchanged.

  The config is in the digest because it decides what a stream CONTAINS (`alwaysFetchTimestamps`, `alwaysFetchTransactions`, `parse.filters`), and because `sourceInvalidationOf` already invalidates the stream half from block 0 whenever it moves. This is ADR-0006's `{source, config}` stream keying made concrete, narrowed on the source side to the FETCH half per ADR-0034 (ADR-0008's 2026-08-31 amendment records the narrowing).

  **`ExistingStream` gains an optional `setStreamConfig`**, which the indexer calls in `reinit` with the config it RESOLVED, before any other call and again on every reconfigure. A keeper is handed a `source` on every operation and never the config, so without it a keeper that addresses a stream would map two configs onto one subtree. A keeper that addresses nothing (a replayed fixture) omits it.

  **`keepStreamOnIndexedDB` now addresses `['stream', <indexer-name>, <streamDigest>, ...]` with the real digest**, and `placeholderStreamDigest` is deleted. `streamAddress(name, source, streamConfig)` takes the source and the config in place of the `chainId` it used to derive the placeholder from; `chainId` is still not a level of its own, because the digest covers it through the block-0 skeleton entry. The `<indexer-name>` level is untouched, so two names and two chains stay isolated exactly as before.

  **Nothing migrates and no payload is rewritten.** A stream written under the placeholder is simply a stream under a different digest: unreachable by a filter that now resolves elsewhere, so nothing needs to move. Disposing of those subtrees belongs to the unregistered-subtree sweep in the generation registry, which is the only place that can know which digests are registered.

- fce71f7: A tab STARTS, STOPS and RECONFIGURES the indexer its host is running, and sees which generation answers reads.

  The port carried progress and the store's four reads; the lifecycle stayed in the host, so an app whose UI lives in a tab could not offer a settings screen, a backgrounded-tab pause, or a source change at all. Five cases now ride the same envelope -- `startIndexing`, `stopIndexing`, `reconfigure`, `generations`, `promotion` -- and `IndexerPort` grows the matching verbs.

  ```ts
  await indexer.stopIndexing(); // answers when the cycle in flight has LANDED
  const {generation, added} = await indexer.reconfigure({source: nextSource});
  const held = await indexer.generations(); // who exists, how far each got, which one answers reads
  ```

  **A stop is honest.** It resolves once the cycle in flight has landed, so no chain request is made after a caller has been answered and the cursor is where a completed cycle would have left it -- a stopped indexer resumes without re-indexing and without skipping. A cut-off cycle is not on offer: the cursor is written in the same transaction as the block it describes (ADR-0027), so the consistent thing to do with an advance already under way is to let it finish. Starting a started host, or stopping a stopped one, is an ANSWER rather than a refusal: these name a STATE a caller wants, not an edge, so two components each asking once leave the host in the state they both asked for. The container is opened once and stays open across a stop, so a host that is not indexing still answers reads.

  **A reconfigure carries the SOURCE, and the generation machinery does the rest.** `Indexer.add` builds the new generation BESIDE the live one, which goes on answering every read until the promotion policy moves the canonical pointer -- nothing is discarded, and a source that hashes to a generation already held resolves to it rather than rebuilding (`HostReconfigure.added` says which happened). The source is the only half of a generation that is data: a fold is code, so changing it is a new worker bundle rather than a message (ADR-0082), and the stream config is not settable per generation. `PromotionConfig` is still passed through un-defaulted at every boundary, and `promotion()` reports what the container resolved.

  **A refusal keeps its type AND its fields.** `PortError` gains `details`, carrying the refusal's own enumerable fields, and `errorFromPort` puts them back where the class declared them: a `GenerationCapReachedError` that crosses a port still says which cap, at what limit, and which generations could be deleted to make room, so an app branches on the refusal instead of parsing its sentence. A field that cannot be cloned is dropped rather than taking the whole refusal down with it.

  **One fix to an existing contract:** a request payload that cannot cross now REJECTS the caller's promise instead of throwing past it. `assertClonable` ran before the promise was constructed, so `await port.call(x).catch(...)` did not catch the one input it refuses -- and the reads that shipped first carry only strings and numbers, so nothing had reached it.

- 6874274: **A tab reads the store across the port**: the seam's four reads are proxied to the host, so an app holding only a port gets TYPED rows with no query runtime on its first-paint path (ADR-0082).

  `createPortReadSurface(port, entities)` is the port-side twin of `createReadSurface(store, entities)` -- same call shape, same result type, same four reads per entity, typed off the declarations the app already wrote. Under it, `IndexerPort.reads` is the untyped, entity-name-string handle those types are generated over, which is what `EntityStateView` is on this thread; four new cases ride the existing envelope (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`, plus `declarations`), so nothing about the transport, the correlation or the clone guard moved.

  There are FOUR reads and there will not be a fifth: no predicate, no caller-supplied ordering, no offset (ADR-0021). Richer queries arrive on this same port as an EXECUTOR with its own serialisation, not as more methods here.

  **The rows are the same rows, and that is a test rather than a claim.** One case list runs against a surface over a store on this thread and against a surface over a port to a host holding its own store, with both stores written by the same processor from the same captured logs, in node over a `MessagePort` and in Chromium, Firefox and WebKit over a real dedicated worker. The projection to the declared columns happens in the HOST, through the same `declaredRow` the same-thread surface uses, so version columns never cross and an unlisted declared field arrives as `null` exactly as the store wrote it.

  **Reads are served WHILE the fold runs**, from the store the CANONICAL generation folds into, resolved per read. One arriving before the host has opened its store waits for it rather than being refused, and is rejected with the failure that stopped the host if one never arrives.

  **`UnknownEntityError` (`@etherfold/state-store`) is new**, thrown by `mustGet` -- so every backend raises the same named refusal for an entity its declarations do not describe, with the same message, and the name survives a `postMessage` where the class cannot. `assertDeclaredBy` is exported from the same package for the same reason: a port proxy checks its declarations against the host's with the seam's own rule instead of a second, weaker one, and refuses a disagreement naming both. If you matched that refusal on its message, the text is unchanged; if you matched `Error` by identity, it is now a subclass.

  A tab-only import is measured rather than described: `packages/browser/test/bundlesForABrowser.test.ts` bundles the three imports an app's tab half writes and asserts no query runtime, no store implementation and no engine came with them (8.2 KB minified against 152.4 KB for the whole package when this landed).

- 7c12a36: A tab renders "syncing, N blocks behind" from progress its host PUSHES at it, and nothing polls (ADR-0082).

  `IndexerPort` gains `onProgress(listener)`, which returns the detach. The host posts when a batch has been APPLIED or the fold changed phase, and posts nothing when the report would repeat the last one, so a host resting at the tip is silent rather than emitting a heartbeat an app has to ignore. Nothing is posted until a tab asks, and when the last listener lets go the host is told to stop: an unsubscribed tab stops RECEIVING pushes rather than merely ignoring them.

  ```ts
  const stop = indexer.onProgress(({phase, blocksBehindTip}) => {
  	banner.textContent = phase === 'at-tip' ? 'live' : `syncing, ${blocksBehindTip} blocks behind`;
  });
  ```

  The listener is called with where the fold is NOW as soon as the host answers (it is the subscribe call's own response, not a push chasing it), so a tab that attaches half way through a fold -- or after the fold has finished and will never move again -- renders the truth without waiting.

  **`createProgressReadable(port)`** is the small helper for the app that just wants a progress bar: the same `Readable` shape `createIndexerState` publishes its stores as, holding whatever the host last said, `undefined` until it has said anything. It is a VIEW over the signal and never a second source of truth -- it keeps the host's own report by reference, derives nothing and merges nothing -- so an app with its own store or signal library subscribes to `onProgress` directly and loses nothing.

  **`HostProgress` grows a `phase` and three derived figures.** The phase is coarse and the set is closed (`SyncPhase`: `waiting`, `loading`, `catching-up`, `at-tip`, `refused`), which is what an app changes its screen for; the load's finer sub-steps (`fetchingLogs`, `FetchingEventStream`, `ProcessingEventStream`) stay a main-thread detail rather than becoming a message each. `at-tip` is the driver's own rest condition and not a threshold beside it, and `refused` is pushed with the `failure` that caused it, because silence and a stall look identical from a tab.

  The figures are `blocksBehindTip`, `numBlocksProcessedSoFar` and `syncPercentage`, computed in the host exactly as `createIndexerState` computes them for the main-thread case. Two differences worth knowing: the distance to the chain tip is `blocksBehindTip` and not `blocksBehind`, because `GenerationProgress.blocksBehind` already means how far a non-canonical generation is behind the CANONICAL one; and all three are ABSENT until a tip has been learnt, rather than computed from the `0` of `0` a container publishes before it has fetched. `ExtendedLastSync.totalPercentage` does not cross at all: it measures the fold against the whole chain, so a deployment starting at block 20,000,000 reads 99.9% from its first fetch.

  **On the envelope:** a third message kind (`kind: 'push'`, carrying no correlation id, since nobody asked) with `PortPushes` as the map a later push adds a key to, plus `subscribeToProgress` / `unsubscribeFromProgress` cases. `isPortPush` is exported beside `isPortRequest` and `isPortResponse`.

- 39eaf51: **A terminated indexer host is TOLD OF, RESTARTED, and RESUMES from the cursor** (ADR-0082).

  Browsers evict workers, so a death is now an expected event with a defined outcome rather than something an app infers from a number that stopped moving. Four things happen and each is load-bearing: the app is told, every call in flight rejects with a typed error, the port starts another host, and the fold carries on from where it was.

  ```ts
  indexer.onHostDeath(({attempt, restarting}) => {
  	banner.textContent = restarting ? 'the indexer restarted' : `the indexer keeps failing (${attempt} times)`;
  });
  ```

  **`dedicatedWorkerHost` now takes the LINE THAT BUILDS a worker rather than a worker.** This is the one breaking change, and it is one arrow:

  ```diff
  -const indexer = connectToIndexerHost(dedicatedWorkerHost(new Worker(url, {type: 'module'})));
  +const indexer = connectToIndexerHost(dedicatedWorkerHost(() => new Worker(url, {type: 'module'})));
  ```

  A hosting shape IS "how a port is obtained", so obtaining one again after a death belongs there and nowhere else. Handed an instance, a port could report a death and reject the calls and then do nothing, with nothing in the types saying the restart half was missing; handed a factory, every port can restart. `HostAccess` carries that as `reopen?`, so a shape that genuinely cannot be re-obtained (a wire somebody else owns) says `restarting: false` instead of pretending.

  **Resume costs nothing and is demonstrated rather than asserted.** Nothing tells the new host where to start: the cursor is written in the same transaction as the block it describes (ADR-0027), so a host that starts reads it and carries on. The proof is a real dedicated worker terminated MID-WRITE in a real browser (`browser/restartsAndResumes.spec.ts`), asserting on the ranges the replacement asked the node for -- a restart that re-ran the load would land on identical rows and only the fetches can tell the two apart.

  **In flight means REJECTED, by type.** `IndexerHostDiedError` carries the death (its cause, which consecutive attempt it was, whether a replacement is coming) and the CASE the lost call was on. It is narrowed by `instanceof`, unlike the refusals that cross the port, because it is raised in the tab about a host that is not there. A client that wants to retry can, and most already do; a silent retry would hide the event.

  **A death is noticed by SILENCE, and a restart is BOUNDED.** No browser fires an event when it evicts a dedicated worker, so the port probes a host that has gone quiet (a new `ping` case) and treats an unanswered probe as a death: what is polled is liveness and never status, which stays pushed. Restarts are budgeted with a doubling backoff, and a host that stays alive long enough is settled so the count starts again -- a worker that dies on boot must not become a hot loop building workers for ever, and the app can see that is what is happening. Both are configurable and are meant to be left alone:

  ```ts
  connectToIndexerHost(access, {watch: {everyInSeconds: 5}, restart: {attempts: 5}});
  ```

  **Two hosts never write to one store.** The port releases the access it is replacing BEFORE it opens a successor, so a host merely suspected of being dead is terminated rather than left running beside its replacement. The writer claim (ADR-0075) sits underneath that as the guarantee rather than the mechanism: it neither blocks nor expires, so a writer killed mid-block leaves a store the next claim simply takes over.

- d4a64a2: `checkTxInclusion` asked from a TAB and answered by its HOST, so an app whose indexer runs in a worker can still lay an optimistic update over indexed state without double-counting.

  The verdict is the one answer on this port that must not be simplified on the way across, and it is not: `IndexerPort.checkTxInclusion` takes the app's whole pending set in ONE round trip and hands back `@etherfold/core`'s `TxInclusionVerdict` per hash, unchanged -- a STATUS and the BASIS for it.

  ```ts
  const verdicts = await indexer.checkTxInclusion(
  	pending.map(({hash, block}) => ({txHash: hash, minedAtBlock: block})),
  );
  for (const {hash} of pending) {
  	if (verdicts[hash].status === 'included') overlay.drop(hash); // the fold has it: stop predicting it
  }
  ```

  **The basis is what an app renders, not the status alone.** `unknown` has two distinct causes -- nothing is synced yet (`not-synced`), and the fold is so far behind the tip that its window says nothing about the region asked about (`window-not-covering`) -- and both mean KEEP the optimistic update, where an honest `absent` means the fold has looked and not found it. Collapsing any of that into a boolean at the boundary is exactly the double-count the call exists to prevent.

  **`minedAtBlock` crosses per query.** The unconfirmed window is SPARSE, so `absent` means only "not in the window"; a caller holding a RECEIPT closes that through the `below-window` branch, and a tab is precisely where a caller has one. The receipt's block HASH is still never compared, because a reorg can re-include the same transaction in a different block.

  **A verdict is a SNAPSHOT.** It is answered from the cursor the host is reporting at the moment of the call and from the finality depth its container actually runs with, so an app watching a transaction asks again -- when `onProgress` says the fold moved, which is when the answer can have changed. It follows the **canonical pointer** for the same reason: the retired cursor is dropped when a promotion moves it, so a tab is never answered from a window nothing is maintaining any more.

  **It answers rather than waiting.** Unlike a read, which waits for the host's first store because "read me the rows" has no honest answer until there is one, this call does not wait for the container to open: a host that has synced nothing says `unknown`/`not-synced`, which is a verdict an app renders, so asking early is answered instead of hanging on however long a provider takes.

- 9409985: **The MAIN THREAD is now a named hosting shape, and `createIndexerState` IS it** (ADR-0082, whose `status: accepted, not yet implemented` line is removed by this change: all three shapes exist).

  The set closes. A browser indexer runs in a dedicated worker (the default), in a SharedWorker, or on the main thread, and the three differ ONLY in how a port is obtained. **The code an app writes against the port is identical across all three**, which is what makes moving the fold off the UI thread later a change to one line of wiring.

  ```ts
  const indexer = createIndexerState({createState, createProcessor});
  await indexer.init({provider, source, config: {stream: {finality: 12}}});
  await indexer.startAutoIndexing();

  // the third hosting shape: a wire to the host that is ALREADY here
  const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
  ```

  **Nothing breaks.** `createIndexerState`'s name, arguments and every verb it returned are unchanged; the returned object GAINED one method (`mainThreadHost()`). An app that never wants a port never sees any of this.

  **Why the third shape is reached from the hook rather than from a top-level factory.** `dedicatedWorkerHost(() => new Worker(...))` and `sharedWorkerHost(...)` CONSTRUCT a host. On this thread there is already one: `createIndexerState` owns the container, opens the store for writing and runs the loop. A `mainThreadHost(spec)` beside those two would have been a SECOND way to build a main-thread indexer with no rule for choosing between them (and, if an app used both, a second container over one store and a writer refusal three layers from the line that caused it). Grep the package's exports: there is one.

  **What it costs, said plainly, because the guide now leads with the dedicated worker instead.** The fold is on the UI thread. 45.6 ms per block of store writes on Chromium is jank in an app that is also trying to render. The main-thread shape is for tests (an in-process path is needed regardless), for a backfill small enough that nobody notices, and for a build that cannot emit a worker. Pass `{watch: false}`: a host on this thread cannot die independently of the tab holding the port, so the liveness probe has nothing to find, and its access carries no `reopen` rather than pretending a restart is possible.

  The wire is a real `MessageChannel`, not a direct call. A value that could not cross to a worker must not cross here either, or the shape an app develops against would be more permissive than the shape it ships.

  **"One implementation, three shapes" is now a fact about one module.** The case dispatch, the row projection, the derived progress figures, the refusals and the push cadence moved into `src/host/cases.ts`, which is the only place a port case is served, and all three shapes reach it. What is honestly NOT shared is the DRIVER: the worker hosts run `serveIndexerHost`'s loop, the main-thread host runs the hook's own auto-index loop and its four verbs. It is checked by ONE parameterised behaviour suite run against all three shapes in a real browser and against the main-thread one under vitest on every commit, rather than by three test files that agree.

  **One behaviour change worth knowing.** `stopAutoIndexing()` now also stops a cycle that was already IN FLIGHT from re-arming the loop. It used to clear only the pending timer, so a stop that landed mid-cycle was undone by that cycle's own re-arm a moment later. That was invisible while nothing waited on a stop; `IndexerPort.stopIndexing()` promises that no chain request is made after it answers, and this is what makes the promise true on this shape.

  `CONTEXT.md`'s **indexer host** entry loses its NOT YET BUILT marker, and its **tx inclusion** and **processor kind** entries now describe the browser surface as the three shapes rather than as one hook.

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

- e475531: The browser indexing loop now SCHEDULES the prune its retention implies, so a store that states a floor actually reclaims what falls below it.

  Retention has two halves and only one of them ran here. A window has always bounded what a READ may ask about (`assertRetained`, on every backend); `prune` is what drops the versions it no longer covers, and ADR-0022 makes that an explicit call the HOST schedules, deliberately, because it costs time proportional to what it drops. Nothing in this package called it. A tab that configured `{blocks: N}` therefore got the refusals of a bounded store and the footprint of an unbounded one, on a device under a quota, for as long as it stayed open. The measured workload reached 4,072 live rows against 29,393 versions, so unbounded is roughly seven times the live set and the ratio grows with churn.

  `createIndexerState`'s cycle now prunes the state of every generation it holds, once per advance, after the advance has been published.

  **The trigger is a FLOOR, not a window.** `retentionFloor` returns one for `revert-only` too wherever a `finalityDepth` was stated (that kind keeps superseded versions exactly as long as reorg revert needs them, and the depth is how long that is), so a `revert-only` deployment prunes as well. Reading the trigger as "a window is set" is what would leave the setting a browser app wanting reorg safety and no history is told to prefer refusing every historical read while retaining every version for ever.

  **Nothing changes for a store with no floor**, which is the default: `unbounded`, and `revert-only` with no depth, delete nothing. The call is made unconditionally rather than guarded, because a prune is a no-op wherever there is no floor (ADR-0022) and the capability report carries no finality depth, so a host holding the seam cannot tell the two `revert-only` cases apart anyway.

  **No default is changed.** `retention` still defaults to `unbounded` everywhere; what a deployment already said it keeps is now what it keeps.

  New: `createIndexerState(..., {pruneBudget})`, how many versions ONE pass may delete, defaulting to the exported `DEFAULT_PRUNE_BUDGET` (1,000). The budget is per PASS and never a limit on what is reclaimed: an unfinished pass leaves the rest for the next cycle, so a tab that ran unbounded for a month before a window was configured drains its backlog over cycles instead of stalling on one delete. It is not a way to turn pruning off, which is what `retention` is for. A prune that throws is logged and the cycle carries on: indexing is what the tab is for.

  Applying a block still performs no deleting, which is asserted rather than trusted (`test/scheduledPrune.test.ts` watches the seam and no `prune` is ever in flight while an `applyBlock` is). The reclamation itself is measured in a real engine, on real IndexedDB, in `browser/indexing.spec.ts`.

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

- 5aa33a9: **The indexer can be HOSTED in a dedicated worker, and a tab holds a typed PORT to it** (ADR-0082).

  A **host** is the execution context that owns a **container** and drives it. This adds the first one that is not the UI thread, so folding a chain's history stops competing with rendering, and a tab holds a port instead of the container.

  An app writes two things. A worker entry point, which is where its processor and its provider are IMPORTED (both are code and closures, so neither can cross a `postMessage`):

  ```ts
  // indexer.worker.ts
  import {createBrowserStateStore, hostIndexerInThisWorker} from '@etherfold/browser';
  import {EntityEventProcessor} from '@etherfold/processor-entities';
  import {openForWriting} from '@etherfold/state-store';
  import {processor, source, provider} from './my-app.js';

  hostIndexerInThisWorker({
  	createState: async () => openForWriting(await createBrowserStateStore(processor.entities)),
  	createProcessor: (store) => new EntityEventProcessor(store, processor),
  	provider,
  	source,
  });
  ```

  ...and a constructor call in the tab, which owns the `new Worker(...)` line so its bundler can trace the entry:

  ```ts
  const indexer = connectToIndexerHost(
  	dedicatedWorkerHost(() => new Worker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module'})),
  );
  const {lastToBlock, latestBlock} = await indexer.progress();
  ```

  **The host holds the writer and a tab cannot.** `createState` runs inside the host, so the claim (ADR-0077) is taken there; `IndexerPort` names no mutating verb and carries no store, so the writer/reader split is a fact of the type rather than a rule to remember. A tab that wants rows opens the same store for READING today; proxying the four reads over the port is the next task in this spec.

  **One envelope, and surfaces are CASES on it.** `PortCases` is the map a later task adds a key to: request and response are typed off it, correlation is handled once, and every value is checked for structured-clone safety BEFORE it is posted — a function, a symbol or a live class instance is refused with a message naming the field it sat in (`the 'read' response.rows[1].store`), rather than as a `DataCloneError` naming an object from the boundary's own stack. A class instance is refused even though clone accepts it, because clone accepts it by dropping the prototype and handing the other side a copy with no methods.

  **One host body, not one per shape.** `serve.ts` names no worker; `dedicatedWorker.ts` is the only file in the package that does, and all it does is hand over a wire (`HostAccess`). That is what makes the SharedWorker and main-thread shapes configuration rather than a second implementation.

  `progress` is the one surface so far: how far the fold has got, and WHERE it is running — `scope` is what `globalThis` IS in the answering context, which is how a test asserts that the UI thread is not doing the fold without timing anything. Note the container's own edge it reports faithfully: before the first fetch a cursor is `0` of `0`, so equality alone is not "caught up".

  `createIndexerState` is untouched and remains the main-thread path; the last task in this spec makes it this same host rather than a second way of building one.

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

- 8673844: **The stream-seeding outcome now reaches the surface an application already subscribes to.** An app can render "installing", "seeded at block N", or a refusal with a reason it can explain, instead of the unexplained empty screen ADR-0064 names as the outcome the whole seeding spec exists to avoid.

  It lands on the EXISTING stores and adds no reactive mechanism:
  - **`SyncingState.streamSeed`**, a new field beside `error` and `nonCanonicalGenerations`, carrying a small discriminated state: `{status: 'installing'}`, `{status: 'seeded', at, reachesBackTo, from, events, segments}`, `{status: 'refused', reason, direction?}`, or ABSENT where no seed was asked for. Additive, so no existing subscriber changes and no existing field changes meaning.
  - **`StatusState.state` gains `'InstallingStreamSeed'`**, beside `Loading`, `FetchingEventStream` and the rest, because that enum is where applications already switch to choose what to render. The phase LEAVES that value at the terminal outcome (back to `Idle` until the load moves it on): a phase says what is happening, and what happened is the field above.

  **`error` is deliberately NOT reused.** A refusal is a NORMAL condition -- the app still starts and still indexes forward (ADR-0064) -- so an app treating `error` as a fault would render a crash for an ordinary outcome, and `acknowledgeError()` does not fit an outcome nothing can acknowledge away.

  **`createIndexerState` takes an optional `seed`** (`BrowserStreamSeedOptions`: the ordered `locations`, an optional `expectedContentHash`, `reachBackTo`, `maxEventsPerBatch` and an injectable `fetch`) and runs `installStreamSeed` at `init`, BEFORE the generation is built, publishing `installing` and then the terminal outcome. It needs a `keepStream` and RAISES without one, because a seed IS a stream and no location makes a missing keeper right. The trust contract is unchanged and is the caller's: keep both the locations and any pin in the BUILD (ADR-0066).

  **The hook option is ERGONOMICS, not a safety mechanism.** Driving `installStreamSeed` (`@etherfold/core`) directly still works, and is asserted correct BOTH before `init()` and after it, because the install carries its own resolved stream config and sets it on the keeper before addressing anything (ADR-0067). An app that starts indexing before installing gets the `subtree-not-empty` refusal, which is loud, as data, and leaves the stream it refused intact.

  **The direction is DATA and nothing infers from it.** `direction` is the refusal reason narrowed to `seed-covers-more` / `seed-covers-less`, present only where the reason names one, so an app can switch on one field. An application may render "a newer version of this app may be available"; this library may not, because a deliberately narrower client is indistinguishable from a stale one.

  **No byte-level progress**, and that is measured rather than assumed: the whole install is about 1 s on a mid-range phone in the shape this ships, which a spinner covers, and the variable part is the DOWNLOAD. `installing` plus one terminal state is the whole surface, so the field publishes at most twice per boot.

- 8c8341a: The cached event stream appends in SEGMENTS, so a save costs its batch and not the history.

  `keepStreamOnIndexedDB` used to read the whole stream, concatenate and write all of it back on every `saveNewEvents` — a full structured clone of the accumulated history per index cycle, which made a backfill QUADRATIC and charged an empty batch the same price purely to move the cursor. It now writes one immutable SEGMENT per batch, at the next ordinal, together with a CURSOR RECORD, in one `readwrite` transaction; nothing already written is ever touched again, and an empty save writes only the small cursor record.

  The rules live once, in `@etherfold/core`'s new `createSegmentedStream`, over a five-operation `StreamSegmentPort` a keeper supplies (`commitSegmentWithCursor` / `readCursor` / `writeCursorOnly`, plus a scoped segment read and a scoped delete). A SQL keeper and an OPFS keeper are the expected next consumers, and they inherit every rule: the ordinal allocated from the cursor record INSIDE the commit, the full ordered scan on the way back, the one comparison that refuses a write which would leave a hole, and the one rule for damage.

  **A stream is now addressed HIERARCHICALLY**, as IndexedDB array keys in `idb-keyval`'s default store: `['stream', <indexer-name>, <digest>, <ordinal>]` for a segment and `['stream', <indexer-name>, <digest>, 'cursor']` for the cursor record. The digest level carries a PLACEHOLDER derived from `chainId` until the real stream digest lands, so two chains under one indexer name stay isolated exactly as `stream_<name>_<chainId>` kept them. Segments are read with a key RANGE, never a whole-store scan.

  **A stream stored in the previous whole-blob format is DELETED and re-indexed, not adopted**, and the deletion is logged. Nothing is published and no disk anywhere holds state this had to preserve, so the cheap branch is the right one.

  **An inconsistent stream is CLEARED rather than repaired** — a gap in the ordinals, segments with no cursor, an unparseable segment, or a stream that does not reach back to the block a rebuild asks for. Nothing raises: the indexer takes its existing clear branch and re-fetches. A cursor with NO segments is not damage and is kept, because that is the ordinary state of a deployment whose contracts have not emitted anything yet.

  **The stream keeper stores no `unconfirmedBlocks`**, in a segment or in the cursor record, and `fetchFrom` returns a `LastSync` whose window is `[]`. The window's two homes that are actually READ (the state keeper's saved cursor, and the entity path's serialized sync cursor) are unchanged.

### Patch Changes

- ebfa4f0: A stream seed whose body cannot be DECOMPRESSED is now refused `unreadable-format` rather than `unreachable`.

  Both reasons were already in `NotInstalledReason`, so nothing about the type changes; what changes is which one a corrupt or truncated artifact produces. The fetch now stops at the transport and the inflate happens under its own refusal, because the two reasons send someone to different places: a host that answers `200` with a half-uploaded file has been REACHED, and calling that "could not reach it" points an operator at their network while the artifact is what is broken. `unreadable-format` already means "something was fetched and it is not a seed this build reads", which a body that will not inflate is. Failover is unaffected — either reason walks to the next location.

  The `@etherfold/browser` entry is for tests only, with no runtime change: the snapshot-only mode's fixture now publishes a cursor whose observed tip is the finality depth above the snapshot's own block, and the client passes `finalityDepth`, so the consumer half of ADR-0028's two-sided defence is actually exercised. Previously the publisher reported the snapshot's own block as the tip it had seen — which is what indexing straight to the tip produces — and against that `insideReorgWindow` is true for any positive depth, so the guard could never have been on. A new case asserts a snapshot taken at its producer's tip is refused `inside-reorg-window` and installs nothing, and that the same document one finality depth deeper is admitted.

- 011aa87: **A store refusal that waiting cannot fix now says so, and the browser indexing loop stops instead of retrying it for ever.**

  The auto-index loop swallows a failure and comes back a few seconds later, which is right for a rate limit or a dropped socket and catastrophic for a refusal the store will repeat identically. A tab whose store had been moved ahead by another writer before it ever wrote got `block N is not above the recorded tip M`, treated it as transient, and re-fetched the whole range from the node on every tick: measured at ~90 `eth_getLogs` per second of wall clock, with the cursor pinned and nothing reported. The work was invisible precisely because each attempt merely failed again.

  **The three block refusals are now errors carrying `retryable: false`** (`StoreWriteRefusedError`, `@etherfold/state-store`): a height already recorded, a hash already recorded, and a height the tip has passed. `StoreWriterChangedError` carries it too. They are read STRUCTURALLY (`err.retryable === false`), which is why `@etherfold/state-store` declares the flag while importing nothing — it has no dependencies, and an error crossing a package boundary still classifies correctly. The three messages also stop being copied into four backends: `blockNotAboveTip`, `blockAlreadyRecorded` and `blockHashAlreadyRecorded` are the one place that spells them.

  `isRetryable` is now exported from `@etherfold/core` beside `RetryableError`, rather than being a private helper in `logFetcher.ts`, so every driver that retries on a timer asks the question the same way.

  **If you catch these:** the messages and the class of failure are unchanged, and the refusals are still refusals — what is new is the flag and the shared `StoreWriteRefusedError` type. A loop of your own should ask `isRetryable(err)` before re-arming.

  **A refused write stops the browser loop and is NOT a demotion.** It reports through `syncing.error` with id `WriteRefused` and leaves `syncing.demotion` alone, because the two mean opposite things: a demotion says this tab lost a race and should become a reader, while this says the write itself is wrong and the remedy is to revert first or stop. An app can tell them apart.

- 9c15bb8: **A store now reports whether its retention is actually ENFORCED against its storage**, so the one configuration nothing could detect -- a floor in force and nothing ever dropped -- is discoverable instead of silent.

  Retention has two halves. `assertRetained` bounds what a read may ask about the moment a floor exists, and it runs on every read whatever the host does; `prune` physically drops what falls below that floor, and ADR-0022 makes it an explicit call the HOST schedules. Every host this project ships now prunes unconditionally, so the broken state is unreachable with a shipped host -- but a host that rolled its own indexing loop still gets the refusals of a bounded store and the footprint of an unbounded one, and until now the store's own report said nothing about it, because that report is about the CLAIM.

  **The new read is `StateStore.readRetentionEnforcement()`**, a twelfth verb at the seam, answering one of three things: `{kind: 'no-floor'}` (`unbounded`, or `revert-only` with no declared finality depth -- nothing to enforce), `{kind: 'never-pruned', floor}` (a floor, and no pass has ever run), or `{kind: 'pruned', floor, prunedTo}` (a floor, and a pass ran at block `prunedTo`). `floor` is the floor as it stands NOW and `prunedTo` is the floor the last pass ran at, kept apart deliberately: the distance between them is how far behind a prune has fallen, and a store pruned once a year ago reports `pruned` with nothing but that gap to say so.

  **It is asynchronous, and that is the design rather than an inconvenience.** The value is durable -- a store pruned before the process died must not come back saying never -- so it lives in storage, and `capabilities` is a synchronous getter documented as readable before `migrate` and before the database is open. Making it a capability field would have forced either an async `capabilities` (breaking every consumer) or an in-memory flag that resets on reload, which is a report that lies about the exact case it exists to catch. **`capabilities` is UNCHANGED**, so every existing consumer keeps compiling and keeps its pre-open readability.

  **Two details worth knowing.** A pass is recorded whether or not it deleted anything, because a host pruning on a schedule deletes nothing on most cycles and treating "deleted something" as the evidence would make the healthy case the alarm. And whether a store has a floor is a fact about the SETTING, not about how far it has got, so a configured store that has applied no block yet reports `never-pruned` rather than `no-floor` -- it is exactly the store a misconfigured host is most likely to be holding.

  The record rides the cursor port under `RETENTION_ENFORCEMENT_KEY`, as the snapshot origin does: a durable, unversioned, never-reverted, never-pruned slot, so this is one more key rather than a new table on four backends. On IndexedDB it commits in the SAME transaction as the deletion it describes.

  **Every backend implements it and the conformance suite asks all of them**, cross-checking the report against the floor `prune` itself returned -- the suite cannot hold a fixed expectation, because only the store knows whether it has a floor at all. A new backend therefore inherits the obligation rather than rediscovering the hazard.

  No default and no configuration shape changed, and nothing refuses: this is a report. ADR-0076 records why it replaced the construction-time refusal the originating spec launched with, and `work/notes/findings/a-worker-cannot-hold-a-timer-across-requests.md` is the platform constraint that ruled out the alternative.

  `@etherfold/browser` is listed only because a store decorator in its tests implements the seam and therefore implements the new verb. Nothing it ships changed, and the hook still publishes no enforcement state on `syncing`.

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

- c670273: **Documentation only: `revert-only` is now named, where a browser app chooses retention, as the way to ask for reorg safety with no history.**

  The setting already existed and already worked; nothing said so at the point of choice. `BrowserStateStoreConfig.retention` described the window (`{blocks: N}` and the finality depth it may not go under) and mentioned `revert-only` only as a thing that happens to state a prune floor, so a developer who wanted "reorg safety, no history" had no reason not to approximate it with a small window.

  That approximation is worse than it looks, and the reason is measured rather than stylistic. Retention counts BLOCK NUMBERS and never updates (ADR-0019), and on the real measured stream event-bearing blocks are median **429 blocks apart**, max 1,226,194 (`work/notes/findings/sqlite-in-the-browser.md`), so `{blocks: 64}` typically holds exactly ONE of them, the tip's, and often none. What that buys is a store that refuses almost every historical read while looking configured for history: the failure is a refusal a session meets late, rather than a fact reported up front.

  The configuration docstring now says all three parts: `revert-only` is the way to say it, it reports `capabilities.asOf === false` so a caller that needs history learns at startup rather than from a wrong or refused answer later (which is why `asOf` is reported separately from `retention`: a window answers inside itself and refuses outside it, while a store that reconstructs no history refuses everywhere), and it still guarantees the reorg half, because its floor is the finality depth and the versions a revert reopens are exactly the ones it keeps. `finalityDepth`'s own docstring now says why it belongs beside `revert-only` and not only beside a window. The same paragraph is in `@etherfold/browser`'s README, and the `'revert-only'` and `'unbounded'` arms of `RetentionSetting` (`@etherfold/state-store`) carry per-arm docs, so the choice is described where an editor shows it.

  One test is added rather than changed, pinning the claim the docstring now makes on the DEFAULT backend: `createBrowserStateStore(entities, {retention: 'revert-only', finalityDepth: 64})` reports `{retention: {kind: 'revert-only'}, asOf: false}`. It passes on the code as it stands, which is the point: the prose is now checkable.

  No behaviour, default or type changed: `unbounded` is still the default, `revert-only` still reports `asOf: false`, and a window is still refused below the finality depth.

- 5adafa9: The indexer and its cached event stream agree on which of them is ahead, so the cache can be behind or ahead but never HOLED.

  A **hole** is a range of blocks the stream never RECEIVED, hidden behind a cursor that claims to cover them (`[100..5000]` then `[6001..7000]`, cursor at 7000). It was reachable in one ordinary session with no crash and no reload, and nothing detected it afterwards: segments are keyed by save rather than by block, so a save that never happened leaves no trace, and the next state discard replayed the stream as though it were whole.

  **The stream is now written BEFORE the processor is called, and a batch that was not written is not processed.** `promiseToIndex` processed and then saved; the processor persists its own state inside `process()`, so a failed save left the stream a batch behind, and the next cycle computed its delta from the already-advanced cursor and jumped over a range whose events the stream never got. A failed write now means the cycle achieves nothing and the next one tries again from the same cursor: nothing is lost, nothing is skipped. It also makes a second invariant free — **a retraction is never written into a stream that lacks the event it retracts**, because the unconfirmed window cannot advance past the stream.

  **A cache can no longer wedge the indexer, and the retry is bounded and paced.** After `streamWriteRetry.maxConsecutiveFailures` consecutive failed writes (default 3, one attempt every `streamWriteRetry.delaySeconds`, default 1) the cache is FROZEN, said loudly through `named-logs`, and indexing carries on without it. Frozen means frozen, not cleared: what is on disk is a contiguous prefix with a cursor that describes it honestly, so it still seeds a rebuild, and throwing it away would cost a re-fetch from the source's first block. The one cause that DOES clear is a store that is out of SPACE, since there the cache is itself the problem; keepers say so on the error they throw and `isOutOfSpace` reads it structurally (the flag, or the Web platform's own `QuotaExceededError`), exactly as `retryable` is read.

  **A stream that is AHEAD of the state is now REPLAYED rather than re-fetched.** The state-DISCARDED load branch always fed the cached stream; the state-KEPT branch only validated it and had no `else`, so a tab that closed between the two writes caught up from the NODE and appended those blocks to the stream a second time — and the next rebuild saw them twice. It now feeds them, re-decoded against the source running now (ADR-0034), which turns a node re-fetch into a local replay.

  **A stream holding a CURSOR and no events now resumes from that cursor.** The fetched cursor used to be adopted only as a side effect of feeding events, so a deployment whose contracts have emitted nothing left the in-memory cursor at `freshLastSync` and re-scanned from the start block on every reload, forever.

  Two mechanisms are DELETED rather than fixed. `streamNotYetSaved`, the in-memory carry-forward of unsaved events, never fired: it lived on the save action's promise CONTEXT, which is reset unless a save is queued onto one still in flight, and the index cycle awaits its save. It existed only to compensate for processing first, and it appended without de-duplicating. With it gone, `createAction`'s `setContext`/`getContext` had no callers and are gone too. What replaces it is the inverse: the extent of the last SUCCESSFUL write, held in memory, so a processor that throws deterministically cannot grow the cache by one duplicate copy per retry — and where the chain reorged under events the processor never accepted, they are RETRACTED into the stream, because the state cannot retract what it never applied.

  `@etherfold/browser` gains all of this through the core it drives; `ProvidedIndexerConfig.streamWriteRetry` reaches it through `createIndexerState(...).init`. See `docs/adr/0038` for why a frozen stream is never appended to again and why that decision cannot be the keeper's.

- 70e51a6: **A catching-up generation no longer advances one fetch range per tip interval.**

  Both browser drivers decided whether to REST from the CANONICAL generation's cursor alone, but `Indexer.indexMore` advances every generation the container holds. So a successor added by a reconfigure, while the canonical generation was already at the tip, got exactly ONE range per interval with the process idle in between: at the default four seconds, over an hour of wall clock for a successor with a thousand ranges of history to fetch. Nothing reported it, because the generation being reported on really was at the tip.

  The rest is now decided over EVERY generation held, and a generation with no cursor yet counts as behind rather than level -- which is exactly what a just-added one looks like. Adding a generation also WAKES a resting driver, so an app no longer pays out the remainder of an interval before the work it just asked for begins.

  **The rule is decided in ONE place now.** This package has two drivers and goes on having two, because they genuinely differ in how a rest is waited out -- the worker host `await`s a rest it can be woken from, the main-thread host re-arms a timer. What was duplicated between them was never that scheduling; it was the DECISION, which does not differ and had been written out twice. Twice meant two chances to be wrong and both were taken: each rested on the canonical cursor alone. It now lives in one internal module (`host/pacing.ts`), alongside `host/cases.ts`, which already played the same role for the boundary -- so what "one implementation over three hosting shapes" means is one implementation of the boundary and one of the cadence, over two schedulers.

  One consequence is user-visible and is a fix in its own right: the main-thread host's PHASE used the canonical cursor while its rest used the whole container, so it could report `at-tip` while still driving a successor. Both now come from the same decision, and `SyncPhase.at-tip` means what it always claimed to mean -- every generation the container holds is level, not merely the one answering reads.

  Two things deliberately did not change. With one generation held, which is the overwhelmingly common case, the rule is the same expression it always was. And a cycle that advances NOTHING still rests, even while something is behind, so a generation that cannot advance paces the loop exactly as before instead of spinning against a provider a browser user is rate-limited on.

  **`HostProgress.failure` no longer outlives the drive it describes.** A driver stopped by a non-retryable refusal recorded `failure`, and it was only ever cleared by disposing the host -- so a host started again reported a phase that moved (`catching-up`, then `at-tip`) with the old failure still attached, and an app rendering from it showed an error over a fold that was running. Both drivers now clear it when a new attempt starts.

  **The hook's progress figures are numbers before the first fetch.** A container publishes its cursor once at load, as `0` of `0`, and `ExtendedLastSync` derived `totalPercentage` as `lastToBlock / latestBlock` -- `NaN` -- and `syncPercentage` over a negative span. Both now come from `derivedProgress`, the same derivation the port already published from, and read `0` until a tip has been learnt: "nothing known yet", never a full progress bar.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- 4fa577b: **The legacy whole-blob stream compatibility path is deleted.**

  `keepStreamOnIndexedDB` carried a probe for a stream written by an older, flat-key format: a `legacy` address beside every stream subtree, a `hasLegacyBlob` read on the way into every `fetchFrom`, an `inconsistent` status reporting a blob this build cannot adopt, and a paired delete in `clear`.

  It was already decided that such a blob would never be ADOPTED, and for the right reason, recorded where the probe lived: adopting it "would spare a re-index for users who do not exist". The detection was kept anyway. So every indexing cycle paid an IndexedDB read looking for data that cannot exist, through a wrapper whose only other job was to forward five calls, for a status branch that could never fire.

  It also propped up a live decision from a dead one. `keyval.ts` justified sharing `idb-keyval`'s default store partly because "a keeper that quietly opened a store of its own would never SEE the legacy blob it is required to delete". That store choice stands on its two remaining reasons, which are about `clear` semantics and are unaffected; the justification no longer leans on a blob nobody has.

  Nothing about the stream format changes, and nothing that could exist is read differently. `fetchFrom` and `clear` go straight to the segmented keeper, and both still RAISE through on an unreadable store, which the degradation suite asserts independently of which call gets there first.

- 570e029: **The reactivity of the published stores rests on the store library's equality rule, and that is now asserted instead of assumed.**

  Tests and docs only; no behaviour change. Both published stores call `set(x)` where `x` is the SAME OBJECT they already hold: `state` publishes a read handle with deliberately stable identity (the same object every time, so a caller keeping one is not defeated by an update), and `syncing` mutates its state object in place and then sets the store to the object it just mutated. They notify only because `sveltore`'s `writable` guards on Svelte's `safe_not_equal`, which reports any object as changed regardless of identity.

  Nothing stated that dependency, nothing tested it, and breaking it is SILENT: swap in any store whose default equality is `===` (Solid's `createSignal`, Vue's `ref`, a React `useSyncExternalStore` snapshot compared by identity) and every subscriber simply stops being called, with no error and no failing test. `reactiveUpdatesNotifyOnAStableIdentity.test.ts` pins it, and was verified by substituting an identity-comparing store: subscribers drop from three notifications to one, and the test reddens naming the reason.

  The browser guide also now says what `state` actually publishes. On the entities path the value is a HANDLE carrying no rows, so an update is a notification to RE-READ rather than a delivery of new state, and neither `state` nor `syncing` can be diffed or snapshotted by a subscriber, because the previous value is the same live object as the current one.

- 85f1982: **The cursor port is now ENTIRELY the caller's: the seam keeps its own three records in a keyspace of its own** (ADR-0080).

  Three facts the seam must not forget across a reload used to live at the cursor port under reserved key names: `snapshotOrigin` (where a bootstrapped store's rows came from, ADR-0028), `retentionEnforcement` (the floor the last prune ran at, ADR-0076) and `writerClaim` (the no-op a claim is taken by, ADR-0077). Each arrived as "one more key rather than a new port on four backends", and together they turned a namespace a CALLER chooses keys in into a shared one with a reserved list.

  The collision that motivates this is silent in both of its dangerous forms. A caller that stored its own position under `snapshotOrigin` overwrote the marker, after which a bootstrapped store answered an as-of read below its snapshot -- about rows it does not have -- with `undefined`, which is an ordinary answer a caller acts on and which is wrong. A caller that chose `retentionEnforcement` made a pruned store report `never-pruned`. Neither looks like a failure.

  So `writeCursor('snapshotOrigin', ...)` is now just a cursor with an odd name. **There are no reserved cursor keys, nothing refuses, and there is nothing to document or remember.**

  **If you implement `StateStoreBackend` (the breaking part):** it grows three members, addressed by a CLOSED union of three keys rather than a caller-supplied string.

  ```ts
  readSeamRecord(key: SeamRecordKey): Promise<string | undefined>;
  writeSeamRecord(key: SeamRecordKey, value: string): Promise<void>;
  clearSeamRecord(key: SeamRecordKey): Promise<void>;
  ```

  They behave exactly as the cursor port's three do -- an opaque string, absent until written, a clear that is a no-op where nothing was written -- with one obligation: they must not share storage with the cursors, and `clearSeamRecord` must CLAIM on a backend reporting `singleWriter`, because that no-op is how `openForWriting` takes a store without touching a byte. The new conformance chapter `the seam's own records` asks all of it of every backend, including that a cursor of the same name disturbs nothing in either direction.

  The port is on `StateStoreBackend` and never on `StateStore`, so a READER cannot reach it: the snapshot floor still arrives narrowed into `capabilities`, the prune record still arrives shaped as `readRetentionEnforcement`, and the claim is still `openForWriting`'s business.

  **Removed exports:** `SNAPSHOT_ORIGIN_KEY`, `RETENTION_ENFORCEMENT_KEY` and `WRITER_CLAIM_KEY` from `@etherfold/state-store` (and the two that `@etherfold/processor-entities` re-exported). They existed so a host could AVOID them, which is the obligation this removes. **New exports:** the type `SeamRecordKey` and `SEAM_RECORD_KEYS`.

  **If you use a store rather than implement one:** nothing to change, and one thing becomes safe that was not -- any cursor key you like.

  **Storage, per backend.** IndexedDB's writer object store already had schemaless out-of-line keys, so it holds all four values and is renamed `seam` to say so; its `prune` transaction gets narrower, since the cursor store is no longer in it. SQLite gains a `_seam` table with the same two columns as `_cursor`, in the ADR-0053 table namespace with `_blocks`, `_cursor` and `_writer`, because each of these facts is about ONE generation's state. The reference store and the patch store gain a second `Map`. Nothing is migrated and nothing needs to be: no database of any of these shapes exists yet.

  **Why not a guard on `writeCursor` instead**, which is the obvious fix: `openSnapshotAware` composes ABOVE the claim on the real boot path, so the snapshot layer writes its own marker THROUGH a claimed handle and is indistinguishable at runtime from a caller. Refusing reserved names there refuses the seam its own namespace and takes bootstrap down with it.

- 16bdd1a: **The snapshot-only mode is now a named, asserted configuration**: a generation whose state comes from a published state snapshot and which keeps NO stream at all (`keepStream` absent). It is what the reference deployment ran and what most browser apps should reach for, and until now it worked by accident: nothing named it and nothing tested it, so an author choosing it was guessing.

  No runtime code changed in this package, and no behaviour changed anywhere. `keepStream` was already optional, the engine already answered `'skipped'` when there was nothing to save, and `bootstrapFromSnapshot` already shipped. What landed is `test/snapshotOnlyMode.test.ts`, which NAMES the mode (`snapshotOnlyClient`) and asserts it end to end against the neighbouring mode -- the same published snapshot and the same events WITH an IndexedDB keeper under them -- across a first run, a reorg inside the finality window and a reload.

  The load-bearing claim is proved by READING KEYS rather than by asserting a call did not happen: after each run there is no segment and no cursor record at the address a keeper would have used, and the whole `['stream', ...]` keyspace is byte-for-byte what it was before the run, which is what catches a write under a name the case never chose.

  What the mode COSTS is deliberately not documented here: a snapshot-seeded generation is a leaf (ADR-0028's retention floor, and no stream beneath it to re-fold), so a later processor-only change waits for a republished snapshot instead of being free.

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

- 9bfc424: **BREAKING: the kept-stream keeper seam now speaks `StoredLogEvent`, so a keeper that would persist a decoded event no longer compiles.** `StreamFetcher` and `StreamSaver` — and therefore `ExistingStream` and `StreamReader` — are declared over the raw log the node reported plus the reorg verdict the indexer derived, with `args` / `eventName` / `decodeError` structurally refused. The strip already happened at runtime; this is the seam saying so, which is what stops the rule drifting across implementations.

  **What a third-party keeper implementor has to change.** Annotations, and nothing else: `saveNewEvents(source, {eventStream, lastSync})` receives `StoredLogEvent[]` and `StoredLastSync` instead of `LogEvent<ABI>[]` and `LastSync<ABI>`, and `fetchFrom` must hand back those same two shapes. Where a keeper reads its own storage back and cannot prove the shape to the compiler — a row from SQL, a record from IndexedDB — asserting the STORED type at that boundary is the sanctioned move and is what the shipped keepers do. What is NOT: widening the seam, or re-typing a keeper to `BaseLogEvent` or `EmittedLog`, both of which a decoded event satisfies, so either would compile while enforcing nothing.

  **The cursor gets a stored variant, and `LastSync` is untouched.** `StoredLastSync` (with `StoredEventBlock`) is `LastSync` with the unconfirmed window's events narrowed the same way, and it is used by these two function types and nowhere else — the processor seam, the load path, the state keepers and the wire all still speak `LastSync<ABI>`. Core strips the window on the way into `saveNewEvents` exactly as it strips the batch, so a seam that still declared `LastSync<ABI>` there would have been promising an implementor a decoded half that is `undefined` at runtime. No keeper stores a window at all (ADR-0035, as amended), so the return side costs an implementation nothing.

  **The stored type governs WRITES; READS tolerate a decoded half; nothing is migrated.** Segments written before this keep their `args` and `eventName` forever, are served rather than treated as damage, and are never rewritten — the re-decode drops and re-derives that half regardless (ADR-0034). Adopting the stricter type therefore costs an existing deployment no rebuild, which is pinned by a test that writes a segment the previous version's way and replays it end to end.

  Also narrowed with them: `StreamSegment` is now `{events: StoredLogEvent[]}` and carries no ABI type parameter, since a segment holds nothing an ABI was needed for. `EmittedLog` keeps its own meaning and its own callers on the emission-append path, unchanged.

- 7b64e35: **`stream.alwaysFetchTimestamps` and the whole enrichment path under it are DELETED.** Unlike the transaction half of the same decision this is a SWAP rather than a removal: the time axis survives, unconditionally and for free. `blockTimestamp` is on the log itself, standardised in `ethereum/execution-apis#639`, so `event.blockTimestamp` is populated exactly as before at zero extra requests. What goes is the machinery that compensated for its absence at a cost the operator did not choose: `enrichEvents`, `blockFetcherFor`, the reorg-window-bounded block-timestamp cache, and the `eth_getBlockByHash` calls under them, issued one hash at a time in a `for` loop unless the provider advertised `eth_batch`. Neither deployment shape of ADR-0003 can be configured into a per-block request any more: not the single-process `IndexerGeneration`, not the split `LogFetcher`. `ProvidedStreamConfig` is now `{finality, parse}`.

  **THE MINIMUM NODE REQUIREMENT.** The engine reads `blockTimestamp` off the log and has no fallback to fetch it with, so a node that does not serve the field is now REFUSED at the fetch boundary rather than silently compensated for. That requires geth >= 1.16.0, reth, besu, erigon, anvil, ethereumjs, or **`@nomicfoundation/edr >= 0.20.0`** (`NomicFoundation/edr#1644`, released 2026-09-02). The requirement is on the resolved EDR version and never on the Hardhat version: no released Hardhat bundles it yet (3.16.0 ships edr 0.19.0), and EDR is an ordinary npm dependency, so a Hardhat project satisfies this TODAY with a package-manager override (`pnpm.overrides`, npm `overrides`, yarn `resolutions`) pinning `@nomicfoundation/edr` to `>=0.20.0`, rather than waiting for a Hardhat release. An override does force a combination Hardhat did not test, so verify it rather than assuming it just works; the published 0.19-to-0.20 delta is narrow.

  **The refusal is PERMANENT machinery and it fires in two places.** It is not a transitional guard: a timestampless log stays reachable at any version, because a node being FORKED may predate the spec change (EDR types the field `Option<u64>` precisely so a missing timestamp stays distinguishable from a real one) and EDR's on-disk RPC response cache replays such an absence once it has recorded one, until `rpc_cache` is dropped. (Not because pre-change cache entries keep answering: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and ignores the rest.) At the FETCH BOUNDARY the refusal names the NODE and the four things that cause it, one round trip in; at the FOLD, `blockPointer` names the BLOCK, because a stream can reach a fold without passing a fetcher at all (a seed install, a fixture replay). `blockPointer`'s message no longer recommends `stream: {alwaysFetchTimestamps: true}`, which would now be advice to set a flag that does not exist. Neither guess: a zero or interpolated timestamp does not fail, it answers confidently about the wrong block for as long as the store lives, and `getAsOf({timestamp})` has no way to tell a caller it was lied to.

  **What is deliberately NOT deleted.** `blockTimestamp?: number` stays OPTIONAL on the processor-facing event type, because the wire genuinely does not guarantee it and the type says what the wire does. `parseLogBlockTimestamp` and its hex/decimal quantity tolerance stay too: READING the field off the log is the surviving path, and an absent or unreadable value still yields `undefined` rather than a number.

  `@etherfold/fetcher-host` no longer reads `STREAM_ALWAYS_FETCH_TIMESTAMPS`, and `platforms/nodejs-fetcher` no longer documents it: the variable set the flag that no longer exists, so it now names nothing and is ignored like any other unrecognised variable. `STREAM_FINALITY` is the whole of the stream configuration the environment owns.

  **On the stream identity.** The stream config is hashed into the stream digest, so dropping a field from it is an addressing change and not merely an API change. It costs nothing here: `resolveStreamConfig` omits keys whose value is `undefined`, so a deployment that never set the flag contributed no key to the digest preimage and its digest does not move (pinned as recorded bytes in `aDeletedStreamFlagDoesNotMoveTheDigest.test.ts`). A deployment that DID set it re-indexes from block 0, which is the correct outcome. Backward compatibility with what has already been released is not an obligation of this project at its current stage, so there is no deprecation window and no migration path; this entry is a factual record of what changed.

  With this and the transaction half, the engine's entire chain-facing surface is `eth_getLogs` for data, `eth_blockNumber` for the tip and `eth_chainId` for the identity guard, and no configuration can make it call anything else. ADR-0073 records the reasoning; ADR-0002's block-timestamp consequence is updated to match.

- Updated dependencies [ebfa4f0]
- Updated dependencies [0ba3c60]
- Updated dependencies [9fa7f35]
- Updated dependencies [3e36261]
- Updated dependencies [514c821]
- Updated dependencies [2b4f3fc]
- Updated dependencies [f77f8ea]
- Updated dependencies [61a5462]
- Updated dependencies [a1fccd0]
- Updated dependencies [5427806]
- Updated dependencies [391dbf8]
- Updated dependencies [c6b5215]
- Updated dependencies [0f33468]
- Updated dependencies [a64a843]
- Updated dependencies [d92021c]
- Updated dependencies [23c1eae]
- Updated dependencies [bc63e6b]
- Updated dependencies [5729da5]
- Updated dependencies [ebfa4f0]
- Updated dependencies [2e10f5e]
- Updated dependencies [ce43a7b]
- Updated dependencies [1524a04]
- Updated dependencies [011aa87]
- Updated dependencies [ff167f0]
- Updated dependencies [a4d106e]
- Updated dependencies [339d212]
- Updated dependencies [4f5588b]
- Updated dependencies [91cb92c]
- Updated dependencies [9c15bb8]
- Updated dependencies [351c585]
- Updated dependencies [6874274]
- Updated dependencies [a448b1b]
- Updated dependencies [839e781]
- Updated dependencies [6b5395e]
- Updated dependencies [f0515f8]
- Updated dependencies [e72cbec]
- Updated dependencies [4e5067e]
- Updated dependencies [dc08d24]
- Updated dependencies [29895dc]
- Updated dependencies [e7d06c9]
- Updated dependencies [aa17a93]
- Updated dependencies [da289e2]
- Updated dependencies [053a963]
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
- Updated dependencies [74f74f5]
- Updated dependencies [9a41ba3]
- Updated dependencies [74b2889]
- Updated dependencies [114879f]
- Updated dependencies [f5fb4d2]
- Updated dependencies [114879f]
- Updated dependencies [0bf9dc7]
- Updated dependencies [b0e9a0d]
- Updated dependencies [bb86a77]
- Updated dependencies [c670273]
- Updated dependencies [1fa09f5]
- Updated dependencies [8d1c6c5]
- Updated dependencies [8baecea]
- Updated dependencies [114879f]
- Updated dependencies [5adafa9]
- Updated dependencies [a6963b4]
- Updated dependencies [27b6e65]
- Updated dependencies [cb28315]
- Updated dependencies [ad8d8b1]
- Updated dependencies [50748cf]
- Updated dependencies [290e827]
- Updated dependencies [c0d694f]
- Updated dependencies [d10b64e]
- Updated dependencies [01ed0ef]
- Updated dependencies [629dff0]
- Updated dependencies [88f3ea8]
- Updated dependencies [9e2c66d]
- Updated dependencies [ed8e7ff]
- Updated dependencies [b824312]
- Updated dependencies [35fc4c2]
- Updated dependencies [4f206c3]
- Updated dependencies [449f6fb]
- Updated dependencies [31579cc]
- Updated dependencies [7af8558]
- Updated dependencies [85f1982]
- Updated dependencies [eee7e00]
- Updated dependencies [a28d27e]
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
- Updated dependencies [fe2e1bb]
- Updated dependencies [0a53b98]
  - @etherfold/core@1.0.0
  - @etherfold/state-store@1.0.0
  - @etherfold/state-store-indexeddb@0.2.0

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
