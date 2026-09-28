---
'@etherfold/state-store': minor
'@etherfold/state-store-conformance': minor
'@etherfold/state-store-sqlite': patch
'@etherfold/platform-nodejs': patch
'@etherfold/state-store-patch': patch
'@etherfold/state-store-indexeddb': patch
'@etherfold/graphql': patch
'etherfold': patch
---

Three small fixes from the query-layer drive. `normalizeEntities` now also refuses a relation whose `as` is `queryCurrent` or `queryAsOf`, the two reads `createQuerySurface` adds beside a parent's collections, which would otherwise have silently overwritten that collection on the SQLite query surface; `@etherfold/state-store-conformance` asserts both refusals in `a declared relation is checked against the ids`. `QuerySurface` (`@etherfold/state-store-sqlite`) now types a parent's relation collections (`CollectionsOf`), so `surface.<parent>.<as>` needs no cast on the server-side tier either. `startServer` (`@etherfold/platform-nodejs`) waits for the socket to listen before reading its address, so with a `hostname` it reports the port it actually bound rather than `0`, and a bind that fails (for example `EADDRINUSE`) rejects the call; `etherfold serve --host 127.0.0.1 --port 0` therefore prints a usable URL. Every import guard that lists a package's imports (in `@etherfold/state-store-sqlite`, `@etherfold/state-store-patch`, `@etherfold/state-store-indexeddb` and `@etherfold/graphql`) now uses one matcher that crosses newlines and also catches `export ... from`, with a fixture case proving it; `etherfold` gains a test for the `serve` line. Both are test-only changes.
