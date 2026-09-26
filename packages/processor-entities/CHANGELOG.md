# @etherfold/processor-entities

## 0.2.0

### Minor Changes

- 8a8fe33: **A deployment can now RUN from a BUNDLE, and the generation it registers is identified by that bundle's hash** (ADR-0086).

  `--processor` still names a PATH and that does not change. What changes is what the path may point AT: where it names a SELF-CONTAINED bundle, the CLI reads it, hashes it (`sha256:<hex>` over the octets), instantiates it from those bytes and registers a generation whose `processor` identity IS that hash. An author who edits a handler and forgets to bump anything gets a different generation, because there is nothing left to forget. Two machines building the same source get the same one, because the identity is the bytes and not the path they sit at.

  Nothing bundles anything: reading a file and hashing it is not bundling, and the CLI acquires no bundler.

  **Both shapes work, which is the point of this step.** A path naming an UNBUNDLED module -- one that still expects somebody else to resolve an import -- resolves through the module system exactly as it always did and keeps the author-declared identity from `getVersionHash()`. The declared `version`, `getVersionHash()` and the code fingerprint are all untouched; four migrate batches and a contract task follow and each depends on that.

  **A bundle is a module that expects nobody else to resolve anything**, which is `unresolvedImportsOf`'s existing judgement and not a second one. The consequence worth knowing: a hand-written entry point that imports NOTHING is a bundle by that definition and is identified by its bytes rather than by its `version`.

  New in `@etherfold/utils`: `openProcessorArrival(path, options)`, which lands one operator-supplied path on whichever of the two arrivals it describes and answers with `{processor, processorModule, identity?}` -- `identity` present exactly when the path named a bundle. An injected `importModule` governs the module arm alone; the bundle arm imports a `data:` URL of the bytes it just read, where the module cache is keyed on those bytes and is therefore exactly right.

  New in `@etherfold/processor-entities`: `EntityEventProcessorOptions.identity`, the identity a host HANDS a fold when the arrival derived one. Absent is the ordinary case and means the declared hash, unchanged. It is not the caller-declared version hash ADR-0043 rejected: it is derived from something the class cannot see and REPLACES the computation rather than sitting beside it, so there are still never two live answers.

  Nothing parses a processor identity anywhere in the tree, which is what lets two derivations coexist through the migration and after it.

- 3e36261: `entityProcessorVersionHash(processor, config)` exposes a fold's identity as a FUNCTION of what a host already holds — the declared version, the entity declarations and the processor config — so it can be computed BEFORE the processor exists.

  A **generation**'s state is a table-name NAMESPACE named from `{stream digest, processor version hash}` (ADR-0053), and a generation is built STATE FIRST (ADR-0043), so the state factory has to name that namespace before the processor it will fold into has been constructed. ADR-0053 records that this is possible; this is where it is possible from.

  `EntityEventProcessor.getVersionHash()` now returns exactly this call, so the two cannot diverge. That is the point, and it is not the thing ADR-0043 rejected: what was rejected was a caller DECLARING the hash beside its factory, because a declaration can silently disagree with `getVersionHash()` and would then key a store on a lie. Calling the owner's own function is the opposite of that.

- 9ad39f4: A reorg PUBLISHES a retraction naming the fork point it withdrew, and the coherence token rotates with it.

  A reorg does not add data, it WITHDRAWS it, so a signal that can only say "there is more" leaves a reader rendering the branch the chain abandoned. `StateMoved` is now a DISCRIMINATED union of the two cases, and a retraction names a FORK POINT rather than a set of blocks — the vocabulary `revertTo(keepUpTo)`, the emission stream's `removed` markers and the canonical view's rewind already share:

  ```ts
  indexer.onStateMoved((moved) => {
  	if (moved.coherence !== held) {
  		held = moved.coherence;
  		return queryClient.invalidateQueries();
  	}
  	if (moved.kind === 'applied')
  		for (const entity of moved.entities) queryClient.invalidateQueries({queryKey: [entity]});
  });
  ```

  **The token is the load-bearing half.** "A missed notification is repaired by the next one" is true of an APPEND and FALSE of a retraction: after a reorg the stale entities are the ones the ABANDONED branch touched, and those are generally not in the changed-set of whatever block arrives next, so a reader that missed the retraction and invalidated narrowly would keep dead-branch rows on screen indefinitely. A retraction therefore ROTATES the token as part of publishing it (`StateMovedPublisher.publishRetraction`, one call, so a retraction that forgot to rotate is unexpressible), and the reader above converges at the very next notification without ever having seen it. That property is asserted by DROPPING the retraction over a real reorg, not by inspecting a message shape.
  - **`@etherfold/core`** exports `StateApplied`, `StateRetracted` and `StateMoved` (their union). A retraction carries `{kind: 'retracted', forkPoint, coherence, generation}` — no block and no entity set, because a rotated token already means invalidate everything and a narrower answer would have to come back out of `revertTo`, which answers `void` on every backend. Only the CANONICAL fold publishes, and the same filter covers the rotation: a follower replaying a stored stream's reorg rotates nothing.
  - **The processor seam's channel is RENAMED**, because it no longer carries only applied blocks: `EventProcessor.setAppliedBlockReporter` is now `setFoldReporter`, and `AppliedBlockReporter` is now `FoldReporter`, carrying `FoldReport = AppliedBlock | Retraction`. `AppliedBlock` gains `kind: 'applied'`. `process` is still NOT widened, and no other signature changed.
  - **`@etherfold/processor-entities`** derives the fork point where it already did — the line that reads the `removed` markers and calls `revertTo` — and reports it AFTER the revert returned and BEFORE the replacement blocks are applied, which is the order they happened in.
  - **`@etherfold/processor-sqlite`** forwards the renamed channel, retractions included, pinned by its own test.

  `StateStore`, `WritableStateStore` and `revertTo` are untouched: no backend and no conformance case changed. ADR-0083 records the reasoning; a PROMOTION rotating the same token is still its own change.

- da289e2: A published snapshot a client cannot read is REFUSED, never installed as state — closing the last corner `tagged-bigint-codec-across-storage-adapters` left open knowingly (ADR-0040).

  The blob snapshot's format number now lives in `@etherfold/core` as `BLOB_SNAPSHOT_FORMAT`, beside the codec it versions, so the WRITER (`@etherfold/cli`'s keeper) and every READER import one number. It used to be the CLI's own `SNAPSHOT_FORMAT`, which the browser could not see (`@etherfold/browser` must not depend on the CLI and still bundles for a tab), so the CLI refused a format-1 file locally while `keepStateOnIndexedDB` installed the same bytes — whose every `uint256`, with no fallback reviver left, arrived as the string `"123n"` instead of a BigInt. `isReadableBlobSnapshot` and the `BlobSnapshotEnvelope` type are exported alongside it; the CLI no longer exports a format constant of its own.

  `keepStateOnIndexedDB` now checks the number on every remote fetch: an unreadable snapshot is refused whole (never translated, never half-read) and the refusal is logged with the location and both numbers. An unreadable mirror is treated exactly as an unreachable one already was — skipped when it loses selection, failed over from when it wins — and local state that is already ahead still wins over any remote, readable or not. A prefix-form mirror's bare `lastSync` file carries no format and is read as SELECTION data only: nothing from it is installed, and the state file it selects for carries the check.

  The ENTITY snapshot envelope's constant is renamed `ENTITY_SNAPSHOT_FORMAT` (`@etherfold/state-store`; re-exported by `@etherfold/processor-entities`) so the two envelopes — which version different file shapes and revise independently — are distinguishable by NAME at a call site that can hold both. They are not merged.

  Nothing is published under `@etherfold/*` yet, so no format-1 snapshot exists in the wild: this is a guard added before the first release rather than a breaking correction to one already shipped.

