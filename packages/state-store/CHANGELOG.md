# @etherfold/state-store

## 1.0.0

### Major Changes

- da289e2: A published snapshot a client cannot read is REFUSED, never installed as state — closing the last corner `tagged-bigint-codec-across-storage-adapters` left open knowingly (ADR-0040).

  The blob snapshot's format number now lives in `@etherfold/core` as `BLOB_SNAPSHOT_FORMAT`, beside the codec it versions, so the WRITER (`@etherfold/cli`'s keeper) and every READER import one number. It used to be the CLI's own `SNAPSHOT_FORMAT`, which the browser could not see (`@etherfold/browser` must not depend on the CLI and still bundles for a tab), so the CLI refused a format-1 file locally while `keepStateOnIndexedDB` installed the same bytes — whose every `uint256`, with no fallback reviver left, arrived as the string `"123n"` instead of a BigInt. `isReadableBlobSnapshot` and the `BlobSnapshotEnvelope` type are exported alongside it; the CLI no longer exports a format constant of its own.

  `keepStateOnIndexedDB` now checks the number on every remote fetch: an unreadable snapshot is refused whole (never translated, never half-read) and the refusal is logged with the location and both numbers. An unreadable mirror is treated exactly as an unreachable one already was — skipped when it loses selection, failed over from when it wins — and local state that is already ahead still wins over any remote, readable or not. A prefix-form mirror's bare `lastSync` file carries no format and is read as SELECTION data only: nothing from it is installed, and the state file it selects for carries the check.

  The ENTITY snapshot envelope's constant is renamed `ENTITY_SNAPSHOT_FORMAT` (`@etherfold/state-store`; re-exported by `@etherfold/processor-entities`) so the two envelopes — which version different file shapes and revise independently — are distinguishable by NAME at a call site that can hold both. They are not merged.

  Nothing is published under `@etherfold/*` yet, so no format-1 snapshot exists in the wild: this is a guard added before the first release rather than a breaking correction to one already shipped.

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

### Minor Changes

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

- 6874274: **A tab reads the store across the port**: the seam's four reads are proxied to the host, so an app holding only a port gets TYPED rows with no query runtime on its first-paint path (ADR-0082).

  `createPortReadSurface(port, entities)` is the port-side twin of `createReadSurface(store, entities)` -- same call shape, same result type, same four reads per entity, typed off the declarations the app already wrote. Under it, `IndexerPort.reads` is the untyped, entity-name-string handle those types are generated over, which is what `EntityStateView` is on this thread; four new cases ride the existing envelope (`getCurrent` / `getAsOf` / `listCurrent` / `listAsOf`, plus `declarations`), so nothing about the transport, the correlation or the clone guard moved.

  There are FOUR reads and there will not be a fifth: no predicate, no caller-supplied ordering, no offset (ADR-0021). Richer queries arrive on this same port as an EXECUTOR with its own serialisation, not as more methods here.

  **The rows are the same rows, and that is a test rather than a claim.** One case list runs against a surface over a store on this thread and against a surface over a port to a host holding its own store, with both stores written by the same processor from the same captured logs, in node over a `MessagePort` and in Chromium, Firefox and WebKit over a real dedicated worker. The projection to the declared columns happens in the HOST, through the same `declaredRow` the same-thread surface uses, so version columns never cross and an unlisted declared field arrives as `null` exactly as the store wrote it.

  **Reads are served WHILE the fold runs**, from the store the CANONICAL generation folds into, resolved per read. One arriving before the host has opened its store waits for it rather than being refused, and is rejected with the failure that stopped the host if one never arrives.

  **`UnknownEntityError` (`@etherfold/state-store`) is new**, thrown by `mustGet` -- so every backend raises the same named refusal for an entity its declarations do not describe, with the same message, and the name survives a `postMessage` where the class cannot. `assertDeclaredBy` is exported from the same package for the same reason: a port proxy checks its declarations against the host's with the seam's own rule instead of a second, weaker one, and refuses a disagreement naming both. If you matched that refusal on its message, the text is unchanged; if you matched `Error` by identity, it is now a subclass.

  A tab-only import is measured rather than described: `packages/browser/test/bundlesForABrowser.test.ts` bundles the three imports an app's tab half writes and asserts no query runtime, no store implementation and no engine came with them (8.2 KB minified against 152.4 KB for the whole package when this landed).

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

