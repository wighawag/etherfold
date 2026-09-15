# @etherfold/state-store-indexeddb

## 0.2.0

### Minor Changes

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

- 9c15bb8: **A store now reports whether its retention is actually ENFORCED against its storage**, so the one configuration nothing could detect -- a floor in force and nothing ever dropped -- is discoverable instead of silent.

  Retention has two halves. `assertRetained` bounds what a read may ask about the moment a floor exists, and it runs on every read whatever the host does; `prune` physically drops what falls below that floor, and ADR-0022 makes it an explicit call the HOST schedules. Every host this project ships now prunes unconditionally, so the broken state is unreachable with a shipped host -- but a host that rolled its own indexing loop still gets the refusals of a bounded store and the footprint of an unbounded one, and until now the store's own report said nothing about it, because that report is about the CLAIM.

  **The new read is `StateStore.readRetentionEnforcement()`**, a twelfth verb at the seam, answering one of three things: `{kind: 'no-floor'}` (`unbounded`, or `revert-only` with no declared finality depth -- nothing to enforce), `{kind: 'never-pruned', floor}` (a floor, and no pass has ever run), or `{kind: 'pruned', floor, prunedTo}` (a floor, and a pass ran at block `prunedTo`). `floor` is the floor as it stands NOW and `prunedTo` is the floor the last pass ran at, kept apart deliberately: the distance between them is how far behind a prune has fallen, and a store pruned once a year ago reports `pruned` with nothing but that gap to say so.

  **It is asynchronous, and that is the design rather than an inconvenience.** The value is durable -- a store pruned before the process died must not come back saying never -- so it lives in storage, and `capabilities` is a synchronous getter documented as readable before `migrate` and before the database is open. Making it a capability field would have forced either an async `capabilities` (breaking every consumer) or an in-memory flag that resets on reload, which is a report that lies about the exact case it exists to catch. **`capabilities` is UNCHANGED**, so every existing consumer keeps compiling and keeps its pre-open readability.

  **Two details worth knowing.** A pass is recorded whether or not it deleted anything, because a host pruning on a schedule deletes nothing on most cycles and treating "deleted something" as the evidence would make the healthy case the alarm. And whether a store has a floor is a fact about the SETTING, not about how far it has got, so a configured store that has applied no block yet reports `never-pruned` rather than `no-floor` -- it is exactly the store a misconfigured host is most likely to be holding.

  The record rides the cursor port under `RETENTION_ENFORCEMENT_KEY`, as the snapshot origin does: a durable, unversioned, never-reverted, never-pruned slot, so this is one more key rather than a new table on four backends. On IndexedDB it commits in the SAME transaction as the deletion it describes.

  **Every backend implements it and the conformance suite asks all of them**, cross-checking the report against the floor `prune` itself returned -- the suite cannot hold a fixed expectation, because only the store knows whether it has a floor at all. A new backend therefore inherits the obligation rather than rediscovering the hazard.

  No default and no configuration shape changed, and nothing refuses: this is a report. ADR-0076 records why it replaced the construction-time refusal the originating spec launched with, and `work/notes/findings/a-worker-cannot-hold-a-timer-across-requests.md` is the platform constraint that ruled out the alternative.

  `@etherfold/browser` is listed only because a store decorator in its tests implements the seam and therefore implements the new verb. Nothing it ships changed, and the hook still publishes no enforcement state on `syncing`.

