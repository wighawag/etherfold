---
title: '`run` is CONFIGURED, and a new command `node` RECEIVES uploads'
slug: run-is-configured-and-node-receives-uploads
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions, here ADR-0094) + the code.

> **REVISED 2026-09-26, before tasking**, after a review that found it contradicted ADR-0048 and ADR-0084's amendment, left `--promotion` on `run` undecided, and claimed the moved suites keep their assertions when several cannot. The maintainer decided the three open points the same day (recorded in ADR-0094's revision): a configured start naming the canonical generation DISCARDS a different pending successor behind the start guard; `node` refuses the `-p` and `--deployments` FLAGS and does not read `INDEXING_SOURCE`; `run` keeps `--promotion` and `--drop-on-promotion`.

## Problem Statement

`etherfold run` learns what to run from two places at once: its configuration (`-p`, `--deployments`, `INDEXING_SOURCE`) and its registry, fed by `etherfold upload`. Every interaction between the two has needed a rule: an upload must match a configured source; a start may not silently replace an uploaded successor (`--override`); a restart with an unchanged `-p v1` after `v2` was uploaded and promoted would roll the node back, because a configured processor is an arrival; and a configured start naming the canonical generation leaves a pending successor to be promoted, so `run` can serve code its configuration does not name. The dev loop is also split across two mechanisms (the re-read endpoint and the upload).

## Solution

ADR-0094: each command has ONE source of truth.

- **`run` is CONFIGURED** and never receives code: no upload route, no re-read route. What it folds toward is exactly what `-p` names.
- **`node` RECEIVES**: the chain, store and database like `run`, and NO processor and NO source. Code arrives only by `etherfold upload`. It is the waiting mode of ADR-0093, as its own command.
- **The re-read endpoint is deleted.** The dev loop is `node` plus a watcher calling `etherfold upload`.

## User Stories