- f3dc9a5: `on<EventName>` handler args are now a UNION when one event name covers two wire events, instead of the two input lists MERGED.

  An upgraded contract can emit `Transfer(address,address,uint256)` before the upgrade block and `Transfer(address,address,uint256,bytes)` after it. They share a name, so `ExtractAbiEventNames` collapses them and the author writes one `onTransfer` -- which is fine. What was not fine is what `args` said about it: `InputValues` mapped over the extracted event with `T` taken WHOLE, so the mapped type did not distribute and the two input lists merged into `{from, to, id, memo}` with `memo` REQUIRED. A pre-upgrade log then handed the author `undefined` through a type promising a value, with no cast and no warning anywhere.

  `InputValues` now distributes. (It landed in both authoring packages, which each held their own copy; the free-form one has since been deleted with its package, ADR-0037.) `event.args.memo` no longer compiles un-narrowed; `if ('memo' in event.args)` narrows to the version that has it, shared fields included.

  A single-version ABI -- every processor written today -- is unaffected: distributing over a non-union is the mapped type itself, and that is pinned as a type-identity assertion rather than assumed. Handler keys stay NAME-based; a signature-keyed alias (`on['Transfer(address,address,uint256,bytes)']`) is a later addition and would remove nothing.

  Both directions run under `pnpm typecheck` (`@ts-expect-error` as the assertion), since vitest strips types without checking them.

- 114879f: **Two rules that had two homes now have one** (ADR-0071).

  **`Indexer` asks the registry, not its own array.** Whether a new generation FOLLOWS its stream was decided from the order of the container's in-memory `held` array — whatever order the caller passed its specs in, and not durable across a restart. It now asks the durable registry whether any OTHER generation is already registered on that stream.

  Deliberately NOT `writerOf`, which looks like the unification and creates TWO WRITERS: `follows` is frozen per generation at add time (`readOnlyStream` is baked into the engine's config) while `writerOf` is a function of the whole record set at a moment, and `createdAt` is milliseconds with a processor-HASH tie-break — so two generations added in one millisecond can each see `writerOf` name themselves. Measured at 20/20 runs. No behaviour change on any path where the two agree, which is every path with a distinguishable `createdAt`.

  **`NotBootstrappedReason` gains `unreadable-format`.** `bootstrapFromSnapshot` reported `'unreachable'` both for a fetch that failed and for a document that WAS fetched and is not an envelope this build reads. The remedies are opposite: a host that did not answer may answer next time, so retrying is right; a document this build cannot read means the app or the publisher is out of date and retrying never helps. This is the reason an app renders to a user. The stream-seed path — the deliberate analogue, with the same failover and refusal-as-data vocabulary — has split the two since it was written; this union drifted.

  If you `switch` exhaustively on `NotBootstrappedReason`, add the new member. `pickReason` reports it above `unreachable` and below the two content checks: most specific first.

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

- d5f1039: The fold PUBLISHES what it just changed: a reader can be told the state moved.

  A client could read the state and had no way to know when to read it again. `Indexer` now publishes one **`StateMoved`** per block the CANONICAL fold applies — `{block, coherence, entities, generation}` — and a reader's whole rule is two lines: token unchanged, invalidate narrowly using `entities`; token changed, invalidate everything. ADR-0083 decides the shape; this is the producer's chain-facing half of it.

  ```ts
  const detach = indexer.onStateMoved(({block, entities, coherence}) => {
  	if (coherence !== held) {
  		held = coherence;
  		return queryClient.invalidateQueries();
  	}
  	for (const entity of entities) queryClient.invalidateQueries({queryKey: [entity]});
  });
  ```

  It is a SIGNAL and not a delivery of data: no rows, no mutations, no state handle, because a reader handed the delta applies it by hand and is wrong at the next reorg. It says what moved so a reader re-reads through the surface it already has.
  - **`@etherfold/core`** exports `StateMoved`, `StateMovedHandler`, `StateMovedDetach`, `StateMovedPublisher` and `coherenceToken`, and `Indexer.onStateMoved(handler)` returns the detach. The publisher holds NOTHING per subscriber (no buffer, no retry, no cursor), which is what stops a SharedWorker's memory growing with the number of open tabs; a handler that throws is caught and logged, exactly as `onStateUpdated` already contains one.
  - **The entity set comes from below and core RELAYS it.** `EventProcessor` gains ONE optional member, `setAppliedBlockReporter(reporter)`, carrying `AppliedBlock` (`{block, entities}`) upward. `process` is NOT widened and no existing signature changed: a processor that implements nothing here is unaffected and publishes no signal, which is the honest answer since core has no mutation vocabulary at all and could not name what such a fold applied.
  - **`@etherfold/processor-entities`** produces the set where the mutations already are: `applyEventStream` takes an optional reporter and reports each block AFTER `applyBlock` returned, with the entity NAMES its mutations carried, deduplicated and sorted. Names and never ids in this version, so the payload is O(schema) rather than O(mutations). `EntityEventProcessor.setAppliedBlockReporter` is the slot the container sets.
  - **`@etherfold/processor-sqlite`** forwards it to the fold it wraps, including a reporter attached before that fold is built.

  Three rules worth knowing before relying on it: only the CANONICAL fold publishes (a follower re-folding a stored stream would otherwise fire one notification per past block while nothing a reader can see has moved); a block whose handlers changed nothing is still published, with an empty set, because "one notification per APPLIED BLOCK" is one rule; and the coherence token is OPAQUE — compare it, never parse it. Nothing rotates it yet, so it is stable for the life of a container; a retraction and a promotion will, each in its own change.

  Delivery is best-effort, at most once: a missed notification is repaired by the next one plus the token.

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

- eee7e00: **The storage seam NARROWS: `StateStore` is the reads, and a mutation nobody claimed for is no longer expressible** (ADR-0077 contracted, ADR-0079).

  ADR-0075 put a writer token on every mutating path and ADR-0077 split the seam additively so consumers could migrate one at a time. This is the contract step, and it is one atomic change because narrowing a SHARED TYPE is atomic by construction: the moment `EntityEventProcessor`'s constructor takes the writable shape, every package that constructs it with a seam-typed value stops typechecking.

  **Three names, one hierarchy.** `StateStore` is what a CONSUMER holds and is the reads only (`migrate`, the four reads, `readCursor`, `readRetentionEnforcement`, `capabilities`, `declarations`) -- calling `applyBlock` on one is now a compile error. `StateStoreBackend` is that plus the five mutating verbs: what a backend class declares, what a factory hands over. `WritableStateStore` is a backend plus the `token` a claim minted, and `openForWriting` is the only way to obtain one. The two scaffolding names from the expand phase, `ReadableStateStore` and `StateStoreMutations`, are DELETED.

  **If you hold a store:** decide whether you READ or WRITE, and say so. A reader needs no change and gets a compile error if it tries to mutate. A writer claims: `const store = await openForWriting(await createBrowserStateStore(processor.entities))`. `openForWriting` migrates, so it replaces the `migrate()` you were calling, and it is idempotent per store instance, so the shipped `createState: () => store` pattern takes ONE claim and every generation writes through it. It takes a BACKEND and never a store already narrowed to its reads, so the narrowing is one-way; a demoted writer builds a new store and opens that (ADR-0078).

  **If you implement a backend:** declare `implements StateStoreBackend` instead of `implements StateStore`. The classes themselves are UNCHANGED and keep their full surface, including the SQL tier's `queryCurrent` / `queryAsOf` / `applyBlocks` / `drop`; `createD1Store` still returns the concrete class.

  **If you wire a browser app:** `createBrowserStateStore` still hands back a store and deliberately does NOT claim -- a tab that only renders opens the same database, and claiming there would have every reading tab take the store from the tab that is indexing. `createState` now returns a `WritableStateStore`, so wrap the factory in `openForWriting`. `openForWriting` / `openForReading` are re-exported from `@etherfold/processor-entities` beside the bootstrap primitives, because they are on the same boot path.

  **If you run the conformance suite:** your factory and options are unchanged, and every chapter is asked ONCE again -- the two-shape parameterisation that existed while consumers migrated is gone.

  Two consequences worth knowing before they surprise someone (both ADR-0079). Claiming MIGRATES, and a receiving container builds a generation's state before the generation cap can refuse it (the cap is keyed on the processor's version hash, which needs the processor, which needs the state), so a cap-refused generation now leaves an empty namespace behind; what a refusal still guarantees is no registry record and no state. And `VersionedStateEventProcessor` claims on FIRST USE rather than in its constructor, because claiming is asynchronous and that constructor is not -- still an explicit claim, and safe here because the store is one it built and nothing else holds.

