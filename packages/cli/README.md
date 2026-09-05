# etherfold

The command line. `etherfold run` follows a chain, folds a processor into a libSQL database and answers HTTP over it, in one process; `etherfold build` is the same thing as a one-shot that exits at the tip; `etherfold fetch` is the chain-facing half of a split deployment, pushing raw logs to a server elsewhere; `etherfold index` is the half that receives those pushes and owns the database; `etherfold serve` is the READ tier over a database written elsewhere, answering `/status` -- health, schema version, reorg counters and the cursor the fold has reached.

```sh
npm i -g etherfold        # or: npx etherfold …
etherfold --help
```

Every run names its intent: there is no default command, so a bare `etherfold` prints this help and indexes nothing.

## When you want this, and when you do not

| you want | use |
| --- | --- |
| to run an indexer: follow a chain, fold into a database and answer HTTP | here, `run` |
| to index a contract into a database, from a terminal or a CI job | here, `build` |
| to run the chain-facing half near your node, pushing to an indexer elsewhere | here, `fetch` |
| to receive those pushes and own the database, on another host | here, `index` |
| to answer over a database something else writes | here, `serve` |
| to index inside a browser tab, with no server | [`@etherfold/browser`](https://github.com/wighawag/etherfold/tree/main/packages/browser) |
| to write the processor being run | [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) |
| to embed the same pipeline in your own Node program | [`@etherfold/core`](https://github.com/wighawag/etherfold/tree/main/packages/core) + [`@etherfold/fetcher-host`](https://github.com/wighawag/etherfold/tree/main/packages/fetcher-host) |

## `etherfold run` -- the whole pipeline, in one process

```sh
etherfold run \
  -p ./dist/processor.js \
  --store sqlite --db file:./etherfold.db \
  -n https://rpc.example --port 2000
```

**This is the default thing to reach for.** One process, one terminal invocation: it follows the chain, folds your processor into the libSQL database you named, and answers HTTP on the port you resolved -- with no knowledge required of how the components divide. When it reaches the tip it does not stop; it backs off to a poll interval and keeps following.

It is ASSEMBLY and not a fourth engine. A log-fetcher pushes into a stream-builder through an in-process direct ingestion (the two halves of the wire with the transport removed), the stream-builder folds your processor into the store, and the server starts on the SAME database handle the store writes through. `run` IS `fetch` plus `index` plus `serve` in one process; splitting them later is a deployment change and not a rewrite.

| flag | |
| --- | --- |
| everything `build` takes | same flags, same variables, same refusals: see the table below |
| `--port <port>` | port to listen on (or `PORT`). Defaults to `2000`; `0` asks the OS for any free port |
| `--host <hostname>` | hostname to bind. Binds every interface when absent |
| `--no-auto-setup` | do not apply the fixed-table schema at startup. Then somebody else must: this process stores the stream it folds into those tables, and it will not advance until it can (see below) |

**How it stops.** On `SIGINT` or `SIGTERM` it finishes the cycle in flight and exits `0`; nothing needs to be saved, because the store holds the rows AND the sync cursor in one transaction (ADR-0027), which is also why an interrupted run resumes from the store rather than from the start block. A refusal no waiting fixes -- a foreign `{source, config}`, the wrong chain, a suspected truncation -- ends it with a non-zero code, so a supervisor can tell a stop from a wedge. A retryable failure (an unreachable node) is retried indefinitely on an escalating, capped backoff rather than after N attempts: a transient outage should not leave a stopped indexer behind. Reaching the tip is not one of the ways it ends; that is `build`.

**`/status` reports a cursor that advances**, which is how a running deployment is observable before a query layer exists:

```json
{"healthy": true, "cursor": {"reported": true,
  "value": {"lastFromBlock": 21000001, "lastToBlock": 21004300, "latestBlock": 21004300, "unconfirmedBlocks": 3}}}
```

Four numbers, deliberately, and never the cursor itself: the stored cursor is a serialized sync structure carrying a window of decoded events, and `/status` reports whatever a host hands it verbatim (ADR-0047). `lastToBlock` is what moves; `latestBlock - lastToBlock` is how far behind it is.

**It also counts the reorgs it concluded**, in `reorgs: {absence, contradiction, last}`, and the split is the whole point. A `contradiction` is PROOF -- the same block height now carries a different hash -- and is ordinary chain activity. An `absence` is an INFERENCE: a block we held is simply not in the re-delivered range, which is indistinguishable from a node that under-delivered it. Both revert state, so folding them into one number would hide the only signal that says "your logs are being truncated or your filter is wrong" rather than "the chain reorged" (ADR-0004). Neither makes the process unhealthy: an absence-driven revert is a signal to investigate, not a fault.

**All three folding shapes carry these counters, not just the one behind an HTTP route.** `run`, `build` and `index` all count the reverts they concluded, into the database they fold into, through one writer (ADR-0050) -- so `run` and `fetch` plus `index` agree about a reorg the way they already agree about state and the cursor, and `packages/cli/test/equivalence.test.ts` compares them directly. `serve` reports what its database holds, since it folds nothing and concludes nothing. A count that cannot be written (a database with no fixed tables, see `--no-auto-setup`) is a logged miscount and never a fold that stops.

**And all three STORE THE STREAM they folded** (ADR-0052): every emitted log, retractions included, in the `_emissions` table of the database they fold into, which is what a later processor change re-folds from instead of re-fetching the whole history from your node, and what both feed views read. That write is NOT best-effort, and it is the one thing that can stop a fold: it happens BEFORE the batch is processed, and a batch that could not be stored is not processed at all, because a state that advanced past events the stream never received is silent, permanent damage nothing downstream can detect. So a `run` pointed with `--no-auto-setup` at a database nobody has migrated retries its cycle and reports no progress, rather than indexing into a database that cannot record what it indexed; it catches up by itself once the schema is applied.

**A `run` process hosts no remote writer.** It fetches for itself, so no registry is injected into its server: an authenticated call to `/{anything}/ingest` answers `501 ingestion-not-configured`, and an unauthenticated one answers `401`, exactly as on the read tier. A remote sender pushing into a process that is already fetching would be a second writer nobody asked for; the command that receives pushes is `index`. That is why `--ingest-endpoint` and `--ingest-token` are refused here: the two halves meet in this process through a direct in-process ingestion, so there is no wire to configure.

**`--indexer` is accepted here, and it is the one input this command may default.** It is NOT a wire setting: the name is what every row of the stored stream is keyed on (ADR-0036), so a process that folds needs one whether or not anything addresses it by one. This process routes no batch by name -- it registers none, as above -- so the never-defaulted rule that binds `fetch` and `index` does not reach it, and it defaults to `default` (ADR-0052). Name it explicitly when two answer sets will share a database, or when a consumer should follow the feed under a name you chose.

## `etherfold build` -- one shot, to the tip, then exit

```sh
etherfold build \
  -p ./dist/processor.js \
  --store sqlite --db file:./etherfold.db \
  -n https://rpc.example
```

Named for what it PRODUCES: a database. What it does: load the processor module, open the store, resolve the source, then fetch and fold until it reaches the chain tip it observed, and exit. Exit code 0 on success, 1 on failure, so a CI job can depend on it.

**It is `run` without the serving, stopping at the tip**, and that is true of the code rather than of this sentence: both commands assemble through one function and differ by whether the loop aborts on the first report that reached the tip.

**It is a ONE-SHOT and nothing else.** It does not follow the chain, does not stay up, and cannot be reconfigured while it runs: to keep a database current, run it again (a cron, a loop, a job). It resumes rather than restarting, because the sync cursor is in the store, written in the same transaction as the block it describes (ADR-0027). Live reconfiguration is the browser package's ability, not this one's.

**The database it emits carries its provenance**, which is why `build` applies the fixed-table schema even though it binds no port: the artifact records the schema version, the reorgs it concluded (`absence` versus `contradiction`, exactly as `run` and `index` record them -- ADR-0050) and the STREAM it folded (ADR-0052), so a `serve` pointed at it, or a later process fed it, reads the same facts a `run` database carries. The stream is the part that makes the artifact re-foldable: a processor-logic change replays what is already on disk instead of re-fetching a whole history from a node that may no longer serve it. Nothing else in this command would ever create those tables, and a database that loses its provenance the moment it becomes an INPUT is the failure this prevents. `--no-auto-setup` is refused here: the one-shot answers no queries, and there is no startup to decline the tables at.

| flag | |
| --- | --- |
| `-p, --processor <path>` | the processor module. It must export `createProcessor` (a factory, or the processor object itself) |
| `--store <sqlite>` | REQUIRED and never defaulted. It names where the state goes, and it is the axis a second backend would arrive on |
| `--db <url>` | libSQL url: `file:./etherfold.db`, `:memory:`, or `libsql://<host>`. Required with `--store sqlite`, so no run writes a database nobody named |
| `--retention <blocks\|revert-only\|unbounded>` | how far back superseded versions are kept, in BLOCK numbers and no other unit (ADR-0019). Default `unbounded` |
| `-d, --deployments <folder>` | contract deployments in hardhat-deploy / rocketh format, or `INDEXING_SOURCE` as JSON. Optional when the module supplies `contractsDataPerChain` |
| `-n, --node-url <url>` | the JSON-RPC endpoint (or `ETH_NODE_URI`) |
| `--rps <n>` | cap the requests per second made to the node (or `REQUESTS_PER_SECOND`) |
| `--indexer <name>` | the NAMED INDEXER the artifact's stored stream is keyed on (or `INDEXER_NAME`). Optional here, and the only input besides `--port` that defaults: `default` (ADR-0052). It routes nothing -- this command answers no requests |

A flag combination that names no store is REFUSED rather than ignored: an accepted-and-ignored flag is a deployment believing a retention window is enforced, or a database is being written, when neither is true. Nothing prunes automatically, because pruning costs time proportional to what it drops and is a call a host schedules (ADR-0022).

The processor module hands back the AUTHORING object (declarations plus handlers) and never picks a store; that is what makes the SAME module file the one a browser tab runs. A module still returning the retired `{kind, processor}` tag is refused by name (ADR-0037).

## `etherfold fetch` -- the chain-facing half, and the ONLY way to run a fetcher

```sh
etherfold fetch \
  -n https://rpc.example \
  -d ./deployments \
  --indexer my-indexer \
  --ingest-endpoint https://indexer.example
```

**It follows the chain and pushes contiguous ranges of raw logs at an indexer-server elsewhere**, which is what makes splitting a deployment a deployment decision rather than a rewrite: run this on a host near your node and the folding half anywhere. It folds nothing, answers no queries, and keeps running until it is stopped.

It is a front door onto [`@etherfold/platform-nodejs-fetcher`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs-fetcher) and not a second implementation, and it is now the ONLY one: that package used to ship an `etherfold-fetch` binary configured from the environment alone, and that binary is retired with its `bin` entry. What survives there is the library the command drives.

| flag | |
| --- | --- |
| `-n, --node-url <url>` | the JSON-RPC endpoint (or `ETH_NODE_URI`) |
| `-d, --deployments <folder>` | what to index, as a deployments folder, or `INDEXING_SOURCE` as JSON. REQUIRED here in one form or the other: there is no processor module to read contracts out of |
| `--indexer <name>` | REQUIRED. The NAMED INDEXER on that server to push into (or `INDEXER_NAME`): one indexed answer set over one chain (ADR-0036), and the first segment of every ingest route. Never defaulted -- a name the receiver was not built with is refused with a `404` |
| `--ingest-endpoint <url>` | the indexer-server to push to (or `INGEST_ENDPOINT`). `/{indexer}/ingest` hangs off it |
| `--ingest-token <token>` | the wire's shared secret (or `INGEST_TOKEN`, which is preferable: a secret on a command line is visible to every process on the host) |
| `--rps <n>` | cap the requests per second made to the node (or `REQUESTS_PER_SECOND`) |

Everything else a fetcher deployment tunes -- `SUSPECT_RESULT_COUNT` (**read that package's README about this one**), the fetch bounds, the backoff, the stream identity -- stays in the environment the fetcher host already publishes, rather than growing a second name here.

**It owns no state, and the flags that would imply otherwise are REFUSED rather than ignored.** No `--store` and no `--db`, because a fetcher holds no cursor and no database (ADR-0003); no `-p`, because the chain-facing half holds no processor and whatever folds these logs lives behind `--ingest-endpoint` under `--indexer`. There is likewise no state file, no lock file and no `--from-block`: where the next batch starts is the RECEIVER's answer, and a `409` telling this process it asked from the wrong place is the ordinary correction path. So killing it costs nothing and running two of them needs no coordination.

**How it stops.** `SIGINT` / `SIGTERM` finish the cycle in flight and exit `0`. A refusal no waiting fixes -- a bad token, a `{source, config}` the server does not serve, a provider on the wrong chain, a suspected truncation -- exits non-zero, because a fetcher that stays up while achieving nothing is indistinguishable from a working one until somebody reads the state it is not producing. Everything else (an unreachable server, a `5xx`, a dropped socket) is retried on an escalating, capped backoff and never exits.

## `etherfold index` -- the RECEIVING half, which owns the database

```sh
etherfold index \
  -p ./dist/processor.js \
  --store sqlite --db file:./etherfold.db \
  -d ./deployments --indexer my-indexer --port 2000
```

**It folds what something else pushed at it.** It makes no chain call, receives contiguous ranges of raw logs over HTTP, folds them through your processor into the libSQL database you named, and keeps running. It is the other half of the pair `fetch` sends to, and together they are a split deployment: run `fetch` on a host near your node and this anywhere.

**It exposes the write path and NOT the query API, and that asymmetry is the point.** It has an HTTP surface because it must RECEIVE; answering queries is `serve`'s. So a split deployment is `index` plus `serve` against ONE database -- the writer and a stateless read tier -- and `/status` is available on both, because it reports on the database rather than on the process.

| flag | |
| --- | --- |
| `-p, --processor <path>` | the processor module. It must export `createProcessor` |
| `--store <sqlite>` / `--db <url>` | REQUIRED, exactly as on `build`: this command owns the database |
| `--retention <blocks\|revert-only\|unbounded>` | as on `build`. Nothing prunes automatically (ADR-0022) |
| `-d, --deployments <folder>` | what to index, or `INDEXING_SOURCE` as JSON. REQUIRED here in one form or the other -- see below |
| `--indexer <name>` | REQUIRED, and never defaulted on this half of the wire (unlike `run` / `build`, which route nothing). The NAMED INDEXER this process HOSTS (or `INDEXER_NAME`): the name a sender addresses it by, and the name the stream it stores is keyed on. It registers exactly this one and refuses every other with a `404`, rather than serving a misdirected push from the only indexer it holds |
| `--ingest-token <token>` | REQUIRED. The wire's shared secret, the same name on both sides (or `INGEST_TOKEN`, which is preferable: a secret on a command line is visible to every process on the host) |
| `--port <port>` / `--host <hostname>` | where it LISTENS for pushes (or `PORT`). `/{indexer}/ingest` and `/status` hang off it |
| `--no-auto-setup` | do not apply the fixed-table schema at startup |

**It makes NO chain call, and that is why the source must be explicit.** `-n` and `--rps` are REFUSED naming what this command is instead: there is no node here. The source cannot be taken from a processor module that keys its contracts per chain either, because reading one costs an `eth_chainId` call -- so it comes from `-d` or `INDEXING_SOURCE`, and a module-only source is refused naming both forms. That is not fussiness: the wire identity is derived from the source and the stream config together, so a source this half discovered on its own could not be the sender's, and every push would be refused with a `400`.

**It authenticates, or it refuses everyone.** The shared secret is required, so a receiver with none configured never binds a port rather than coming up as an open-looking endpoint that answers `401` to a sender with no way to know why. A push with the wrong secret is a `401` naming the variable, and nothing is applied.

**A replayed or resumed push is safe, because the cursor IS the idempotency key.** A batch that does not start where this receiver says the next one must is refused with a `409` carrying that block, and the sender re-sends from there; a sender that fell behind is corrected with no operator involved, and a batch re-sent after a lost acknowledgement cannot be applied twice. There is no dedupe table and no idempotency header, deliberately.

**`/status` reports the cursor here, exactly as on `run`**, because this is the half that owns the store. It also counts the reorgs it derived (`absence` versus `contradiction`, ADR-0004): a rising rate of the absence kind means truncation or misconfiguration rather than chain activity. Those counts are taken by the FOLD and written by the process that owns the store (ADR-0050), so this half and a combined `run` over the same chain report the same numbers -- the ingest route is a caller of that path rather than the owner of it, and a receiver that both concludes a revert and serves the request that carried it counts it once. The same is true of the STREAM it stores (ADR-0052): the append happens inside the fold, before the batch is processed, so this half and a combined `run` over one chain store the same rows, and a store that cannot take a batch answers the sender a `500` having applied nothing -- its next push meets the cursor it already had, so nothing is lost and nothing is applied twice.

**How it stops.** `SIGINT` / `SIGTERM` shut the listener down and exit `0`. It never stops on its own: a receiver has no tip to reach, because what it folds arrives from somewhere else. A configuration it refuses, a module it cannot drive or a database it cannot open exits `1` without binding a port.

One thing it does not have yet: an indexer-NAME route segment. This is one indexer per process; hosting several under one server is a later milestone.

## `etherfold serve` -- the READ tier

```sh
etherfold serve --db file:./etherfold.db --port 2000
```

**It only serves.** It holds no processor, makes no chain call, receives no logs and writes no indexed state: it answers queries over a database something ELSE wrote, so a serving tier can scale or move without carrying an indexer with it. Point it at a database `etherfold build` produced, or at the one `etherfold index` is folding into -- both carry the fixed tables, their reorg counters and the stream they folded, so a read tier reports the same numbers whichever shape wrote the database. (The FEED views are the one thing it cannot serve: validating a consumer's cursor needs to know which stream is served NOW, and only a process holding the receiver knows that.)

**It answers `/status` WITHOUT a cursor, and that is correct rather than missing.** The cursor reaches `/status` only through a reporter the host injects, and only a process that OWNS the store can read one; a read tier owns none and is given none, so its `/status` carries no `cursor` field at all rather than an invented one. What it does report is what the server derives from the DATABASE itself -- health, the schema version, the reorg counters -- so those agree with what the writer of that database reports.

It starts [`@etherfold/server`](https://github.com/wighawag/etherfold/tree/main/packages/server) on Node through [`@etherfold/platform-nodejs`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs): `GET /status` (health, schema version, reorg counters, last error) and `POST /admin/setup`. Because it hosts no ingestion, the write path is a CAPABILITY it does not have rather than a route it lacks: an authenticated call to `/{anything}/ingest` answers `501 ingestion-not-configured` (an unauthenticated one answers `401`, so the absence of a processor is not something an anonymous caller can probe). `platforms/nodejs/test/serve.test.ts` asserts both.

The one thing it does write is the fixed-table SCHEMA, applied at startup if it is not already there, because the Node host is the single-operator case; `--no-auto-setup` turns that off and leaves migration to the operator.

| flag | |
| --- | --- |
| `--db <url>` | REQUIRED. The libSQL database to answer over (or `DB`). It is not defaulted, so a read tier never comes up on an empty database nobody named |
| `--port <port>` | port to listen on (or `PORT`). Defaults to `2000` |
| `--host <hostname>` | hostname to bind. Binds every interface when absent |
| `--no-auto-setup` | do not apply the fixed-table schema at startup |

The server's dependency tree is imported lazily, so `etherfold build` never pays for it.

## Configuration: flags first, environment behind them

Every command resolves every input THE SAME WAY, which is what makes moving between them a deployment change rather than a rewrite. The rules:

- **A flag beats the environment**, the environment is used when the flag is absent, and neither present is a REFUSAL. Only the port falls back to a default (`2000`); nothing else does, because getting a database or a node URL wrong silently is how a deployment ends up believing something untrue.
- **One name per input**, and the variables are the ones a deployable already publishes: the fetcher host's (`INDEXING_SOURCE`, `ETH_NODE_URI`, `INGEST_ENDPOINT`, `INGEST_TOKEN`, `REQUESTS_PER_SECOND`) plus the Node server host's (`DB`, `PORT`).
- **A refusal names the flag AND the variable** that would have satisfied it, and it happens before the chain is dialled or a database is opened.
- **Nothing is accepted and ignored.** A flag a command does not own is refused with the reason it does not own it (`etherfold serve -p ./processor.js` says that a read tier holds no processor and points at `index` / `run` / `build`), rather than being taken and quietly having no effect. An ambient VARIABLE a command does not own is simply not read, so one host can run several commands side by side.

Seven inputs have a variable and six do not, and the line is deliberate: **the environment carries what varies between deployments of one image** -- the chain, the source, the database, the wire, the port -- while a flag carries what the image IS: which processor module, which store, which retention window, which interface.

| variable | flag | |
| --- | --- | --- |
| `INDEXING_SOURCE` | `-d, --deployments` | what to index, as JSON (`{chainId, contracts}`) where the flag is a deployments folder |
| `ETH_NODE_URI` | `-n, --node-url` | the chain's JSON-RPC endpoint |
| `DB` | `--db` | the libSQL database |
| `PORT` | `--port` | the port an HTTP surface binds |
| `INDEXER_NAME` | `--indexer` | the NAMED INDEXER: what `fetch` pushes into and `index` hosts (required on both), and what the stream `run` or `build` stores is keyed on (optional there, defaulting to `default`) |
| `INGEST_ENDPOINT` | `--ingest-endpoint` | the indexer-server a `fetch` pushes to |
| `INGEST_TOKEN` | `--ingest-token` | the ingest wire's shared secret, the same name on both sides. Prefer the variable: a secret on a command line is visible to every process on the host |
| `REQUESTS_PER_SECOND` | `--rps` | the rate limit applied to the node |

The CLI used to read a second name for the node URL (`ETHEREUM_NODE`). It is RETIRED: there is one name for it, and it is `ETH_NODE_URI`, which is what the fetcher deployable already refuses by.

## The five names, and the two compositions

All five ship, and `CONTEXT.md` is the authority for what each one means. Two compositions hold in the CODE rather than in this sentence: **`run` IS `fetch` plus `index` plus `serve` in one process** (the first pairing is the in-process direct ingestion, the same log-fetcher and the same stream-builder with the transport removed), and **`build` is `run` without the serving**, stopping at the tip.

Which is why splitting is a deployment decision you can defer and then reverse. `packages/cli/test/equivalence.test.ts` asserts it at the commands rather than claiming it: the same processor, the same entity declarations and the same fixture chain -- reorg included, with the replacement branch carrying fewer events -- run once through `run` and once through `fetch` plus `index`, land on identical state and an identical cursor; and `index` plus `serve` against one database answer what `run` answers.

All five rows of the configuration live in one table (`src/config.ts`), which is what makes moving between them a deployment change rather than a rewrite. Two asymmetries in it are load-bearing: `fetch` takes a source but no processor, and refuses `--store` and `--db` outright, because the chain-facing half holds no state (ADR-0003); and `index` resolves its source with NO chain call at all, so it takes it from `-d` or `INDEXING_SOURCE` and refuses a processor module that could only be resolved by asking a node for its chain id.

## Tests

`pnpm --filter etherfold test`, vitest.
