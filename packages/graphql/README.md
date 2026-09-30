# @etherfold/graphql

ONE GraphQL schema, built from the entity declarations, answered through the accessor seam (`@etherfold/accessor`), with every operation pinned to one block (ADR-0099). And the `QueryExecutor` contract every transport implements, so the same document runs against a browser worker and a hosted indexer with identical results.

The root entry is runtime-neutral: it imports `graphql`, Pothos and the two seams, and nothing else, and it builds for Node and for a browser (asserted).

```ts
import {buildQuerySchema, localExecutor} from '@etherfold/graphql';

const schema = buildQuerySchema(declarations); // the same array the store and the processor take
const execute = localExecutor(schema, {
	accessor: store.accessor(),
	generation, // generationDigestOf(...) from @etherfold/core: reported, never parsed
	tip: async () => highestBlockTheStoreHolds(), // the pin, and the reorg guard
	asOf: store.capabilities.asOf, // required: a revert-only store answers every read at the tip
});

const {data, errors, extensions} = await execute({
	query: `query ($min: U256) {
		pool(where: {amount: {gte: $min}}, orderBy: {field: amount, direction: desc}, first: 20) {
			pool kind amount
			deposits(first: 10) { seq who amount }
		}
	}`,
	variables: {min: '1000000000000000000'},
});
extensions; // {generation, block}: which generation answered, and the block every field was read as of
```

## What the declarations become

- An entity is an object type, its name capitalised (`pool` is `Pool`); its id columns are `String!` and its fields nullable.
- `text` is `String`, `integer` is `SafeInt` (±(2^53 - 1): GraphQL's `Int` is 32 bits), `real` is `Float`, `blob` is `Bytes` (`0x` hex), a `u256` is `U256` (a DECIMAL STRING, because JSON has no `bigint`), and an enum is a GraphQL enum (`PoolKind`), value for value.
- A relation (`parent: {entity, as}` on the child) is a nested collection named `as` on the parent, read for a whole page of parents in ONE accessor call and bounded per parent.
- Each entity has one root list field, named as the entity is (`pool`), never a guessed plural.
- Every list field takes `where` (per column `{eq, ne, lt, lte, gt, gte, in, isNull}`, combined with `_and` / `_or`), `orderBy: {field, direction}` and a REQUIRED `first`. A root field also takes `block`, to answer as of an earlier block: a `BlockAddress`, which is `@oneOf` `{number: SafeInt}` or `{hash: Bytes32}` (giving both or neither is `invalid-query`); its nested collections read as of the same one.

The query semantics (null, ordering, text as UTF-8 bytes, a `u256` numerically) are the accessor's, fixed by the seam, so they are the same on every backend. A declaration set whose generated type names collide (an entity `poolWhere` beside `pool`) is refused when the schema is built, naming both.

## One block per operation

An operation reads the tip when it begins and PINS that block: every field is read as of it, so a block applied while the resolvers run changes nothing it reads, and a parent and its children always come from one block. The answer names the pin in `extensions`, by number (`block`) and by hash (`blockHash`). Two things are read at the start and again at the end: the store's REVERT SEQUENCE (every revert increments it, in its own transaction) and the tip. If the store reverted, or a reorg took the tip BELOW the pin, the operation is run once more, and refused with `tip-moved-during-operation` if it happens again. The revert sequence is what catches a reorg away from the pinned block and back to it (A, then B, then A) during one operation, which leaves the tip and the hash exactly as they were; it is read BEFORE the pin and AFTER the last field, and that order is part of the guard. A `block` above the pin is refused (`block-not-yet-indexed`).

A number is a height, and a reorg can put another block at it, so an app composing several operations into one view pins each follow-up to the HASH the first answer named (`block: {hash: extensions.blockHash}`): it then reads the same block of the same chain, or is refused with `block-not-recorded`. That refusal never claims a reorg, because a store records only the blocks that carried a log it indexes (and nothing below a snapshot it started from), so an unrecorded hash may still be canonical.

The context carries the store's block reads and revert sequence as `blocks: {at, of, revertSequence}`, which a host copies off the store (`blockAt`, `blockOf` and `revertSequence` on the SQLite and IndexedDB stores, forwarded by `openForWriting`'s and `openSnapshotAware`'s handles; `graphqlQueryHandler` refuses a store without them). The member is REQUIRED, as `asOf` is, so every answer has one shape; `queryBlocksOf(store)` builds it from a store that has the reads. On a store that answers no as-of read (`asOf: false` in the context, which is required and copied from the store's `capabilities.asOf`), reads are at the tip and any move of the tip during the operation is retried once, then refused.

