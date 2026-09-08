# @etherfold/platform-nodejs-fetcher

The Node host for the etherfold **log-fetcher**: a long-running process that drives fetch cycles on an interval and backs off when there is nothing to do.

It is one half of a split deployment (ADR-0003). The other half is the **indexer-server**, which owns the cursor, the reorg derivation and the state. This process reads the chain and pushes contiguous ranges of raw logs at it.

This is the host that *drives* the chain, and it wants a runtime that can hold a process. A serverless runtime is a good home for the indexer-server, whose work is short and per-request, and a poor one for this: a cron fires on a schedule rather than continuously, and an invocation is capped well below what a first sync takes. So the usual split is a Node fetcher pointed at an indexer-server anywhere, including one on Workers.

**This package is a LIBRARY, and it ships no binary.** There is exactly one way to run a fetcher and it is [`etherfold fetch`](https://github.com/wighawag/etherfold/tree/main/packages/cli), which puts a flag surface in front of the configuration below and drives this:

```sh
npm i -g etherfold
etherfold fetch -n https://rpc.example -d ./deployments --indexer alpha --ingest-endpoint https://indexer.example
```

(The standalone `etherfold-fetch` binary this package used to ship is RETIRED, along with its `bin` entry. It was a second front door onto the same loop, configured only from the environment. The CLI is the process now, which is the shape [`@etherfold/platform-nodejs`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs) already had: a library with no binary, called by the command.)

Embedded in your own program:

```ts
import {startFetcher} from '@etherfold/platform-nodejs-fetcher';

const running = startFetcher({source: mySource});
await running.stopped;
```

## Combined: one process that fetches *and* processes

When the processor runs on Node too, there is no reason to put a network between the halves. Hand the fetcher a stream-builder instead of a URL:

```ts
import {createDirectIngestion} from '@etherfold/core';
import {startFetcher} from '@etherfold/platform-nodejs-fetcher';

const running = startFetcher({
	source: mySource,
	dependencies: {target: createDirectIngestion(myStreamBuilder)},
});
```

`INGEST_ENDPOINT` and `INGEST_TOKEN` are then neither needed nor read: there is no network to point at and nobody to authenticate to. Everything else is identical, because it is the same fetcher, the same stream-builder and the same contract, with the transport removed. The receiver still owns the cursor, still derives every reorg and still refuses a batch that does not start where it says.

(Building the stream-builder and its processor is the indexer-server's business, not this package's. `etherfold run` is that combined process built for you, and it drives its own loop -- so it takes `stopOnSignals` from here rather than `startFetcher`, which is what keeps "which signals stop a fetching process, and what happens to the cycle in flight" one answer:)

```ts
import {stopOnSignals} from '@etherfold/platform-nodejs-fetcher';

const controller = new AbortController();
const release = stopOnSignals(controller); // SIGINT and SIGTERM abort it
await runFetcherLoop(myHost, {signal: controller.signal});
release();
```

## It keeps nothing, on purpose

There is no state file, no lock file and no `--from-block`, and their absence is the design rather than an omission. The server is authoritative about where the next batch starts; this process asks, and a `409` telling it that it asked from the wrong place is the normal correction path, not an error. So:

- **Kill it at any moment.** Mid-fetch, mid-push, `SIGKILL`: nothing is lost and nothing needs repairing. The next start asks where to begin and is told.
- **Run two of them.** Redundancy needs no coordination, because neither holds an opinion worth reconciling. The one that loses a race is corrected, or ends its cycle as `yielded` and picks the work up on the next one.
- **Do not give it a database.** A block number written down anywhere on this side is a second opinion of a value the server owns, and it is wrong exactly when it matters (after a crash between a push and its acknowledgement).

## Configuration

Every variable below is read from the environment. Anything can also be passed to `startFetcher` directly, which wins -- and that is how `etherfold fetch` supplies the five an operator configures with flags (`-n`, `-d`, `--indexer`, `--ingest-endpoint`, `--ingest-token`), each of which still falls back to the variable behind it. A `.env` file works when the CLI loads one (it uses `ldenv`).

| Variable | Required | Meaning |
| --- | --- | --- |
| `INDEXING_SOURCE` | yes | The `IndexingSource` as JSON: `{"chainId":"1","contracts":[{"abi":[...],"address":"0x...","startBlock":123}]}`. Must match the server's. |
| `INGEST_ENDPOINT` | split only | The indexer-server's base URL. `/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block` hang off it. |
| `INDEXER_NAME` | split only | The NAMED INDEXER to push into: one indexed answer set over one chain (ADR-0036), and the first segment of every ingest route. Never defaulted -- a receiving host registers the names it was built with, and any other is refused with a `404`. |
| `INGEST_TOKEN` | split only | The server's `INGEST_TOKEN`. Sent as a bearer token, and never logged or included in an error. |
| `ETH_NODE_URI` | yes | The JSON-RPC endpoint to read the chain from. Treated as a credential: only its host is ever logged. |
| `SUSPECT_RESULT_COUNT` | **read this** | Your node's real `eth_getLogs` result cap. Discovered from the provider where it reports one, otherwise `10000`. See below. |
| `MAX_EVENTS_PER_FETCH` | no | How many events one fetch aims for. Default `10000`. |
| `MAX_BLOCKS_PER_FETCH` | no | The widest block range one fetch may cover. |
| `STREAM_FINALITY` | no | Must match the server's, since `{source, config}` is the wire identity. |
| `REQUESTS_PER_SECOND` | no | Rate limit for the JSON-RPC provider. |
| `POLL_INTERVAL_MS` | no | Wait after a cycle that reached the tip, or found nothing. Default `4000`. |
| `CATCH_UP_DELAY_MS` | no | Wait after a cycle that pushed and is still behind. Default `0`. |
| `MIN_RETRY_DELAY_MS`, `MAX_RETRY_DELAY_MS` | no | The escalating wait after a retryable failure. Defaults `1000` and `60000`. |
| `CONTENTION_RUN_ALERT` | no | How many consecutive `yielded` cycles before warning. Default `3`. |
| `RETRY_ATTEMPTS`, `RETRY_INITIAL_DELAY_MS` | no | The bounded retry *inside* one cycle. Defaults `4` and `500`. |
| `MAX_CORRECTIONS_PER_CYCLE` | no | How many `409`s one cycle follows before yielding. Default `2`. |

### `SUSPECT_RESULT_COUNT`: set it to your node's real cap

This is the sharpest edge in the deployment, and it cannot be closed in code.

A node that caps `eth_getLogs` **silently** returns exactly N logs and no error, and nothing distinguishes that from a range that genuinely holds N. The only detection there is is matching N exactly. The fetcher treats a result set landing on `SUSPECT_RESULT_COUNT` as suspect, halves the range and re-fetches until the answer comes back under it.

If your node caps at 5000 and this says 10000, the guard never fires: a short range is pushed as a complete one, the server reads the missing logs as an absence, an absence is a reorg, and a reorg deletes state.

**It is DISCOVERED where your provider reports it.** Several providers state their real result cap in every refusal, structurally (`{"code":-32005,"data":{"from":"0xBDE5F8","limit":10000,"to":"0x102DBCC"}}`, Infura) or in words (`Query returned more than 50000 results`, a Nethermind node such as Gnosis; `logs matched by query exceeds limit of 10000`, Arbitrum). The fetcher reads that number and uses it, so the count comes from the node rather than from a guess. The three tiers, most specific first, are:

1. `SUSPECT_RESULT_COUNT`, when you set it. It **wins**, always: setting it is an assertion about your node, and a number parsed out of an error message is weaker evidence than that.
2. a cap the provider reported in a refusal, which only ever fills the gap an unset variable leaves. A report that could not be a count of logs (zero, negative, fractional, absurd) is ignored and logged, and a later, higher report never raises an earlier, lower one.
3. `10000`, the most common cap.

Which of the three is in force is not left to be inferred: the startup line says whether the count is CONFIGURED or the DEFAULT, a discovered cap taking effect is logged (as is a configured one overriding a report), and a truncation that cannot be halved away names the source in its error. Leaving the variable unset asserts that your node caps at exactly 10000, does not cap silently at all, or reports its cap when it refuses.

Do **not** try to reach the same effect by raising `MAX_EVENTS_PER_FETCH`. That widens the span each fetch asks for, which makes truncation more likely rather than less. The two knobs mean different things: one is what this fetcher asks for, the other is what the node will silently refuse to exceed.

## What it logs, and what it never logs

Cycles are reported through [`named-logs`](https://github.com/wighawag/named-logs), and this package hooks up no sink: `etherfold fetch` hooks the facade to the console (`NAMED_LOGS`, `NAMED_LOGS_LEVEL`), because choosing where logs go is a process entry point's job and an application embedding `startFetcher` chooses its own. A run of `yielded` cycles is raised to a warning, because one is ordinary (that is what two fetchers do to each other) and a run of them is not.

No credential is ever written. `INGEST_TOKEN` appears in no log line and in no error message: a wrong one comes back as a `401` whose message names the variable. `ETH_NODE_URI` and `INGEST_ENDPOINT` are logged host-only, since `.../v2/<api-key>` is the standard shape at every hosted provider.

## Exit codes

`runFetcherProcess()` resolves the code the process should exit with, and `etherfold fetch` exits on it:

- `0`: asked to stop (`SIGINT`, `SIGTERM`).
- `1`: stopped because no retry would help: a bad token, a `{source, config}` the server does not serve, a provider on the wrong chain, a suspected truncation. The process exits rather than staying up and achieving nothing.

Everything else is retried with an escalating, jittered backoff and never exits: an unreachable server, a `5xx`, a dropped socket.