- ffe7c40: **Four defects that had been sitting in `work/notes/observations/` are fixed.**

  **An id VALUE containing U+0000 is refused instead of silently merging two rows.** `entityKey` joins the entity name and the id values with U+0000, and the memory and patch backends key rows on that string, so for `id: ['x', 'y']` the distinct keys `{x: 'a\0b', y: 'c'}` and `{x: 'a', y: 'b\0c'}` produced the SAME string: the second write overwrote the first and both reads answered with it. Reproduced before and after -- on `MemoryStateStore` the two writes were accepted and both reads returned `"second"`; they are now refused by name. The SQL backend kept them apart (separate columns) and IndexedDB did too (an array key), so the same processor meant different things per backend, which is the divergence the seam exists to prevent. Refused in `idValues`, beside the existing id-is-required refusal, rather than escaped: a length-prefixed join would change every key string for data that has never had this problem, to keep admitting a value no chain produces -- an id comes from decoded event args, where a string is an address, a hash or a decimal.

  **A `contractsData`-only processor module can resolve a source.** `resolveSource` fetched `eth_chainId` only inside the `contractsDataPerChain` branch, so a module exporting only `contractsData` -- the shape the docs describe as the fallback, and the one `--deployments` calls optional "where the processor module supplies its own contract data" -- always threw `no chainId found`, on the CLI and the server alike. It now asks for the id it needs, and only when it needs it: a module supplying no contract data at all still refuses without touching the chain. The test that had locked this in as "quirky, but preserved exactly" is replaced; it was not a quirk, it was a dead path.

  **An indexer-server can state a byte ceiling on an ingest batch, and refuse an oversized one with `413`.** A wire batch is bounded by block range and by event count, and neither is a bound in BYTES: the size of a decoded batch is not known until it is built, so an ABI with large `bytes` arguments defeats a count at any setting. A receiver read the whole body into memory before it could check anything about it and answered no `413`, so its limit was whatever its runtime died at. `ServerOptions.maxIngestBytes` is optional and has NO default, deliberately: only a host knows its own ceiling (a Worker has a request limit, a Node process does not), and nothing has measured what a decoded batch costs per log for a realistic ABI, so a number invented here would be a guess. When set, the declared `Content-Length` is checked before the body is buffered, with the actual size as a backstop for a chunked request. The WHOLE batch is refused and the limit is named, because ADR-0004 forbids delivering part of a range -- a short payload is read as an absence, concluded as a reorg, and reverts state -- so the sender lowers `toBlock` and re-sends from the same `fromBlock`. It is deliberately not a `409`, which means "re-send from THIS block" and would have the sender skip the range it never delivered.

  The remaining half of that last one is unchanged and still open: bounding a batch by bytes at the SENDER needs an estimate computed where the payload is built, next to the truncation guard that already lowers `toBlock`. What this adds is the receiving half, so the ceiling is stated rather than discovered.

- 114879f: **A malformed `finalityDepth` is now refused on every retention kind, not only on a window.**

  `resolveRetention` returned early for `'revert-only'`, `'unbounded'` and the default, so its non-negative-integer check on `finalityDepth` was only ever reached by `{blocks: N}`. All three versioned backends nevertheless stored whatever they were given and passed it to `retentionFloor`, whose `revert-only` floor is `tip - finalityDepth`. So a negative depth put the prune floor **above the tip** (measured: tip 1000, depth -5, floor 1005), and `prune` would then delete every closed version — including the ones reorg revert has to reopen. Accepted by `MemoryStateStore`, `VersionedStateStore` and `IndexedDBStateStore`.

  `PatchStateStore` was the only backend that refused it, because it carried a private copy of the check whose comment admitted it was a copy. That is the tell: a validation rule enforced on one backend and absent on three.

  The check is hoisted above the early returns and exported as **`assertFinalityDepth`**, which `PatchStateStore` (which resolves no retention at all) now calls instead of its own. `'revert-only'` and `'unbounded'` still do not require a depth — only a window does, and that requirement is unchanged.

  A guard test asserts the rule has exactly one implementation across the `state-store*` packages, so a fifth backend cannot quietly grow a fourth copy.

