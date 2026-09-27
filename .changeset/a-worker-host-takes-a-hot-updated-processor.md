---
'@etherfold/browser': minor
---

A worker host takes a hot-updated processor, and folds it beside the live generation as the main thread does.

`IndexerHost` (what `hostIndexerInThisWorker`, `hostIndexerInThisSharedWorker` and `serveIndexerHost` return) has a new verb, `reconfigureFromHotUpdate(generation, processorConfig?)`, for the worker entry's own `import.meta.hot.accept` handler: under Vite a module worker receives HMR itself (measured, `work/notes/findings/a-module-worker-receives-hmr-under-vite.md`), so the edited module arrives where the fold runs. It is the main thread's `reconfigureFromHotUpdate` run against the host's container, serialised with a tab's `reconfigure`: the successor folds beside the canonical generation, which answers every read until the promotion policy moves the pointer, and it answers the same `ReconfigureReport` (`registered`, `unchanged`, `failed`). The processor is built inside the worker and named by the module arrival's derivation over what the worker instantiated (ADR-0086).

A tab learns the outcome over the port: `HostProgress.hotUpdate` is `{count, report}` (`HostHotUpdate`), the last hot update the host took and how many it has taken, pushed on the progress push; `sameProgress` compares the count, so a repeated verdict is still pushed. `IndexerHost` is now generic over the entry's `ABI`, `ProcessResultType` and `ProcessorConfig`, with `any` defaults so a bare `IndexerHost` still names every host. The main-thread hook, its free `reconfigureFromHotUpdate`, `processorBundle` and production builds are unchanged.
