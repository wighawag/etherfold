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

## Decisions

- **The verb is a method on `IndexerHost`, named `reconfigureFromHotUpdate`, rather than letting the entry call the free function on the host.** Why: no tab made the call, so the host has to publish the verdict to its tabs, and it has to wait for its container before comparing generations (otherwise a save before the container opens would wrongly answer `registered`). It reuses the free function's name and report because it is the same operation. Alternative: make `IndexerHost` fit the free function's input type and add a reporting hook. Cost: the small `hotUpdate.ts` ships in a production worker bundle. Touches the public `IndexerHost` API.
- **The verdict travels as `HostProgress.hotUpdate: {count, report}` (new type `HostHotUpdate`), and progress comparison checks `count`.** Why: without the count, two saves with the same verdict would be dropped as a repeat push. Alternatives: a new push kind, or the bare report. It is the latest update only, like `publication` and `streamSeed`. Touches the envelope and the cross-tab channel that shares the comparison.
- **`IndexerHost` is now generic, with `any` defaults.** Why: the verb takes a typed processor, and a narrower default broke every existing bare `IndexerHost` in the tests. Alternative: update every call site to spell its types.
- **A hot update does not inherit the entry spec's `processorConfig`.** It matches the main thread, where `reconfigureFromHotUpdate` takes `processorConfig` explicitly. An entry that uses one passes it itself.
- **The reference's worker entry gains `keepStream: keepStreamOnIndexedDB('reference-stream')`.** Measured: without a keeper the edit still folds beside the live state and switches, but it fetches the whole history again first. The keeper is what makes the swap warm.
- **The reference tab accepts the processor module with an empty callback (documented as HAZARD 3).** Measured: the tab imports that module, and without accepting it Vite turns every save into a page reload. Alternative: move the ABI and entity declarations out of the processor module.
- **Reference workaround for the missing state-moved signal on a switch.** While a new generation is catching up, the tab asks for the generation list on each progress push and re-reads once it takes over; this covers the redeploy path too. Why: the proper fix would be in core (`stateMoved.ts`) and is a design question outside this task. Alternatives: re-read on every progress push, or change core. Recorded as the observation above.
- **"Retire the observation" means deleting the file**, as the previous task did with its observation.
