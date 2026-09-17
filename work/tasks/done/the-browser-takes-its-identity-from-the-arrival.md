---
title: '`@etherfold/browser` takes its identity from the ARRIVAL'
slug: the-browser-takes-its-identity-from-the-arrival
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [a-deployment-runs-from-a-bundle-identified-by-its-hash]
covers: [6, 8]
---

## What to build

One MIGRATE batch of a wide refactor (`work/protocol/TASKING-PROTOCOL.md` 3a), scoped to `packages/browser`.

Move this batch's call sites off `processor.getVersionHash()` and onto the identity the ARRIVAL supplies, in both source and tests. The measured blast radius for this batch is roughly **10 `getVersionHash` call sites**; ground that against the code before you start rather than trusting the number, because sibling batches are landing around it.

Nothing is DELETED here. The declared `version`, `getVersionHash()` and the code fingerprint all still exist when this batch finishes: the contract task removes them once every batch has landed, and that is what lets each batch stay green on its own.

Note what this batch does NOT do: the HMR arrival, which has no bytes to hash, derives its identity differently and is `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`. This batch moves the ORDINARY browser paths onto the supplied identity and leaves that one alone.

Tests in this batch migrate WITH their source. A test gives a generation an identity by supplying BYTES rather than by declaring a version, which works because the engine compares identities for equality and never parses them, and because these suites assert on WHICH generation rather than on what the code does. Synthetic bytes are correct here; only a genuine instantiate round trip needs the committed bundle fixture.

## Acceptance criteria

- [ ] Every `getVersionHash()` call site in `packages/browser` takes its identity from the arrival instead, source and tests together.
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

**`updateProcessor` is deliberately NOT given a `processorIdentity`, and its suites stay on the declared path.** What arrives at that call is a MODULE OBJECT a dev server handed the tab: there are no bytes to hash, and `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` states in as many words that the app must not supply that arrival's identity ("do not let the app supply the identity … that is the author-declared identity re-entering through the one door left open"). Widening the options bag would have been the mechanical move (core already accepts `{force, processorIdentity}`) and would have let me migrate `reconfigure.test.ts` too, but it invents an input the HMR task would have to delete. So `reconfigure.test.ts`'s axis one and `liveReload.test.ts`'s four `updateProcessor` cases keep declaring versions, each labelled at the site with the task that owns them, and a `## WHY THERE IS NO processorIdentity HERE` section sits on `updateProcessor`'s JSDoc so the asymmetry with the generation spec is not a mystery. **Touches:** `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` (which will add the derivation there) and `an-hmr-update-reconfigures-the-tab-it-is-running-in`.

**Criteria 1 and 3 conflict on two `getVersionHash()` sites, and I resolved it the way the sibling batches did: a site that does not SOURCE an identity stays.** `callShape.test.ts`'s free-form fixture is a value asserted to be REFUSED by `@ts-expect-error` (the retired JS-object shape, ADR-0037) and names no generation; `reconfigure.test.ts:68` is a docstring describing the declared formula on the HMR axis above. Migrating either would delete coverage rather than move a caller. Alternative considered: migrate literally every occurrence — rejected because criterion 3 requires the declared form to go on WORKING and something inside this package has to witness that. **Touches:** the contract task will find two labelled declared-path sites here, plus the fixtures below, rather than none.

**Generation specs in suites that hold exactly ONE generation and never observe an identity keep the declared fallback** (`utils/applied.ts`, `browser/readWorkload.ts`, `workload.ts`'s base definition and every `indexerFor` caller that passes nothing). Migrating them would be churn with nothing observable behind it, and they are the live witness for criterion 3. The cost I am flagging: after `version` is deleted those fixtures have no identity at all, so the contract task's sweep includes them — `indexerForProcessor`/`runWorkload` now take an optional identity parameter precisely so that sweep is a one-line change per call site. **Touches:** `the-declared-version-and-the-drift-report-are-deleted`.

**The name is `processorIdentity`, reused verbatim from `GenerationSpec.processorIdentity` and `FoldParts.processorIdentity`.** Coherence check: `identity` alone would re-mean the glossary's *generation* (identity IS `{stream, processor}`), and `versionHash` would say DECLARED VERSION while holding a hash of bytes. No new concept is introduced by this batch; the browser threads an existing one. **Touches:** every caller of `createIndexerState`, `addGeneration` and the worker hosts — documented in the package README and in the changeset, because an accepted input the docs do not describe is a deployment believing something untrue.

**The test identity helper is DUPLICATED into `packages/browser/test/utils/` rather than shared, and deliberately kept OUT of `browser/workload.ts`.** `@etherfold/core` and `@etherfold/processor-entities` each already carry their own copy for the same reason (a test folder is not a published surface, and what is under test is that the hook takes WHATEVER it is handed). It hashes with `node:crypto`, which is fine for the Vitest half but would break the Playwright specs that load `workload.ts` inside a real browser — so the harness only ever PASSES an identity through and never derives one. **Touches:** nothing outside this package; a later batch wanting one shared helper would have three copies to fold together.

**`aTabHoldsItsGenerationsInSlots.test.ts` stopped PARSING generation identities.** It read the declared version off the front of one (`record.processor.split('-')[0]`) to name slots and to key IndexedDB databases, which is exactly what ADR-0086 says nothing may do and which a hash identity makes meaningless. It now asks a test-only reverse map (`markerOf`) for which bytes it hashed, and the fixture's `dropState` looks a connection up by the whole identity, as a real host does. Alternative: keep the parse and make the synthetic bytes start with a version-shaped prefix — rejected as teaching the suite a lie it would pass on.