- 053a963: **`applyBlock` now refuses a height that is not ABOVE the recorded tip, on every backend, and no longer only a height that is already recorded.**

  The old check was narrower than the invariant a single writer maintains. A caller reverts to the fork BEFORE it applies the branch that replaces it (`applyEventStream`, `@etherfold/processor-entities`), so every apply lands above what the store holds; a block offered at or below the tip is therefore a writer working from a position the store has passed -- a backgrounded tab resuming on a stale cursor, a second instance of one indexer -- and taking it would open a version underneath the live one rather than after it. That was reachable at any height nothing happened to be recorded at, which on a SPARSE block table (only blocks carrying our logs get a row) is most of them.

  This is the tightening of a refusal and not a new capability, so a correct caller sees no change. It is the height half of `a-second-writer-writes-nothing`; the writer token is the other half, and the two answer different questions (WHO is writing, and WHETHER the height is above the tip).
  - **An EMPTY store admits any height**, because there is no tip to be above: a fresh index at a contract's start block, a rebuild resuming mid-chain and a bootstrap installing a snapshot taken far above zero all still work unchanged.
  - **The tip is read inside the same atomic unit as the write**, so a revert lowering it and an apply above it cannot interleave with another writer. On IndexedDB that is one more read in the `readwrite` transaction that was already open. On SQLite it is ADR-0054's shape, because `remote-sql` has no read inside a transaction: every statement of the block carries `NOT EXISTS (SELECT 1 FROM _blocks WHERE number > ?)`, so a refused block applies to NOTHING (versions and cursor included), and the tip read that opens the same batch is the evidence the message is assembled from.
  - **The existing refusals are unchanged.** A duplicate height still raises where it always did, with the message it always had (on SQLite, still the `_blocks` primary-key violation), and so does a duplicate hash.
  - **The message names both heights** on every backend, from one place at the seam: the new `blockNotAboveTip(number, tip)` in `@etherfold/state-store`. Like the duplicate-height refusal beside it, it is a plain `Error` and says the CALLER is wrong; `StoreWriterChangedError` remains the one on this path that means the opposite.

  **If you run the conformance suite:** three cases join `a block is one atomic unit` -- a height at or below the tip is refused even where that height is free, an empty store admits any height, and a height becomes applicable again once a revert has taken the tip back under it.

  **If you use `applyBlocks` (the SQL backend's packed backfill):** the blocks handed to it must now ASCEND, refused before anything is sent, because each is judged against the tip the one before it left. The lowest block is sent in a batch of its own, carrying the tip read that decides the whole sequence, so a refusal leaves NOTHING applied and costs one extra round trip per call rather than per block.

  No runtime code changed in `@etherfold/processor-sqlite`, and nothing it does changed: one test there reads the statements of a block's batch, and the tip read now leads them.

- d26ada8: **Two instances of one indexer can no longer corrupt one state store: every mutating path now carries a WRITER TOKEN, checked inside the same atomic unit as the write it guards** (ADR-0075).

  A writer CLAIMS the store on its first mutation. A second writer's first mutation claims in turn, which invalidates the first claim, so the earlier writer's next mutation is refused whole with the new `StoreWriterChangedError` -- nothing applied, nothing applied late, the store byte-identical. Claiming is IMPLICIT, so no caller changes and no caller can forget; it does not block and does not expire, so a writer killed mid-block leaves a store the next claim simply takes over.

  Guarded: `applyBlock`, `revertTo`, `writeCursor`, `clearCursor`, `prune`, plus `applyBlocks` and `drop` on the SQL backend. `migrate` is deliberately NOT guarded and never claims, because it runs on every open and several tabs of one app all open.

  This is ADR-0054's guarded batch with a revision token, applied one level down, not a second mechanism. On IndexedDB the check and the write are in one serialisable `readwrite` transaction, so the fencing is EXACT rather than best-effort. On SQLite every statement is guarded on the token and the same batch reads it back, because `remote-sql` reports no affected-row count.

  **The claim is scoped to one unit of STORAGE**, because the token lives inside it: the `databaseName` on IndexedDB, the database plus ADR-0053's table namespace on SQL. So two unrelated indexers on one origin never contend, two generations of one indexer addressed apart both keep writing, and two generations sharing one storage by misconfiguration are now REFUSED where they used to corrupt each other silently.

  **If you implement `StateStore`:** `StateStoreCapabilities` has a new REQUIRED `singleWriter: boolean`. Report `true` only if you enforce it on every mutating path; a backend whose storage is an instance field (`MemoryStateStore`, `@etherfold/state-store-patch`) reports `false` honestly, because a token there could only ever be compared with itself.

  **If you run the conformance suite:** it takes an optional third argument. A backend claiming `singleWriter` must pass `{twoWriters: {sharingStorage, addressedApart}}` -- two handles on ONE storage, and two handles ADDRESSED APART -- because `StateStoreFactory` is a fresh database per call and cannot express either. A backend that claims the guarantee and supplies no affordance fails a case saying so.

  **If you deploy on D1:** a prune round now costs three queries rather than two (the guarded DELETE plus its read-back), and names one fewer row id per statement, because the guard is that statement's other bound parameter. `d1PruneBudget` accounts for both.

  The IndexedDB schema version moved to 3 for the new `writer` object store; the upgrade is `contains`-guarded, so an existing database gains it and keeps every row.

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

### Patch Changes

- 011aa87: **A store refusal that waiting cannot fix now says so, and the browser indexing loop stops instead of retrying it for ever.**

  The auto-index loop swallows a failure and comes back a few seconds later, which is right for a rate limit or a dropped socket and catastrophic for a refusal the store will repeat identically. A tab whose store had been moved ahead by another writer before it ever wrote got `block N is not above the recorded tip M`, treated it as transient, and re-fetched the whole range from the node on every tick: measured at ~90 `eth_getLogs` per second of wall clock, with the cursor pinned and nothing reported. The work was invisible precisely because each attempt merely failed again.

  **The three block refusals are now errors carrying `retryable: false`** (`StoreWriteRefusedError`, `@etherfold/state-store`): a height already recorded, a hash already recorded, and a height the tip has passed. `StoreWriterChangedError` carries it too. They are read STRUCTURALLY (`err.retryable === false`), which is why `@etherfold/state-store` declares the flag while importing nothing — it has no dependencies, and an error crossing a package boundary still classifies correctly. The three messages also stop being copied into four backends: `blockNotAboveTip`, `blockAlreadyRecorded` and `blockHashAlreadyRecorded` are the one place that spells them.

  `isRetryable` is now exported from `@etherfold/core` beside `RetryableError`, rather than being a private helper in `logFetcher.ts`, so every driver that retries on a timer asks the question the same way.

  **If you catch these:** the messages and the class of failure are unchanged, and the refusals are still refusals — what is new is the flag and the shared `StoreWriteRefusedError` type. A loop of your own should ask `isRetryable(err)` before re-arming.

  **A refused write stops the browser loop and is NOT a demotion.** It reports through `syncing.error` with id `WriteRefused` and leaves `syncing.demotion` alone, because the two mean opposite things: a demotion says this tab lost a race and should become a reader, while this says the write itself is wrong and the remedy is to revert first or stop. An app can tell them apart.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- 1fa09f5: **Five source-scanning gates now match CODE rather than the whole file, so documenting a rule no longer breaks the gate that enforces it.**

  Tests only; no shipped behaviour changes. These packages assert platform-neutrality by scanning `src/` for a forbidden word -- no `D1`, no `cloudflare`, no `console.`, no `D1Database`, and, in `@etherfold/state-store-patch`, that the as-of methods never reach for stored state. Run against raw file text they read PROSE as well as code, so the sentence explaining _why_ a store must never name D1 failed the gate that exists to keep it from naming D1. The perverse incentive is the point: the cheapest way back to green was to delete the explanation, so the check punished exactly the comment that would stop someone reintroducing the dependency.

  A shared `codeOnly()` helper strips comment trivia with the TypeScript scanner before matching. String literals are deliberately KEPT, because `'D1Database'` in a string is a real reference and a gate that ignored it could be defeated by quoting. The anchored `^\s*import ... from '...'` scans keep reading raw source, since an import cannot be a comment; only the whole-file word matchers changed. `state-store-patch`'s method-body slice still finds its boundaries in the raw text, so `\n\t}` keeps meaning "closing brace at class indent" -- only the matched text is stripped.

  Verified in both directions rather than assumed: a comment mentioning D1 and cloudflare now passes, while a bare `D1` token in code and a `@cloudflare/workers-types` import both still redden the gate.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- 88f3ea8: **The IndexedDB schema version restarts at 1**, because the ladder it had climbed was a ladder for databases that do not exist.

  `SCHEMA_VERSION` had reached 3, narrating three changes to this package's object stores (the cursor store, the writer token, and the seam's own records taking the writer store over). Nothing is published, so no browser anywhere holds a database an earlier build created, and every step of that ladder was an upgrade nothing could ever perform. A reader met migration notes for a population of zero.

  What is KEPT is the mechanism, which needs no history to be useful: `open(name, version)` takes a version whatever we do, `upgrade` is written to CONVERGE rather than to step (every creation is `contains`-guarded, so one function brings a database at any earlier version to the declared shape), and the rule for when to bump is now stated forwards -- when THIS PACKAGE adds or renames an object store, which a processor declaring one more entity never does.

  There is nothing to migrate and nothing that could be: a database created by a previous build of this unpublished package would be at a HIGHER version than this one opens at, which IndexedDB refuses. Delete it, or use a different `databaseName`.

