---
title: 'A tab that imports `workerExecutor` bundles no GraphQL runtime'
slug: the-tab-bundle-carries-no-graphql-for-the-worker-executor
blockedBy: []
covers: []
---

## What to build

ADR-0099 keeps GraphQL opt-in and off the tab: the schema and the `graphql` runtime live in the worker, and the tab holds only `workerExecutor(port)`. That promise is broken for the TAB today. `@etherfold/graphql/worker` (`src/worker/index.ts`) holds both `workerExecutor` and `graphqlQueryHandler`, so it imports the handler's pipeline (`execute.js`, `schema.js`, `documents.js`), and `@etherfold/graphql`'s `package.json` declares no `sideEffects`, so a bundler keeps those modules even when the tab imports only `workerExecutor`. Measured on `examples/browser-reference` with `vite build`: the tab chunk grows from 170.7 KB (63.2 KB gzipped) to 268.3 KB (86.7 KB gzipped) and contains graphql-js; with `"sideEffects": false` it is 172.0 KB (63.7 KB gzipped) and contains none.

Do both fixes: move `workerExecutor` into its own module that imports only the executor contract (`executor.js`) and types, keeping it exported from `@etherfold/graphql/worker` so no import changes; and add `"sideEffects": false` to `@etherfold/graphql`'s `package.json`, after checking that no module of the package relies on an import-time side effect (if one does, use the array form naming it). Then update the guide section that states the tab cost as a known gap.

## Acceptance criteria

- [ ] A bundle test beside `packages/graphql/test/worker-bundle.test.ts` (esbuild, `platform: 'browser'`, reading the metafile's inputs): a TAB entry that imports only `workerExecutor` from `@etherfold/graphql/worker`, resolved the way an app resolves it (through the package's `./worker` export, so `sideEffects` is exercised), contains no `graphql` and no `@pothos/core` module; the POSITIVE CONTROL, a tab entry that imports something that needs the runtime (for example `graphqlQueryHandler` or `buildQuerySchema`), contains them, so the check is known to see GraphQL when it is there.
- [ ] The existing worker-bundle cases still pass (a worker entry without the handler has no GraphQL; with it, it has).
- [ ] `examples/browser-reference`'s tab chunk from `vite build` contains no graphql-js, and its gzipped size is within 1 KB of the 63.2 KB it had before the executor was imported (state the measured numbers in `## Decisions`).
- [ ] The guide (`docs/guide/indexing-in-a-browser-app/index.md`, the paragraph "The tab pays a little too, today") states the tab's measured cost with the numbers above and no longer describes a known gap, and `packages/graphql/README.md` (which states only the worker's cost today) adds the tab's measured cost beside it. The observation with the slug `importing-workerexecutor-puts-graphql-in-the-tab-bundle` (in the observations bucket), which that guide paragraph links to, is deleted in the same change: it was kept only because the guide cites it, and `pnpm check:refs` must stay green.
- [ ] Changesets: `@etherfold/graphql` (patch), plus any other published package whose directory you change (patch or minor, never major).
- [ ] CI: dorfl's `verify` gate runs vitest only, so the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done (the `browser-reference` verify, which exercises `workerExecutor` in a real tab, runs in `browser (chromium)`).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: restore ADR-0099's "opt-in and off the tab" for the tab that holds `workerExecutor`. Look at `@etherfold/graphql` (`src/worker/index.ts`, `src/executor.ts`, `package.json` exports), `packages/graphql/test/worker-bundle.test.ts` (the pattern for the new test), `examples/browser-reference/browser/main.ts` (the tab that imports `workerExecutor`), and the measurement in `docs/spikes/a-worker-host-answers-graphql-over-its-port/`. `a-host-started-from-a-snapshot-answers-queries` may be in flight at the same time and adds tests in `packages/graphql/test`; keep your worker-module change a move plus a re-export so its imports keep resolving.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. Read ADR-0099 (the executor paragraph) and check that `workerExecutor` still shares a module with the handler and that `package.json` still has no `sideEffects`. If it has changed, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files: inspect a built chunk with a bounded `node -e` `indexOf`, never a regex over the whole file.
>
> CI: dorfl's gate runs vitest only. The real-browser suites run in CI's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs; the PR is done only when those three are green too.

## Decisions

- **The new test counts only modules that put bytes into the output.** The spec asked for "the metafile's inputs". But the build-wide `metafile.inputs` still lists a module esbuild read and then dropped, so graphql showed up there even when the output contained none. The test therefore reads the single output's `inputs` and keeps entries with `bytesInOutput > 0`. That is still the metafile's input list, just per output. The alternative, the build-wide list, can never pass for a self-referencing package. This touches only the new test; `worker-bundle.test.ts` keeps its original method, which still works because `@etherfold/browser` never imports graphql.
- **The test resolves through the package's own name.** The entry imports `@etherfold/graphql/worker` from inside the package, which esbuild resolves through the `./worker` export to `dist/`. This relies on `dist/` being built before tests, which `verify` already does (`pnpm build` runs before `pnpm test`). The alternative, importing `./src/...`, would bypass `sideEffects` and so would not check the fix.
- **`sideEffects: false` as a boolean, not the array form.** No module under `src/` (including `conformance/`) runs code at import time: the top level is only imports, exports, pure constants and `Symbol(...)`. So there was nothing to name in an array.
- **Measured numbers, stated in kB as Vite reports them (1000 bytes):** the tab chunk is 172.03 kB, 63.71 kB gzipped, with no graphql-js. The worker chunk still contains graphql. The 63.2 kB baseline (before the tab imported the executor) and the 86.7 kB "before" figure in the changeset come from the deleted observation; I did not re-measure them.
- **Re-export placement:** `export {workerExecutor, type PortWithQuery} from './executor.js';` sits at the end of `src/worker/index.ts`, where the moved code used to be. It is a plain move plus a re-export, so the files of `a-host-started-from-a-snapshot-answers-queries` keep resolving.