- 27b6e65: **A CLI deployment that configures a retention floor now actually reclaims what falls below it**, and the loop that does it is budget-driven, so a serverless host can drive the same one.

  Retention has two halves and only one of them ran on the server side. A window has always bounded what a READ may ask about from the moment it is configured (`assertRetained`, at the seam, on every backend); `prune` is what physically drops the versions it no longer covers, and ADR-0022 makes it an explicit call the HOST schedules -- and no host in this repository scheduled one. So `--retention 50000` bought the refusals of a bounded store and the footprint of an unbounded one, which is strictly worse than either honest position, and nothing anywhere detected it.

  **`pruneMore(states, {maxVersions})` (`@etherfold/state-store`) is that pass, written once.** It prunes every state a host holds, spends ONE budget across them (not one each), skips a state it was handed twice, and reports `{passes, versionsDeleted, complete}`. The shape is `rebuildMore`'s: bounded work per call, reporting whether it finished, with the host looping -- which is what lets a CLI cycle and a Worker's `scheduled` handler drive one loop rather than two implementations of it. The budget is a PARAMETER because the number belongs to the caller's schedule: a Worker passes `d1PruneBudget(plan)` (its per-invocation query allowance), a CLI passes its own.

  **The CLI schedules it, and the two commands loop differently because their lives differ.** `run` takes one bounded pass in the gap it already waits between fetch cycles, so a backlog drains over cycles instead of stalling the one that met it; `build` runs bounded passes until the state is at its floor once it has reached the tip, because the database it exits with is a publishable artifact and "prunes eventually" is not a property an artifact has. Neither is in the ingest or apply path: a prune costs time proportional to what it drops (1.1 s at 62,553 versions) and a block carrying a median of 7 mutations must not pay for it.

  **The trigger is a FLOOR, not a window.** `revert-only` states a floor too -- the finality depth this deployment protects against -- so it is pruned as well; that is the case a binary window-or-not implementation gets wrong, and getting it wrong leaves the setting a reorg-safe deployment is told to prefer refusing every historical read while retaining every version for ever.

  **Nothing changes for an `unbounded` deployment, which is the default and probably most of them.** A prune with no floor is a no-op, which is exactly why the host may schedule it without first asking what it is holding. `DEFAULT_PRUNE_BUDGET` (10,000 versions per pass, exported from `etherfold`) bounds one pass and is not a way to turn pruning off: `--retention` is where a deployment says what it wants kept.

  `createD1Store`'s docstring now shows that scheduled call with the shared pass (documentation only; no D1 behaviour changed).

  **Not covered:** `etherfold index`, the receiving half, still schedules no prune -- it is fed over the wire and has no cycle of its own, and a prune inside the ingest path is what ADR-0022 refuses. And nothing here `VACUUM`s: SQLite reuses the freed pages, so the file stops growing without shrinking.

- a28d27e: **The storage seam now has a READABLE shape and a WRITABLE one, and the ability to mutate is obtained by CLAIMING: `openForWriting` / `openForReading`** (ADR-0077).

  ADR-0075 made a second writer's mutation land never. It left the rule as something a caller had to remember, because any value typed `StateStore` could still mutate. This makes it a fact of the TYPE, which is what ADR-0044 already does for streams by handing a follower a read-only stream view rather than asking it to behave.

  ```ts
  const store = await openForWriting(await createBrowserStateStore(processor.entities));
  await store.applyBlock(block, mutations, cursor);

  function render(state: ReadableStateStore) { ... } // cannot write: `applyBlock` is not on the type
  render(openForReading(store));
  ```

  `openForWriting` MIGRATES (so it replaces the `migrate()` a host would otherwise call), then CLAIMS: it swaps the stored writer token, so an earlier writer's next mutation is refused from the moment this call returns rather than from whenever the new writer gets round to writing. It does not block and does not wait -- a loser is not queued, it has lost. It is IDEMPOTENT per store INSTANCE, which is load-bearing rather than a convenience: the shipped `createState: () => store` pattern hands ONE store to EVERY generation, so a second open returns the claim the first one made and building a successor cannot invalidate the canonical generation.

  What it hands back carries a `token`, and that member is what makes the writable shape unforgeable: without it the type would be structurally satisfied by any store. It is deliberately NOT the token the backend compares in its transactions, which stays private -- a token a caller can read is a token a caller can hand back, and ADR-0075 rejected exactly that.

  **Nothing breaks.** `StateStore` keeps its mutating members, so every existing consumer compiles and passes unchanged, and the concrete backend classes are untouched and still expose their full surface. Consumers migrate to the two new shapes one package at a time; a later change removes the mutating half of `StateStore` and folds `ReadableStateStore` into it.

  **If you implement `StateStore`:** nothing to do, and one contract is now asserted that was previously only implied -- `clearCursor` on a key that was never written must still CLAIM on a backend reporting `singleWriter`, because that no-op is how `openForWriting` takes the store without touching a byte. It is exercised by the new conformance chapter `a writer claims by opening`.

  **If you run the conformance suite:** every factory-driven chapter is now asked TWICE, once of the store your factory returns and once of the handle `openForWriting` gives back, so a handle that delegated a verb wrongly is caught. Your factory and options are unchanged.

  **New exports from `@etherfold/state-store`:** `openForWriting`, `openForReading`, `WRITER_CLAIM_KEY` (a reserved cursor-port key nothing ever writes), and the types `ReadableStateStore`, `WritableStateStore`, `StateStoreMutations`, `WriterToken`.

### Patch Changes

