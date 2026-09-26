---
title: 'A `run` node started with NOTHING configured waits for its first upload'
slug: a-run-node-with-nothing-configured-waits-for-its-first-upload
spec: a-processor-artifact-is-pushed-to-a-running-deployment
blockedBy: [an-upload-command-sends-a-built-bundle, status-says-when-the-canonical-generation-is-frozen]
covers: [11]
---

## What to build

ADR-0093. `etherfold run` may be started with NO processor and NO source, together. Such a node:

- **With a canonical generation in its registry**, instantiates it from its stored bundle and folds, exactly as an upgrading restart already instantiates the canonical generation at `open` (`an-upgrading-restart-keeps-the-incumbent-folding`). The contracts it indexes are the ones that bundle carries.
- **With none**, serves, fetches nothing, and says so: reads answer the existing "no canonical generation yet" refusal (ADR-0058's `503`, the shape a fresh deployment answers before its first fold), and `/status` reports that the node is WAITING for a processor.
- **With a canonical generation it CANNOT instantiate** (its stored code is broken, or it sits on a stream this deployment cannot name; decided by the maintainer on 2026-09-26): starts anyway, serves that generation frozen, fetches nothing, and `/status` shows it frozen with the reason through the canonical report `status-says-when-the-canonical-generation-is-frozen` built. The next upload is accepted and registers beside it as usual.
- **On its first upload**, takes that upload's contracts as its source, registers it (the registry makes the first generation `canonical` by its existing rule), and starts fetching and folding.
- **Later uploads are never refused for carrying different contracts.** A node started with nothing configured has no source the OPERATOR configured, and the contract-match refusal applies only to that (`a-processor-bundle-is-uploaded-to-a-running-node`). A later upload with different contracts is a successor on a new stream, as on any node whose source came from its processor.

**This is a MODE, not a default** (ADR-0093 and ADR-0048). Only the pair may be absent. A SOURCE with no processor is still refused (contracts with nothing to fold them are a configuration error). A processor with no source is valid as today. `build`, `fetch`, `index` and `serve` are unchanged; the split `index` does not wait.

**Two things do not exist yet in this shape, and both are this task's.** The FETCHER: today `run` builds its one fetcher over a source resolved at start, and a waiting node has to start fetching when a source arrives. And the CONTAINER: in `@etherfold/core`, `ReceivingIndexerOptions.generation` is required, `open()` always adds it, and `opening` throws when no fold is held, while the CLI's `openFolding` / `prepareIndexing` need a declared processor and a resolved source. So a receiving container with no generation to open cannot be constructed today. Change that seam properly. Do NOT fake it with a placeholder generation or processor: that is the defaulted input ADR-0048 and ADR-0093 both reject.

## Acceptance criteria

- [ ] `run` with neither processor nor source starts, answers reads with the no-canonical-generation refusal, and `/status` says it is waiting for a processor. Asserted end to end.
- [ ] `etherfold upload` to that node registers the first generation as canonical, the node begins fetching the uploaded contracts, and it folds: observe its cursor advance over a fake chain.
- [ ] A second upload, with different contracts or the same, registers as `successor` and is not refused.
- [ ] With nothing configured over a registry whose canonical generation cannot be instantiated, the node starts, serves it frozen, fetches nothing, `/status` says frozen with the reason, and a subsequent upload registers.
- [ ] `run` with neither, over a database whose registry already has a canonical generation, instantiates it from its stored bundle and folds the contracts that bundle carries.
- [ ] `run` with a source and no processor is still refused, and every other command still requires what it required.
- [ ] **ADR-0093's `status: accepted, not yet implemented` line is REMOVED, leaving NO status line** (`work/protocol/ADR-FORMAT.md`: absent means accepted and current; `accepted, implemented` is not a valid value). This task is the last to implement ADR-0093 and owns the removal. ADR-0093's Consequences sentence "It depends on two unbuilt things" stops being true with this task, so correct it in the same change. ADR-0048 gains a dated amendment naming the exception. ADR-0085's status line is NOT this task's (`an-uploaded-processor-survives-a-restart` owns it).
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- `an-upload-command-sends-a-built-bundle` -- the waiting node is driven by the command, end to end.
- `status-says-when-the-canonical-generation-is-frozen` -- both change what `/status` reports about the canonical generation, so they are serialised; build the "waiting" state on the shape that task settled.

## Prompt

The goal is The Graph's first half: a node is stood up once, with nothing configured, and processors arrive by deploy.

Read ADR-0093 (the decision), ADR-0048 (why a missing input is refused, and the exception this adds), ADR-0058 (what a read answers before a first fold), ADR-0092 and the done record of `an-upgrading-restart-keeps-the-incumbent-folding` (instantiating the canonical generation at `open`, which is what "boot from the registry" reuses), and the done records of the upload route and command.

The seams: the receiving container's options, `open` and `opening` in `@etherfold/core` (which assume a configured generation), the CLI's configuration resolution (the ownership table that says `run` requires a processor), `prepareIndexing` and the folding wiring (how `run` assembles its container and its one fetcher from a resolved source), the upload route (where the first upload must be allowed to define the source), and the `/status` reporter.

The decision most likely to be got wrong is faking the waiting state with a placeholder processor, source or generation, which is the default ADR-0048 and ADR-0093 both reject. The second is letting an upload skip validation because there is nothing to match: it still has to be self-contained and evaluate.

Done means: a `run` with nothing configured waits visibly, the first upload makes it index, and ADR-0093 stops saying it is unimplemented.

FIRST, check this task against current reality: the upload route, the command and the `/status` task will have landed. If they landed differently than this assumes, route to needs-attention with the discrepancy.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular how the fetcher comes to exist after start. Do not write the done record, the commit message or the PR body yourself.
