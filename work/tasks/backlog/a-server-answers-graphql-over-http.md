---
title: 'A server answers GraphQL over HTTP, and a client can use it through a fetch'
slug: a-server-answers-graphql-over-http
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy: [the-same-query-answers-the-same-on-both-backends]
covers: [2, 3, 4, 9]
---

## What to build

`@etherfold/server` serves the schema over HTTP (Hono, which it already uses, with GraphQL Yoga, as the research decided) from the served database's canonical generation through the SQLite accessor, sharing the schema module's error formatter so Yoga's own masking does not diverge from the in-process executor. `etherfold serve` (and the other serving commands, where they serve reads) exposes it at `/graphql` (ADR-0099). `httpExecutor(url)` in `@etherfold/graphql` talks to it and normalises transport failures (a non-2xx, a non-JSON body, a network error) to the transport-failure shape the executor contract defines (`a-graphql-schema-is-built-from-the-declarations`); `executorToFetch(executor)` turns any executor into a `fetch` for client libraries that take one. The HTTP executor joins the query conformance suite as a third executor. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

## Acceptance criteria

- [ ] `etherfold serve` answers GraphQL over HTTP, and `httpExecutor` against it passes the query conformance suite byte for byte.
- [ ] Transport failures normalise to the defined shape (tested for a 500, a non-JSON body and a network error).
- [ ] `executorToFetch` lets a fetch-taking client (asserted with a minimal client) run a query; changesets for every published package changed.

## Blocked by

- `the-same-query-answers-the-same-on-both-backends`

## Prompt

> Goal: GraphQL over HTTP on the server, plus `httpExecutor` and `executorToFetch` (ADR-0099). Look at `@etherfold/server` (its Hono app, `createQuerySurface`), the `serve` command in the CLI, the schema module and the query conformance suite.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