- ff167f0: **A writer whose mutation is refused now DEMOTES itself to a reader instead of raising at your app** (ADR-0078).

  Losing the store is not an application error: it is a writer learning it lost a race it could not have avoided (ADR-0075). So `@etherfold/browser` stops fetching and folding, DROPS the in-memory `LastSync` that is now a lie, narrows every store it was folding into to `openForReading`, and goes on ANSWERING READS from the store the winner is writing. The tab that lost keeps showing correct data.

  **New: `demoteToReader`**, one exported function for the two ways of losing -- a refused write (`'write-refused'`, which the hook calls for itself) and a lost lease (`'lease-lost'`, which a caller electing one indexing tab calls through `indexer.demoteToReader(...)`). It is not the inverse of `promote`: that moves the canonical pointer between generations, this drops the write duty over the storage they fold into.

  **New: `syncing.demotion`** (`{reason, reading}`), reported beside `syncing.streamSeed` and deliberately NOT inside `syncing.error`, plus a `named-logs` warning -- because a tab that silently stops indexing for ever is the quiet failure the writer guard exists to end. `status` returns to `Idle`. It clears on `dispose()`.

  **BREAKING: `indexMore()`, `indexMoreAndCatchupIfNeeded()` and `indexToLatest()` now answer `Promise<LastSync | undefined>`.** `undefined` means DEMOTED and means nothing else. Throwing was rejected because both browser loops swallow exceptions and retry on a timer, so the refusal would be retried for ever against a store that will never accept it again; returning the last cursor was rejected because that is the very value the demotion exists to drop (`checkTxInclusion` answers from it). A caller that ignores the return value needs no change.

  **`startAutoIndexing()` on a demoted tab returns `false` and starts nothing.** A demoted writer never re-claims on its own: a backend does not re-mint a claim it has committed, so indexing again means `dispose()` plus a fresh `init` over a store built FRESH, which re-reads everything.

  A demoted writer is deliberately NOT a follower. A follower is read-only on the STREAM axis and a full writer of STATE (it re-folds through `EventProcessor.process`, so it calls `applyBlock` constantly); a demoted writer must stop writing state, so "become a follower" would keep mutating, keep being refused, and loop.

  `@etherfold/state-store` is unchanged in behaviour: what is new there is the assertion that the refusal a lost writer meets stays OUTSIDE the `BlockUnavailableError` family (that family is a read this store cannot answer; this is the write path, and the mutation did not happen).

- 8bb063e: The server's FIXED tables move into the reserved `_` namespace: `Meta` becomes `_meta` and `EmissionStream` becomes `_emissions` (with its indexes `_emissions_canonical` and `_emissions_by_address_topic`). Nothing about what they CONTAIN changes: same columns, same keys, same two indexes, same semantics.

  It closes a silent collision. Entity tables are created as `CREATE TABLE IF NOT EXISTS "<entity.name>"`, and in every combined shape the store and the server share ONE database handle (`buildProcessor`), so a processor declaring an entity called `Meta` or `EmissionStream` issued that DDL against the SERVER's table: `IF NOT EXISTS` made it succeed silently, and the failure surfaced much later as a column error on a write, pointing nowhere near the declaration that caused it.

  The mechanism that closes it already existed, and the server's tables were simply outside it. `@etherfold/state-store` reserves the `_` prefix and refuses any entity inside it, and the store's own fixed tables already live there as `_blocks` and `_cursor`. Moving the server's two in makes the collision unreachable by CONSTRUCTION, with no new API, no dependency from the store to the server, and no widening of the entity legality rules. Parameterising the reserved set so a composing host declares its fixed names was considered and rejected: it grows optional API on the store for a guard that is off by default (a browser uses the store with no server at all) and relocates the discipline rather than removing it.

  The convention is now a GUARANTEE rather than a memory: a test scans `packages/server/src/schema/sql/db.sql` and fails if any table or index it creates does not begin with `_`, with a guard so an empty or unparsed scan cannot pass it. A fixed table added later without the prefix fails the gate instead of shipping a collision.

  There is NO migration and NO compatibility shim. The `schemaVersion` row lives in the table that was renamed, so a database migrated by an older build has no `_meta` and reports the schema as UNAPPLIED, which is the correct signal: those tables really did change. `SCHEMA_VERSION` therefore stays at `2` -- no database can hold a `_meta` row this build did not write.

  `EMISSION_STREAM_TABLE` still names the table for a host appending under a name it holds; its value is now `_emissions`. `@etherfold/state-store`'s reserved-identifier refusal is unchanged in behaviour, and its message and docstring now say the prefix means "not a user entity" rather than "the store's", since two packages place tables there. The CLI's reorg counters write to `_meta`.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- c670273: **Documentation only: `revert-only` is now named, where a browser app chooses retention, as the way to ask for reorg safety with no history.**

  The setting already existed and already worked; nothing said so at the point of choice. `BrowserStateStoreConfig.retention` described the window (`{blocks: N}` and the finality depth it may not go under) and mentioned `revert-only` only as a thing that happens to state a prune floor, so a developer who wanted "reorg safety, no history" had no reason not to approximate it with a small window.

  That approximation is worse than it looks, and the reason is measured rather than stylistic. Retention counts BLOCK NUMBERS and never updates (ADR-0019), and on the real measured stream event-bearing blocks are median **429 blocks apart**, max 1,226,194 (`work/notes/findings/sqlite-in-the-browser.md`), so `{blocks: 64}` typically holds exactly ONE of them, the tip's, and often none. What that buys is a store that refuses almost every historical read while looking configured for history: the failure is a refusal a session meets late, rather than a fact reported up front.

  The configuration docstring now says all three parts: `revert-only` is the way to say it, it reports `capabilities.asOf === false` so a caller that needs history learns at startup rather than from a wrong or refused answer later (which is why `asOf` is reported separately from `retention`: a window answers inside itself and refuses outside it, while a store that reconstructs no history refuses everywhere), and it still guarantees the reorg half, because its floor is the finality depth and the versions a revert reopens are exactly the ones it keeps. `finalityDepth`'s own docstring now says why it belongs beside `revert-only` and not only beside a window. The same paragraph is in `@etherfold/browser`'s README, and the `'revert-only'` and `'unbounded'` arms of `RetentionSetting` (`@etherfold/state-store`) carry per-arm docs, so the choice is described where an editor shows it.

  One test is added rather than changed, pinning the claim the docstring now makes on the DEFAULT backend: `createBrowserStateStore(entities, {retention: 'revert-only', finalityDepth: 64})` reports `{retention: {kind: 'revert-only'}, asOf: false}`. It passes on the code as it stands, which is the point: the prose is now checkable.

  No behaviour, default or type changed: `unbounded` is still the default, `revert-only` still reports `asOf: false`, and a window is still refused below the finality depth.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

