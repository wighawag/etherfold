# @etherfold/fetcher-host

## 0.2.0

### Minor Changes

- 0f33468: A NAMED INDEXER IS A ROUTE SEGMENT AND A REGISTRY ENTRY, on both halves of the wire.

  An indexer-server hosted exactly one indexer: `ServerOptions.getIngestion` resolved a single `LogIngestion`, and the ingest routes were the unnamespaced `/ingest` and `/ingest/expected-from-block`. It now hosts SEVERAL, each under a NAME an operator supplies at deploy time (ADR-0036).

  **`/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block` replace the unnamespaced pair, which is GONE rather than kept beside them.** The name is a ROUTE SEGMENT and is deliberately NOT a field in the envelope: putting tenancy in the wire format would turn a misdirected batch into a payload error rather than a routing one. ADR-0004's `{source, config}` envelope and its refusal families (`409` resumable, `400` otherwise) are untouched.

  **`ServerOptions.getIndexer` replaces `getIngestion`, and resolves a registry ENTRY per name.** The entry is an object (`{ingestion}`) so that what a name holds can grow — a later generation model gives one entry several live wire contexts — without every host's resolver changing its return type. `indexerRegistry({name: streamBuilder})` builds one from a plain record for a host that knows its names up front; a host whose names depend on the request writes the function itself. Two named indexers on one server are isolated: a batch pushed to one is not visible to the other.

  **An unknown name is REFUSED, never defaulted: `404 unknown-indexer`.** A routing refusal, matching what the name is, and distinct from `501 ingestion-not-configured`, which a host with NO registry at all still answers under every name (a read tier, or a combined `run`). Both are in the non-retryable 4xx family a sender must not re-send into.

  **`createHttpIngestion` takes the indexer name beside the endpoint** (`@etherfold/core`) and posts to the namespaced routes; it refuses to be built without one rather than addressing nobody. `@etherfold/fetcher-host` reads it from `INDEXER_NAME` and demands it wherever it demands `INGEST_ENDPOINT` and `INGEST_TOKEN`, so a combined host that configures no wire is still asked for nothing.

  **The CLI grows `--indexer <name>` / `INDEXER_NAME`, REQUIRED on `fetch` and `index` and refused on `run`, `build` and `serve`.** The two halves of a split deployment agree on one name the way they already agree on one secret: `fetch` addresses `/{indexer}/ingest`, `index` registers exactly that name and refuses every other. The three commands with no wire route no batch by name, and refuse the flag with that reason rather than accepting and ignoring it.

  `StartOptions.getIngestion` on `@etherfold/platform-nodejs` becomes `getIndexer`, carried through unchanged as before.

### Patch Changes

- afd3da9: `etherfold run` and `etherfold build` no longer refuse to start when `STREAM_FINALITY` is set, and every command now HONOURS the environment's stream settings instead of half-ignoring them.

  The resolved stream config is hashed into the wire identity, so the sending `LogFetcher` and the receiving `StreamBuilder` must reach the same one. `resolveFetcherHostConfig` read three settings from the environment (`STREAM_FINALITY`, `STREAM_ALWAYS_FETCH_TIMESTAMPS`, `STREAM_ALWAYS_FETCH_TRANSACTIONS`) and then merged the caller's override OVER them. The commands that hold both halves in one process passed a hard-coded empty override, and spreading `{}` cannot remove a key the environment has already put there: the sender resolved `finality: 25` while the receiver resolved the default `17`, the digests could never match, and `WireContextMismatchError` is not retryable, so the process exited.

  The split deployment failed the same way and worse, because there the operator is told the two halves must agree: `etherfold fetch` honoured `STREAM_FINALITY` while `etherfold index` was pinned to the default, so setting it on both hosts, which is what a careful operator does, made every push refused.

  The stream config is now derived ONCE from the environment (`streamConfigFromEnv`, newly exported from `@etherfold/fetcher-host`) and handed to both halves, and an override REPLACES the environment's config rather than merging over it, because a spread can add a key but can never say "no finality here".

  The fix deliberately keeps the variable working rather than making both halves ignore it. Agreeing by ignoring would have satisfied the digest comparison while silently discarding a documented setting, and this CLI's rule is that nothing is accepted and ignored. The combined shape and the split shape now read one environment the same way.

  `STREAM_CONFIG`, previously exported from `etherfold`, is replaced by `streamConfigFor(env)`. It could not remain a constant: the value depends on the environment.

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
