---
title: 'A server answers GraphQL over HTTP, and a client can use it through a fetch'
slug: a-server-answers-graphql-over-http
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy: [the-same-query-answers-the-same-on-both-backends]
covers: [2, 3, 4, 9]
---

## What to build

`@etherfold/server` serves the schema over HTTP (Hono, which it already uses, with GraphQL Yoga, as the research decided) from the served database's canonical generation through the SQLite accessor, sharing the schema module's error formatter so Yoga's own masking does not diverge from the in-process executor. `etherfold serve` (and the other serving commands, where they serve reads) exposes it at `/graphql` (ADR-0099). `httpExecutor(url)` in `@etherfold/graphql` talks to it and normalises transport failures (a non-2xx, a non-JSON body, a network error) to the transport-failure shape the executor contract defines (`a-graphql-schema-is-built-from-the-declarations`); `executorToFetch(executor)` turns any executor into a `fetch` for client libraries that take one. The HTTP executor joins the query conformance suite as a third executor. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

> FORWARD-POINTER (planted by the conductor, 2026-09-28): the host builds a `QueryContext` for `executeQuery`, which needs `tip()` (the block every operation pins, `a-graphql-schema-is-built-from-the-declarations`) and `asOf`. `asOf` currently defaults to `true` (`context.asOf ?? true` in `packages/graphql/src/execute.ts`), so a host over a `revert-only` store that omits it refuses every query with `BlockNotRetainedError` (`work/notes/observations/query-context-asof-defaults-true-on-a-revert-only-store.md`). Derive `asOf` from the store's `capabilities.asOf` when building the context (or make `executeQuery` derive the default from the store and drop the footgun for every host), and cover a revert-only served database.

## Acceptance criteria

- [ ] `etherfold serve` answers GraphQL over HTTP, and `httpExecutor` against it passes the query conformance suite byte for byte.
- [ ] Transport failures normalise to the defined shape (tested for a 500, a non-JSON body and a network error).
- [ ] `executorToFetch` lets a fetch-taking client (asserted with a minimal client) run a query; changesets for every published package changed.

## Blocked by

- `the-same-query-answers-the-same-on-both-backends`

## Prompt

> Goal: GraphQL over HTTP on the server, plus `httpExecutor` and `executorToFetch` (ADR-0099). Look at `@etherfold/server` (its Hono app), `createQuerySurface` in `@etherfold/state-store-sqlite`, the `serve` command in the CLI, the schema module and the query conformance suite.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **Yoga speaks HTTP only; `executeQuery` answers every request.** A Yoga plugin hands each request to `executeQuery` and sets its result, so the pin, the reorg guard, the formatter and the codes are exactly the in-process executor's. Errors Yoga raises itself (body not JSON, no `query`) are reformatted by `formatQueryError` as `invalid-query`, keeping Yoga's 4xx status. Anything else is masked as `internal-error`. Yoga is never given our schema, because it refuses a schema built by another copy of graphql-js. GraphiQL, the landing page, batching and Yoga's own CORS are off (the app's CORS applies). Alternatives: Yoga running the query itself (a second pipeline that drifts), or no Yoga at all (the task names it). Touches the worker task, which shares `executeQuery`.
- **Every GraphQL answer is HTTP 200.** A client sends `accept: application/json`. `httpExecutor` treats any non-2xx as a transport failure, as the task says. Touches any future client.
- **Refusals before GraphQL are plain HTTP statuses, not GraphQL codes.** `501 graphql-not-configured` when the host passed no `graphql` option. `501 several-named-indexers` when the database holds more than one named indexer. `503 no-canonical-generation` (following ADR-0058) and `503 no-declarations`. A client sees these as `http-status`. Alternative: new `QUERY_ERROR_CODES`, which would change the shared code set.
- **New `ServerOptions.graphql` (`GraphQLServing`: `declarationsOf({id, indexer, db}, c)`, `retention?`, `finalityDepth?`).** The route resolves the generation from `getDB`'s rows; the host only supplies what the rows cannot (the declarations) plus the writer's retention. When absent the route answers 501, not 404, which is the house rule for a missing capability. The schema and store are cached per database handle and per canonical generation, and a failure is not cached. It mirrors `producePublication`'s `declarationsOf`.
- **`index` does not serve `/graphql`.** Its README says it "exposes the write path and NOT the query API, and that asymmetry is the point", and `indexCommand.test.ts` asserted exactly that. So `serve`, `run` and `node` get it, and `index` answers `501 graphql-not-configured`. I changed that test from expecting 404 to expecting 501 for `/graphql`. Reverse by passing `graphqlServing(...)` in `indexCommand.ts`.
- **The query surface claims the writer's retention.** `run` and `node` pass `--retention` and the stream finality. `serve` is told none and claims `unbounded`, like `publish`. The recorded-prune-floor gap this leaves is the observation above.
- **`QueryContext.asOf` is now required** (it defaulted to `true`). This follows the task's forward-pointer and drops the footgun for every host, not just this one. It is a breaking change and is noted in the changeset. Touches `a-worker-host-answers-graphql-over-its-port`, whose context must now pass `asOf`.
- **`executorToFetch` answers 200 with whatever the executor returned, including a transport failure.** A client library then reads it as errors instead of discarding the body as a network error. A request it cannot read as GraphQL gets `400` with one `invalid-query` error and never reaches the executor.
- **`declarationsOfStoredBundle` is a shared CLI helper**, used by `publish` and by `/graphql`, so both read a generation's declarations the same way.
- **Test-only config:** the server and CLI `vitest.config.ts` inline `@pothos/core`, as `@etherfold/graphql` already does, to avoid two graphql-js copies in vitest. Plain Node loads one copy; I checked that with a smoke run.
