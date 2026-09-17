---
title: 'The two processor packages take their identity from the ARRIVAL'
slug: the-processor-packages-take-their-identity-from-the-arrival
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [a-deployment-runs-from-a-bundle-identified-by-its-hash]
covers: [6, 8]
---

## What to build

One MIGRATE batch of a wide refactor (`work/protocol/TASKING-PROTOCOL.md` 3a), scoped to `packages/processor-entities` and `packages/processor-sqlite`.

Move this batch's call sites off `processor.getVersionHash()` and onto the identity the ARRIVAL supplies, in both source and tests. The measured blast radius for this batch is roughly **30 `getVersionHash` call sites**; ground that against the code before you start rather than trusting the number, because sibling batches are landing around it.

Nothing is DELETED here. The declared `version`, `getVersionHash()` and the code fingerprint all still exist when this batch finishes: the contract task removes them once every batch has landed, and that is what lets each batch stay green on its own.

These two are the packages that IMPLEMENT the processor seam, so they are migrated together: `VersionedStateEventProcessor` delegates to `EntityEventProcessor`, and splitting them would put a seam change on one side of a batch boundary.

Tests in this batch migrate WITH their source. A test gives a generation an identity by supplying BYTES rather than by declaring a version, which works because the engine compares identities for equality and never parses them, and because these suites assert on WHICH generation rather than on what the code does. Synthetic bytes are correct here; only a genuine instantiate round trip needs the committed bundle fixture.

## Acceptance criteria

- [ ] Every `getVersionHash()` call site in `packages/processor-entities` and `packages/processor-sqlite` takes its identity from the arrival instead, source and tests together.
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

**The option is named `identity`, matching `EntityEventProcessorOptions.identity`, and NOT `processorIdentity` as `packages/core` chose.** Both spellings already exist in the tree and they sit on different layers: a *generation/engine* option says `processorIdentity` (because `identity` there would collide with `GenerationId`, which is exactly why core rejected the short name), while the thing *accompanying a processor object* says `identity` — `EntityEventProcessorOptions.identity`, and `ProcessorArrival.identity` in `@etherfold/utils`. `VersionedStateProcessorOptions.identity` forwards straight into the former, in the same package family, so matching it is what keeps one concept one word at this layer. The alternative, renaming `EntityEventProcessorOptions.identity` to `processorIdentity` for tree-wide uniformity, was rejected because its only caller is `packages/cli/src/folding.ts` (`{identity}`), so the rename would require editing a sibling package and break criterion 4 and every parallel batch. What it touches: `the-cli-server-and-examples-take-their-identity-from-the-arrival` meets `identity` here and `processorIdentity` in core/cli; if either batch or the contract task wants one word everywhere, the rename is theirs to make in one commit rather than mine to make across a fence.

**Criteria 1 and 3 conflict inside these packages, and I resolved it the way the sibling batch did: the DECLARED path's own test suites stay.** `processor-sqlite/test/version.test.ts` is entirely assertions *about* `getVersionHash()`, the fingerprint and `PROCESSOR DRIFT`, and `lifecycle.test.ts`'s `describe('getVersionHash')` pins the declared formula. Those are `getVersionHash()` call sites, so criterion 1 read literally says migrate them — but they are not sites that *take* an identity, they are the witness that the old form still *works*, which criterion 3 requires and which `the-declared-version-and-the-drift-report-are-deleted` is explicitly tasked to delete. Rewriting them onto an arrival identity would not migrate the declared path, it would silently delete its coverage while leaving the code, which is the failure mode the task's own prompt warns about. `core-takes-its-identity-from-the-arrival` recorded the same judgement for one `streamBuilder.test.ts` case. So every site that *sources* an identity now sources it from the arrival, and the declared path's own suites are retained with a comment at each naming the task that retires them. The alternative (migrate literally everything) was rejected on the above; the other alternative (delete them here) is forbidden outright. What it touches: the contract task will find ~14 retained declared-path assertions in these two packages, labelled, rather than none.

**The forwarding to the inner fold is asserted by reading a PRIVATE field (`innerFoldOf` in `lifecycle.test.ts`).** The inner `EntityEventProcessor` is never asked its identity by anything in production — core holds the wrapper — so the forwarding is unobservable through the public surface, and an assertion is the only thing that stops a later edit dropping it and reintroducing two live answers to "which fold is this". The alternative considered was not testing it at all (it changes no current behaviour) or exposing the inner fold, which would widen a published surface to serve a test. `version.test.ts` already reaches into a private field the same way (`(p as unknown as {version}).version = undefined`), so this is precedented rather than novel; the helper's docstring says why the reach is there.
