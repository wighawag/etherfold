---
title: 'A worker host answers GraphQL over its port, for writer and reader tabs alike'
slug: a-worker-host-answers-graphql-over-its-port
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy: [a-server-answers-graphql-over-http]
covers: [2, 13, 14, 19, 25]
---

## What to build

A worker host (dedicated and SharedWorker, and the main-thread host through the same port surface) answers GraphQL: the schema and the `graphql` runtime live in the worker, built from the host's declarations over the IndexedDB accessor, and `workerExecutor(port)` in the tab sends documents over the host port (a new port case). Parsed and validated documents are cached in the worker. A READER tab under tab election (ADR-0097) answers queries from the shared store the same way. The worker executor joins the query conformance suite. Measure and record the gzipped cost the GraphQL runtime adds to a worker bundle, and state it in the package README, since an app decides from it whether to take GraphQL or stay on the read surface. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

## Acceptance criteria

- [ ] `workerExecutor` against a dedicated-worker host and a SharedWorker host passes the query conformance suite byte for byte; a reader tab under tab election answers the same queries.
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
