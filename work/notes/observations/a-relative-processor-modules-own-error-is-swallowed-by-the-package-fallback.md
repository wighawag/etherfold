---
title: "`loadProcessorModule` swallows a relative module's OWN error and reports the package-resolution failure instead"
slug: a-relative-processor-modules-own-error-is-swallowed-by-the-package-fallback
observed: 2026-09-17
---

2026-09-17 — Noticed while reading `packages/utils/src/processorSetup.ts` for the artifact loader beside it (`a-processor-artifact-is-bytes-a-hash-and-a-loader`). `loadProcessorModule` imports a relative path and, on ANY failure, falls back to `createRequire(cwd/node_modules).resolve(...)` with the first error discarded (`catch (err)`, unused). So a processor module that exists and simply throws at import -- a syntax error, a missing sibling, a top-level throw -- is reported as "Cannot find module './dist/processor.js'" from the node_modules resolver, which points an operator at their path when the fault is inside their module.

Not investigated and NOT fixed (out of this task's scope). The likely shape is to fall back only when the first failure is a RESOLUTION failure (`ERR_MODULE_NOT_FOUND` naming that specifier) and to re-raise anything else.
