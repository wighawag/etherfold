---
title: 'Two tabs contending for one height leave one winner and no torn state'
slug: two-tabs-contending-for-one-height-leave-one-winner
spec: a-second-writer-writes-nothing
blockedBy: [every-mutating-path-carries-a-writer-token]
covers: [1, 2, 14, 15]
---

## What to build

The existing four-tab browser case proves the substrate tolerates four concurrent connections, and says itself that it is not testing contention: "Each tab owns its own block heights (a block is applied once, by definition), writes its own rows". That is the claim ADR-0024 needs from it and it was never evidence that two indexers can share a database.

Add the case it deliberately avoids: several tabs contending for the SAME block heights against one database. Exactly one wins each height, the losers are refused by name, and a fifth connection auditing afterwards finds no torn state.

This is where the writer token stops being an assertion and becomes an observation.

## Acceptance criteria

- Several tabs of one app contend for the same heights against one database, and exactly one write per height lands.
- Every loser is refused with the writer-changed refusal, by name, rather than failing in some other way or silently doing nothing.
- An independent connection afterwards finds a coherent store: no half-applied block, no row from a refused writer, no cursor behind its data.
- The case runs on Chromium, Firefox and WebKit, and its output is recorded beside the existing browser results.
- It is NOT added to the acceptance gate, on the same reasoning as the existing browser run: it needs three browser binaries a clean checkout does not have.
- Removing the guard turns this case red.
- A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is part of the acceptance gate, so a missing changeset is a red gate for a reason unrelated to the work.

## Blocked by

`every-mutating-path-carries-a-writer-token`: there is nothing to observe until the guard exists.

## Prompt

Read `packages/state-store-indexeddb/browser/multi-tab.spec.ts` first: it is the harness you are extending and its own comment explains precisely what it does not cover. Then `packages/state-store-indexeddb/playwright.config.ts` for why the browser run sits outside the gate, and `work/specs/tasked/a-second-writer-writes-nothing.md`.

Domain vocabulary: IndexedDB `readwrite` transactions SERIALISE across tabs, which is the primitive the whole guard rests on (recorded in ADR-0054's opening line). The **storage identity** the token is scoped to is the `databaseName` here, so tabs contending must share one.

Note that `fake-indexeddb` cannot demonstrate cross-tab serialisation at all, so this case only counts in the real-engine run. Say so where the results are kept, rather than leaving a reader to assume the node suite covers it.

Done means the contention case exists, is green on three engines, and would be red without the guard.
