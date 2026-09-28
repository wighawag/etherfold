---
'@etherfold/graphql': patch
---

A tab that imports `workerExecutor` from `@etherfold/graphql/worker` no longer bundles the `graphql` runtime (ADR-0099: GraphQL is opt-in and off the tab). `workerExecutor` now lives in a module of its own that imports only the executor contract, still exported from `@etherfold/graphql/worker`, and the package declares `"sideEffects": false`, so a bundler drops the query handler's pipeline when the tab does not use it. Measured on `examples/browser-reference` with `vite build`, the tab chunk goes from 86.7 kB to 63.7 kB gzipped, and it contains no graphql-js.
