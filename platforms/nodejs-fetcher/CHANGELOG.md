# @etherfold/platform-nodejs-fetcher

## 1.0.0

### Major Changes

- 70af4e1: **BREAKING: the `etherfold-fetch` binary is RETIRED, with its `bin` entry, and this package survives as a LIBRARY.**

  There is exactly one way to run a fetcher and it is `etherfold fetch` (the `etherfold` CLI), which puts a flag surface in front of the configuration this package reads from the environment. The binary was a second front door onto the same loop, and a second front door is a second answer to how a fetcher is configured.

  Nothing else moves: `startFetcher`, `runFetcherProcess`, `stopOnSignals`, the loop, the signal handling and the exit codes are unchanged, and the environment variables are still the ones documented here. This is precisely the shape `@etherfold/platform-nodejs` already has -- no binary, and the CLI imports its start function -- so the symmetry between the two host adapters is restored rather than invented, and the runtime adapter stays the only place a runtime is named (ADR-0003).

  Two dependencies go with the entry point that used them: `ldenv` (loading a `.env` file is what a process does, and the CLI does it) and `named-logs-console` (hooking the log facade to the console is a process entry point's job, so `etherfold fetch` does it now, and an application embedding `startFetcher` still chooses its own sink).

  **Migrating:** replace `etherfold-fetch` with `etherfold fetch`, whose flags default to the same variables this package always read.

### Minor Changes

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

- 8d1c6c5: **A DOCUMENTED DEPLOYMENT VARIABLE IS REMOVED, not an internal flag.** `PROVIDER_SUPPORTS_ETH_BATCH` was an environment variable `platforms/nodejs-fetcher` documented in its configuration table, and it is gone from that table, from `@etherfold/fetcher-host`'s resolved config and overrides, and from `@etherfold/core`'s `ProvidedIndexerConfig` and `ProvidedLogFetcherConfig` as `providerSupportsETHBatch`. An operator who sets it now sets nothing: it is ignored like any other unrecognised variable, with no warning, no alias and no deprecation period, on the same ground as `STREAM_ALWAYS_FETCH_TIMESTAMPS` before it (CONTEXT.md: nothing is published, so backward compatibility with what was released is not an obligation, and a variable that is read and ignored is indistinguishable from one that works).

  **Why it buys nothing any more.** The knob existed so the per-hash block and transaction fetches could go out as ONE batched request instead of N. Those fetches are DELETED (ADR-0073), so the engine's whole chain-facing surface is one `eth_getLogs` per range, one `eth_blockNumber` for the tip and one `eth_chainId` for the identity guard: there is no request left that a batch could carry, and therefore nothing for a deployment to tell the engine about its provider's batch support.

  **This is NOT a re-prohibition of batch RPC.** A caller's provider may batch whatever it likes, transparently, and the engine neither knows nor cares. ADR-0002's consequence bullet is rewritten to say exactly that rather than deleted, because a bullet that simply disappeared would read as a reversal of the correction it was written to make.

  **No stream forks and no history is re-fetched.** The flag was a SIBLING of `stream` rather than a member of it, so it was never part of the resolved stream config and never in the digest taken over it. Unlike the `stream` flags removed alongside it, this one is digest-neutral for every deployment, including one that set it.

- 0f33468: THE NODE FETCHER ADDRESSES A NAMED INDEXER, through `INDEXER_NAME`.

  No code changes here: the variable is read by `@etherfold/fetcher-host`, which this adapter already resolves its whole configuration through, and it may equally be passed to `startFetcher` as an override. What changes is that a SPLIT deployment now needs it: the receiving server's routes are `/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block`, a host registers the names it was built with and defaults none, so a fetcher started without a name refuses at construction naming the variable, exactly as it already does for `INGEST_ENDPOINT` and `INGEST_TOKEN`. A COMBINED host, which pushes through `createDirectIngestion` and addresses no route, is asked for nothing.

### Patch Changes

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- 7af8558: `suspectResultCount` is now DISCOVERED from the provider where the provider reports it, instead of being a number an operator has to guess about their own node. An explicitly configured value still wins.

  This is the sharpest correctness knob in the fetcher. It is the count at which a result set is treated as SUSPECT rather than complete, and the detection is exact-count matching because it cannot be anything else: a capped answer and a complete one differ in nothing. Set it wrong and a node capping silently at 5000 hands back 5000 logs, the guard does not fire, a short range is pushed as a complete one, and the receiver reads the missing logs as an absence — an absence is a reorg, and a reorg deletes state (ADR-0004). It defaulted to 10000 and was otherwise a guess, while several providers state their real cap in every refusal.

  **Three tiers, most specific first: `configured` → `reported` → `default`.** A configured value is an ASSERTION about your node and outranks everything, because a number parsed out of an error message is weaker evidence than a deployment saying what it knows; a reported cap may only FILL the gap an unconfigured deployment leaves; the default is unchanged (`fetch.maxEventsPerFetch`, itself 10000, in core — and 10000 flat in `@etherfold/fetcher-host`, which still refuses to let the suspect count follow how much a fetcher asks for).

  **`reportedResultCapFromError` is the fourth reader of one refusal**, beside `getNewToBlockFromError` (how far to shrink this retry), `statedBlockCapFromError` (a ceiling on every range from now on) and `archiveRefusalFromError` (stop, this endpoint serves no history) — and the only one whose answer is not about a range at all. It reads two shapes, structured before prose as the others do: the `limit` of a `{from, to, limit}` descriptor (`{"code":-32005,"data":{"from":"0xBDE5F8","limit":10000,"to":"0x102DBCC"}}`, Infura, quoted verbatim in ethers-io/ethers.js#4703), and a count written out beside what it counts — `Query returned more than 50000 results` (Gnosis, Chiado, Fraxtal, zkSync Era, Abstract), `logs matched by query exceeds limit of 10000` (Arbitrum One and Nova), `a cap of 10K logs in the response` (Alchemy), all captured 2026-09-08 in `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/`.

  **The two fields of the structured descriptor gate each other.** `getNewToBlockFromError` already required `limit` before believing a `to`, because a bare `to` may be a provider echoing the request back; this requires `to` before believing a `limit`, because a bare `limit` is also what a provider calls a request-RATE allowance, and a rate limit read as a result cap would make the fetcher suspect every answer of 100 logs and stop outright on a block holding exactly that many.

  **A cap is read only where the words name what is COUNTED.** Providers cap this method by block SPAN or by RESULT COUNT, the numbers differ by orders of magnitude, and the sentences look alike, so the result patterns anchor on `results`/`logs` exactly as the block ones anchor on `block range`: `exceeded maximum block range: 5000` reaches neither this reader nor `suspectResultCount`, and `logs matched by query exceeds limit of 10000` — which the block reader deliberately refuses — is exactly what this one takes. The LOWEST plausible candidate in a refusal wins, and a later, HIGHER report never raises an earlier one, both for the same asymmetry: a suspect count below the node's real cap costs a re-fetched half-range, while one above it misses the truncation entirely and pays for it in deleted state. A number that could not be a count of logs (zero, negative, fractional, above 10,000,000) is ignored and logged rather than trusted.

  **What is in force, and where it came from, is now readable rather than inferred.** `LogFetcher.suspectResultCount` is a public getter returning `{count, source}` with `source` one of `configured` / `reported` / `default`, re-resolved per fetch so a cap learned from the very refusal that provoked it applies immediately. A discovered cap taking effect is logged, and so is a configured value overriding a reported one — the line an operator needs when telling "my configuration is wrong" from "my provider says this". `SuspectedTruncationError` carries the same `source` and names it in its message, with the fix that follows from it (a REPORTED count is overridden by configuring one). `@etherfold/fetcher-host` prints which tier its startup number is.

  **Two shapes changed:** `SuspectedTruncationError`'s constructor takes the source as a third argument, and `FetcherHostConfig` carries `suspectResultCountSource: 'configured' | 'default'` beside the number. The second is what makes the whole thing work on the deployed path: the host resolved its default into the same field an operator's value goes in, so every deployment looked configured to core and no reported cap could ever have filled the gap.

  Scope: `suspectResultCount` exists only on the split fetcher path. The single-process indexer has no equivalent truncation guard, and this change does not add one.

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
- Updated dependencies [a4d106e]
- Updated dependencies [339d212]
- Updated dependencies [4f5588b]
- Updated dependencies [351c585]
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
- Updated dependencies [afd3da9]
- Updated dependencies [49e73ae]
- Updated dependencies [70f98d6]
- Updated dependencies [3e9e9d0]
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
- Updated dependencies [b0e9a0d]
- Updated dependencies [bb86a77]
- Updated dependencies [8d1c6c5]
- Updated dependencies [8baecea]
- Updated dependencies [114879f]
- Updated dependencies [5adafa9]
- Updated dependencies [a6963b4]
- Updated dependencies [cb28315]
- Updated dependencies [ad8d8b1]
- Updated dependencies [50748cf]
- Updated dependencies [290e827]
- Updated dependencies [c0d694f]
- Updated dependencies [d10b64e]
- Updated dependencies [01ed0ef]
- Updated dependencies [629dff0]
- Updated dependencies [9e2c66d]
- Updated dependencies [ed8e7ff]
- Updated dependencies [b824312]
- Updated dependencies [35fc4c2]
- Updated dependencies [4f206c3]
- Updated dependencies [449f6fb]
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
- Updated dependencies [0a53b98]
  - @etherfold/core@1.0.0
  - @etherfold/fetcher-host@0.2.0

## 0.1.0

### Minor Changes

- 31833b6: A host for the log-fetcher: the Node loop, and the policy every host shares.

  `LogFetcher` (`@etherfold/core`) answers what a fetch cycle IS and deliberately says nothing about when one runs. These packages are the layer above.

  **`@etherfold/fetcher-host`** is everything a host needs that is NOT scheduling, so that it exists once rather than once per runtime: the configuration a deployment supplies, the classification of a cycle into the five things a scheduler can act on, the wait after each, and the loop that drives them. `runFetcherLoop` runs cycles back to back while there is known work left and settles into a poll interval at the tip.

  **Three of the five outcomes are not failures.** `progress` and `idle` (`up-to-date`: the chain has produced nothing above the cursor) are ordinary, and so is `contended` (`yielded`: the cycle was corrected repeatedly without landing, which is what redundant fetchers do to each other) -- it backs off on an escalating, jittered curve and is raised to a warning only after a RUN of them, since one is normal and a run is a signal. The split between `retry` and `fatal` is read off the error's own `retryable` flag and is never re-derived from a status code or a message: an unreachable server escalates and keeps going, while a bad token, a foreign `{source, config}`, the wrong chain or a suspected truncation stops the host, because no waiting makes those right.

  **`@etherfold/platform-nodejs-fetcher`** adds a process and nothing else: `startFetcher()` returns a handle, `SIGINT`/`SIGTERM` let the cycle in flight finish, and `etherfold-fetch` exits `1` when it stopped on a refusal, because a fetcher that stays up while achieving nothing is indistinguishable from a working one until somebody reads the state it is not producing.

  **It holds no cursor, and has nowhere to put one.** Progress across restarts comes from the indexer-server's expected cursor and from nothing else (ADR-0004): every run's first act is to ask, and a `409` is the correction path rather than an error. This is tested rather than assumed. A fetcher is killed with a cycle in flight, between reading the logs and delivering them, and replaced by one carrying nothing; every log still lands exactly once, over real HTTP, with no operator involved.

  **Set `SUSPECT_RESULT_COUNT` to your node's real `eth_getLogs` cap.** Silent truncation is detectable only by matching the cap exactly, so a node capping at anything other than the default 10000 pushes a short range as a complete one, which the receiver reads as an absence, and an absence is a reorg. It is resolved INDEPENDENTLY of `MAX_EVENTS_PER_FETCH`: lowering how much a fetcher asks for (the only lever a host has over batch size) must not quietly lower what it treats as a capped answer.

  Credentials come from configuration and are never written. `INGEST_TOKEN` appears in no log line and in no error message; `ETH_NODE_URI` and `INGEST_ENDPOINT` are logged host-only, since `.../v2/<api-key>` is the standard shape at every hosted provider.

  **There is deliberately no serverless fetcher, and only one schedule shape.** Driving the chain needs a host that can hold a process: a serverless trigger fires on a schedule rather than continuously, caps an invocation well below what a first sync takes, and holds a whole batch in memory while it is built. A serverless runtime is a good home for the RECEIVING half, whose work is short and per-request, and this half runs where a loop can.

  What does vary is where the batch goes, and it arrives as one dependency. `createHttpIngestion` pushes to an indexer-server elsewhere; `createDirectIngestion` (new in `@etherfold/core`) hands it to a stream-builder in the same process, so a single Node deployable runs both halves. `endpoint` and `token` are consequently optional and are demanded only by a host that will actually push over HTTP: a combined one has no network to point at and nobody to authenticate to. A test drives both shapes over the same chain, reorg included, and asserts they land in the same state.

### Patch Changes

- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [0957f8c]
- Updated dependencies [c681b79]
- Updated dependencies [9d21d67]
- Updated dependencies [ca6f981]
- Updated dependencies [31833b6]
- Updated dependencies [047cd73]
- Updated dependencies [31833b6]
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
  - @etherfold/fetcher-host@0.1.0
