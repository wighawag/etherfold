---
title: 'The state-store seam calls `createState: () => store` "the shipped generation pattern", which reads as licence for the store collision the guide now warns against'
slug: the-seam-calls-one-store-instance-for-every-generation-the-shipped-pattern
observed: 2026-09-20
---

2026-09-20 — Noticed while correcting the guide's `addGeneration` recipe (task `the-guide-s-add-generation-recipe-gives-the-new-fold-its-own-store`) and deliberately not touched, since it lives under `packages/*/src` and a README, which that task fences off.

`packages/state-store/src/store.ts` (the `openForWriting` docstring, "It is IDEMPOTENT per store instance"), `packages/state-store/README.md` and `packages/state-store-conformance/README.md` all describe `createState: () => store`, one store INSTANCE handed to every generation, as "the shipped generation pattern". The only place in the tree that does it is `packages/browser/browser/workload.ts:663`, a benchmark harness. Meanwhile `packages/browser/src/index.ts` (the `GenerationContext` re-export note, "two generations sharing one storage location are one store"), the browser README's hot-update example and now the guide all say a generation beside the live one needs its OWN `databaseName`, because two that share one collide on the rows and on the sync cursor. `BrowserGenerationSpec.createState`'s own JSDoc states only the shared-instance half. Both statements can be true at once (the seam's point is only that a second claim on one instance is not a second claim), but a reader who meets "the shipped pattern" first has been told the opposite of what the side-by-side case needs, and the phrase names a pattern nothing ships.
