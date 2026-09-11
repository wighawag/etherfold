---
title: 'The indexer is hosted in a dedicated worker and the tab holds a port'
slug: the-indexer-is-hosted-in-a-dedicated-worker
spec: the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
blockedBy: []
covers: [1, 2, 12, 15, 16]
---

## What to build

The first vertical path across the boundary: an app writes a short worker entry point, the indexer runs in that worker against a store opened for WRITING there, and the tab holds a typed port that can ask it something and get an answer.

Three things have to be right, and they are the reason this is one task rather than three. It is the thickest task in this spec, deliberately: none of the three is demoable without the other two, so splitting them would produce pieces that cannot be verified on their own.

**A worker becomes a third HOST, not a new architecture.** `CONTEXT.md` already defines a **host** as the thing that owns a **container** and drives it, and this repository already runs two hosts over one model (ADR-0071). Add a third. What differs between hosts is how a port is obtained and nothing else; the container, the store handling and the driving loop are written once and are host-agnostic. Later tasks add a SharedWorker host and adapt the main-thread one, and they must be able to do that without a second copy of anything. This is the decision ADR-0082 exists to protect, and getting it wrong here is expensive to undo.

**The app authors the entry, the package ships what it calls.** A processor is code and closures and cannot cross `postMessage`, so the worker IMPORTS it. What an app writes should be about five lines: import its processor, import this package's worker entry helper, call it. Provide that shape, and make it the thing the test app uses, so "a handful of lines" is demonstrated rather than claimed.

**The envelope is typed and carries surfaces as cases.** One request/response envelope with correlation, not a bespoke message per feature: every later task adds a CASE. Only one surface needs to exist here — enough to prove the path end to end, which in practice means the host reporting that it is alive and how far the fold has got — but the envelope must already be the shape the store proxy, the control calls and (later, in another spec) the query executor slot into. Values crossing it must be structured-clone-safe; a value that cannot cross should be refused where it is written, not thrown at run time.

The writer lives in the host and the tab does not get a writable handle. That is the writer/reader split (ADR-0077, ADR-0079) reaching across the boundary, and it should be a fact of the TYPES a tab can name, not a rule someone has to remember.

## Acceptance criteria

- [ ] An app can construct an indexer hosted in a dedicated worker by writing only a worker entry point that imports its processor, plus a constructor call in the tab.
- [ ] The host opens the store for writing; nothing handed to the tab can mutate it.
- [ ] The tab can ask the host how far it has got and get a correct answer, across the real boundary.
- [ ] A real chain fold runs to completion in the worker and the resulting state matches what the same workload produces on the main thread today.
- [ ] The UI thread is demonstrably not doing the fold (assert on where the work happens, not on a timing threshold, so the case is not flaky).
- [ ] Every value the envelope carries is structured-clone-safe, and a value that is not is refused with a message naming the field rather than throwing from `postMessage`.
- [ ] What runs inside the host is host-agnostic: only the part that obtains the port knows it is a dedicated worker. A reviewer can point at the seam.
- [ ] It is tested in a REAL browser with a REAL worker, using the existing Playwright browser harness in this package rather than a mocked port.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches a PUBLISHED package and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

None — can start immediately.

## Prompt

The goal is to move the browser indexer off the UI thread, with a boundary the six tasks after this one extend rather than redesign.

Read `work/specs/tasked/the-indexer-runs-in-a-worker-and-the-tab-talks-to-it.md`, **ADR-0082**, and the **indexer host** entry in `CONTEXT.md`. The ADR holds the decisions you must not relitigate: a worker is a third host rather than a new architecture, the app authors the entry point so the processor crosses as an IMPORT, dedicated is the default, and the writer is in the host with a reader in the tab.

**Vocabulary matters here and is already pinned.** Use HOST (the execution context that owns a container and drives it), CONTAINER (`Indexer`, the named unit holding generations), DRIVER (whatever calls the advance), PORT (the typed boundary a tab holds) and HOSTING SHAPE. An earlier draft of this work coined *body* and *shell*; `CONTEXT.md` explicitly says not to reintroduce them, because they are `container`+driver and `host` renamed. If you find yourself needing a word the glossary does not have, that is worth a `## Decisions` entry rather than a coinage.

Where to look. `@etherfold/browser` is the package: `createIndexerState` is today's main-thread entry point and it is large, holding the store, driving the container and publishing three reactive stores (`state`, `syncing`, `status`). Do NOT try to move all of it across in this task — take what the container needs and the minimum surface that proves the path, and leave the rest of that function alone; later tasks bring the surfaces over one at a time, and the LAST task in this spec is the one that makes `createIndexerState` the main-thread host rather than a second path beside it. Keep that end state in view so you do not build a structure that cannot absorb it.

`@etherfold/core` holds the container (`container.ts`) and the generation model; `@etherfold/state-store` holds the seam, where `StateStore` is the read shape, `openForWriting` returns the writable one, and ADR-0079 explains why there are three names.

The real-browser harness already exists in this package: a `browser/` directory with a code-under-test module, a workload and a spec, driven by `playwright.config.ts` and `pnpm test:browser`. That run sits OUTSIDE the acceptance gate because it needs browser binaries a clean checkout does not have, which is the existing convention (see the IndexedDB package's multi-tab cases) — follow it rather than adding browser binaries to the gate, and say where the results are kept.

Bundler note worth checking rather than assuming: `new Worker(new URL('./x.worker.ts', import.meta.url), {type: 'module'})` is the form that works across current bundlers, and this package already has an esbuild-based bundling test (`bundlesForABrowser.test.ts`) — extend that reasoning if the entry shape needs one.

Done means: an app in the harness that indexes a real workload in a worker, a tab that can ask it a question and get the right answer, a store only the host can write, and a structure a second host could run without being copied.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The envelope's shape and where the host/container seam falls are exactly such decisions and must appear there, because six later tasks build on them. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
