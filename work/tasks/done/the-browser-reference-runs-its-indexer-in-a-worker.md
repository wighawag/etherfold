---
title: 'The browser reference runs its indexer in a worker'
slug: the-browser-reference-runs-its-indexer-in-a-worker
blockedBy: [a-worker-host-takes-its-provider-and-settings-from-the-tab]
covers: []
---

## What to build

Resolve `work/notes/observations/the-browser-reference-still-runs-the-main-thread-shape.md`: `examples/browser-reference/browser/main.ts`, the file `docs/guide/indexing-in-a-browser-app` tells readers to copy, still builds `createIndexerState` on the UI thread with `connection.provider`, while the guide now leads with the dedicated-worker host (ADR-0082). Move the reference to the worker shape: an app-authored worker entry (`hostIndexerInThisWorker`) and the tab's side connecting to it, handing the connection's provider over as a port with the settings, as `a-worker-host-takes-its-provider-and-settings-from-the-tab` built. Its `verify/reference.spec.ts` (and anything else that drives it) keeps passing against the worker shape, and the reference keeps demonstrating what it demonstrates today. Update the guide's sentence that says the reference still runs on the main thread, and retire the observation.

## Acceptance criteria

- [ ] The browser reference indexes in a dedicated worker, with the wallet connection's provider handed over as a port, and nothing indexing on the main thread.
- [ ] `verify/reference.spec.ts` and `pnpm build:examples` pass; everything the reference showed before still shows.
- [ ] The guide no longer says the reference runs on the main thread; the observation is retired.
- [ ] Changesets for any published package changed (0.x: patch or minor).

## Blocked by

- `a-worker-host-takes-its-provider-and-settings-from-the-tab`

## Prompt

> Goal: move `examples/browser-reference` to the worker shape (see What to build). Look at `examples/browser-reference/`, the guide's worker recipe, and the tab-side API `a-worker-host-takes-its-provider-and-settings-from-the-tab` added.
>
> FIRST, check this task against current reality: check its blocker landed as assumed; if not, route to needs-attention with the discrepancy.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **Axis one (edited processor) becomes a page reload.** The port can only carry a source, and a worker entry has no hook to hand a new processor module to, so `updateProcessor` / `reconfigureFromHotUpdate` have no counterpart here. I tested it once with a throwaway spec (deleted afterwards): editing `src/processor.ts` made Vite reload the page, and the new worker rebuilt the count under the edited handler as a single generation. The comments and README now say the warm swap without a reload belongs to the main-thread hook. The alternatives were adding a new seam to `@etherfold/browser` or leaving a main-thread path in the reference; the first is out of scope and the second breaks "nothing on the main thread". This makes the "everything it showed before still shows" criterion only partly true for axis one, which is why I wrote the observation note.
- **Axis two uses `reconfigure({source})` instead of `updateIndexer`.** The port verb folds a new generation next to the live one and switches reads to it once it catches up, rather than discarding and rebuilding. So the page no longer shows "state discarded" or the `sourceInvalidation` verdict, which the port does not carry. It reports `added` and `follows` instead, and `onRedeploy` returns the new generation's record so the test can wait for it to take over. The test is renamed to match.
- **The worker's database name is now `reference-${context.stream}`**, dropping the chain id and contract. The stream digest already covers both, and the worker no longer knows them because the source now comes from the tab. The same keying gives the redeploy's new generation its own store.
- **The source and stream config are sent by the tab (`settings`), not hard-coded in the worker.** After a redeploy only the tab knows the new ABI, and this is the shape the guide's worker recipe shows.
- **The page does one read by hand after subscribing to `onStateMoved`.** That signal stays silent until the fold next moves, so without the manual read the count would not appear until the next block.
