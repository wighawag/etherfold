---
title: 'A module worker receives HMR under Vite: its own `import.meta.hot.accept` is handed the edited module with no page reload, provided every OTHER importer of that module accepts it too'
slug: a-module-worker-receives-hmr-under-vite
source: 'measured by docs/spikes/a-worker-host-takes-a-hot-updated-processor/measure-worker-hmr.mjs (Vite 8.0.16 and Playwright 1.62.1 from examples/browser-reference, driving Chromium 151.0.7922.34 headless), 2026-09-27. Raw rows in that folder''s measured-2026-09-27.json.'
---

The question `a-worker-host-takes-a-hot-updated-processor` rests on: when a developer edits the processor module a `{type: 'module'}` worker imports, does the WORKER hear about it (`import.meta.hot` inside the worker), or only the tab?

**It does.** Under Vite's dev server a module worker is an HMR client in its own right: `import.meta.hot` is defined inside it, and a worker that calls `import.meta.hot.accept('./processor.js', cb)` has `cb` called with the EDITED module object, and the page is not reloaded. The same holds for a module `SharedWorker`.

## The measurement

A throwaway Vite root in the reference's shape (a tab starting a module worker, a worker importing a `processor.js`), served by the reference's own Vite and driven in Chromium. `processor.js` is edited on disk once the worker has started; after three seconds the script reads what each side logged, and whether a marker set on `window` from OUTSIDE the page's code survived (it does not survive a reload).

| scenario | who imports `processor.js` | who accepts it | worker got the edited module | page reloaded |
| --- | --- | --- | --- | --- |
| `worker-accepts` | worker | worker | yes, in its accept callback (`value: 2`) | no |
| `shared-worker-accepts` | SharedWorker | SharedWorker | yes, in its accept callback | no |
| `worker-accepts-tab-imports` | worker AND tab | worker only | only by being RESTARTED (`started`, `value: 2`) | **yes** |
| `tab-accepts` | worker AND tab | tab only | only by being restarted | **yes** |
| `both-accept` | worker AND tab | worker AND tab | yes, and the tab's callback fired too | no |

`import.meta.hot` was `object` in the worker in every scenario, and Vite logged `hot updated: /processor.js via /worker.js?worker_file&type=module` whenever the worker's boundary took it.

## What follows

1. **The design is the first branch of the task: the worker entry's own `import.meta.hot.accept` hands the new module to a verb on the host.** The processor is instantiated where the fold runs, from the module the worker's own module graph received, so its identity is derived from what the worker instantiates (ADR-0086) with nothing crossing the port but the verdict.

2. **The "tab tells the host what to load" design is not only unnecessary, it does not work as sketched.** A tab that accepts the module while the worker merely imports it is a FULL RELOAD (`tab-accepts`): Vite propagates an update through every importer, and the worker's import has no boundary. So the tab could never have been the only receiver.

3. **The trap an app will walk into: an importer that does not accept.** The reference's tab imports `src/processor.ts` for its ABI and entity declarations. With only the worker accepting, that import turns every save into a full page reload (`worker-accepts-tab-imports`), and the warm swap never happens. Every module that imports the processor module has to accept it (a tab that has nothing to do with the new module accepts it with an empty callback), or import what it needs from a module the processor does not live in.

4. **This is Vite's behaviour, measured, and not a web platform guarantee.** Another bundler's worker HMR is its own question; `@etherfold/browser` subscribes to nothing (see `hotUpdate.ts`), so a bundler without worker HMR simply never calls the verb, and a save reloads the page as it did before.