- eee7e00: **The storage seam NARROWS: `StateStore` is the reads, and a mutation nobody claimed for is no longer expressible** (ADR-0077 contracted, ADR-0079).

  ADR-0075 put a writer token on every mutating path and ADR-0077 split the seam additively so consumers could migrate one at a time. This is the contract step, and it is one atomic change because narrowing a SHARED TYPE is atomic by construction: the moment `EntityEventProcessor`'s constructor takes the writable shape, every package that constructs it with a seam-typed value stops typechecking.

  **Three names, one hierarchy.** `StateStore` is what a CONSUMER holds and is the reads only (`migrate`, the four reads, `readCursor`, `readRetentionEnforcement`, `capabilities`, `declarations`) -- calling `applyBlock` on one is now a compile error. `StateStoreBackend` is that plus the five mutating verbs: what a backend class declares, what a factory hands over. `WritableStateStore` is a backend plus the `token` a claim minted, and `openForWriting` is the only way to obtain one. The two scaffolding names from the expand phase, `ReadableStateStore` and `StateStoreMutations`, are DELETED.

  **If you hold a store:** decide whether you READ or WRITE, and say so. A reader needs no change and gets a compile error if it tries to mutate. A writer claims: `const store = await openForWriting(await createBrowserStateStore(processor.entities))`. `openForWriting` migrates, so it replaces the `migrate()` you were calling, and it is idempotent per store instance, so the shipped `createState: () => store` pattern takes ONE claim and every generation writes through it. It takes a BACKEND and never a store already narrowed to its reads, so the narrowing is one-way; a demoted writer builds a new store and opens that (ADR-0078).

  **If you implement a backend:** declare `implements StateStoreBackend` instead of `implements StateStore`. The classes themselves are UNCHANGED and keep their full surface, including the SQL tier's `queryCurrent` / `queryAsOf` / `applyBlocks` / `drop`; `createD1Store` still returns the concrete class.

  **If you wire a browser app:** `createBrowserStateStore` still hands back a store and deliberately does NOT claim -- a tab that only renders opens the same database, and claiming there would have every reading tab take the store from the tab that is indexing. `createState` now returns a `WritableStateStore`, so wrap the factory in `openForWriting`. `openForWriting` / `openForReading` are re-exported from `@etherfold/processor-entities` beside the bootstrap primitives, because they are on the same boot path.

  **If you run the conformance suite:** your factory and options are unchanged, and every chapter is asked ONCE again -- the two-shape parameterisation that existed while consumers migrated is gone.

  Two consequences worth knowing before they surprise someone (both ADR-0079). Claiming MIGRATES, and a receiving container builds a generation's state before the generation cap can refuse it (the cap is keyed on the processor's version hash, which needs the processor, which needs the state), so a cap-refused generation now leaves an empty namespace behind; what a refusal still guarantees is no registry record and no state. And `VersionedStateEventProcessor` claims on FIRST USE rather than in its constructor, because claiming is asynchronous and that constructor is not -- still an explicit claim, and safe here because the store is one it built and nothing else holds.

