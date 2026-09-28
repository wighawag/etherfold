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
- Every list field takes `where` (per column `{eq, ne, lt, lte, gt, gte, in, isNull}`, combined with `_and` / `_or`), `orderBy: {field, direction}` and a REQUIRED `first`. A root field also takes `block`, to answer as of an earlier block; its nested collections read as of the same one.

The query semantics (null, ordering, text as UTF-8 bytes, a `u256` numerically) are the accessor's, fixed by the seam, so they are the same on every backend. A declaration set whose generated type names collide (an entity `poolWhere` beside `pool`) is refused when the schema is built, naming both.

## One block per operation

An operation reads the tip when it begins and PINS that block: every field is read as of it, so a block applied while the resolvers run changes nothing it reads, and a parent and its children always come from one block. The tip is read again at the end: if a reorg took it BELOW the pin the operation is run once more, and refused with `tip-moved-during-operation` if it happens again. A `block` above the pin is refused (`block-not-yet-indexed`). On a store that answers no as-of read (`asOf: false` in the context), reads are at the tip and any move of the tip during the operation is retried once, then refused.

A host whose canonical pointer can move passes a FUNCTION as the context, answering one per operation, so a query cannot straddle a promotion.

## The executor contract

A `QueryExecutor` is `(request: {query, variables?, operationName?}) => Promise<QueryResult>`, and it never rejects. Every executor answers the same JSON: the same serialisation (`U256` as a decimal string, `Bytes` as hex), the same error codes through the one formatter (`formatQueryError`), and `extensions: {generation, block}` on every answer. When the transport itself fails (an HTTP 500, a body that is not JSON, a network error, a closed port, a dead worker host), the executor normalises it to ONE shape, `transportFailure(reason, message, {status?})`: no `data`, no `extensions`, one error coded `transport-failure` naming the `reason`. `isTransportFailure(result)` tells one apart from an answer.

`localExecutor` is the in-process executor. The HTTP executor, the worker executor (on a `@etherfold/graphql/worker` subpath, so this root entry never imports a browser package) and the `fetch` shim implement the same contract.

## Error codes

`QUERY_ERROR_CODES`, in `extensions.code`:

| code | when |
| --- | --- |
| `invalid-query` | the document does not parse or validate, a variable is of the wrong type, or an argument cannot mean anything (`first` below 1, `null` where a filter was expected) |
| `block-not-retained` | a `block` the store does not retain (the seam's `BlockNotRetainedError`), carrying `requested` |
| `block-not-yet-indexed` | a `block` above the operation's pin, carrying `requested` and `pinned` |
| `rows-examined-bound` | the accessor's own refusal past its rows-examined bound (IndexedDB), carrying `entity` and `bound` |
| `tip-moved-during-operation` | a reorg under the operation, twice, carrying `started` and `ended` |
| `internal-error` | anything unexpected; the message is masked |
| `transport-failure` | the transport failed, carrying `reason` (and `status` for HTTP) |

## Testing with vitest

`graphql` 16 ships CommonJS and ESM builds with no `exports` map, so under vitest Pothos (loaded by Node, as CommonJS) and your source (transformed by vite, as ESM) can load two instances, and graphql-js refuses a schema built by one inside the other. Inline Pothos (`test.server.deps.inline: [/@pothos\/core/]`), as this package's own `vitest.config.ts` does. Node alone and every bundler resolve one instance and are unaffected.
