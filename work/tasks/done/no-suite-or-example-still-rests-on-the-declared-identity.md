---
title: 'The CLI suites and the `etherfold` example stop resting on the DECLARED identity, so the contract step can delete it'
slug: no-suite-or-example-still-rests-on-the-declared-identity
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [a-deployment-runs-from-a-bundle-identified-by-its-hash]
covers: [6, 8]
---

## What to build

The FIFTH migrate batch of a wide refactor (`work/protocol/TASKING-PROTOCOL.md` 3a), and the last one. It exists because the first four left a remainder that only becomes visible when you try to delete the old form.

Every place that SOURCES an identity has been migrated. What has not is every place that silently RESTS on the fallback: a deployment stood up through an injected `importModule`, which supplies no identity, so `processorIdentityOf` falls through to `processor.getVersionHash()`. That is correct today and becomes a deployment with NO NAME AT ALL the moment the contract task removes the declared half.

Move them off it, so that `the-declared-version-and-the-drift-report-are-deleted` really is the removal it describes.

**READ THIS BEFORE CONCLUDING THE TASK IS DRIFTED.** `work/tasks/done/the-cli-server-and-examples-take-their-identity-from-the-arrival.md`, Decisions #4, says these suites were left alone and that "the contract task's sweep is unaffected (they name no identity)". That sentence is TRUE and it is not a contradiction of this task. It is a statement about a TEXTUAL sweep: grep those files for `getVersionHash` and you will find nothing, which is exactly why the batch correctly left them. The dependency is not textual, it is a FALLBACK the code takes at run time. So a grep says they are clean and the test run says otherwise, and only the second one is the truth the contract task meets. Do not stop on the strength of that sentence; it and this task are both right.

**What this batch does NOT touch: the declared-path WITNESSES.** Three sites deliberately keep the old form because their subject IS the old form, and retiring them is the contract task's job rather than this one's: `packages/cli/test/anEndpointReconfiguresARunningRun.test.ts` (whole, it is the `PROCESSOR DRIFT` and `unchanged`-names-`version` suite), the two DECLARED cases inside `packages/cli/test/aDeploymentRunsFromABundle.test.ts`, and `nftProcessor.version` in `packages/cli/test/utils/chain.ts`. Batch 4 recorded each one and why. Migrating a witness does not move coverage, it deletes it while leaving the code, which is the failure that task's prompt warns about. Leave all three exactly as they are.

**The example.** `examples/event-processor-nfts` runs `etherfold build -p ./dist/cli.js`, a `tsc` output that imports its ABI and so is not self-contained, and `src/entities.ts` still carries `version: '1.0.0'`. The root `test` script includes `examples/*` on purpose, because an example is EVIDENCE and evidence nothing runs is a claim. So this one is inside "the whole tree is green" and has to move here. Batch 4 assigned it to `the-build-command-and-its-pinning-rule-are-documented`; that no longer works, because the docs task runs LAST and the contract task, which runs before it, is what breaks on this example. Use the command the two committed fixtures already use (`esbuild --bundle --format=esm --minify`, see `packages/cli/test/fixtures/processor-bundle/README.md`) rather than choosing a new one, so the docs task's "the refusal and the documentation name the same command" criterion stays reachable.

**`examples/browser-reference` is NOT yours.** It hands a tab a module object, and its identity comes from `a-module-handed-to-a-tab-is-identified-by-its-handler-sources`. Leave it.

Nothing is DELETED here and nothing is REFUSED here. The declared `version`, `getVersionHash()` and the code fingerprint all still exist when this batch finishes, an unbundled configuration still resolves, and no new refusal is introduced -- refusing is `a-path-naming-an-unbundled-entry-point-is-refused`, which is correctly blocked on the contract task. This batch only moves what rests on the fallback off it, which is what keeps it green on its own like the four before it.

## Acceptance criteria

