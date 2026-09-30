---
title: 'A reader tab of a module-arrival fold answers a query on a quiet chain'
slug: a-reader-of-a-module-fold-answers-a-query-on-a-quiet-chain
blockedBy: []
covers: []
---

## What to build

A READER tab in a tab election (ADR-0097) answers a GraphQL query with `internal-error` ("Unexpected error.") when its app runs its processor as a MODULE and the chain is quiet. `readerGenerationOf` (`@etherfold/browser`, `tabElection.ts`) names the generation a reader's answers belong to from the generation the leader last named on the state-moved signal, and otherwise from the reader's own bundle identity or `processorIdentity`. A module arrival has neither (its identity is derived only once a fold is BUILT, which a reader never does), so a reader that joined after the leader's last applied block refuses, by design, until the leader applies another one. `graphqlQueryHandler` then swallows the refusal's message into `internal-error`. The read surface is unaffected: it needs no generation name.

That is every reader tab of an app under `vite dev` (a module arrival) that opens after the chain went quiet, and a real chain can be quiet for a long time on a contract with little traffic. Reproduced in `examples/browser-reference` (a module processor, the fake chain fixed at its tip): the second tab's `holders()` answered `internal-error` until the leader was made to apply one more block (`verify/wallet.ts` `__mint`), which the test for `one-store-constructor-serves-the-tab-election` now does to get past it.

A reader should be able to name its leader's generation without waiting for a block: for example the leader publishing its canonical generation with its progress (which a reader already relays), or answering a reader that asks, as the server's `coherenceNow` tells a connecting remote client the position and the token at once. Which one is the builder's design question.

## Acceptance criteria

- [ ] A reader tab of a module-arrival app that opens after the leader's last applied block answers a GraphQL query with data, not `internal-error`, and names the leader's generation (a browser test, at least on chromium, without `__mint`).
- [ ] The answer names the leader's CURRENT canonical generation, so a later promotion is not answered under a stale name.
- [ ] Where a reader genuinely cannot name a generation, the query's error says so, rather than an opaque `internal-error`.
- [ ] Any ADR-0097 amendment is dated and in the same PR; changesets for every package changed (0.x: patch or minor).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a reader tab of a module-arrival fold answers GraphQL on a quiet chain, naming its leader's generation without waiting for the leader's next block. Look at `readerGenerationOf` and `queryContext` / `servedState` (`@etherfold/browser`, `tabElection.ts`, `host/serve.ts`, `IndexerState.ts`), what a leader publishes to its readers over the election's channel (ADR-0097, "A leader publishes; it is not polled"), `graphqlQueryHandler` (`@etherfold/graphql/worker`), and how the server tells a connecting client where it stands (`coherenceNow`, ADR-0083). The reproduction is `examples/browser-reference/verify/reference.spec.ts`, the second-tab test, with its `__mint` calls removed.
>
> FIRST, check this task against current reality (written 2026-09-30 against `@etherfold/browser@0.12.0`). If a reader already names its leader's generation on a quiet chain, route to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles. The real-browser suites run in CI's browser jobs; they must be green.