1. As an operator, I want `etherfold node` to start with only a chain, a store and a database, wait for its first upload, and say so on `/status`, so that a node is stood up once and deployments arrive.
2. As an operator, I want `node` to REFUSE the `-p` / `--processor` and `--deployments` flags by name, pointing at `etherfold upload`, and to not read `INDEXING_SOURCE` (ADR-0048's rule for an ambient variable a command does not own), so that nothing on its command line competes with what was uploaded and one host can still run it beside a configured command.
3. As an operator, I want every upload behaviour built for `run` (refusals before registering, catch-up beside the incumbent, promotion, survival across a restart, a new-stream upload fetched by its own writer, `/status` and the admin listing) to hold on `node`, with `--promotion` and `--drop-on-promotion` meaning what they mean on `run`.
4. As an operator, I want `run` to not serve the upload route, and to be refused when started with neither processor nor source (naming `etherfold node`), so that a configured deployment receives no code.
5. As an operator, I want a start of `run` to fold toward exactly what `-p` names: a different processor registers as successor (unchanged); the canonical processor while a DIFFERENT successor is pending DISCARDS that successor behind the start guard; the pending successor itself changes nothing; the predecessor re-arms (a rollback by configuration).
6. As an operator, I want `run` to keep `--promotion` and `--drop-on-promotion`, because a successor registered at start still catches up while it runs; the flag's rationale and help say so rather than citing the re-read.
7. As an author, I want my dev loop to be `etherfold node` plus a watcher that calls `etherfold upload` on each build, so that development exercises the path production uses.
8. As a maintainer, I want the re-read endpoint and everything that exists only for it deleted, so that there is one way code reaches a running Node process.
9. As an operator, I want one database to be openable by either command: `run` over a `node` database is an ordinary configured start (story 5); `node` over a `run` database runs the canonical generation over the contracts its bundle carries, and serves it FROZEN with the reason, waiting for the next upload, where `run` had been given a source that bundle does not carry.
10. As a reader of the docs, I want the command set, the CLI README, CONTEXT.md, the guides, the browser docs and the ADRs to describe seven commands, `node` among the deployment intents and `upload` as a client, and no re-read endpoint.

## Implementation Decisions

- **`node`'s ownership row** is `run`'s row with `processor` and `source` (`--deployments`) refused and `override` refused; `promotion`, `dropOnPromotion`, the indexer name (defaulted as on `run`, ADR-0052), the chain, store and database as on `run`. `INDEXING_SOURCE` is not read. It shares `run`'s waiting-mode assembly (`openWaitingFolding`, `prepareWaiting`, the per-stream fetchers, `fetchesItsOwnStreams`) and server shape, and never wires the re-read route (it answers what a host without the seam answers until the route is deleted).
- **`run` loses:** the upload route, the waiting mode, the re-read route, the configured-source branch of the upload path. **`run` keeps:** `-p`, the source flags, the start guard, successor-at-open, the per-stream fetchers, `fetchesItsOwnStreams`, `--promotion`, `--drop-on-promotion`.
- **The re-read deletion list** (all of it, one task): the server route and `reconfigure-not-held` (`packages/server/src/api/admin.ts`), the `IndexerRegistryEntry.reconfigure` seam and its forwarding (`packages/server/src/registry.ts`), `ReconfigureArrival`'s `re-read` (`packages/core/src/arrival.ts`, and its export), the CLI reconfigurer and its exports (`reconfigurerFor`, `ReconfigureContext`; KEEP `arrivalQueue`, `ArrivalQueue` and `sameIdentity`, which `upload.ts` imports, moving them if their module goes), and every doc that names the re-read: the browser README and `hotUpdate.ts` / `src/index.ts` JSDoc, `docs/guide/indexing-in-a-browser-app/index.md`, the CLI README, CONTEXT.md's generation entry. Changesets for every package whose public types change (core, server, cli, browser).
- **Refusal and help texts** that would point a user at a mode that no longer exists are rewritten where the task that removes the mode lands: `startGuard.ts`'s "or with none, to keep it" (name `etherfold node`), `resolveRunProcessor`'s "give NEITHER, and the node starts with nothing configured and waits" and the `run` help line saying it "may be started with NEITHER" (both task 1), the `--override` help, `OVERRIDE_IS_THE_NODES`, `UPLOAD_DOES_NOT_PROMOTE`, `UPLOAD_CARRIES_ITS_CONTRACTS`, `NEVER_PROMOTES_BUILD` / `NEVER_PROMOTES_INDEX` (which cite the reconfigure route), the `--promotion` rationale block in `config.ts`, and the CLI README's upload and restart sections.
- **Every task amends the ADRs and glossary entries its OWN change makes false**, never leaving it to a later task. Known candidates: ADR-0048 (its two 2026-09-26 amendments), ADR-0057 (the command-set amendment), ADR-0084:101 ("Only the START is guarded. The re-read..."), ADR-0085 (its route "served by `etherfold run`" section, and in its relocated decisions the bullets "Everything that can refuse ... the contract match" and "The contract match applies only to a source the OPERATOR configured", both false after task 1, and "beside the re-read", false after task 3), ADR-0087's 2026-09-26 amendment (`run` with nothing configured; a re-read after a configured-source change), ADR-0093's amendments, CONTEXT.md's command-set and generation entries. Each task still greps `docs/adr/` and `CONTEXT.md` for more.
- **ADR-0094's `status: accepted, not yet implemented` line** is removed by the LAST task of the chain below, named: `an-arrival-of-the-predecessor-re-arms-it-as-successor`. ADR-0093's `superseded in part by ADR-0094` line stays.

## Testing Decisions

Every existing suite that uses `run` as an upload target or the re-read as a way to add a successor gets an explicit fate, owned by one task. "Re-home" means: keep the PROPERTY the test asserts, reach the successor another way (an upload to `node`, or a `run` restart with a different `-p` or source), and record in the task which.

| Suite (lines as of 2026-09-26) | Fate | Task |
| --- | --- | --- |
| `aBundleIsUploadedToARunningNode` | moves to `node` | 1 |
| ...its configured-source refusal case (~:420) | deleted with the branch | 1 |
| ...its "predecessor upload behaves exactly as a re-read" case (~:504-543; its helper `aNodeWithAnUnheldPredecessor` builds and upgrades a `run`) | upload half moves to `node` (two uploads and a promotion make the predecessor) and pins today's behaviour; the re-read half stays on `run` | 1 |
| ...that case's re-read half | dropped | 3 |
| `anUploadCommandSendsABuiltBundle` | moves to `node`; its contract-mismatch case deleted | 1 |
| `aRunNodeWithNothingConfiguredWaits` | becomes `node`'s suite; its "re-read answers `failed`" case (~:176-190) deleted | 1 |
| `anUploadedProcessorSurvivesARestart`, nothing-configured cases | move to `node` | 1 |
| ...its `run -p` start cases over uploaded state (~:330-475) | re-expressed as upload-to-`node`, restart as `run -p` (story 9), assertions kept; the "names the canonical processor changes nothing" case then changed to story 5's DISCARD | 1, then 2 |
| ...its "an upload and a re-read each replace it" case (~:477-530; it starts `run -p` and uploads to it) | upload half moves to `node`; the re-read half stays on `run` | 1 |
| ...that case's re-read half | dropped | 3 |
| `aSuccessorOnANewStreamIsFetchedByItsOwnWriter`, nothing-configured shape | moves to `node` | 1 |
| ...its CONFIGURED shape (`run -p` receiving uploads) | re-expressed on `node`, or as a `run` restart with a changed source; recorded | 1 |
| ...its "re-read after the operator changed a configured source" case (~:542-578) | re-homed onto a `run` restart with a changed source | 3 |
| `anEndpointReconfiguresARunningRun` (cli), `aReconfigureReachesARunningDeployment` (server) | deleted | 3 |
| `theDeploymentSelectsItsPromotionPolicy` (~:183-271, its only successor arrival) | re-homed: upload to `node` for the in-process policy, and a `run` restart for `run`'s flag | 3 |
| `aRestartedDeploymentGoesOnAppending` (~:465-489), `aRestartReFoldsTheStoredStream` (~:276-283), `aDeploymentRunsFromABundle` (~:287-340) | re-homed | 3 |
| server `anUploadReachesARunningDeployment` (~:365, re-read mention) | adjusted with the seam | 3 |
| `equivalence.test.ts` | comment edits only | 1 |
| `configuration.test.ts`, the block "`run` may be started with no processor and no source..." (~:753-806) | becomes `node`'s ownership assertions; `run` with neither is refused naming `node` | 1 |
| `configuration.test.ts`, "is owned by the ONE command that can apply it" (~:706, `--promotion` / `--drop-on-promotion`) | now owned by `run` and `node` | 1 |
| `anUploadedProcessorSurvivesARestart` helpers that start `run` with nothing configured (`whatTheRegistryHolds`, `aNodeStoppedMidUpgrade`, used by the `build` / `index` start-guard block ~:532-617) | start `node` instead | 1 |
| core `aPendingSuccessorSurvivesARestart`, "...names the canonical generation, which changes nothing" (~:81-98) | becomes the DISCARD case (asked; successor deleted; not promoted) | 2 |

New assertions: `run` does not serve the upload route; `run` with neither input is refused naming `node`; `node` refuses `-p` and `--deployments` by name and ignores `INDEXING_SOURCE`; `node` honours `--promotion`; story 5's four cases on `run`, each through the start guard where it applies; story 9 in both directions, including the frozen case.

## Tasking (strict chain; each task is blocked by the previous one)

1. **`node-is-a-command-that-receives-uploads`**: add `node` (ownership row, program, help, README, CONTEXT.md's command set); move the waiting mode and the upload route to it and stop serving the route on `run` in the SAME task, so no state has both or neither; refuse `run` with neither input; the suite fates marked 1; story 9's cross-over tests with today's configured-start rule; the ADR amendments this makes false.
2. **`a-configured-start-folds-toward-exactly-its-configuration`**: story 5's DISCARD rule, with the start guard, on `run`, `build` and `index` (ADR-0094: the maintainer extended it to all three configured commands on 2026-09-26). The rule lives in core: `open()` discards the pending successor BEFORE `foldTheSuccessor`, through the registry's `deleteGeneration` (row, state, bytes), where the configured fold is the canonical generation and `successor` names a different one. Today `confirmTheStartMayReplace` returns early exactly then (`slotHolding(slots, arriving)`), and `SuccessorReplacementAtStart` means "arriving would take the successor slot", so the confirm payload gains a DISCARD variant and `startGuardFor` its own wording (its current "register ... in the `successor` slot, which REPLACES" would be false for a discard). The rows marked 2; ADR-0084 and ADR-0093 amendments; core and cli changesets.
3. **`the-re-read-endpoint-is-deleted`**: the whole deletion list; the suite fates marked 3; the `--promotion` rationale and refusal texts rewritten (story 6); the ADR and doc amendments this makes false.
4. **`an-arrival-of-the-predecessor-re-arms-it-as-successor`** (already staged; rewritten at tasking): drops its re-read criterion and seam; the upload arm on `node`, the configured-start arm on `run`; removes ADR-0094's status line.

## Detail moved

Tasked on 2026-09-26, as a strict chain, into `node-is-a-command-that-receives-uploads`, `a-configured-start-folds-toward-exactly-its-configuration`, `the-re-read-endpoint-is-deleted` and `an-arrival-of-the-predecessor-re-arms-it-as-successor` (rewritten). The decisions live in ADR-0094; the Testing Decisions table above is the tasks' shared checklist and is left in place for them.

## Out of Scope

- A split form of `node` (a receiver of uploads fed by a separate `fetch`): ADR-0093's "later".
- A `deploy` command that builds and uploads, and any file watcher inside the CLI.
- Renaming `ReconfigureReport`.
- The browser's hot update, which is unchanged apart from the `re-read` value leaving the arrival type.
