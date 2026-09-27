---
title: The browser reference example still runs the main-thread shape
slug: the-browser-reference-still-runs-the-main-thread-shape
---

2026-09-27. `docs/guide/indexing-in-a-browser-app` now leads with the dedicated-worker host (ADR-0082), but the file it tells readers to copy, `examples/browser-reference/browser/main.ts`, still builds `createIndexerState` on the UI thread with `connection.provider` (the wallet's wrapper, which cannot cross into a worker). The guide says so in one sentence; moving the reference (and its `verify/reference.spec.ts`) to a worker entry is its own task, and it would need an RPC-endpoint provider in the worker.