A host whose canonical pointer can move passes a FUNCTION as the context, answering one per operation, so a query cannot straddle a promotion.

## The executor contract

A `QueryExecutor` is `(request: {query, variables?, operationName?}) => Promise<QueryResult>`, and it never rejects. Every executor answers the same JSON: the same serialisation (`U256` as a decimal string, `Bytes` as hex), the same error codes through the one formatter (`formatQueryError`), and `extensions: {generation, block, blockHash}` on every answer. When the transport itself fails (an HTTP 500, a body that is not JSON, a network error, a closed port, a dead worker host), the executor normalises it to ONE shape, `transportFailure(reason, message, {status?})`: no `data`, no `extensions`, one error coded `transport-failure` naming the `reason`. `isTransportFailure(result)` tells one apart from an answer.

`localExecutor` is the in-process executor. `httpExecutor(url, {fetch?, headers?})` is the HTTP one, for a remote indexer's `/graphql` (`etherfold serve`, `run` and `node` serve it): it `POST`s the request as JSON and hands the answer back exactly as the server wrote it, and normalises a non-`2xx` (`http-status`, with `status`), a body that is not a GraphQL result (`invalid-body`) and a network error (`network`) to the one shape. The worker executor, `workerExecutor(port)`, implements the same contract over a port to a browser host (below).

`executorToFetch(executor)` turns ANY executor into a `fetch`, for a client library that only takes one (urql's `fetch`, Apollo's `HttpLink`, graphql-request):

```ts
const fetch = executorToFetch(httpExecutor('https://indexer.example/graphql')); // or the worker executor
const client = new Client({url: '/graphql', fetch, exchanges: [fetchExchange]}); // urql
```

It reads a `POST` with a JSON body or a `GET` with query parameters, and answers the executor's result as a `200` whatever it is, a transport failure included, so the client reads it as errors rather than discarding the body as a network error. A request it cannot read as GraphQL is answered `400` with one `invalid-query` error.

## In a browser worker

The resolvers need the store and the store is in the worker, so the schema and the `graphql` runtime live in the HOST: the app's worker entry passes `graphqlQueryHandler()` as the host's `query` handler, and the tab holds `workerExecutor(port)`. Both are on the `@etherfold/graphql/worker` subpath, the only part of this package that knows `@etherfold/browser` (for its types), so the root entry stays runtime-neutral and a server importing it pulls in no browser package.

```ts
// indexer.worker.ts (or hostIndexerInThisSharedWorker, or createIndexerState(...).mainThreadHost({query}))
import {hostIndexerInThisWorker} from '@etherfold/browser';
import {graphqlQueryHandler} from '@etherfold/graphql/worker';
hostIndexerInThisWorker({createState, createProcessor, query: graphqlQueryHandler()});

// the tab
import {connectToIndexerHost, dedicatedWorkerHost} from '@etherfold/browser';
import {workerExecutor} from '@etherfold/graphql/worker';
const execute = workerExecutor(connectToIndexerHost(dedicatedWorkerHost(() => new Worker(url, {type: 'module'}))));
```

The handler answers every operation from the store the host's canonical generation folds into (the IndexedDB accessor, with `graphqlQueryHandler({accessor: {rowsExaminedBound}})` to set its bound), reports that generation, and caches parsed and validated documents (`DocumentCache`, 100 per schema by default), so a repeated document is not parsed again. A READER tab under the tab election answers the same way from the shared store it opened for reading, naming the generation its leader named. A closed port is the transport failure `port-closed`, a host that died is `host-gone`, and a host whose entry passed no handler refuses the query (`invalid-body`).

**It is opt-in, and it costs 48.3 KiB gzipped.** `@etherfold/browser` carries a generic query case and never imports GraphQL, so a worker entry that passes no handler bundles no `graphql` at all (asserted). Passing it adds 191.0 KiB minified, **48.3 KiB gzipped** to the worker bundle (51.8 to 100.2 KiB gzipped for a bare worker entry; measured with esbuild, `docs/spikes/a-worker-host-answers-graphql-over-its-port/`). It is off the first-paint path, since it is in the worker; an app reading a few entities by id is served by the generated read surface (`createPortReadSurface`) for nothing. The TAB pays next to nothing: `workerExecutor` is a module of its own that imports only the executor contract, and the package declares `"sideEffects": false`, so a tab importing it bundles no `graphql` (asserted); measured on `examples/browser-reference` with `vite build`, the tab chunk is 172.0 kB, **63.7 kB gzipped**, against 63.2 kB gzipped before it imported the executor.

