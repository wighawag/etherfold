---
title: 'A tab runs a published processor bundle, and its identity is the bytes' hash'
slug: a-tab-runs-a-published-processor-bundle
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy: []
covers: [8]
---

## What to build

`@etherfold/browser` can take a processor as a URL to a published, self-contained bundle (the same bytes `etherfold build` folds with): it fetches the bytes, derives the identity as the SHA-256 of those bytes exactly as `processorArtifactIdentity` does, instantiates the processor FROM THOSE BYTES, and hands both to the generation (ADR-0086, ADR-0095). It is the browser counterpart of `loadProcessorArtifact`, and it works on the main thread and in both worker hosts, where the processor is instantiated inside the worker.

It must never report an identity for bytes it did not run: identity is derived from the bytes that are instantiated, never from a separately fetched or injected value (ADR-0095 refuses the injected-hash variant). Refusals are reported as outcomes: a bundle that still imports something (not self-contained), bytes that do not load, and a host that forbids instantiating from bytes (a strict Content-Security-Policy), which must name the policy as the reason.

## Acceptance criteria

- [ ] A tab given a bundle URL folds with it and registers its generation under the bundle's SHA-256, equal to what the CLI derives for the same file.
- [ ] The same in a dedicated worker and a SharedWorker host.
- [ ] A non-self-contained bundle, unloadable bytes and a refused instantiation are each reported as a distinct refusal and fold nothing.
- [ ] The module arrival (HMR) is unchanged, with its module identity.
- [ ] Tests cover the new behaviour, mirroring the existing browser identity and host suites.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: the bundle arrival in the browser (ADR-0086, ADR-0095). Look at `loadProcessorArtifact` / `processorArtifactIdentity` in `@etherfold/utils` (Node) and at `moduleProcessorIdentity` and `processorIdentity` on the browser's generation spec. ADR-0091 records which runtimes can instantiate from bytes; a browser can, subject to CSP. Test at the browser host seam with a real bundle built the way the examples build theirs.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