## 0.1.0

### Minor Changes

- ff393f7: The last two reads that answered plausibly now refuse, or answer whole.

  Both were the same bug wearing two hats: a read that could not be served came back as `undefined`, which at this seam is not a shrug but a STATEMENT -- the block is fine and the entity was absent from it -- and it is what a caller acts on normally.

  **An `at` that is not a block number is refused** (`InvalidBlockNumberError`, `@etherfold/state-store`). `getAsOf('token', {id: '1'}, {hash: '0x64'})` on a backend with no addressing layer used to pass the retention check, compare an object against every version range, match nothing, and report the token as absent at a block nobody had named. The guard is `assertBlockNumber`, called first thing inside `assertRetained`, so it is written ONCE and every backend whose as-of reads take a block number inherits it (memory, patch, IndexedDB) across `getAsOf` and `listAsOf` alike, rather than three copies drifting.
  - **It is a `TypeError`, deliberately outside the `BlockUnavailableError` family.** Every member of that family is a fact about the STORE (the address resolved to no block; the versions are outside retention), and a caller acts on one by re-pinning or widening retention. A non-number `at` is a fact about the CALL: no store configuration makes it answerable, so it is a programmer error and it does not get swallowed by a `catch (e) { if (e instanceof BlockUnavailableError) ... }` written for the other thing. It comes BEFORE the retention check for the same reason: a `revert-only` store answering "not retained" would send its caller off to widen a window that was never the problem.
  - **`@etherfold/state-store-sqlite` keeps its richer addressing** (a height, `{hash}`, `{timestamp}`), because it resolves to a block number before the seam sees one. Its HEIGHT axis now throws the same `InvalidBlockNumberError` (via the seam's shared `isBlockNumber`) instead of a bare `Error`, with the same message it had; `NoSuchBlockError` still answers an address that resolves to no recorded block.

  **`MutationContext.get` answers with a WHOLE row for a key staged in the same block.** It returned `{...staged.values}`, which is only what the handler passed to `set`, so an id column and a declared field the write did not list were `undefined` for a row written earlier in the SAME block and present for one written in an earlier block: the shape of a row depended on when it was read. `get` now builds a staged row through `stagedRow`, the construction `list` already used for exactly this reason, so the two cannot drift apart again and a handler cannot read a field that is only sometimes there.

  Both are in the conformance suite (`@etherfold/state-store-conformance`), so a new backend inherits them: `versioned reads` gains the refusal (asked of every backend, whatever addressing sits above it), and `read-your-writes within a block` gains the row shape plus a case pinning that `get` and `list` agree about a staged row.

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

- b61de79: A declaration is now legal on every backend or refused on every backend, and the rest of the "same declaration, different meaning" class is closed.

  `entity-identifier-sql-keyword` fixed the SQL-KEYWORD half by quoting in `@etherfold/state-store-sqlite`, deliberately keeping one engine's reserved-word list out of the shared seam. This finishes the audit it opened. **It contains source-compatibility breaks** (named below); breaking an existing declaration was accepted where the rule is right.

  **Two names that differ only in CASE are now refused at declaration time, on every backend** (`@etherfold/state-store`, **breaking**). `{name: 'token'}` and `{name: 'Token'}` were accepted (`normalizeEntities` de-duplicated by exact string) and then meant two different things: SQLite folds identifier case even inside quotes, so `CREATE TABLE IF NOT EXISTS "Token"` matched the existing `token` and was silently SKIPPED, leaving ONE table with `token`'s columns and `getCurrent('Token', ...)` answering with `token`'s row, while the memory, patch and IndexedDB backends kept two entities. Quoting cannot reach this one, and no spelling of the DDL makes the engines agree, so the answer had to be the declaration's: two names a backend could confuse are one name.

  Unlike a keyword list, this belongs at the seam, and the distinction is written out where the rule lives (`src/entities.ts`): a keyword list is one engine's VOCABULARY, which quoting removes entirely; case is IDENTITY, and the backends disagree about it, so it is a PORTABILITY rule. The rule applies at all three levels -- entity names, id columns and fields -- with id columns and fields treated as one namespace, since they are the columns of one row. The message names both spellings and says to rename one. A repeated id column (`id: ['id', 'id']`, previously accepted here and `duplicate column name` at `migrate()` on SQLite) is refused too.

  **An entity named like another entity's derived index no longer breaks `migrate()`** (`@etherfold/state-store-sqlite`, **breaking for a stored database, not for a declaration**). An index and a table share ONE namespace in SQLite, so declaring `token` beside `token_open` was two ordinary entities everywhere else and `SQLITE_ERROR: there is already an index named token_open` here. The derived index names now carry the store's `_` prefix (`_token_open`, `_token_history`, `_token_lower`, `_token_upper`), which the seam already keeps declarations out of, so the collision is impossible by construction rather than refused by a new rule -- a declaration's legality must not depend on which other entities were declared beside it. An existing database re-migrates cleanly and keeps its old, now-redundant indexes under their old names; drop them by hand or rebuild.

  **An entity name in SQLite's own `sqlite_` namespace is refused when the store is CONSTRUCTED** (`@etherfold/state-store-sqlite`, **breaking**), rather than at `migrate()`. SQLite refuses `sqlite_`-prefixed object names however they are quoted, so this is genuinely one engine's limit and does not become a seam rule; what it does become is a DECLARATION-time failure, where the store was built, instead of a deploy-time one. `sqlite_`-prefixed COLUMN names stay legal, because SQLite allows them and narrowing the seam for no engine reason is the same defect pointing the other way.

  **Audited and left alone.** Identifier LENGTH: no backend imposes one (SQLite stores a 2,000-character table name and its indexes; the others hold names as JS strings), so the seam invents none. NON-ASCII and NFC/NFD collisions: already unreachable, because the shape rule `/^[A-Za-z][A-Za-z0-9_]*$/` is ASCII-only, so `café` and `cafe` + U+0301 are both refused as identifiers and can never become the case collision in another alphabet. That is also why the case fold is exact rather than approximate, and the regex now says so.

  **`@etherfold/state-store-conformance` carries every new rule**, so a future backend inherits the obligation instead of rediscovering it. The `a declaration means the same thing on every backend` group gains the case cases (entity, id column, field, and across the id/field boundary), the non-ASCII case, and `DECLARATION_PROBES`: an exported list of legally-shaped names that strain some engine (`sqlite_` entity and column names, a 200-character entity name and column names, and an entity named like a derived index), each asserting only that the store REFUSES when it is constructed or stores and reads the row back -- never accepted-then-fatal-at-`migrate()`. Adding a probe is how a newly found engine limit becomes every backend's problem at once.

  The `_` prefix rule, the shape rule and `entity-identifier-sql-keyword`'s quoting are unchanged and still tested.

- 879c4fe: Lift the processor authoring API out of the SQLite packages, so one processor runs against several storage backends.

  Two new packages. **`@etherfold/state-store`** is the seam: entity declarations, `MutationContext` (now including `update` as sugar over get-then-spread-then-set), the `StateStore` interface a backend implements (`migrate` / `applyBlock` / `getCurrent` / `getAsOf` / `revertTo`), the capabilities it declares, and `MemoryStateStore`, a reference implementation in versioned rows over a Map. It declares no dependencies at all, which is what lets a storage primitive depend on it. **`@etherfold/processor-entities`** is the ABI-typed authoring surface (`EntityProcessor`, the `on<EventName>` handler map) plus the revert-then-apply engine (`applyEventStream`), written once against `StateStore` rather than per backend. ADR-0018 records why this is two packages and not one.

  A backend now **reports what it can do as data**, readable before `migrate` and before any read: a retention kind (`revert-only`, a window of N BLOCK NUMBERS, or `unbounded`) and whether it answers as-of reads. `@etherfold/state-store-sqlite` reports `unbounded` because that is what is true of it: the package has no pruning, and it deliberately takes no retention option, since a store that accepted a window it cannot enforce would be making exactly the claim the report exists to prevent.

  **`@etherfold/state-store-sqlite`** implements `StateStore` nominally, which it already did structurally: only `capabilities` was added. Its entity, mutation and block-pointer vocabulary is now defined at the seam and re-exported from here, so there is one definition rather than two; `ColumnType` is a deprecated alias of `FieldType`. Its block addressing (`getBlock`, hash and timestamp axes, `NoSuchBlockError`) and its SQL query surface (`queryCurrent` / `queryAsOf`) are unchanged and stay backend-specific on purpose.

  **`@etherfold/processor-sqlite`** consumes the authoring types rather than defining them. `SQLProcessor` is kept as a deprecated alias of `EntityProcessor`, so existing processors compile unchanged; the type never had anything SQL in it.

  The claim is asserted, not stated: `processor-entities/test/two-backends.test.ts` runs one processor, unmodified, against a real libSQL database and against the in-memory store, with the same declarations and the same handlers, and pins that the resulting state is identical, that read-your-writes composes two events in one block, and that a reorg makes a counter go back down on both.

- 01ab642: A configured retention window is now ENFORCED against storage, so a store that declares one stops growing.

  **`StateStore.prune(options?)` is the new verb**, on the seam and implemented by both shipped stores. It deletes the versions the declared retention no longer covers and reports what went: `{tip, floor, versionsDeleted, complete}`. Assert on `versionsDeleted`, never on reported bytes: `navigator.storage.estimate()` is quantised and lags badly enough that the spike measured it reporting MORE space used after a prune that dropped nothing.

  **It is a call the HOST schedules, and that is a decision rather than an omission (ADR-0022).** A prune plus `VACUUM` measured 1.1 seconds at 62,553 versions while a block on the same real stream carries a median of 7 mutations, so folding it into `applyBlock` would stall whichever block happened to cross a threshold, for work that block did not cause, and would have a store picking a maintenance cadence for a browser tab, a backfilling CLI and a long-running server alike. An amortised policy is `prune({maxVersions: n})` on your own schedule (watch `complete`); a background policy is `prune()` on a timer. Pruning a store with nothing to enforce (`unbounded`, or `revert-only` with no declared `finalityDepth`) is a NO-OP and not an error, so a host may schedule it unconditionally. `VersionedStateEventProcessor.prune()` is the same call for a deployment that configured retention through the processor; it is on the processor and not on the read-only `state` view, because it is a write.

  **The LIVE version of an entity is never dropped, however old it is.** A row written once at block 12,082,307 and never touched again is still the current state, and on the real measured stream (event-bearing blocks median 429 apart, rows written once and never revisited) that is the normal case rather than an edge. The floor is `retentionFloor`, which is exactly `retainedRange(...).from`, so the block a read is refused below and the block a version is deleted at cannot drift apart, and `revertTo` still reaches the full depth of the window afterwards.

  **A store with a window configured now REPORTS that window** instead of downgrading to `unbounded`, on `@etherfold/state-store-sqlite` and on `MemoryStateStore` alike, because both now enforce it on both halves: refused on every as-of read, and dropped from storage by `prune`. `retentionWithoutPruning` is REMOVED (it existed only to express "this store cannot enforce what it was asked"). The report remains about what a caller may RELY on rather than about bytes on disk, so a host that has not pruned yet still refuses the reads its window excludes -- the safe direction, and the same one a `revert-only` store already took.

  **`BatchBounds` gains `maxRowsPerStatement` (default 500).** The existing bounds cap a batch and say nothing about a single statement touching an unbounded number of rows, which is exactly the shape a hosted backend rejects, so a prune deletes by an explicit bounded list of row ids instead of by predicate. That also makes the count exact, which `remote-sql` (rows, no affected-row count) could not otherwise supply.

  `@etherfold/state-store-conformance` gains a `pruning, and what must survive it` group, asked of every backend under each retention claim, and its windowed subjects are now ordinary configuration rather than test doubles.

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

- ab45129: Retention becomes a number a deployment SETS, a store REPORTS, and a read is REFUSED against.

  **The unit is block numbers, and there is only one unit.** A deployment writes `retention: 'unbounded' | 'revert-only' | {blocks: N}` on a store (or on `VersionedStateEventProcessor` / `fromSQLProcessor`, which pass it through). `{blocks: N}` is the only window spelling: a bare number names no unit, a duration is refused on every spelling, and a count of updates is refused too. Those are not style rules. Time would prune on WALL-CLOCK progress rather than chain progress, so a stalled indexer would drop history it never finished writing and a halted chain would expire its whole window while the tip stands still; "last N updates" is derivable above the seam from the blocks each backend already indexes, and adding it below would duplicate the prune path, the report and the tests for a unit that is a floor block number. See ADR-0019.

  **Sizing a window is not sizing a number of updates**, and the arithmetic is counter-intuitive enough to state at the API: on the real measured stream, event-bearing blocks are median **429 blocks apart**, so a window of 64 blocks holds exactly ONE event-bearing block. The default is `unbounded`, which is the only report true of a store that does not prune.

  **A window below the finality depth is refused where it is configured**, naming both numbers, because reorg revert reopens versions closed after the fork point and would find them pruned. `finalityDepth` is required alongside a window for the same reason, and `VersionedStateEventProcessor` checks it a second time at `load` against the finality the stream actually runs with, since a floor validated against the wrong number is silent corruption waiting for a deep reorg.

  **An as-of read the store cannot serve now throws instead of answering.** `BlockNotRetainedError` carries the block that was requested and the range that is retained, and it joins `NoSuchBlockError` under a new shared base, `BlockUnavailableError` (both exported from `@etherfold/state-store` and re-exported from `@etherfold/state-store-sqlite`). ADR-0015 settled that an unresolvable block address is an error and not an empty result; this is the other way a historical read can fail, and it must not arrive as `undefined` (which reads as "the entity was absent then") or as the tip value (a plausible wrong number nothing downstream can tell apart from a true one). A store set to `revert-only` refuses every as-of read and keeps reverting.

  **No store claims a window it does not enforce.** `@etherfold/state-store-sqlite` has no pruning, so a configured window is validated, warned about, and reported as `unbounded` -- which is what the store actually does, since every version ever written is still there. `MemoryStateStore` behaves identically. The right to report a window is earned by `prune-versions-outside-retention-window`.

  `VersionedStateView` now exposes `capabilities`, so the consumer holding the read handle can discover at startup what history is available instead of discovering it from a refusal (or a wrong number) in production. The capability cases run against both backends in `processor-entities/test/two-backends.test.ts`.

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

- 2a4e6ed: An entity column named after a SQL keyword no longer works on some backends and kills `migrate()` on others.

  **The defect.** `{name: 'placementPlayer', id: ['epoch', 'position', 'index'], ...}` passed identifier validation (`index` matches the shape rule and does not touch the store's `_` namespace), was stored and read without complaint by `MemoryStateStore`, `@etherfold/state-store-patch` and `@etherfold/state-store-indexeddb`, and then died on `@etherfold/state-store-sqlite` at `store.migrate()` with `SQLITE_ERROR: near "index": syntax error`. SQL cannot bind an identifier as a parameter, so a name reaches the engine as TEXT, and a SQL KEYWORD has a perfectly ordinary identifier shape: `index`, `order`, `group`, `select`, `table`, `where`, `default`, `references` and `primary` were all in the same position. The declaration is the surface ONE processor writes and SEVERAL backends store, so this made a processor silently non-portable and failed at deploy time on one platform, far from where the name was written.

  **The fix is to QUOTE, not to reject.** `@etherfold/state-store-sqlite` now emits every identifier that came from a declaration double-quoted -- the entity name, its id columns, its fields, and the index names derived from the entity name -- in its DDL (`src/ddl.ts`), in its statement builders (`src/statements.ts`) and in the reads on the store itself. **This is not a compatibility break:** every declaration that was legal before is still legal, and the ones that used to be fatal on SQLite now work. Rejecting keywords at declaration time was the other defensible fix and was not taken: it would have pushed one engine's reserved-word list into the surface every backend shares, broken declarations that are legal today, and re-opened the same hole the day SQLite adds a keyword or a second SQL backend arrives with a different list. The store's own fixed names (`_lower`, `_upper`, `_rowid`, `_blocks`) stay bare, so "quoted" reads as "this name came from outside".

  The shape rule is unchanged and still does its job: `to"ken`, `a-b` and anything else that is not `/^[A-Za-z][A-Za-z0-9_]*$/` is refused at declaration time, on every backend, and the `_` prefix stays the store's own. Quoting is not what stands between a declaration and injection; the shape check still runs first.

  **`@etherfold/state-store-conformance` gains a group, `a declaration means the same thing on every backend`**, asked of every backend. That is the property this was a defect against rather than a naming preference: a declaration one backend accepts must work on all of them, and one any backend refuses must be refused by all of them, at DECLARATION time. Its subject is a new shared fixture, `RESERVED` -- an entity named `order` with id columns `group` and `index` and fields `select`, `table`, `where`, `default`, `references` and `primary`. It is in `CONFORMANCE_ENTITIES`, so every case migrates it, every revert sweeps it and every prune considers it, and the keyword identifiers reach every statement a backend emits rather than only its DDL. A backend that adds this version of the suite and does not quote will see the whole run go red, which is what it did here before the fix.

  `quoted(name)` and `quotedList(names)` are exported from `@etherfold/state-store-sqlite` for the caller-supplied-SQL tier (`queryCurrent` / `queryAsOf`), where the predicate text is the caller's to write and therefore the caller's to quote: `store.queryCurrent('order', {where: `${quoted('default')} > ?`, args: [7]})`.

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
