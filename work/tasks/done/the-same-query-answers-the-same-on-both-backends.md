---
title: 'The same query answers byte for byte the same on a SQLite and an IndexedDB executor'
slug: the-same-query-answers-the-same-on-both-backends
spec: the-same-query-runs-against-a-worker-and-a-server
blockedBy: [an-accessor-scans-indexeddb-within-a-bound, a-graphql-schema-is-built-from-the-declarations]
covers: [1, 5, 6, 7, 8, 12, 22, 23]
---

## What to build

A query conformance suite in `@etherfold/graphql`, parameterised by an executor factory, exactly parallel to `@etherfold/state-store-conformance`: one list of `{query, variables, expected}` cases run against an executor over a SQLite-backed accessor and one over an IndexedDB-backed accessor, asserting identical rows and identical SERIALISATION (the four parity rules of ADR-0099: `bigint`/`u256`, error codes, transport-failure shape, `extensions.generation`). `BlockNotRetainedError` is asserted with the same code on both. Every capability the browser cannot serve, and the rows-examined bound, are asserted PER EXECUTOR: the IndexedDB-backed executor refuses with the accessor's code, the SQLite-backed one answers (ADR-0099: a documented difference between deployments, not a parity rule). This task also delivers story 12 of the spec `a-declaration-a-schema-can-be-built-from` (the same nested query works in the browser and against a server). Include nested relations, enums, `u256` ordering and an as-of query. Do NOT remove ADR-0099's `accepted, not yet implemented` line: `an-indexeddb-index-serves-the-accessor` lands last and removes it.

## Acceptance criteria

- [ ] The suite passes against both executors with byte-identical results for every case, including nested relations, enums, `u256` and as-of.
- [ ] The retention refusal is asserted with the same code on both; the bound and every browser-only refusal are asserted per executor (IndexedDB refuses with the accessor's code, SQLite answers).
- [ ] Changesets for every published package changed.

## Blocked by

- `an-accessor-scans-indexeddb-within-a-bound`
- `a-graphql-schema-is-built-from-the-declarations`

## Prompt

> Goal: the query conformance suite (ADR-0099). Look at `@etherfold/state-store-conformance` for the parameterised shape, the schema module and `localExecutor`, and the two accessor implementations.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0098 and ADR-0099 and the spec `the-same-query-runs-against-a-worker-and-a-server` (in `work/specs/tasked/`), and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **The suite is published on a `./conformance` subpath of `@etherfold/graphql`, not kept test-only.** Why: the HTTP and worker executor tasks say their executors "join the query conformance suite", and `@etherfold/accessor/conformance` sets the pattern. The alternative was a test-only helper, which those tasks could not import. Touches: `a-server-answers-graphql-over-http` and `a-worker-host-answers-graphql-over-its-port`, which should call `describeQueryConformance`. Also `runtime-neutral.test.ts`, which now scans the conformance folder with its own allowed imports.
- **"Byte-identical" means the same JSON text, key order included.** Each case is written once as an expected JSON result, so every executor is held to the same bytes. The retention message is built with the seam's own `BlockNotRetainedError` and `retainedRange`, from what the store says it retains. That keeps the check exact without copying one backend's text. The alternative, comparing only codes on refusals, was too weak for "one formatter". Touches: any future executor must keep the key order of `executeQuery` and `formatQueryError`.
- **Rows-examined refusals are checked by their parts, not by message.** The suite checks the code, entity, bound, path, `data: null` and extensions. The message is IndexedDB's own text, and ADR-0099 says this is a per-deployment difference, not a parity rule.
- **The factory reports the generation (`QuerySubject.generation`); the suite does not choose it.** A server computes its own generation digest, so the suite cannot pick it. Touches: the HTTP and worker factories.
- **Transport failures are exercised through an optional `transportFailures` hook, one function per reason, that breaks the subject's transport.** This lets the worker task's "a closed port and a terminated host, asserted in the suite" plug in without a suite change. The two in-process executors declare none.
- **SQLite's no-bound claim is checked at 25,001 rows**, reusing the accessor suite's `UNBOUNDED_PROBE_ROWS`, for all three bounded query shapes. It costs about 1 to 2 seconds per case on in-memory libSQL. Running an IndexedDB executor as if it had no bound was too slow on `fake-indexeddb`, so that direction is not in the tests.
- **In the test factories, the IndexedDB tip is read straight from the store's `blocks` object store**, through a connection the test opens itself. The store keeps its tip read private. The alternative was to add a public tip method to `IndexedDBStateStore`, which is another package's API and belongs to the worker host task.