- fe2e1bb: The browser run gains the CONTENTION case: several tabs offering the SAME heights against one database.

  `browser/multi-tab.spec.ts` proved that four tabs can OPEN one database and use it (the claim ADR-0024 needs, and the one both wasm-SQLite VFSs fail), and said itself that it was not testing contention: every tab wrote heights of its own, so no two of them ever raced for one. That gap is now closed. Four tabs claim, then offer every height in one range at once, and the case asserts three things: exactly one write lands per height, every loser is refused with `StoreWriterChangedError` **specifically** rather than by some other failure or by silence, and an independent connection afterwards finds a coherent store (no half-applied block, no row from a refused writer, no cursor behind its data).

  No production code changed: this is the observation behind ADR-0075's guard rather than an addition to it. It runs on Chromium, Firefox and WebKit and its output is kept in `docs/spikes/indexeddb-row-backend-browser-default/results/contention-<engine>.json`.

  It is deliberately NOT in the acceptance gate, on the same reasoning as the rest of the browser run: it needs three browser binaries a clean checkout does not have. It is also the case the node suite cannot stand in for, because `fake-indexeddb` cannot demonstrate `readwrite` transactions serialising across tabs at all, which is the primitive the guard rests on. Both facts are stated where the results are kept, together with the manual observation that removing the guard turns the case red.

