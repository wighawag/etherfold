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

## Decisions

- **How the fetcher comes to exist after start.** A waiting `run` builds no fetcher at start. Its drive loop (`index()` in `prepareWaiting`) waits until the container reports a source (`ReceivingIndexer.fetchedSource`), then builds the fetcher once and runs the normal cycle loop. An upload wakes the wait immediately. Any other way a source can appear, such as an operator promote, is caught by a 1-second poll (`WAITING_POLL_MS`, exported). Alternatives were a placeholder fetcher (rejected under ADR-0048/0093), a callback on upload only (misses promote), or rebuilding the fetcher per upload (would contradict "one fetcher per run"). This touches `run` only.
- **The fetched source is set once, by the first generation the container holds.** On a node with nothing configured, `fetchedSource` is the configured source if there is one, otherwise the source of the first generation it folds, and it never moves after that. So a later upload with different contracts is a successor on a new stream that this process does not fetch, the same as today on a node whose source came from its processor module. The alternative, re-pointing the fetcher at each upload, would be a new behaviour the spec does not ask for. It touches the container's `add`, instantiation and the `/admin` folding report.
- **In the frozen-canonical case the next upload starts fetching**, even though it registers as a successor. Otherwise that successor could never catch up and be promoted. `/status` reports `waiting` alongside the frozen `canonical` until then.
- **A stored bundle's source comes from its own contracts, only in waiting mode.** The waiting node's instantiation resolves the source from the bundle, and the container freezes the generation if that stream is not the one being fetched. Configured nodes are unchanged; the extra check only applies when an instantiation names its own source.
- **New `/status` key: `cursor.waiting: {for: 'processor', message}`**, present on both branches of the envelope and absent on every other host. I considered only rewording the existing `reason` string, but that is not something a script can branch on. Recorded as ADR-0047's second 2026-09-26 amendment.
- **Accessors a waiting node doesn't have yet throw instead of being optional.** `host`, `source`, `processor`, `store` and `streamWriter` on `PreparedIndexing` and `RunningIndexer` throw with an explanation until they exist (the same pattern core's `opening` uses). Making them optional in the types would have forced changes across many callers and tests. `run` checks `waiting()` before reading the fetcher's limits.
- **A re-read on a waiting node answers `failed`**, pointing at `etherfold upload`, because there is no `--processor` path to re-read. This is a new refusal, but only on the new mode.
- **Dropping state on a waiting node uses every entity any processor loaded in that process declared.** The alternative was the entities of one "current" processor, which is how configured nodes work. A drop only removes tables that exist, so naming extra ones is harmless. To support this, the upload route's `UploadContext` takes an optional `foldParts`.
- **No new ADR.** The durable parts are recorded in ADR-0093 (now describing where the mode lives) and in the ADR-0048 and ADR-0047 amendments.