## Error codes

`QUERY_ERROR_CODES`, in `extensions.code`:

| code | when |
| --- | --- |
| `invalid-query` | the document does not parse or validate, a variable is of the wrong type, or an argument cannot mean anything (`first` below 1, `null` where a filter was expected) |
| `block-not-retained` | a `block` the store does not retain (the seam's `BlockNotRetainedError`), carrying `requested` |
| `block-not-recorded` | a `block: {hash}` the store has no record of (reorged out, a block that carried no log it records, or below its snapshot), carrying `requested` |
| `block-not-yet-indexed` | a `block` above the operation's pin, carrying `requested` and `pinned` |
| `rows-examined-bound` | the accessor's own refusal past its rows-examined bound (IndexedDB), carrying `entity` and `bound` |
| `tip-moved-during-operation` | a reorg under the operation (the store reverted, or on a store with no as-of reads the tip moved), twice, carrying `started` and `ended` |
| `internal-error` | anything unexpected; the message is masked |
| `transport-failure` | the transport failed, carrying `reason` (and `status` for HTTP) |

## The query conformance suite

"The same query answers the same" is checked, not asserted: `@etherfold/graphql/conformance` is a suite every executor must pass, parameterised by an executor factory exactly as `@etherfold/state-store-conformance` is by a store factory. It is on its own subpath because it imports vitest; the root entry never reaches it.

```ts
import {describeQueryConformance} from '@etherfold/graphql/conformance';

await describeQueryConformance('the in-process executor over IndexedDB', (declarations) => {
	const store = new IndexedDBStateStore(declarations, {databaseName});
	const executor = localExecutor(buildQuerySchema(declarations), {accessor: store.accessor({rowsExaminedBound: 60}), generation, tip, asOf: store.capabilities.asOf});
	return {store, executor, generation};
}, {rowsExaminedBound: 60});
```

The factory hands over a store (the suite WRITES blocks through it, and reverts them) and an executor answering from the same storage, and names the generation it reports. The suite then asks one shared list of requests (`QUERY_PARITY_CASES`: nested relations bounded per parent, enums, `u256` ordering and filtering, every scalar and every null, as-of queries, a reorg, an empty store, and every error code the query layer raises) and requires the expected answer BYTE FOR BYTE, compared as the JSON text, key order included, since that is what crosses a transport. As-of and retention cases are selected against what the store's capabilities CLAIM: the retention refusal (`block-not-retained`) has one code and one message on every executor.

The rows-examined bound is a documented difference between deployments, not a parity rule (ADR-0099), so it is asserted PER EXECUTOR from what the deployment declares (`{rowsExaminedBound}`): declaring a bound, the three queries a bounded IndexedDB accessor cannot serve (a scan past it, one parent's children past it, an as-of query whose delta of churn since its block is past it) are refused with `rows-examined-bound`, naming the entity and the bound; declaring none (SQLite), the same three are answered at a size past the browser's default bound. An executor with a transport declares how to break it (`{transportFailures: {reason: breakIt}}`) and is held to the one transport-failure shape for each. `runQueryConformance` runs the cases without a test runner, so a deliberately wrong executor can be checked to fail.

This package runs it against the in-process executor over SQLite and over IndexedDB, once per retention claim each, and against `httpExecutor` over the `fetch` shim (the round trip through JSON text, and each transport failure). `@etherfold/server` runs it against `/graphql` once per retention claim, and `etherfold` against a real `etherfold serve`.

## Testing with vitest

`graphql` 16 ships CommonJS and ESM builds with no `exports` map, so under vitest Pothos (loaded by Node, as CommonJS) and your source (transformed by vite, as ESM) can load two instances, and graphql-js refuses a schema built by one inside the other. Inline Pothos (`test.server.deps.inline: [/@pothos\/core/]`), as this package's own `vitest.config.ts` does. Node alone and every bundler resolve one instance and are unaffected.
