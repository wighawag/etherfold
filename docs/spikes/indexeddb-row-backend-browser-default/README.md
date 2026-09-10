# indexeddb-row-backend-browser-default — the browser evidence

What `@etherfold/state-store-indexeddb` did in real browsers, kept so that ADR-0024 points at an OBSERVATION rather than at a claim.

This is not a spike and nothing here was re-measured: the numbers that decided IndexedDB over wasm SQLite are `work/notes/findings/sqlite-in-the-browser.md`, with raw output in `../sqlite-in-the-browser/results/`. What is kept here is the output of the shipped backend's own browser run.

## How it is produced

```bash
pnpm --filter @etherfold/state-store-indexeddb test:browser              # all three engines
pnpm --filter @etherfold/state-store-indexeddb test:browser --project=webkit
```

The specs are `packages/state-store-indexeddb/browser/`, on `playwright-browser-harness`: the store and the shared conformance suite are bundled into a real page, driven, and their structured results come back to node.

## What is in `results/`

| file | what it holds |
| --- | --- |
| `browser-<engine>.json` | one entry per case: the conformance run (per retention claim), the same-processor comparison, the listing's `IDBKeyRange` as the engine itself reported it, and persistence across a real reload. `env` records the user agent the run happened on |
| `multi-tab-<engine>.json` | four tabs against one database: what each tab wrote, what it read back, and the audit from a fifth connection |
| `contention-<engine>.json` | four tabs contending for the SAME heights: which tab landed each height, how every other tab was refused, and what an independent connection found afterwards |
| `playwright.json` | the run itself, from Playwright's own reporter |

The five cases, and why each is here rather than in the node suite:

- **conformance** — the SHARED suite (`@etherfold/state-store-conformance`), the same cases the SQL store and the patch store are held to, under all three retention claims this backend can make. The node run uses `fake-indexeddb`, which is the API without an engine; this is the engine.
- **processor** — the same `EntityProcessor` object, run in node against `MemoryStateStore` and in the tab against IndexedDB, compared row for row INCLUDING the version bounds, and through a reorg whose accumulated counter has to go back down (5 → 4 → 5).
- **access-path** — the listing's key range, read off the engine's own `IDBObjectStore.openCursor`: `bound(['placement','7'], ['placement','7',[]])`, four records walked out of 200 rows.
- **persistence** — write, RELOAD the page, read. A reload is the only honest cold start, and it is the thing no node test can show.
- **contention** — four tabs offering the SAME heights against one database, which is the race the multi-tab case avoids by construction (there every tab writes heights of its own). Exactly one write lands per height, every loser is refused with `StoreWriterChangedError` specifically, and a connection that took no part in the race audits the store afterwards. See below: this case COUNTS only here.

## Contention counts only in this run

`multi-tab` and `contention` rest on `readwrite` transactions SERIALISING across connections, which is the primitive the writer token rests on (ADR-0075's opening argument, taken from ADR-0054's). **`fake-indexeddb` cannot demonstrate that**: it is the IndexedDB API in one process, with no second tab for a transaction to serialise against. So the node suite beside this one asserts the RULE (`packages/state-store-indexeddb/test/two-writers.test.ts`, two handles in one process) and is not evidence that two TABS behave; this run is. Do not read the green node suite as covering it.

Neither case is in the acceptance gate, for the same reason the whole browser run is not (`packages/state-store-indexeddb/playwright.config.ts`): it needs `playwright install` and three browser binaries, and a gate that cannot run on a clean CI checkout is a gate that gets skipped. `pnpm test` is vitest only; contention is `pnpm --filter @etherfold/state-store-indexeddb test:browser`.

### Removing the guard turns it red (observed, 2026-09-10, Chromium)

A MANUAL experiment, recorded rather than claimed, because nothing automated can run it: making `claimOrCheck` (`packages/state-store-indexeddb/src/store.ts`) return without claiming or checking — the state of this backend before ADR-0075 — and re-running the case gives

```
1) [chromium] › browser/multi-tab.spec.ts › several tabs contending for the same heights leave one winner and no torn state
   "refusedBy": Object {},
   "unexpected": Array [
     "Error: block 2000 is already recorded: applying the same block twice is a caller bug, and a reorged height
      must be reverted before its replacement is applied.",
     ...
1 failed
```

Three of the four tabs are refused twelve times each, and NOT ONE refusal carries the name `StoreWriterChangedError`: the store tells three tabs that applying the same block twice is a caller bug, which is the opposite diagnosis (fix your code, rather than you lost a race and wrote nothing). That is the whole distinction the case exists to hold, and it is what the guard restores. The row-level audit stayed coherent in that unguarded run too (one tab happened to win every height by speed), because `applyBlock`'s own duplicate-height check was already a compare-and-swap — which is exactly why the four unguarded paths the token was built for (`writeCursor`, `clearCursor`, `revertTo`, `prune`) cannot be observed from this case and are asserted by the conformance suite instead.

## Reading the results

`browser-<engine>.json` is one run's `runs[]`; a case is a failure only if `errors` is non-empty or `results.failures` is. The `timings` are `performance.now()` samples from inside the page and are NOT a benchmark: the workloads here are small on purpose (they exist to be correct, not to be fast), and the ms/block numbers that carry weight are the finding's.
