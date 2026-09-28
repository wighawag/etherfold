# @etherfold/accessor

The **accessor seam** (ADR-0099): the one interface the query layer's resolvers call, and each backend implements. It sits BESIDE the state-store seam and is never a member of it: a handler runs once per event on a substrate with no query planner, so `StateStore` offers no predicate (ADR-0021), while a resolver runs once per request above the store and needs one.

```ts
import type {Accessor} from '@etherfold/accessor';

const page = await accessor.find({
	entity: 'pool',
	where: {and: [{field: 'kind', op: 'eq', value: 'open'}, {field: 'amount', op: 'gt', value: 10n ** 18n}]},
	orderBy: {field: 'amount', direction: 'desc'},
	limit: 20,
	at: 1234, // optional: a block height; absent reads the tip
});
page.rows; // the declared columns, a u256 as a bigint
page.truncated; // whether more rows matched than the limit

// a PAGE of parents' children through a declared relation, in one call, bounded per parent
const pages = await accessor.children({entity: 'arrival', relation: 'moves', parents: [{window: 'w', ordinal: '1'}], limit: 10});
```

## What a query means, on every backend

The same GraphQL document runs against a server and a browser worker, so the semantics are fixed by the seam and not left to an engine:

- **Operators**: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `isNull` (`value: true` is IS NULL, `false` IS NOT NULL), combined with `and` and `or`. An empty `and` matches everything, an empty `or` nothing. There is no `not`.
- **Null**: a comparison with null is false, as in SQL, both ways: a null field matches no comparison and a null operand matches no row. `isNull` is the one operator that sees a null.
- **Order**: by one id column or declared field, `asc` by default; nulls FIRST ascending and LAST descending. Ties, and every row when no order is asked for, come in ascending order of the declared id, so a limit cuts the same rows everywhere.
- **Text** compares as UTF-8 bytes (SQLite's BINARY collation), not JavaScript's UTF-16 order. A **`u256`** (ADR-0098) compares numerically, past 2^64 included. A plain **`blob`** compares bytewise. **`integer`** and **`real`** compare as numbers.
- **Limit** is required, a whole number at least 1, and per PARENT for `children`, so one prolific parent cannot starve the others.
- **As of a block**, outside the store's retention, is refused with the seam's `BlockNotRetainedError`, never answered from the tip.

Every backend runs a query through the same planner (`planFind`, `planChildren`) before executing it: each field is checked against the declaration, each operand is turned into the form the column STORES (a `u256` into its 32 big-endian bytes, an id given as a number into its text), and every comparison with null is folded to "matches nothing". An undeclared field, or an operand of the wrong kind for its field (a string for an integer, a number for a `u256`), is refused there, so the refusal is one sentence on every backend. `answeredRow` is the matching read-side conversion.

## The rows-examined bound

A backend without a query planner (IndexedDB) answers by scanning, and REFUSES past a declared number of rows examined rather than answering slower as data grows: `RowsExaminedBoundError`, with `code` `rows-examined-bound`, the `entity` and the `bound`. Rows examined rather than elapsed time, because a deterministic bound refuses identically on a phone and a laptop. The bound is a backend's own and a documented difference between deployments, not a parity rule: SQLite plans, declares no bound, and answers.

## Implementations

- `@etherfold/state-store-sqlite`: `VersionedStateStore.accessor()`, generated SQL; a page of parents is one `IN` query with a per-parent window.
- `@etherfold/state-store-indexeddb`: `IndexedDBStateStore.accessor({rowsExaminedBound?})`, rung 1: a key-range scan filtered and sorted in memory, refused past 25,000 rows examined by default; as of a block, current plus the delta of versions closed since (which counts every entity's changes). An index (rung 2) is to come.

## The conformance suite

On its own subpath, so the seam never pulls vitest into a bundle:

```ts
import {describeAccessorConformance} from '@etherfold/accessor/conformance';

await describeAccessorConformance('my accessor', (declarations) => {
	const store = new MyStore(declarations);
	return {store, accessor: store.accessor()};
});

// a bounded backend declares its bound, and is held to it
await describeAccessorConformance('my bounded accessor', factory, {rowsExaminedBound: 50});
```

The factory hands over a store (the suite WRITES through it, as a fold would) and an accessor over the same storage (the suite reads through it). As with `@etherfold/state-store-conformance`, the as-of cases are selected against what the store's capabilities CLAIM, and `runAccessorConformance` runs the cases without a test runner so a deliberately broken accessor can be checked to fail the case it breaks. A backend declaring no bound is asked to answer a query examining more rows than the browser's default bound; one declaring a bound is asked to answer at it and refuse past it.
