---
title: 'A generation KEEPS the bundle that folds it, stored beside its state and deleted with it'
slug: a-generation-keeps-the-bundle-that-folds-it
spec: a-generation-retains-the-code-that-folds-it
blockedBy: []
covers: [4, 5, 6]
---

## What to build

ADR-0092, the storage half. Read it first; it is the decision and this task does not repeat its argument.

On a NODE deployment, registering a generation stores the bundle bytes that fold it, in the database beside that generation's state, and every path that deletes a generation deletes its bytes too. Nothing yet READS them back: instantiating stored bytes is the next task's. This task makes the bytes durably present and correctly bounded, and proves both.

**The bytes are dropped today, and that is the first thing to fix.** The processor arrival (`openProcessorArrival`, `@etherfold/utils`) reads the bundle, loads it, and returns only the processor, the module and the identity, so nothing downstream ever sees the bytes. Thread them from where they are read to where a generation is registered, through whatever the receiving container is handed for a generation. The CLI's folding wiring is where a Node deployment builds that today.

**The storage is a port concern, like `dropState` and `readStateCursor`.** The registry reaches its substrate through `GenerationRegistryPort`; the SQL implementation lives in the server package, the memory one in core for tests. The browser's IndexedDB port stores NOTHING and must not start to: ADR-0089 and ADR-0091 say why no runtime but Node retains code. How the port expresses "store these bytes for this generation" and "they go with it" is yours to decide; record it in `## Decisions`.

**Deletion must be total and must not have a second mechanism.** A reclaim, a replaced successor and a drop on promotion all delete a generation today. Each must take the bytes with the row and the state namespace, ideally because they share the one deletion path rather than because three call sites each remembered to.

**Tests supply BYTES, not bundles.** Identity is the hash of the bytes, so synthetic bytes give a stable, distinct identity, which is all the registry, slot, cap and reclaim suites need. Do NOT add a bundler step to tests, and do NOT invent a way to register a generation without bytes on the Node path: that is ADR-0086's deleted `version` growing back under another name.

> **FORWARD-POINTER (from the conductor, 2026-09-22).** The maintainer wants pushing a processor over HTTP (the spec `a-processor-artifact-is-pushed-to-a-running-deployment`) to be built after this chain, and a pushed generation's bytes must be stored by this same path. So make storing the bytes a property of REGISTERING a generation, not of how its bytes arrived: a disk read today and a push tomorrow should reach the same store with no second route.

## Acceptance criteria

- [ ] Registering a generation on a Node deployment stores its bundle bytes beside its state, asserted by reading them back through the port.
- [ ] The stored bytes are the exact bytes whose hash is the generation's identity, asserted by re-hashing them.
- [ ] Every path that deletes a generation deletes its bytes: a reclaim, a replaced successor and a drop on promotion, each asserted.
- [ ] Bytes are bounded by the registered generations: a run of reconfigurations leaves exactly as many stored bundles as there are registered generations. The spec names the existing `aGenerationNoSlotNamesIsReclaimed` and `aSuccessorLandsInADurableSlot` suites as the natural home.
- [ ] The browser's IndexedDB port stores nothing, and nothing in this task makes a tab keep bytes.
- [ ] Tests use synthetic bytes; no test gains a build step.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

ADR-0092's `status: accepted, not yet implemented` line STAYS after this task. The last task in this chain, `a-generation-says-whether-it-can-run-here`, owns removing it.

## Blocked by

None -- can start immediately.

## Prompt

The goal is that a Node deployment durably holds the code for every generation it has registered, so that later tasks can resume one whose code is not in the running build.

Read ADR-0092 first, then ADR-0086 (identity is derived from the code's bytes), ADR-0053 (a generation is a table namespace, and why grouping its storage matters), and ADR-0084 for the slots and for `reclaim`. ADR-0089 and ADR-0091 explain why neither a browser tab nor a Cloudflare Worker retains code; do not extend this to either.

The seams: the processor arrival in `@etherfold/utils` (where the bytes are read and currently discarded), the CLI's folding wiring (where a Node deployment builds what the receiving container is handed), the receiving container's registration, and `GenerationRegistryPort` with its SQL (server package) and memory (core) implementations. Mind the dependency direction: `@etherfold/utils` depends on `@etherfold/core`, never the reverse.

The decision most likely to be got wrong is making deletion three remembered call sites instead of one path. The second is a test shortcut that registers a Node generation without bytes.

Done means: registering stores the bytes, deleting a generation deletes them by every route, the count is bounded by the registered generations, and the browser is untouched.

FIRST, check this task against current reality. It was written on 2026-09-22 from a source read, and the claim that the arrival discards the bytes is load-bearing; confirm it. Builders in this repo have contradicted their task text repeatedly and have been right to every time.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular the port shape and how deletion stays one path. Do not write the done record, the commit message or the PR body yourself.
