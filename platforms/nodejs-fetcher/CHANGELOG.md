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
- Updated dependencies [afd3da9]
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