- Updated dependencies [514c821]
- Updated dependencies [011aa87]
- Updated dependencies [ff167f0]
- Updated dependencies [9c15bb8]
- Updated dependencies [6874274]
- Updated dependencies [da289e2]
- Updated dependencies [053a963]
- Updated dependencies [8bb063e]
- Updated dependencies [d26ada8]
- Updated dependencies [ffe7c40]
- Updated dependencies [114879f]
- Updated dependencies [0bf9dc7]
- Updated dependencies [c670273]
- Updated dependencies [27b6e65]
- Updated dependencies [c0d694f]
- Updated dependencies [85f1982]
- Updated dependencies [eee7e00]
- Updated dependencies [a28d27e]
  - @etherfold/state-store@1.0.0

## 0.1.0

### Minor Changes

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

- 5854d60: **The storage seam gains a sync-cursor port, and `applyBlock` can write the cursor with the block** (ADR-0027).

  `StateStore` gains `readCursor(key)` / `writeCursor(key, value)` / `clearCursor(key)` over an **opaque string**, and `applyBlock(block, mutations, cursor?)` takes an optional `{key, value}` that is written in the SAME transaction as the block. This reverses an explicit "deliberately absent" on the interface: a cursor that could only be a SQL table stopped one-processor-several-backends at the first deployment that was not SQLite, and only the store holds the transaction the block write happens in, so only the store can stop a crash from leaving state ahead of the cursor.

  It stays a STRING and never a typed `LastSync`: that is a `@etherfold/core` type, and typing the port with it would make this package depend on core, invert ADR-0016 and drag viem into every storage primitive. `@etherfold/state-store` still declares no dependencies at all.

  Per backend:
  - **`@etherfold/state-store-sqlite`**: a new fixed `_cursor (key, value)` table, created by `migrate()` alongside `_blocks`, and the cursor statement rides in the same `batch([...])` as the block. `CURSOR_TABLE`, `readCursorStatement`, `writeCursorStatement` and `clearCursorStatement` are exported like the rest of the SQL.
  - **`@etherfold/state-store-indexeddb`**: a new `cursors` object store, written inside the block's own transaction. The package's schema version moved from 1 to 2; the upgrade is additive and `contains`-guarded, so an existing database gains the store and keeps every row. A processor declaring another entity is still not a migration.
  - **`@etherfold/state-store-patch`**: an in-memory map, written after the point where anything can still refuse. Its `durability: 'memory-only'` already says what that means for the cursor: it goes with the process, exactly as the state does.
  - **`MemoryStateStore`**: the same, as the executable definition.

  `@etherfold/state-store-conformance` gains a `the sync cursor` group: the round trip, the clear, the opacity of the value, and the one that matters — a store never reports a cursor ahead of its last applied block, asserted through a refused block and through a re-applied height. The suite's own tests gain a backend that writes the cursor before the block, so the new group is proven to catch it.

  A cursor is deliberately NOT reverted by `revertTo` and not touched by `prune`: how far the caller got is not entity state.

### Patch Changes

- Updated dependencies [ff393f7]
- Updated dependencies [4e75014]
- Updated dependencies [ce8f7d2]
- Updated dependencies [b61de79]
- Updated dependencies [2a4e6ed]
- Updated dependencies [879c4fe]
- Updated dependencies [01ab642]
- Updated dependencies [18c6876]
- Updated dependencies [ab45129]
- Updated dependencies [ebf9690]
- Updated dependencies [5854d60]
  - @etherfold/state-store@0.1.0
