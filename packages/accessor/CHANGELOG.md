# @etherfold/accessor

## 0.1.0

### Minor Changes

- f680567: New package `@etherfold/accessor`: the accessor seam the query layer reads through (ADR-0099), beside `StateStore` and never part of it. `Accessor.find` answers the rows of an entity matching a predicate over its declared id columns and fields (`eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `isNull`, combined with `and` / `or`), ordered by one of them, bounded by a required limit, at the tip or as of a block height, as `{rows, truncated}`; `Accessor.children` answers a page of parents' children through a declared relation in one call, bounded per parent. The semantics are the seam's: a comparison with null is false, nulls first ascending and last descending, text as UTF-8 bytes, a `u256` numerically, ties by the declared id ascending. `planFind` / `planChildren` are the one planner every backend calls (an undeclared field or an operand of the wrong kind is refused there), `answeredRow` the one read-side conversion, and `RowsExaminedBoundError` (code `rows-examined-bound`) the refusal a bounded backend raises past its rows-examined bound. The conformance suite is the `@etherfold/accessor/conformance` subpath (`describeAccessorConformance`, `runAccessorConformance`), parameterised by a factory handing over a store and an accessor over it, with an optional declared `rowsExaminedBound`. `@etherfold/state-store-sqlite`: `VersionedStateStore.accessor()` implements it by generating SQL (a page of parents is one `IN` query with a per-parent `ROW_NUMBER()` window, split only when it would exceed `bounds.maxRowsPerStatement` parameters), declares no rows-examined bound, and refuses an as-of query outside retention with `BlockNotRetainedError`. `queryCurrent` / `queryAsOf` are unchanged.

### Patch Changes

- a3e2b38: The IndexedDB accessor, rung 1 (ADR-0099): `IndexedDBStateStore.accessor({rowsExaminedBound?})` implements `@etherfold/accessor`'s seam by scanning the entity's key range and filtering and sorting in memory in the seam's order (text as UTF-8 bytes, not IndexedDB's UTF-16 key order; a `u256` numerically; nulls first ascending; ties by the id), so it answers what the SQLite accessor answers for every query within the bound. Past the rows-examined bound (default 25,000, the new `DEFAULT_ROWS_EXAMINED_BOUND`, configurable per deployment and reported as `accessor.rowsExaminedBound`) it refuses with `RowsExaminedBoundError`. As of a block it reads the current rows plus the versions closed since (the `upper` index), under the same bound; that delta counts the changes to every entity in the database, so an as-of query on a quiet entity can be refused because others changed, and the refusal says so. A relation page is one bounded key-range scan per parent. New exports: `indexedDBAccessor`, `IndexedDBAccessor`, `IndexedDBAccessorOptions`, `IndexedDBAccessorContext`, `DEFAULT_ROWS_EXAMINED_BOUND`. The accessor suite runs under `fake-indexeddb` and in Chromium, Firefox and WebKit. `@etherfold/accessor`'s README names the IndexedDB implementation.
- Updated dependencies [7d381b1]
- Updated dependencies [f432ff9]
- Updated dependencies [4350448]
- Updated dependencies [71eee1c]
- Updated dependencies [c2a6e02]
- Updated dependencies [5fad61f]
- Updated dependencies [75e98a5]
- Updated dependencies [57edeaa]
- Updated dependencies [6ec0244]
- Updated dependencies [577c0df]
  - @etherfold/state-store@0.4.0