### Patch Changes

- 382421f: **A published snapshot's `processor` label is the identity its producer's ARRIVAL derived, and the candidate rule that protects a client is exactly as strict as it was** (ADR-0086).

  The rule is unchanged and deliberately so: a snapshot whose label differs from the identity the client was handed IS NOT A CANDIDATE at all (`processor-mismatch`), and one installed anyway is REFUSED rather than translated (`SnapshotProcessorMismatchError`). What moved is only where the VALUE comes from. A deployment running a self-contained bundle is named by the SHA-256 of those octets, so that is what it writes into the snapshots it publishes, and a client running the same bundle derives the same name from the same bytes without being told it.

  That matters most for the client least able to notice it is wrong. A snapshot-seeded generation is a LEAF: it has no stream to re-fold and no history below its own block, and on a public node the historical `eth_getLogs` a backfill would need is frequently refused outright. Such a client cannot recover from a mislabelled snapshot by re-indexing, so a browser app's upgrade path rests on the label being right: a new build already obliges its publisher to ship a matching snapshot, and under hash identity that snapshot is one the new build recognises.

  **The snapshot FORMAT number does NOT move, and the reasoning is recorded beside the constant.** This is a VALUE change, not a FORMAT change. `processor` is the same field in the same place meaning the same thing, opaque on both sides (compared for equality, never parsed), so a label derived the old way is not half-understood by a new reader. It is simply another fold, which the candidate rule already answers precisely. Bumping `ENTITY_SNAPSHOT_FORMAT` would convert that precise refusal into `unreadable-format`, telling a user their app is out of date when the truth is that the snapshot is for another processor, and nothing is published, so there is no such document on either side of the distinction.

  Code changes are documentation and coverage:
  - `createSnapshot`'s `processor` field now says WHERE a producer gets the value: from the fold that wrote the rows (the identity its generation is registered under), never derived a second way beside it;
  - `ENTITY_SNAPSHOT_FORMAT` carries the format-number decision above;
  - `etherfold` gains the end-to-end case the round trip was missing (`test/aSnapshotIsLabelledWithItsBundleIdentity.test.ts`): a deployment folds blocks through a REAL committed bundle and publishes what it computed, a client that loaded the same bytes through the artifact loader installs it and resumes at the snapshot's block, and a client running the edited bundle beside it (one handler line different, nothing declared different) gets `processor-mismatch` and an untouched store. Neither side is handed the other's value, so it asserts that two derivations agree rather than that two constants are spelled the same.

- a448b1b: **A fetched range holding a log with no readable `blockTimestamp` is now REFUSED at the fetch boundary, naming the NODE.** Both deployment shapes refuse it: the single-process `IndexerGeneration` on the node's answer, and the split `LogFetcher` before it pushes anything to a receiver that could not have caught it. The new error is `TimestamplessLogError`, exported from `@etherfold/core` and carrying `retryable: false`, so a fetcher host stops and tells somebody instead of asking a node forever for a field it does not serve.

  `blockTimestamp` on the log is `ethereum/execution-apis#639`, served by geth >= 1.16.0, reth, besu, erigon, anvil and `@nomicfoundation/edr >= 0.20.0`. A node that serves it is entirely unaffected by this: no new call, no new failure, nothing about the cycle changes. What changes is that a node which does NOT serve it is refused one round trip in, rather than silently compensated for at a request per event-bearing block, or refused a whole range later at the fold.

  **The message is long on purpose.** Every cause is node-level and each has a DIFFERENT fix, so "missing blockTimestamp" alone would send an operator to the wrong one. It names the standard, the minimum implementations that serve it, and the four situations an operator can be in: the node predates the change; it is a Hardhat version bundling an older EDR (3.16.0 still ships edr 0.19.0, and the fix is a package-manager override to `@nomicfoundation/edr@>=0.20.0`, not waiting for a Hardhat release); it is forking a node that predates the change; or it is replaying an EDR RPC response cache entry that recorded the absence from such a node, which needs its `rpc_cache` dropped.

  The refusal is PERMANENT machinery rather than a transitional guard (ADR-0073), because the last two of those causes survive any version bump: a forked node's history predates the change whatever version forks it, and EDR's on-disk RPC cache replays such an absence once recorded, until `rpc_cache` is dropped. (Not because pre-change entries keep answering: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and ignores the rest.)

  **While `stream.alwaysFetchTimestamps` is set the refusal does not fire**, because the fallback resolves the timestamp and there is nothing to refuse. That flag, and this condition with it, are deleted by a later change; the refusal itself stays.

  `blockPointer`'s fold-time refusal in `@etherfold/processor-entities` is UNCHANGED and is not replaced by this one. The two guards sit on different entry points: a stream can reach a fold without passing a fetcher at all -- a seed install writes through the keeper seam, a fixture reader replays a captured stream -- so a fetch-boundary check would never see either. Neither of them guesses a value: a zero or interpolated timestamp does not fail, it answers confidently about the wrong block for as long as the store lives.

  The tolerant reading of the field is untouched (`parseLogBlockTimestamp`: a 0x-prefixed hex quantity or a bare decimal one, and anything else dropped rather than coerced). "Unreadable" and "absent" therefore reach the refusal as one outcome, which is the intent: neither may become a number.

  `@etherfold/processor-entities` and `@etherfold/browser` carry TEST-ONLY changes here and no API or behaviour change of their own: the first gains the case pinning that the two guards are not redundant, the second has a fake node that now serves the field, as every supported node does.