- [ ] No suite in `packages/cli` or `packages/utils` stands a deployment up whose identity falls through to `getVersionHash()`, except the three declared-path witnesses named above, which are untouched.
- [ ] `examples/event-processor-nfts` runs from a self-contained BUNDLE, built with the same command the committed fixtures use, and no longer depends on its declared `version` for its identity.
- [ ] Demonstrated rather than asserted: with the declared fallback made to throw locally (a scratch edit you do NOT commit), this batch's suites and the example still pass. That is the only check that actually proves the remainder is gone, since a grep cannot see a fallback.
- [ ] Nothing is deleted: the declared `version`, `getVersionHash()` and the fingerprint still exist and still work, and no configuration that resolves today stops resolving.
- [ ] Nothing is refused: no new user-visible refusal is introduced, because that is another task's subject.
- [ ] No file OUTSIDE `packages/cli`, `packages/utils` and `examples/event-processor-nfts` is edited.
- [ ] The batch is GREEN on its own, with the rest of the tree unchanged.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-deployment-runs-from-a-bundle-identified-by-its-hash`, which built the bundle arrival this batch moves onto. It is done, so this is startable now.

> **ADDED 2026-09-18, after the contract task STOPPED on a false premise.** The contract task's body says "four migrate batches have already moved every caller, so this is a removal rather than a change". That was not true, and the reason is structural rather than careless: hashing bytes requires HAVING bytes, and the arrivals with no bytes were left behind by all four batches, each deferral written down at the time. Two of those remainders were handed to tasks that were themselves `blockedBy` the contract task, which deadlocked the family; those edges have been inverted. This batch is the third remainder, which had no owner at all. Measured and recorded in `work/notes/observations/the-adr-0086-contract-task-is-in-a-cycle-with-the-three-leaves-behind-it.md`, and in the surface commit `0e500dd9` on `main`.

## Prompt

The goal is that when the contract task deletes `getVersionHash()`, nothing goes dark.

Read **ADR-0086** for the invariant (an author cannot state their identity; the engine takes one and never asks where it came from), then `work/tasks/done/the-cli-server-and-examples-take-their-identity-from-the-arrival.md` in full -- especially its Decisions, which is where these remainders were deferred and which tells you exactly what each one is and why it was left. Then `packages/core/src/internal/processorIdentity.ts`, which is the one expression the whole engine asks and therefore the exact place the fallback lives.

GROUND THE BLAST RADIUS against the code before you start rather than trusting any list, including the one in this task body. The suites batch 4 named (`run.test.ts`, `indexCommand.test.ts`, `oneShot.test.ts`, `commands.test.ts`, `fixedTableNamespace.test.ts`, `generationNamespaceBesideFixedTables.test.ts` "and the rest") were named in passing, not enumerated, and there were roughly 71 `importModule` occurrences across `packages/cli` and `packages/utils` when this task was written. The criterion that matters is not "does it mention `importModule`" but "does its identity fall through to `getVersionHash()`", and the third acceptance criterion is how you find out.

The decision most likely to be got wrong is deciding these suites do not need migrating, because batch 4's decision record appears to say so. Read the note in "What to build" above before you act on that: batch 4 was making a claim about a textual sweep and it was right; this task is about a run-time fallback and is also right. If you STOP here, the family stays deadlocked for a second time.

The second: HOW to give an injected-module suite an identity. There are two shapes -- give the deployment real bytes (a bundle fixture, as `aDeploymentRunsFromABundle.test.ts` does), or keep the injection seam and have the arrival supply an identity explicitly. Prefer whichever keeps each suite's actual SUBJECT intact, because none of these suites is about identity: they are about namespaces, commands, one-shot behaviour and scheduling, and a migration that rewrites what they are testing has cost more than it bought. Say which you chose and why, per suite family rather than per file.

The third: do not delete the injected-importer test seam itself. Whether an injected `importModule` remains an accepted arrival at all is a question `a-path-naming-an-unbundled-entry-point-is-refused` owns, and removing the affordance here would decide it silently and out of order.

Done means: nothing rests on the declared fallback except the three witnesses that exist to prove it still works, the example ships a bundle, the old form is untouched, and the tree is green.

## Decisions

**`deps.processorIdentity` on `IndexingDependencies` / `IndexDependencies`, rather than converting the suites to bundle fixtures.** Both types are documented "what a test may substitute for the real world", and `importModule` already states WHAT comes back for a `--processor` path; this states what that thing is CALLED, which is what an arrival does. Alternatives considered: (a) point every suite at the committed `nfts.bundle.js` — rejected, its processor differs from `utils/chain.ts`'s (no burn branch), several suites need bespoke modules (reserved entity names, per-chain contract data, an `imported` spy), and a data-URL-evaluated module destroys the object identity three suites assert through, so it would rewrite subjects the prompt says to keep; (b) thread `readBundle` through — rejected, it takes the artifact route and evaluates the bytes, so it is (a) in disguise and cannot keep an injected module. **Precedence is `arrival.identity ?? deps.processorIdentity`**, so real bytes always win and the two can never need a refusal (criterion 5). **What it touches:** `a-path-naming-an-unbundled-entry-point-is-refused` still owns whether an injected importer is an accepted arrival — this neither answers nor forecloses that, and deletes no affordance. **Coherence:** `processorIdentity` is the name already used at this layer (`openFolding`'s context, `ReceivedGenerationSpec`, `FoldParts`) for exactly this thing; no new concept, no re-meaning.

**`FoldParts.generation` now carries `processorIdentity`, which is a source change beyond making the suites green.** Under a probe that deletes the `processorIdentityOf` fallback outright, *every* CLI deployment failed — including the bundle ones — because `foldPartsFor` returned only `createState`/`createProcessor`, so the container asked `processor.getVersionHash()`. That is a genuine "goes dark" site inside my packages, and the task's goal is that nothing does. The value is unchanged (it is the string the table namespace was already named from); only the container stops asking. Alternative: leave it to the contract task — rejected, it is inside this task's packages, it is value-preserving, and leaving it means the contract task discovers the CLI is not actually migrated. **What it touches:** `the-declared-version-and-the-drift-report-are-deleted` finds `packages/cli` fully green when it removes the fallback arm.

**The example borrows the workspace's esbuild binary instead of declaring a devDependency.** `examples/event-processor-nfts/package.json` runs `../../packages/utils/node_modules/.bin/esbuild`. Adding `esbuild` to the example would edit `pnpm-lock.yaml`, which is outside the three paths criterion 6 allows, and CI installs `--frozen-lockfile` so package.json and lock must move together. `packages/cli/test/fixtures/processor-bundle/README.md` already prescribes exactly this borrowing for this repo ("reach for the workspace's copy rather than adding a dependency a deployment would then carry"). The README shows a reader the plain `esbuild …` command instead. **Alternative:** add the dependency and accept the lockfile edit — rejected as a literal criterion-6 violation for a cosmetic gain. **What it touches:** `the-build-command-and-its-pinning-rule-are-documented` may prefer to declare the dependency once it is free to touch the lockfile; the command string it must match is unchanged.

**The example's bundle is built by `pretest`, and `build` now means `tsc && build:bundle`.** The suite drives the real bytes, so they must exist whether it is run alone or by the root `pnpm test`, which does not build examples. Folding the bundle into `build` also keeps the root `README.md`'s `build` → `build:db` sequence true without editing a file outside my scope. **Alternative:** build the bundle inside the test — rejected, it puts a bundler in the test path, which this repo's fixture README argues against.

**No `docs/spikes/` artifact for the probe.** Criterion 3 asks for a scratch edit explicitly *not* committed, and criterion 6 bars new files outside the three paths; the probe recipe and its numbers are recorded here and in the observation note instead, which is where they stay readable for the contract task.
