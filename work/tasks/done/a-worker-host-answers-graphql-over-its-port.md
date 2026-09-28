---
title: 'A worker host answers GraphQL over its port, for writer and reader tabs alike'
slug: a-worker-host-answers-graphql-over-its-port
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy: [a-server-answers-graphql-over-http]
covers: [2, 13, 14, 19, 25]
---

## What to build

A worker host (dedicated and SharedWorker, and the main-thread host through the same port surface) answers GraphQL: the schema and the `graphql` runtime live in the worker, built from the host's declarations over the IndexedDB accessor, and `workerExecutor(port)` in the tab sends documents over the host port. It stays OPT-IN in the worker bundle (ADR-0099): `@etherfold/browser` gains a GENERIC query case on the host port whose handler the app's worker entry injects (for example a `query` option on `hostIndexerInThisWorker`), and never imports GraphQL; `@etherfold/graphql` provides that handler and `workerExecutor` on a SUBPATH export (`@etherfold/graphql/worker`), the only part that imports `@etherfold/browser`, so the root entry stays runtime-neutral (the schema module's Node and browser builds) and `@etherfold/server` importing `@etherfold/graphql` pulls in no browser package. A worker bundle for an app that does not pass the handler contains no `graphql` (assert it). `workerExecutor` normalises a closed port or a dead host to the contract's transport-failure shape. Parsed and validated documents are cached in the worker. A READER tab under tab election (ADR-0097) answers queries from the shared store the same way. The worker executor joins the query conformance suite. Measure and record the gzipped cost the GraphQL runtime adds to a worker bundle, and state it in the package README, since an app decides from it whether to take GraphQL or stay on the read surface. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

> FORWARD-POINTER (planted by the conductor, 2026-09-28): the worker host builds a `QueryContext` for `executeQuery`, which needs `tip()` and `asOf`. `IndexedDBStateStore` keeps its tip read private: the query conformance test factories read the `blocks` object store directly through their own connection (`packages/graphql/test/executors.ts`), which a host must not copy; give the host a proper tip read. Derive `asOf` from the store's `capabilities.asOf` rather than relying on the `true` default (`work/notes/observations/query-context-asof-defaults-true-on-a-revert-only-store.md`), unless `a-server-answers-graphql-over-http` already moved that default into `executeQuery`.

## Acceptance criteria

- [ ] `workerExecutor` against a dedicated-worker host and a SharedWorker host passes the query conformance suite byte for byte; a reader tab under tab election answers the same queries.
- [ ] A closed port and a terminated worker host each yield the contract's transport-failure shape, asserted in the suite.
- [ ] A worker bundle built without the query handler contains no `graphql` module, and `@etherfold/graphql`'s root entry imports nothing from `@etherfold/browser`.
- [ ] Parsed documents are cached (asserted: a repeated document is not re-parsed).
- [ ] The bundle cost is measured and stated; changesets for every published package changed.

## Blocked by

- `a-server-answers-graphql-over-http`

## Prompt

> Goal: the worker executor over the host port (ADR-0099, ADR-0082, ADR-0097). Look at `packages/browser/src/host/` (`serve.ts`, `port.ts`, `cases.ts`, `envelope.ts`), `tabElection.ts`, the schema module and the query conformance suite.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **The handler reaches the store's query reads by feature detection.** The claimed handle forwards `accessor` and `tip` only when the store has them, the way it already forwards `applyBlocks`. `graphqlQueryHandler` checks for both and answers `internal-error` if either is missing. I chose this because ADR-0099 says the accessor must not become a member of `StateStore`, and the host only holds the claimed wrapper. The alternatives were adding the accessor to the seam (the ADR forbids it) or having the app supply an `accessorOf(store)` function (it cannot unwrap the claim). This touches `@etherfold/state-store`, and it leaves the snapshot-store gap in the observation above.
- **What a reader reports as its generation.** A reader has no container, so it reports the generation the leader last named on the state-moved notifications it relays. Until it has heard one, it uses the generation its own spec names (bundle identity or `processorIdentity`, over the stream it opened). If it can name neither, the handler answers `internal-error` rather than make one up. The alternative was adding a generation field to the leader's progress reports, which widens `HostProgress` and the election channel. This touches ADR-0097 readers in both `serve.ts` and `createIndexerState`.
- **How rejections map to transport-failure reasons.** `workerExecutor` maps `IndexerPortClosedError` to `port-closed` and `IndexerHostDiedError` to `host-gone`, matching on the error `name` so the executor needs only browser types, not browser code. Any other rejection (a host with no handler, for example) becomes `invalid-body`, meaning something answered and it was not a GraphQL result. The alternative was a new code or reason, which would change the shared contract set.
- **New `IndexerPortClosedError` class.** It replaces the plain `Error` the port used for a closed port, keeping the old messages so existing assertions pass. It exists so the executor can tell `port-closed` apart from `host-gone`, and it touches `@etherfold/browser`'s public exports.
- **The handler option is named `query`.** It sits on the hosted spec, `mainThreadHost({query})` and `serveHostCases`, and `HostBacking` gains `queryContext()`. The main-thread host takes it per wire (as a `mainThreadHost()` argument) rather than on `createIndexerState`, because the backing is shared across wires. The name follows the task's own example.
- **`@etherfold/browser` is an optional peer dependency of `@etherfold/graphql`.** This keeps the runtime dependency list unchanged (asserted), so `@etherfold/server` pulls in no browser package. The alternative, a real dependency, would install the browser package for servers.
- **Document cache details.** It is keyed per schema (validation depends on the schema), holds 100 documents per schema by default with least-recently-used eviction, and also caches documents that failed to parse. It lives in the root package and is used by `executeQuery` through an option, so any executor can use it, not only the worker one.
- **Conformance hosts run over a chain that answers nothing but `eth_chainId`.** The container opens and claims the store but never folds, so the suite's own writes are the only writes. The conformance test factories live in `packages/graphql/test/workerHosts.ts`, including a local copy of the fake SharedWorker scope from the browser tests.

## Requeue 2026-09-28

Gate-3 BLOCK on PR #250: CI's real-browser jobs (not run by dorfl's vitest gate) fail on all three engines because packages/browser/browser/sharedWorkerServesSeveralTabs.spec.ts has its own PORT_SURFACE list (line 116) missing the new 'query' verb. Add it there (and grep every browser/*.spec.ts and browser/*.ts for any other hard-coded port-surface list), run 'pnpm --filter @etherfold/browser test:browser --project=chromium' if a browser is available, and change nothing else.
