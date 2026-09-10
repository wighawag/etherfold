---
title: 'Two tabs contending for one height leave one winner and no torn state'
slug: two-tabs-contending-for-one-height-leave-one-winner
spec: a-second-writer-writes-nothing
blockedBy: [every-mutating-path-carries-a-writer-token, a-refused-writer-demotes-itself-to-a-reader]
covers: [14, 15]
---

## What to build

The existing four-tab browser case proves the substrate tolerates four concurrent connections and says itself that it is not testing contention: "Each tab owns its own block heights (a block is applied once, by definition), writes its own rows". That is the claim ADR-0024 needs from it and it was never evidence that two indexers can share a database.

Add the case it deliberately avoids: several tabs contending for the SAME heights against one database. Exactly one wins each height, the losers are refused by name, and a fifth connection auditing afterwards finds no torn state.

This is where the writer token stops being an assertion and becomes an observation.

## Acceptance criteria

- [ ] Several tabs of one app contend for the same heights against one database, and exactly one write per height lands.
- [ ] Every loser is refused with `StoreWriterChangedError` specifically, rather than failing in some other way or silently doing nothing.
- [ ] An independent connection afterwards finds a coherent store: no half-applied block, no row from a refused writer, no cursor behind its data.
- [ ] The case runs on Chromium, Firefox and WebKit, and its output is written to `docs/spikes/indexeddb-row-backend-browser-default/results/`, which is where `packages/state-store-indexeddb/playwright.config.ts` already sends browser results.
- [ ] It is NOT added to the acceptance gate, on the same reasoning as the existing browser run: it needs three browser binaries a clean checkout does not have. State that where the results are kept.
- [ ] The recorded result includes the observation that removing the guard turns the case red. This is a manual experiment, not a gate check, because `pnpm test` is vitest only and the browser run is `test:browser`; record it rather than claiming it.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

`every-mutating-path-carries-a-writer-token`, because there is nothing to observe until the guard exists, and `a-refused-writer-demotes-itself-to-a-reader`, because this case asserts the refusal BY NAME and that name is created there.

## Prompt

Read `packages/state-store-indexeddb/browser/multi-tab.spec.ts` first: it is the harness you extend and its own comment explains exactly what it does not cover. Then `packages/state-store-indexeddb/playwright.config.ts` for why the browser run sits outside the gate and where it writes results, and `work/specs/tasked/a-second-writer-writes-nothing.md`.

Domain vocabulary: IndexedDB `readwrite` transactions SERIALISE across tabs, which is the primitive the guard rests on (recorded in ADR-0054's opening line). The **storage identity** the token is scoped to is the `databaseName` here, so tabs that contend must share one.

`fake-indexeddb` cannot demonstrate cross-tab serialisation at all, so this case only counts in the real-engine run. Say so where the results are kept, rather than leaving a reader to assume the node suite covers it.

Done means the contention case exists, is green on three engines, and the results record what happens without the guard.

## Decisions

- **The tabs CLAIM at a barrier before the height race, in a case of their own (`contention-claim`), and the claim is a `writeCursor` under a per-tab key.** Why: a handle that has never written claims UNCONDITIONALLY on its first mutation (`store.ts`), so tabs racing straight from unclaimed handles are refused for offering a **height already recorded** — the duplicate-height caller bug, which means the opposite thing — and the acceptance criterion "every loser is refused with `StoreWriterChangedError` specifically" would be unreachable by construction. `writeCursor` is the shortest mutation that claims and can be refused for no other reason (no block precondition), so every tab's claim commits and the last committer holds the store. Alternatives considered: (a) race unclaimed and accept a mix of refusal kinds — rejected, it fails the criterion and re-tests what the four-tab case already counts; (b) let tabs claim mid-race so the store changes hands, with the new holder re-reading the tip and continuing — rejected because the handover would have to be scheduled by a timer, and this spec family is explicit that the cases must not depend on timing (spec story 13, and `two-writers.test.ts`: "nothing below uses a timer"). **Consequence to be aware of**: the winner is therefore the last claimer, so one tab lands every height and the other three are refused every height. The contention is real (all four offer each height concurrently and the engine serialises them) but the winner does not change hands mid-run. **Touches**: nothing outside this spec file and `cut.ts`; no production code, no flag, no default.
- **Refusals are counted BY ERROR NAME (`refusedBy`) rather than as one `refused` total**, unlike the neighbouring four-tab case which folds two legitimate refusal kinds into one number. This case is the one that asserts the name, so a refusal wearing another name must be visible rather than absorbed; anything not `StoreWriterChangedError` goes to `unexpected` and fails the test. Recognition is `instanceof` with `error.name` as the fallback, matching how `@etherfold/browser` recognises the same refusal (a bundled app can hold two copies of `@etherfold/state-store`). **Touches**: the results schema for `contention-<engine>.json` only; `multi-tab-<engine>.json` keeps its existing shape.
- **The test parses the cursor value it wrote (`<height>:<tab>`).** ADR-0027 keeps the STORE ignorant of what a cursor string means; the test is the caller that wrote it, so reading it back is the caller's business and is what makes "no cursor behind its data" checkable. Stated at the assertion so nobody reads it as the store gaining an opinion about cursor contents. **Touches**: nothing else.
- **A module-level handle (`contender`) in `cut.ts` carries the claim between the two `run` calls.** A claim belongs to a HANDLE and is never re-minted, so the tab must race through the object it claimed with; module state survives because both runs are `page.evaluate` into one loaded page, and a reload correctly clears it. **Touches**: `cut.ts` only, and only the contention cases — no other case keeps state between runs.
