---
title: 'The CLI, the server, the state stores and the examples take their identity from the ARRIVAL'
slug: the-cli-server-and-examples-take-their-identity-from-the-arrival
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [a-deployment-runs-from-a-bundle-identified-by-its-hash]
covers: [6, 8]
---

## What to build

One MIGRATE batch of a wide refactor (`work/protocol/TASKING-PROTOCOL.md` 3a), scoped to `packages/cli`, `packages/server`, `packages/state-store` and `examples/`.

Move this batch's call sites off `processor.getVersionHash()` and onto the identity the ARRIVAL supplies, in both source and tests. The measured blast radius for this batch is roughly **12 `getVersionHash` call sites**; ground that against the code before you start rather than trusting the number, because sibling batches are landing around it.

Nothing is DELETED here. The declared `version`, `getVersionHash()` and the code fingerprint all still exist when this batch finishes: the contract task removes them once every batch has landed, and that is what lets each batch stay green on its own.

The smallest batch, grouped because no one of these packages is worth a batch of its own and none of them implements the seam. `examples/` is included deliberately: an example is EVIDENCE, and an example that no longer compiles is a claim that stopped being true.

Tests in this batch migrate WITH their source. A test gives a generation an identity by supplying BYTES rather than by declaring a version, which works because the engine compares identities for equality and never parses them, and because these suites assert on WHICH generation rather than on what the code does. Synthetic bytes are correct here; only a genuine instantiate round trip needs the committed bundle fixture.

## Acceptance criteria

- [ ] Every `getVersionHash()` call site in `packages/cli`, `packages/server`, `packages/state-store` and `examples/` takes its identity from the arrival instead, source and tests together.
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
