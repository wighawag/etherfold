---
title: 'A worker host takes a hot-updated processor, and the browser reference shows it again'
slug: a-worker-host-takes-a-hot-updated-processor
blockedBy: []
covers: []
---

## What to build

Resolve `work/notes/observations/a-worker-host-has-no-warm-processor-swap.md`. On the main thread, an edited processor arrives as a hot update (`updateProcessor` / `reconfigureFromHotUpdate`, the guide's "Hot reload: two independent axes", axis one): the new processor folds BESIDE the live one and reads switch once it catches up, so a developer never sees a blank app. A worker host (`hostIndexerInThisWorker`, `hostIndexerInThisSharedWorker`, `packages/browser/src/host/serve.ts`) has no seam for it: its `IndexerHost` has no verb a new processor module can be handed to, and the port carries only a source (`reconfigure`). So since `the-browser-reference-runs-its-indexer-in-a-worker`, an edit in the browser reference reloads the page and the new worker re-folds from the start block. The maintainer wants the worker (the documented default, ADR-0082) to support hot reload as well as the main thread does (decided 2026-09-27).

Build the warm processor swap for the worker hosts, with the SAME behaviour and outcomes as the main thread's axis one (fold beside, switch on catch-up, the same verdicts on the status surface, carried over the port). Where the hot update ARRIVES is the design question, and it depends on a fact to MEASURE first, in the browser reference under Vite (record it as a finding under `work/notes/findings/`): does a module worker receive HMR at all (`import.meta.hot` inside the worker, for the processor module the worker imports)?

- If it does, the worker entry's own `import.meta.hot.accept` hands the new module to a verb on the host.
- If it does not, the TAB receives the update (it imports the processor module for that purpose) and tells the host, over the port, what to load. A module cannot be cloned, so what crosses is what the worker can import itself (the updated module's URL, which a bundler's dev server serves), and the worker instantiates it there. The identity is the module identity the main thread's module arrival uses, derived from what the worker actually instantiates, never a value the tab computes for it (ADR-0086, ADR-0095).

Either way the processor-bundle arrival (`processorBundle`) and a production build are unchanged: this is a development path. Then restore axis one in `examples/browser-reference` (its `verify/reference.spec.ts` asserts the warm swap again, as it did before the move to the worker), update the guide's hot-reload section for the worker shape, and retire the observation.

## Acceptance criteria

- [ ] A finding records, measured, whether a module worker receives HMR under Vite, and the design follows from it.
- [ ] In a dedicated-worker host, a hot-updated processor folds beside the live generation and reads switch when it catches up; the tab sees the same verdicts the main thread reports, over the port.
- [ ] The same in a SharedWorker host, where one update reaches the one host for all its tabs.
- [ ] The identity of the swapped-in processor is derived from what the worker instantiates.
- [ ] The browser reference shows the warm swap again, asserted by `verify/reference.spec.ts`; the guide's hot-reload section covers the worker shape; the observation is retired.
- [ ] The main-thread hot-update path and its tests are unchanged; changesets for every published package changed (0.x: patch or minor).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: the warm processor swap on a worker host (see What to build). Look at `packages/browser/src/hotUpdate.ts`, `IndexerState.ts` (`updateProcessor`, `reconfigureFromHotUpdate`), `host/serve.ts`, `host/port.ts`, `moduleIdentity.ts`, `examples/browser-reference/` and the guide's "Hot reload" section.
>
> FIRST, check this task against current reality: if a worker host already takes a hot-updated processor, route to needs-attention saying so.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
