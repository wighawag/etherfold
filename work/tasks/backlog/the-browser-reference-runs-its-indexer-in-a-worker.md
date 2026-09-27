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
