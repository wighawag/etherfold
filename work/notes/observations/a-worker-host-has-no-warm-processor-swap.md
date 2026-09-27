---
title: A worker host has no warm processor swap, so an edited handler reloads the page
slug: a-worker-host-has-no-warm-processor-swap
---

2026-09-27. Moving `examples/browser-reference` to the worker shape, axis one (an edited processor) could no longer use `updateProcessor` / `reconfigureFromHotUpdate`: the port carries only a source (`reconfigure`), and `hostIndexerInThisWorker` returns an `IndexerHost` with no verb a worker entry's own `import.meta.hot.accept` could hand a new module to (`packages/browser/src/host/serve.ts`). So in the worker shape an edit reloads the page and the new worker re-folds from the start block (observed: Vite full-reloads, one generation, the edited count), losing the warm fold-beside-the-live-one the main-thread hook gives a dev loop. Whether a worker host should expose that seam is open.