- 29895dc: Fixed silent, permanent event loss when a `feed`/`replay` batch loop is interrupted: every intermediate cursor is now true on its own.

  `promiseToFeed` hands the processor one batch at a time, and the processor PERSISTS the cursor it is given (`applyEventStream` writes it verbatim for the batch's last block). Those cursors were built by copying the FINAL cursor and walking `lastToBlock` forward, so every intermediate batch carried the final unconfirmed WINDOW: a cursor claiming to have synced through block X while listing blocks above X as already folded.

  That is unresumable. The engine treats the top of the window as the boundary above which events are new, so a run resuming from such a cursor skips every block between `lastToBlock` and the top of the window: they are neither below the resume point nor above the window, and nothing ever delivers them again. The loss is bounded by the finality window, permanent, and completely silent.

  The same defect handed a RETRACTION-ONLY batch the extent of the whole scan. A batch that reverts blocks 101 to 103 and applies nothing was told `lastToBlock: 103` while the fold was back at 100, with the replacement blocks still queued behind it. A crash between the revert and the re-apply left state reverted and a cursor claiming completeness, so the resumed run applied nothing and the replacement branch was lost outright.

  Both are reachable on the ordinary path, not only on a crash: every reconfigure verb calls `disableProcessing()` first, and a cancellation lands in exactly this loop.

  Now each batch is handed a cursor narrowed to what IT has folded, and only the LAST batch gets the stream's own cursor, at which point the whole stream is folded and the claim is true. A retraction-only batch reports the fork point, which is a genuine move backwards and the correct one: the state really is back there until the replacements land. A retraction-only batch that is the last one still takes the stream's cursor, so a scan that legitimately found nothing continues to advance.

  The narrowing rule now exists ONCE, as `cursorSyncedThrough`, newly exported from `@etherfold/core`. `@etherfold/processor-entities` re-exports it as `syncedThrough`, the name its callers already use: the engine narrows per batch and the processor narrows per block, and two copies of a rule this subtle is how the two halves drift apart.

- 70f98d6: **Comments and docstrings that cited a `work/` artifact by a path it no longer has now cite one that resolves, and a gate keeps it that way.**

  No behaviour changes here at all: every source edit is inside a comment. What changed is that the citations were dead. A spec moving `work/specs/proposed/` to `work/specs/tasked/`, or a task moving to `work/tasks/done/`, is the workflow working as designed, and it silently breaks every reference to the old path. Thirty-four such references had accumulated across ADRs, guides, spike READMEs, findings, ideas, specs and seven packages' source, and nothing in the acceptance gate had ever read a path written in prose, so all of them were green.

  `pnpm check:refs` (`scripts/check-work-refs.mjs`) now resolves every `work/{specs,tasks,notes}/<folder>/<slug>.md` written in a navigable surface, and distinguishes the two failures that need different fixes: an artifact that MOVED (it names where it went) and one that is GONE (it tells you to cite what replaced it). Historical and terminal surfaces are exempt by design, because a dead path is CORRECT in a frozen record: `.changeset/`, `CHANGELOG.md`, `work/tasks/done/`, `work/tasks/cancelled/`, `work/specs/dropped/`, and `work/notes/observations/` (an observation whose subject is a broken reference has to be able to quote it).

  Eleven of the dead references were a second, sharper shape worth naming: they pointed at OBSERVATIONS that had been correctly deleted. The work contract discharges a spent observation by deleting it, with git history as the archive, so a durable comment that cites one by path is a dangling pointer by construction, created by the protocol working rather than by anyone forgetting. Those now cite the observation's SLUG, which is stable, greppable in history, and makes no claim that a file is there to open.

  Two were not observations and got real answers instead: `InvalidationVerdict`'s docstring pointed at an idea note retired in `8549133f` and now points at `stream-grafting-what-we-established`, which superseded it; and an idea note pointed at a task rewritten into `abi-versions-are-block-ranged` by `6f2c905b`.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

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

- 8baecea: **The `blockTimestamp` holdout has shipped, so four places stop naming it as open.** Documentation and one error message only: nothing is deleted, no flag is removed, no behaviour changes.

  `blockTimestamp` on the log (`ethereum/execution-apis#639`) was served by geth, reth, besu, erigon, anvil and ethereumjs, and the README, ADR-0002, `blockPointer`'s refusal and the `blockTimestamp?` docstring all named Hardhat's EDR as the one implementation that did not. It does now: `NomicFoundation/edr#1644` merged 2026-08-26 and released in `@nomicfoundation/edr@0.20.0` on 2026-09-02.

  Hardhat has not bumped to it (3.16.0 still bundles edr 0.19.0), but that is not a wait: EDR is an ordinary dependency, so a project can pull it forward with a package-manager override (`pnpm.overrides`, npm `overrides`, yarn `resolutions`). The requirement is therefore on the EDR version resolved, never on the Hardhat version, and the docs now say so.

  `stream.alwaysFetchTimestamps` STAYS, because two cases survive any version bump and neither improves with time: a node being FORKED that predates the spec change keeps the field absent rather than defaulting it (EDR's `Option<u64>` is deliberate, so a missing timestamp stays distinguishable from a real one), and EDR's on-disk RPC response cache replays such an absence once it has recorded one, until `rpc_cache` is dropped. (Not, as an earlier draft of this entry said, because pre-change cache entries keep answering: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and ignores the rest. Same conclusion, corrected mechanism.)

  `blockPointer`'s refusal now names the likely CAUSE rather than only the missing field, so an operator can act on it: an old node, a Hardhat bundling an older EDR (with the override as the fix), a forked node predating the change, or a stale EDR RPC cache.

  Whether the fallback is eventually DELETED is not decided here. That is argued in `work/specs/proposed/etherfold-is-a-fold-over-logs.md`.

- ad8d8b1: **A tightened provider cap no longer collapses the next request to a single block, and two refusal messages stop naming a mechanism that does not exist.**

  `RangeLogFetcher` learns two numbers about a provider: a CEILING it has been refused at, and the largest span it has been SERVED. Those two could go incoherent. A provider that tightens mid-run, or that states a cap smaller than a span it has already answered, left the ceiling BELOW the safe span, and the error-path bisection then read `Math.floor((ceiling - safeSpan) / 2)` -- a negative step, so the `Math.max(1, ...)` guard fired and the fetcher asked for ONE BLOCK, paying a round trip per block until it climbed back. `lowerBlockCeilingTo`, the only writer of the ceiling, now drops a safe span the new ceiling contradicts: the ceiling is the fresher evidence, and a width cannot be both known-safe and at or above a width that is refused. This is the rule the configured-range path already applied to a seeded `learnedRange`, now stated once at the only place the pair can go wrong.

  The same bisection was also missing its BASE. The error path asked for `floor((ceiling - safeSpan) / 2)` where the success path asks for `safeSpan + floor((ceiling - safeSpan) / 2)`, so a fetcher that knew a safe span asked for less than one that knew nothing (the no-safe-span branch asks for `ceiling - 1`). Knowing more made it slower. It now bisects up from the safe span at both sites.

  Neither is a correctness bug -- both cost round trips and recover on the following call -- but the first is the shape that makes a backfill against a tightening endpoint look wedged.

  **The `blockTimestamp` refusals no longer tell an operator to look for the wrong thing.** `TimestamplessLogError` (`@etherfold/core`) and `blockPointer`'s fold-time refusal (`@etherfold/processor-entities`) both listed, among the causes of an absent `blockTimestamp`, "an EDR RPC response cache written before the change". That reads backwards: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and IGNORES everything else in `rpc_cache`, so pre-change entries are not served at all. The real hazard is a CURRENT-format entry that recorded an absence from a FORKED remote predating the spec change, and it persists until `rpc_cache` is dropped. Both messages now say that, as do ADR-0073 and ADR-0002. The conclusion is unchanged -- the refusal is still permanent machinery, because the forked-node cause stands on its own -- but an operator following the old wording would have gone looking for a stale cache that EDR had already stopped reading.

  Also removed: `packages/core/src/internal/utils/extra.ts`, imported by nothing and holding the only `eth_call` in the package. It was built and typechecked but unreachable, and it was the one place a reader grepping the core for provider calls found a method the engine does not declare.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- 2c049bf: **`VersionedStateEventProcessor` takes its fold's identity from the ARRIVAL that produced it, through a new `identity` option** (ADR-0086).

  A processor's identity has always been author-declared: `getVersionHash()` is the `version` field plus the entity and config declarations, and the core discards persisted state when it changes. An author who edited a handler and forgot to bump `version` got state computed by the previous logic, served for ever and silently. ADR-0086's invariant removes the possibility rather than reporting it: an author cannot STATE their processor's identity, so a fold is HANDED one, derived from what the processor IS -- the SHA-256 of a self-contained bundle's octets where a deployment read one off disk -- and never asks where it came from.

  `EntityEventProcessorOptions.identity` already carried that value into the neutral fold. This adds the same option, spelled and meaning the same, to the SQLite convenience class:
  - `VersionedStateProcessorOptions.identity` is what `getVersionHash()` answers with when a host supplied one, so a deployment folding a bundle names its generation by those bytes and a later `configure()` cannot move it (the config a bundle was built with is in the bundle);
  - it is FORWARDED to the `EntityEventProcessor` this class builds on first use, so the wrapper and the fold underneath give ONE answer to "which fold is this" rather than two.

  That type is therefore no longer purely a pass-through to the store it builds: the store never sees an identity.

  **Nothing is removed and no caller has to move yet.** The option is OPTIONAL, and absent means the identity falls back to the author's `entityProcessorVersionHash` exactly as it always did -- so `version`, `getVersionHash()`, `getCodeFingerprint()` and the `PROCESSOR DRIFT` report all still exist and still work. This is one MIGRATE batch of an expand -> migrate -> contract sequence (`work/protocol/TASKING-PROTOCOL.md` 3a); the later contract step is what deletes the declared path, once every package has moved.

  Also documentation, in `@etherfold/processor-entities`, where a docstring told a caller to reach for the declared hash: `BootstrapOptions.processor` and `createSnapshot`'s `processor` now describe WHICH FOLD computed the rows (a value compared for equality and never parsed) rather than "the version hash", and `bootstrapFromSnapshot`'s example passes the identity the deployment's arrival handed its fold instead of calling `getVersionHash()`. The candidate rule itself is untouched. `EntityProcessor.version` now says plainly that it is superseded and is not for new code.

- 7b64e35: **`stream.alwaysFetchTimestamps` and the whole enrichment path under it are DELETED.** Unlike the transaction half of the same decision this is a SWAP rather than a removal: the time axis survives, unconditionally and for free. `blockTimestamp` is on the log itself, standardised in `ethereum/execution-apis#639`, so `event.blockTimestamp` is populated exactly as before at zero extra requests. What goes is the machinery that compensated for its absence at a cost the operator did not choose: `enrichEvents`, `blockFetcherFor`, the reorg-window-bounded block-timestamp cache, and the `eth_getBlockByHash` calls under them, issued one hash at a time in a `for` loop unless the provider advertised `eth_batch`. Neither deployment shape of ADR-0003 can be configured into a per-block request any more: not the single-process `IndexerGeneration`, not the split `LogFetcher`. `ProvidedStreamConfig` is now `{finality, parse}`.

  **THE MINIMUM NODE REQUIREMENT.** The engine reads `blockTimestamp` off the log and has no fallback to fetch it with, so a node that does not serve the field is now REFUSED at the fetch boundary rather than silently compensated for. That requires geth >= 1.16.0, reth, besu, erigon, anvil, ethereumjs, or **`@nomicfoundation/edr >= 0.20.0`** (`NomicFoundation/edr#1644`, released 2026-09-02). The requirement is on the resolved EDR version and never on the Hardhat version: no released Hardhat bundles it yet (3.16.0 ships edr 0.19.0), and EDR is an ordinary npm dependency, so a Hardhat project satisfies this TODAY with a package-manager override (`pnpm.overrides`, npm `overrides`, yarn `resolutions`) pinning `@nomicfoundation/edr` to `>=0.20.0`, rather than waiting for a Hardhat release. An override does force a combination Hardhat did not test, so verify it rather than assuming it just works; the published 0.19-to-0.20 delta is narrow.

  **The refusal is PERMANENT machinery and it fires in two places.** It is not a transitional guard: a timestampless log stays reachable at any version, because a node being FORKED may predate the spec change (EDR types the field `Option<u64>` precisely so a missing timestamp stays distinguishable from a real one) and EDR's on-disk RPC response cache replays such an absence once it has recorded one, until `rpc_cache` is dropped. (Not because pre-change cache entries keep answering: `@nomicfoundation/edr@0.20.0` moved the cache to `rpc_cache/v2` and ignores the rest.) At the FETCH BOUNDARY the refusal names the NODE and the four things that cause it, one round trip in; at the FOLD, `blockPointer` names the BLOCK, because a stream can reach a fold without passing a fetcher at all (a seed install, a fixture replay). `blockPointer`'s message no longer recommends `stream: {alwaysFetchTimestamps: true}`, which would now be advice to set a flag that does not exist. Neither guess: a zero or interpolated timestamp does not fail, it answers confidently about the wrong block for as long as the store lives, and `getAsOf({timestamp})` has no way to tell a caller it was lied to.

  **What is deliberately NOT deleted.** `blockTimestamp?: number` stays OPTIONAL on the processor-facing event type, because the wire genuinely does not guarantee it and the type says what the wire does. `parseLogBlockTimestamp` and its hex/decimal quantity tolerance stay too: READING the field off the log is the surviving path, and an absent or unreadable value still yields `undefined` rather than a number.

  `@etherfold/fetcher-host` no longer reads `STREAM_ALWAYS_FETCH_TIMESTAMPS`, and `platforms/nodejs-fetcher` no longer documents it: the variable set the flag that no longer exists, so it now names nothing and is ignored like any other unrecognised variable. `STREAM_FINALITY` is the whole of the stream configuration the environment owns.

  **On the stream identity.** The stream config is hashed into the stream digest, so dropping a field from it is an addressing change and not merely an API change. It costs nothing here: `resolveStreamConfig` omits keys whose value is `undefined`, so a deployment that never set the flag contributed no key to the digest preimage and its digest does not move (pinned as recorded bytes in `aDeletedStreamFlagDoesNotMoveTheDigest.test.ts`). A deployment that DID set it re-indexes from block 0, which is the correct outcome. Backward compatibility with what has already been released is not an obligation of this project at its current stage, so there is no deprecation window and no migration path; this entry is a factual record of what changed.

  With this and the transaction half, the engine's entire chain-facing surface is `eth_getLogs` for data, `eth_blockNumber` for the tip and `eth_chainId` for the identity guard, and no configuration can make it call anything else. ADR-0073 records the reasoning; ADR-0002's block-timestamp consequence is updated to match.

- Updated dependencies [1ad2d4a]
- Updated dependencies [ebfa4f0]
- Updated dependencies [0ba3c60]
- Updated dependencies [9fa7f35]
- Updated dependencies [3e36261]
- Updated dependencies [514c821]
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
- Updated dependencies [ff167f0]
- Updated dependencies [fc95435]
- Updated dependencies [d8ce920]
- Updated dependencies [a4d106e]
- Updated dependencies [ee8e78d]
- Updated dependencies [1af43de]
- Updated dependencies [9ad39f4]
- Updated dependencies [af6a85a]
- Updated dependencies [72297c8]
- Updated dependencies [339d212]
- Updated dependencies [382421f]
- Updated dependencies [4f5588b]
- Updated dependencies [9c15bb8]
- Updated dependencies [351c585]
- Updated dependencies [b647fb8]
- Updated dependencies [02f46ca]
- Updated dependencies [6874274]
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
- Updated dependencies [053a963]
- Updated dependencies [e652cde]
- Updated dependencies [49e73ae]
- Updated dependencies [70f98d6]
- Updated dependencies [3e9e9d0]
- Updated dependencies [9f693f3]
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
- Updated dependencies [7b5a746]
- Updated dependencies [0bf9dc7]
- Updated dependencies [11481a0]
- Updated dependencies [b0e9a0d]
- Updated dependencies [bb86a77]
- Updated dependencies [c670273]
- Updated dependencies [0403310]
- Updated dependencies [1ed2b80]
- Updated dependencies [8d1c6c5]
- Updated dependencies [8baecea]
- Updated dependencies [114879f]
- Updated dependencies [5adafa9]
- Updated dependencies [a6963b4]
- Updated dependencies [49151c3]
- Updated dependencies [cf1d4d5]
- Updated dependencies [27b6e65]
- Updated dependencies [46e1c7c]
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
- Updated dependencies [6d3df30]
- Updated dependencies [0a53b98]
  - @etherfold/core@0.8.0
  - @etherfold/state-store@0.2.0

## 0.1.0

### Minor Changes

- 5854d60: **`EntityEventProcessor`: run an entity processor against ANY `StateStore`.**

  The runtime the storage seam was built for and the one thing that was missing from it. `new EntityEventProcessor(store, processor)` is an `EventProcessor` the core drives, with the store INJECTED, so the same processor definition (entity declarations plus `on<EventName>` handlers over a `MutationContext`) indexes to SQLite on a server, to IndexedDB in a browser tab, to the light patch store or to memory in a test, with nothing about the processor changed. `fromEntityProcessor(processor, options)(store)` is the factory form, mirroring `fromJSProcessor`.

  `process()` hands back an **`EntityStateView`**: the seam's four reads (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`) plus the capability report. `queryCurrent` / `queryAsOf` are deliberately NOT on it, and not stubbed to throw either, so asking a backend-neutral handle for caller-supplied SQL is a compile error in the editor rather than a runtime throw in a browser tab. `VersionedStateView` (`@etherfold/processor-sqlite`) is the tier that has them.

  **The sync cursor moved behind the storage seam** (ADR-0027) and is written in the same transaction as the block it describes. `serializeLastSync` / `deserializeLastSync` now live here, alongside `SYNC_CURSOR_KEY`, `parseStoredCursor` and `syncedThrough`; `@etherfold/processor-sqlite` re-exports all four from its `sync.ts`, and its `_sync` table is gone, so the SQL that reached it goes with it: **`SYNC_TABLE`, `SYNC_ROW_ID`, `SYNC_SCHEMA_DDL`, `readLastSync`, `writeLastSyncStatement` and `deleteLastSyncStatement` are removed** from `@etherfold/processor-sqlite`'s surface. The storage is `@etherfold/state-store-sqlite`'s neutral `_cursor (key, value)` table, reached through `StateStore.readCursor` / `writeCursor` / `clearCursor`. This closes a live defect: the cursor used to be a second round trip after the blocks, and a crash in that window left state ahead of the cursor, which is not self-healing — the restart replayed a block the store already held and `applyBlock` refused it, so the indexer wedged until a human intervened.

  **`applyEventStream` takes an optional `cursor`** (`{key, lastSync}`) and applies each block together with the cursor that describes THAT block, because one `process` call carries many blocks and each is its own transaction. A stream with no blocks still records the range it scanned.

  **`VersionedStateEventProcessor` is unchanged in behaviour and is now a thin SQLite flavour** of `EntityEventProcessor`: it builds a `VersionedStateStore` from a `RemoteSQL`, keeps the SQL read tier, and delegates the rest. Revert-then-apply, the block grouping, the version hash, the code fingerprint and the retention reconciliation exist once rather than twice.

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

- 879c4fe: Lift the processor authoring API out of the SQLite packages, so one processor runs against several storage backends.

  Two new packages. **`@etherfold/state-store`** is the seam: entity declarations, `MutationContext` (now including `update` as sugar over get-then-spread-then-set), the `StateStore` interface a backend implements (`migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `revertTo`), the capabilities it declares, and `MemoryStateStore`, a reference implementation in versioned rows over a Map. It declares no dependencies at all, which is what lets a storage primitive depend on it. **`@etherfold/processor-entities`** is the ABI-typed authoring surface (`EntityProcessor`, the `on<EventName>` handler map) plus the revert-then-apply engine (`applyEventStream`), written once against `StateStore` rather than per backend. ADR-0018 records why this is two packages and not one.

  A backend now **reports what it can do as data**, readable before `migrate` and before any read: a retention kind (`revert-only`, a window of N BLOCK NUMBERS, or `unbounded`) and whether it answers as-of reads. `@etherfold/state-store-sqlite` reports `unbounded` because that is what is true of it: the package has no pruning, and it deliberately takes no retention option, since a store that accepted a window it cannot enforce would be making exactly the claim the report exists to prevent.

  **`@etherfold/state-store-sqlite`** implements `StateStore` nominally, which it already did structurally: only `capabilities` was added. Its entity, mutation and block-pointer vocabulary is now defined at the seam and re-exported from here, so there is one definition rather than two; `ColumnType` is a deprecated alias of `FieldType`. Its block addressing (`getBlock`, hash and timestamp axes, `NoSuchBlockError`) and its SQL query surface (`queryCurrent` / `queryAsOf`) are unchanged and stay backend-specific on purpose.

  **`@etherfold/processor-sqlite`** consumes the authoring types rather than defining them. `SQLProcessor` is kept as a deprecated alias of `EntityProcessor`, so existing processors compile unchanged; the type never had anything SQL in it.

  The claim is asserted, not stated: `processor-entities/test/two-backends.test.ts` runs one processor, unmodified, against a real libSQL database and against the in-memory store, with the same declarations and the same handlers, and pins that the resulting state is identical, that read-your-writes composes two events in one block, and that a reorg makes a counter go back down on both.

- 18c6876: The read surface is now GENERATED from the entity declarations, so `{name, id, fields}` is the single description of the data for storage and for reads.

  ```ts
  const entities = declareEntities([{name: 'token', id: 'id', fields: {owner: 'text', transferCount: 'integer'}}]);

  const store = new MemoryStateStore(entities); // the same array drives the storage...
  const surface = createReadSurface(store, entities); // ...and types the reads

  const token = await surface.token.getCurrent({id: '1'}); // {id: string; owner: string | null; ...} | undefined
  await surface.placement.listCurrent({epoch: 7}, 8); // the children of a key, bounded
  ```

  No table name, no column string, no hand-written row type. **Rename `owner` in the declaration and the consumer stops COMPILING**, instead of reading `undefined` in production, which is the whole reason the surface is generated rather than written beside the declaration.
  - **Two tiers, one schema source.** `createReadSurface` (`@etherfold/state-store`) is the seam's four reads (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`) and runs unchanged on every backend. `createQuerySurface` (`@etherfold/state-store-sqlite`) is those four PLUS `queryCurrent` / `queryAsOf`, which take caller-supplied SQL. The asymmetry is placement, not caution: the bounded tier is what a handler is held to, and a handler runs once per event on every backend including the ones with no query planner (ADR-0021), while a server-side reader runs per request with a planner underneath it.
  - **The as-of parameter is whatever the STORE takes**, read off its own signature. Over a plain `StateStore` that is a block number; over `@etherfold/state-store-sqlite` it is a height, a `{hash}` or a `{timestamp}`. So a hash reaches the backend that can resolve one, and does not compile against a backend that cannot, with no new capability flag to declare.
  - **Errors stay errors.** `NoSuchBlockError` (ADR-0015) and `BlockNotRetainedError` (ADR-0019) travel through the surface untouched; neither becomes `undefined`, which keeps its one meaning of "the block is known and the entity was absent from it".
  - **Rows are PROJECTED to the declared columns**: id columns, then every declared field, with an unlisted one as `null` (a version is a whole row) and the version columns dropped, since they are storage rather than state and a projected row cannot be spread back into a write.
  - **Nothing is decoded beyond the declared storage class**, so a `uint256` stored as decimal `text` comes back as the string it is and the consumer calls `BigInt()`. Decoding it would need the declaration to SAY a text column is a u256, which it cannot; ADR-0025 records the answer and leaves the field type itself to `tagged-bigint-codec-across-storage-adapters`.
  - **`declareEntities` keeps a declaration's literal types** and changes nothing at run time. An annotated declaration (`const TOKEN: EntityDeclaration = ...`) widens `'owner'` to `string`, after which nothing can be derived from it.
  - **Nothing here ships GraphQL, and nothing here blocks it.** The decided stack (Hono, then Yoga, then Pothos, built programmatically, no SDL and no deploy-time codegen) walks the same declarations for its object types and resolves them through this surface, so it is an addition rather than a refactor. The example keeps its hand-written routes.

### Patch Changes

- ce8f7d2: A handler can now ask about a SET of rows: the bounded id-prefix listing.

  ```ts
  // entity: {name: 'placement', id: ['epoch', 'position', 'playerIndex'], fields: {player: 'text'}}
  const {rows, truncated} = await state.list('placement', {epoch: 7}, 8);
  ```

  That is the one read the entity model was missing, and it is what makes a one-to-many expressible the way a subgraph's `@derivedFrom` does it: children are their own entity keyed by their parent, and the collection is DERIVED WHEN READ. Nothing is maintained at write time. `MutationContext` gains `list`; `StateStore` gains `listCurrent` and `listAsOf`, which every backend must implement.

  **The bound is the decision, not an implementation detail.** A listing takes a PREFIX of the declared id (a leading run of its id columns, at least one) plus a REQUIRED limit, and takes no `where`, no `orderBy` and no offset. A handler runs once per event on every backend, including the ones with no query planner, so the seam gets the one shape that is an indexed range scan everywhere: a key-prefix range with a bound. An accidental full scan is therefore impossible to EXPRESS rather than merely discouraged. `@etherfold/state-store-sqlite`'s `queryCurrent` / `queryAsOf`, which do take caller-supplied SQL, are the server-side read layer and are unchanged. See `docs/adr/0021`.
  - **Truncation is reported, never inferred.** A listing answers `{rows, truncated}`, and every backend reads one row more than the limit to fill it in, because `rows.length === limit` cannot tell an exact answer from a cut-off one and a cascade delete that guesses wrong leaves orphans silently.
  - **Order is the id's own, ascending**, which is what a range scan gives for free, and therefore LEXICOGRAPHIC over the stringified id: `'10'` sorts before `'9'`. Key ordered children by something naturally unique and ordered (an event ordinal, or `(blockNumber, logIndex)`) and make a numeric key fixed-width. If arrival order is wanted, that is a modelling answer, not a parameter.
  - **Read-your-writes holds for a listing too**: a child written earlier in the block appears and one deleted earlier in the block does not, which means merging the block's staging area into the scan rather than falling through to the store. The fetch budget accounts for staged deletes, so a limit is still filled from beyond them.
  - **In SQLite it is one indexed range scan**: equality on the leading id columns plus `ORDER BY` the declared id rides the entity's id index with no sort and no table scan. Pinned by the generated statement's shape AND by `EXPLAIN QUERY PLAN`, since no behavioural assertion can tell a range scan from a table scan that returns the same rows.
  - **The conformance suite gained a group for it**, so a new backend is held to the same answers, and `@etherfold/processor-entities` gained a test that models the real ordered bounded collection from `work/notes/findings/sqlite-in-the-browser.md` (a window of seven, evicting the oldest and everything nested under it) with no stored array, no CSV index and no count, on both backends.

- e0a6480: The log ingestion endpoint, and the receiving half of the wire contract (ADR-0004).

  `@etherfold/core` gains **`StreamBuilder`**: the stream-builder of ADR-0003, as an object. It takes contiguous ranges of raw logs from a stateless log-fetcher, derives every retraction itself, drives an `EventProcessor`, and is authoritative about where the next range must start. It makes no chain calls at all, which is why it is not `EthereumIndexer`: that class opens `load()` with `eth_chainId`, so the half of a split deployment that hosts the processor could never use it. It reads the persisted cursor on every call rather than caching one, because the intended host is serverless and an in-memory cursor is one isolate's private opinion of a value the database owns.

  `@etherfold/server` gains **`GET` and `POST /ingest`**, behind an `INGEST_TOKEN` bearer token. The stream-builder is injected exactly like the database (`getIngestion` alongside `getDB` / `getEnv`), so which processor runs against which source stays a deployment's choice; a server with none answers `501` rather than pretending to have a cursor.

  The cursor is the idempotency key, so there is no dedupe table and no idempotency header. A batch whose `fromBlock` is not the server's `expectedFromBlock` is refused with **`409` carrying that value**, and the sender re-sends from there; a batch re-sent after a lost acknowledgement takes exactly that path, so at-least-once on the wire is exactly-once in effect. `409` is the only resumable refusal: a foreign `{source, config}`, a malformed range, or a payload that is not the range it claims are `400`, because no block number makes them right and a sender must not retry them forever.

  `generateStreamToAppend` now throws a typed `UnexpectedFromBlockError` carrying `expectedFromBlock`, instead of an `Error` whose message had to be parsed. Same rule, same message, one place: the HTTP layer reads the number off the error rather than re-deriving it, so the wire and the engine cannot drift apart.

  A revert concluded from **absence** is surfaced and counted apart from one concluded from a hash **contradiction**. Absence is an inference and is indistinguishable from a sender that under-delivered a range, so `/status` now reports `reorgs: {absence, contradiction, last}` from the database (not from process memory, since a rate is the point and isolates are recycled), and an absence-driven revert is logged at `error` level naming the range. It does not make the server unhealthy: it is a signal to investigate, not a fault.

  Wire batches are serialized with `serializeWireBatch` / `parseWireBatch`, which tag BigInts as `{__bigint__: "..."}`. A decoded log's `args` hold a BigInt for every `uint256` an ABI declares and `JSON.stringify` throws on those, while the older `"123n"` suffix convention would revive a contract-emitted string ending in `n` as a number. The tagged codec now lives once, in `@etherfold/core` (`taggedBnReplacer` / `taggedBnReviver`), and `@etherfold/processor-entities`' sync-cursor codec uses it instead of its own copy.

- c359dcb: The light state store, behind the same seam: `@etherfold/state-store-patch`.

  **A new package.** Current state as a plain object, history as immer reverse patches, reorg revert by replaying them backwards. It is the cheapest legitimate implementation of the storage seam, so a browser tab that only needs current state and reorg safety pays nothing for versioned rows while running the SAME processor as the server:

  ```ts
  const store = new PatchStateStore(processor.entities, {retention: 'revert-only', finalityDepth: 64});
  await applyEventStream(store, processor, eventStream, config); // the same processor as on SQLite
  ```

  `packages/processor-entities/test/patch-backend.test.ts` asserts that equality against `@etherfold/state-store-sqlite` on the same input, and the store passes `@etherfold/state-store-conformance` under its own claim.

  **It advertises `revert-only`, and that is a MEASURED result rather than a limitation.** Backwards replay is correct wherever the patches exist (matched the recorded state at every depth to 64 on Chromium, Firefox, WebKit and node, at a cost linear in depth). What withdraws the capability is SPARSITY: history is pruned by BLOCK-NUMBER distance from the tip, while a real stream carries only event-bearing blocks, which on the launched stratagems game on Base are median **429 blocks apart**. At a finality of 64 exactly one block's reversals survive, the tip's, and no tuning returns it. So `revertTo` works and is the reason this backend exists, while every as-of read throws `BlockNotRetainedError` at every depth — never the tip value, which is the single failure mode this design exists to prevent because it is plausible. Asking this store for a window is refused where it is configured rather than downgraded quietly.

  **A revert it cannot perform is an error, not a partial revert.** Once a block's reverse patches have been pruned, `revertTo` throws `RevertBeyondPatchHistoryError` (naming the blocks it cannot undo, the deepest revert still available and the declared depth) and leaves the state untouched, because a half-undone reorg is the write-path twin of a historical read served from the tip. `store.retainedReversals()` reports the depth still available — on a sparse stream, one block.

  **Memory-only, and the capability report says so** (`durability: 'memory-only'`): a reload is an empty store. Persisting is deliberately left to the seams that own it — the whole-state `KeepState` path above, and the row-level IndexedDB backend beside. See ADR-0023.

  `prune()` drops the reverse patches at or below `tip - finalityDepth` and is a call the host schedules (ADR-0022), never a side effect of a write, which is the deliberate difference from `@etherfold/js-processor`'s `History`.

- ab45129: Retention becomes a number a deployment SETS, a store REPORTS, and a read is REFUSED against.

  **The unit is block numbers, and there is only one unit.** A deployment writes `retention: 'unbounded' | 'revert-only' | {blocks: N}` on a store (or on `VersionedStateEventProcessor` / `fromSQLProcessor`, which pass it through). `{blocks: N}` is the only window spelling: a bare number names no unit, a duration is refused on every spelling, and a count of updates is refused too. Those are not style rules. Time would prune on WALL-CLOCK progress rather than chain progress, so a stalled indexer would drop history it never finished writing and a halted chain would expire its whole window while the tip stands still; "last N updates" is derivable above the seam from the blocks each backend already indexes, and adding it below would duplicate the prune path, the report and the tests for a unit that is a floor block number. See ADR-0019.

  **Sizing a window is not sizing a number of updates**, and the arithmetic is counter-intuitive enough to state at the API: on the real measured stream, event-bearing blocks are median **429 blocks apart**, so a window of 64 blocks holds exactly ONE event-bearing block. The default is `unbounded`, which is the only report true of a store that does not prune.

  **A window below the finality depth is refused where it is configured**, naming both numbers, because reorg revert reopens versions closed after the fork point and would find them pruned. `finalityDepth` is required alongside a window for the same reason, and `VersionedStateEventProcessor` checks it a second time at `load` against the finality the stream actually runs with, since a floor validated against the wrong number is silent corruption waiting for a deep reorg.

  **An as-of read the store cannot serve now throws instead of answering.** `BlockNotRetainedError` carries the block that was requested and the range that is retained, and it joins `NoSuchBlockError` under a new shared base, `BlockUnavailableError` (both exported from `@etherfold/state-store` and re-exported from `@etherfold/state-store-sqlite`). ADR-0015 settled that an unresolvable block address is an error and not an empty result; this is the other way a historical read can fail, and it must not arrive as `undefined` (which reads as "the entity was absent then") or as the tip value (a plausible wrong number nothing downstream can tell apart from a true one). A store set to `revert-only` refuses every as-of read and keeps reverting.

  **No store claims a window it does not enforce.** `@etherfold/state-store-sqlite` has no pruning, so a configured window is validated, warned about, and reported as `unbounded` -- which is what the store actually does, since every version ever written is still there. `MemoryStateStore` behaves identically. The right to report a window is earned by `prune-versions-outside-retention-window`.

  `VersionedStateView` now exposes `capabilities`, so the consumer holding the read handle can discover at startup what history is available instead of discovering it from a refusal (or a wrong number) in production. The capability cases run against both backends in `processor-entities/test/two-backends.test.ts`.

- ebf9690: One conformance suite every state-store backend must pass, including its capability claims.

  **A new package, `@etherfold/state-store-conformance`.** Adding a backend is providing a factory and running one suite:

  ```ts
  await describeStateStoreConformance('MyStore', (declarations) => new MyStore(declarations));
  ```

  It asserts EXTERNAL BEHAVIOUR only -- what a read returns after a write, after a revert, as of a block -- and never a table, a statement or a version column, so a versioned-rows backend and a patch-log backend can both be asked it. Five groups: versioned reads (a version is a COMPLETE row with a half-open validity range), as-of reads tested against what the store CLAIMS, reorg revert including a counter that must go back DOWN, read-your-writes within a block, and a block applying as one atomic unit.

  **The capability report is read first, and then tested.** A store claiming `unbounded` is asked a read at any depth; a store claiming a WINDOW is asked at both of its edges and must refuse below it with a `BlockNotRetainedError` naming what was asked and what is kept; a store that answers no historical read must refuse every one of them. Testing a backend against a capability it never claimed would fail honest backends, and testing it against less than it claimed is what lets a claim become fiction.

  **That the capability cases are real is itself a test.** The suite is run against backends carrying one lie each -- claiming a window it does not honour, answering an as-of read from the tip, accepting a revert without undoing the state -- and the tests assert which cases go red. This is why the cases are exported as DATA (`stateStoreConformanceCases`, `runStateStoreConformance`) with the vitest registration as a thin adapter on top: a suite that only registers tests can be run but cannot be asserted on. See ADR-0020.

  **The reorg case is the load-bearing one and runs on every backend**, not once: an accumulated counter that does not decrease when its block is reverted is the canonical bug this design exists to make impossible, and the real instance is recorded in `work/notes/findings/sqlite-in-the-browser.md` (a `computedPoints` of 12 going back to 6). The counter is accumulated through the mutation context, because the read is where the bug bites.

  The suite runs today against `MemoryStateStore` and against `@etherfold/state-store-sqlite`'s `VersionedStateStore` on a real libSQL database, each under three retention claims. Shared cases that existed as a second copy in `state-store-sqlite` and `state-store` have moved into it; what stays in those packages is what only that implementation can be asked.

- 0ac08c0: Follow-on from the tagged BigInt codec landing everywhere: no behaviour change in any of these three, but they each referred to the convention that is gone.

  `@etherfold/processor-sqlite`'s deployment-shapes test simulated the wire crossing with `bnReplacer` / `bnReviver`, which no longer exist; it now crosses through the REAL `serializeWireBatch` / `parseWireBatch`, so it exercises what a deployed log-fetcher and receiver actually put on the wire. `@etherfold/js-processor`'s version test carried an inline copy of the old suffix reviver to stand in for "the same convention the real keepers use", and now uses the codec those keepers actually use. `@etherfold/processor-entities`' sync-cursor note said the tagged codec was shared with the wire; it is now the repo's only BigInt convention, and says so.

- Updated dependencies [ff393f7]
- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [4e75014]
- Updated dependencies [ce8f7d2]
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
  - @etherfold/state-store@0.1.0
  - @etherfold/core@0.7.0
