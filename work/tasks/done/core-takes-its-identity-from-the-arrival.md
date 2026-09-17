---
title: '`@etherfold/core` takes its identity from the ARRIVAL, not from the processor'
slug: core-takes-its-identity-from-the-arrival
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [a-deployment-runs-from-a-bundle-identified-by-its-hash]
covers: [6, 8]
---

## What to build

One MIGRATE batch of a wide refactor (`work/protocol/TASKING-PROTOCOL.md` 3a), scoped to `packages/core`.

Move this batch's call sites off `processor.getVersionHash()` and onto the identity the ARRIVAL supplies, in both source and tests. The measured blast radius for this batch is roughly **60 `getVersionHash` call sites**; ground that against the code before you start rather than trusting the number, because sibling batches are landing around it.

Nothing is DELETED here. The declared `version`, `getVersionHash()` and the code fingerprint all still exist when this batch finishes: the contract task removes them once every batch has landed, and that is what lets each batch stay green on its own.

This is the LARGEST batch by a wide margin and it holds the seam itself, so it sets the pattern the other three follow. Where a choice here would read differently in a sibling package, prefer the one that ports.

Tests in this batch migrate WITH their source. A test gives a generation an identity by supplying BYTES rather than by declaring a version, which works because the engine compares identities for equality and never parses them, and because these suites assert on WHICH generation rather than on what the code does. Synthetic bytes are correct here; only a genuine instantiate round trip needs the committed bundle fixture.

## Acceptance criteria

- [ ] Every `getVersionHash()` call site in `packages/core` takes its identity from the arrival instead, source and tests together.
- [ ] The batch is GREEN on its own: this package's suites pass with the rest of the tree unchanged.
- [ ] Nothing is deleted: the declared `version`, `getVersionHash()` and the fingerprint still exist and still work, because sibling batches depend on them.
- [ ] No file OUTSIDE this batch's packages is edited, so parallel batches do not collide.
- [ ] Tests that declared a `version` now supply BYTES, and none of them runs a bundler to do it.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Prompt

The goal is to move this batch's callers onto the identity the ARRIVAL supplies, leaving the batch green, so that the contract task can delete the declared path once every batch has landed.

Read **ADR-0086** for the invariant (an author cannot state their identity; the engine takes one and never asks where it came from), then `a-deployment-runs-from-a-bundle-identified-by-its-hash` in `work/tasks/done/`, which built the road this batch moves onto, and `work/protocol/TASKING-PROTOCOL.md` 3a for why this is a batch rather than a vertical slice.

The decision most likely to be got wrong is deleting something. This is a MIGRATE batch: the declared `version`, `getVersionHash()` and the fingerprint must all still EXIST when you finish, because sibling batches have not landed yet and the contract task is what removes them. A batch that deletes the old form breaks every batch that has not run.

The second: in TESTS, do not reach for a bundler. Identity is a hash of bytes and the engine never parses it, so a test supplies BYTES -- synthetic ones are fine and correct, because these suites assert on WHICH generation, never on what the code does. A test that shells out to `esbuild` to get an identity has misread the design. The one exception is a round trip that genuinely instantiates, which uses the committed fixture.

The third: stay inside this batch's packages. The batches are file-orthogonal on purpose so they can run in parallel, and a helpful edit in a sibling package's file is the merge conflict that costs more than it saved. If you find something wrong outside this batch, note it in your report.

The seam to test at is whatever this batch's packages already test at: the point of a migrate batch is that the EXISTING suites go on passing, with their identities now sourced from the arrival.

Done means: this batch's call sites take their identity from the arrival, its suites are green, the old form still exists untouched, and no sibling package was edited.

## Decisions

**The name is `processorIdentity`, and it is a field on the options bag that accompanies the processor at every entry point.** Chosen because `packages/cli` already spells exactly this concept `FoldParts.processorIdentity` (landed by `a-deployment-runs-from-a-bundle-identified-by-its-hash`), so the batch that migrates the CLI meets a name it already uses. Plain `identity` was rejected as a re-meaning: a generation's identity IS `{stream, processor}`, so `GenerationSpec.identity` would name the whole `GenerationId` and mean two things one line apart. What it touches: the three sibling batches all see this name, and the contract task deletes the fallback behind it.

**It is deliberately NOT a key on `ProvidedIndexerConfig`, even though that is the bag already threaded from the container to the engine and would have needed no signature change.** Rejected because `IndexerOptions.config` is ONE value shared by every generation a container builds, so a `processorIdentity` there would silently give two generations one name — one registry record, one state namespace, and two specs folding a stream that is only folded once. The cost of the alternative I took is a fifth parameter on `IndexerOptions.createGeneration`. What it touches: `@etherfold/browser`'s `createIndexerState({createIndexer})` mirrors that hook. An existing four-parameter factory still type-checks and still compiles (TypeScript accepts fewer parameters), but it would silently DROP the identity, so the browser batch must widen its own factory when it migrates. I flag it rather than bury it because a compiler will not.

**`updateProcessor`'s "the swap was skipped" warning now branches on WHICH ARRIVAL supplied the identity.** Telling an author who cannot declare an identity to "bump the processor's version hash" is a wrong instruction at the exact moment they are confused. This mirrors the precedent the blocking task set for the CLI's `reconfigure` `unchanged` message, so the two read the same. It branches on whether an arrival answered — `options.processorIdentity === undefined` — and never on the identity string, because nothing in the tree parses `GenerationId.processor` and this does not start. What it touches: it is user-visible prose on a core log line; `the-declared-version-and-the-drift-report-are-deleted` removes the declared half of the branch.

**The identity is resolved LAZILY at each site, not captured at construction.** An arrival-supplied identity is a constant, but the DECLARED fallback is not: `getVersionHash()` covers a processor's config as well as its version and `configure()` can move it, which is precisely why `StreamBuilder.generation` reads it on every call today. Capturing at construction would have been tidier and would have changed un-migrated behaviour. The alternative is available to the contract task for free, once the fallback is gone.

**One test is deliberately left on the declared fallback**: `streamBuilder.test.ts`'s `reads the DECLARED fallback live, so a processor reconfigured after construction is not misreported`. Criterion 3 says the old form must still *work*, and a migrate batch that left no assertion of that inside this package would be trusting the sibling packages to notice. It is labelled at the site as the case the contract task retires with the path it describes. Everything else in the package takes its identity from the arrival.

**The test helper spells the `sha256:<hex>` rendering itself instead of importing `processorArtifactIdentity`.** `@etherfold/utils` depends on `@etherfold/core` and not the other way round, so core cannot import it. Recorded because it looks like a forked derivation and is not one: what core is under test for is that it takes WHATEVER it is handed, so the exact derivation is the test's business. The docstring says so and points at both prior arts (`stream/seed.ts`'s `streamSeedContentHash` and the artifact loader).
