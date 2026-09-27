---
title: 'A worker-hosted tab starts from a publication, and the guide leads with the worker'
slug: a-worker-hosted-tab-starts-from-a-publication
blockedBy: []
covers: []
---

## What to build

ADR-0082 decided that the browser indexer is HOSTED, that a DEDICATED WORKER is the default host, a SharedWorker opt-in and the main thread the third shape, and that the three differ ONLY in how a port is obtained. Reality has drifted from it:

- The newer tab-side features exist only on the main-thread host (`createIndexerState`): the stream-seed install (`seed` / `keepStream`), the publication-index option (`publication`, `a-tab-starts-from-a-publication-index`) and the returning-tab switch (`catchUpWithinSeconds`, ADR-0096). `HostedIndexerSpec` / `serveIndexerHost` (`packages/browser/src/host/serve.ts`) read none of them; ADR-0096 records the switch as main-thread only for that reason. The processor-bundle arrival (`processorBundle`) already works in both worker hosts.
- `docs/guide/indexing-in-a-browser-app` shows `createIndexerState` in every recipe, so an app that follows the guide indexes on the thread that paints, which ADR-0082 exists to avoid (45.6 ms per block of store writes on Chromium; a seed install blocks 190 to 632 ms on a phone, `work/notes/findings/what-a-published-stream-seed-costs-to-install.md`).

Build:

1. **Parity.** A dedicated-worker host and a SharedWorker host accept `publication`, `catchUpWithinSeconds`, and the stream seed (`seed` with its `keepStream`), with the same behaviour and the same outcomes as the main thread, reported to the tab over the port on the existing status surface (`syncing.publication`, `syncing.streamSeed`, or their port equivalents). Everything is constructed INSIDE the host from what the app's worker entry passes (ADR-0082: the app authors the worker entry; a provider, a fetch or a store is built there). Share the implementation with the main-thread host rather than copying it (ADR-0082: "three hosts running three implementations is the obvious accident"). The returning-tab switch re-runs the app's `createState` with `replaceLocal` inside the host, as it does on the main thread.
2. **The guide leads with the worker.** Every recipe in `docs/guide/indexing-in-a-browser-app` that sets up an indexer (the snapshot-only mode, the publication index and bundle, the returning tab, the stream seed) shows the dedicated-worker shape first: the app's worker entry (`hostIndexerInThisWorker`) and the tab's side (`dedicatedWorkerHost` + `connectToIndexerHost`). The main thread (`createIndexerState`) is documented as the alternative, stating when it is reasonable (development, HMR, a tiny state) and what it costs. The SharedWorker stays opt-in, as ADR-0082 says. Use the shape webevm uses as the bar for ergonomics (`wighawag/webevm` README: `createNode()` and `createWorkerNode({worker})` are interchangeable one-liners, and a worker that must build something first calls one `expose` function): if the worker recipe needs noticeably more code than the main-thread one, record in `## Decisions` what would close the gap, and close it if it is small.
3. Amend ADR-0096's recorded limit (main-thread only) in place, since this removes it. Update ADR-0082 only if its text is now contradicted.

## Acceptance criteria

- [ ] In a dedicated-worker host and a SharedWorker host, a tab with a publication starts from its generation's snapshot and keeps it across the first load; `stream-mismatch`, `no-entry` and an unreachable index are reported to the tab over the port.
- [ ] In a worker host, the returning-tab switch works for both reasons (`archive-refused`, `over-budget`) and `'always'`, with no block skipped or applied twice, as in `aReturningTabCatchesUpOrStartsFromTheSnapshot.test.ts`.
- [ ] In a worker host, a seed asked for is installed and its outcome reaches the tab; by default no seed is fetched.
- [ ] The main-thread host's behaviour and its existing tests are unchanged.
- [ ] One implementation serves all three hosts (no duplicated publication / switch / seed logic per host).
- [ ] The browser guide's indexer recipes show the dedicated worker first and the main thread as the documented alternative; `pnpm docs:build` passes.
- [ ] Tests mirror the existing worker-host suites (`aTabRunsAPublishedProcessorBundle.test.ts`, `aSharedWorkerServesSeveralTabs.test.ts`); changesets for every published package changed (0.x: patch or minor).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: bring the worker hosts to parity with the main thread for the publication, the returning-tab switch and the seed, and make the guide lead with the dedicated worker, as ADR-0082 already decided. Look at `packages/browser/src/host/` (`serve.ts`, `dedicatedWorker.ts`, `sharedWorker.ts`, `mainThread.ts`, `port.ts`), `IndexerState.ts` and `publication.ts`, ADR-0082 and ADR-0096, and `~/dev/github/wighawag/webevm/README.md` for the worker ergonomics bar (read only the README and `packages/webevm/src/worker-*.ts`).
>
> FIRST, check this task against current reality: if a worker host already reads one of these options, or ADR-0082 was superseded, adjust or route to needs-attention with the discrepancy.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
