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

## Decisions

**`theDeploymentSelectsItsPromotionPolicy.test.ts` is moved onto the BUNDLE arrival, which reverses a "do not inline it back" comment the blocking task left.** `a-deployment-runs-from-a-bundle-identified-by-its-hash` pushed that suite's fixtures onto the module route (a sibling `abi.js` import) so the EXPAND step would not silently change their arrival, and said so at the site. Its stated reason was that the cases "express a successor as a `version` bump". This batch is the step that changes that: the successor is now one edited handler line in a self-contained module, so the sibling import no longer earns its keep and the fixture reads as what a real deployment ships. Alternative considered: leave it on the module route and migrate nothing there — rejected, because the suite's subject is WHEN THE POINTER MOVES and nothing in it is about the declared identity, so leaving it would have left a whole CLI suite naming generations by a field this family deletes. What it touches: the comment the blocking task wrote is gone from that file; `anEndpointReconfiguresARunningRun.test.ts` keeps its identical comment, deliberately (below).

**`anEndpointReconfiguresARunningRun.test.ts` is RETAINED whole on the declared arrival, labelled, and is this package's declared-path witness alongside `aDeploymentRunsFromABundle.test.ts`.** Criteria 1 and 3 conflict here and I resolved it the way all three sibling batches did: a site that does not SOURCE an identity, but WITNESSES that the old form still works, stays. That file's subject is the `PROCESSOR DRIFT` report and the `unchanged` message that names `version` — machinery that exists ONLY on the declared route, because it is the compensation for an identity an author had to remember. Rewriting it onto a bundle would not migrate the coverage, it would delete it while leaving the code, which is the failure the task's own prompt warns about. The same endpoint on the bundle arrival is already asserted in `aDeploymentRunsFromABundle.test.ts`. Alternative considered: split the non-drift cases onto bundles — rejected as duplicating the bundle suite while stranding the drift cases in a file whose fixture no longer produces them. What it touches: `the-declared-version-and-the-drift-report-are-deleted` will find one labelled CLI suite (plus `aDeploymentRunsFromABundle.test.ts`'s two declared cases and `utils/chain.ts`'s `nftProcessor.version`) to retire, rather than none.

**Both examples stay on the declared path, labelled, and I did NOT give either an identity.** `examples/browser-reference` hands a tab a module OBJECT (`createIndexerState`), and `examples/event-processor-nfts` runs `etherfold build -p ./dist/cli.js`, a `tsc` output that imports its ABI. Neither arrival derives an identity today. For the tab, `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` says in as many words "do not let the app supply the identity … that is the author-declared identity re-entering through the one door left open", so passing `processorIdentity` from the app — the mechanical move, since `createIndexerState` now accepts it — is forbidden rather than merely premature. For the CLI example, making it ship a bundle means adding a bundler and a build command to an example, which is `the-build-command-and-its-pinning-rule-are-documented`'s (it owns the documented command, and its own criteria reference the example). So both keep `version`, each with a label naming ADR-0086, the arrival it is on, why the old rule still applies there, and the task that retires it — because an example that teaches a rule being deleted without saying so is the "claim that stopped being true" this batch includes examples to prevent. What it touches: `a-module-handed-to-a-tab-is-identified-by-its-handler-sources` (which will migrate `browser-reference`) and `the-build-command-and-its-pinning-rule-are-documented` (which will migrate `event-processor-nfts`'s build). Alternative considered and rejected: a Vite `define`d build id as the browser example's identity — that is an author-declared identity wearing a build tool's hat, and it would set a user-visible pattern the HMR task then has to un-teach.

**The CLI suites that stand a deployment up through an injected `importModule` were left alone** (`run.test.ts`, `indexCommand.test.ts`, `oneShot.test.ts`, `commands.test.ts`, `fixedTableNamespace.test.ts`, `generationNamespaceBesideFixedTables.test.ts` and the rest). They inject the MODULE arrival, which legitimately supplies no identity, and none of them sources or asserts one — they derive namespaces from what the deployment registered. Migrating them would have meant writing a bundle per case and deleting the injected-importer affordance, for no observable change. Alternative considered: convert them all to bundles — rejected as churn that removes a test seam. What it touches: the contract task's sweep is unaffected (they name no identity), but `a-path-naming-an-unbundled-entry-point-is-refused` will have to decide whether an injected `importModule` is still an accepted arrival, and these suites are where that lands.

**`SnapshotProcessorMismatchError`'s message now says "computed by processor `x`" rather than "by processor version `x`".** A user-visible string, so I am flagging it rather than burying it. It is a one-word honesty fix, not a predicate or format change: the value is compared for equality and never parsed, and `@etherfold/processor-entities`'s equivalent message already reads exactly this way, so this removes a disagreement between two messages about the same rule. What it touches: `a-snapshot-is-labelled-with-the-identity-it-was-computed-under` owns the VALUE in that field and may reshape the wording further; I claimed none of that, and left the envelope, the format number and the candidate predicate untouched.

**The CLI's test identity helper IMPORTS `processorArtifactIdentity` where the other three packages re-spell it.** Core, `processor-entities` and `processor-sqlite` each recorded that they spell `sha256:<hex>` themselves because they cannot depend on `@etherfold/utils`. `packages/cli` can and does — `aDeploymentRunsFromABundle.test.ts` already reads its own deployments' identities through that function — so a second spelling here could disagree with the one the CLI actually runs. Recorded because it looks like an inconsistency with the three siblings and is the opposite: the reason those three forked is a dependency direction that does not apply here.
