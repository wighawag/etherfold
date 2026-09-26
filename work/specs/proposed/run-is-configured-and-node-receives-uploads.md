---
title: '`run` is CONFIGURED, and a new command `node` RECEIVES uploads'
slug: run-is-configured-and-node-receives-uploads
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions, here ADR-0094) + the code.

## Problem Statement

`etherfold run` learns what to run from two places at once: its configuration (`-p`, `--deployments`, `INDEXING_SOURCE`) and its registry, fed by `etherfold upload`. Every interaction between the two has needed a rule: an upload must match a configured source; a start may not silently replace an uploaded successor (`--override`); and a restart with an unchanged `-p v1` after `v2` was uploaded and promoted would roll the node back, because a configured processor is an arrival. That last case has no good rule, since the same `-p v1` means "run v1" before any upload and "stale configuration" after one. The dev loop is also split across two mechanisms (the re-read endpoint and the upload).

## Solution

ADR-0094: each command has ONE source of truth.

- **`run` is CONFIGURED** and never receives code: no upload route, no re-read route. A restart with a different `-p` is a deploy, including one naming the predecessor.
- **`node` RECEIVES**: the chain, store and database like `run`, and NO processor and NO source. Code arrives only by `etherfold upload`. It is the waiting mode of ADR-0093, as its own command.
- **The re-read endpoint is deleted.** The dev loop is `node` plus a watcher calling `etherfold upload`.

## User Stories

1. As an operator, I want `etherfold node` to start with only a chain, a store and a database, wait for its first upload, and say so on `/status`, so that a node is stood up once and deployments arrive.
2. As an operator, I want `node` to REFUSE `-p`, `--deployments` and `INDEXING_SOURCE` by name, so that nothing on its command line can compete with what was uploaded.
3. As an operator, I want every upload behaviour built for `run` (refusals before registering, catch-up beside the incumbent, promotion, survival across a restart, a new-stream upload fetched by its own writer, `/status` and the admin listing) to hold on `node` unchanged.
4. As an operator, I want `run` to refuse an upload (the route is not served there) and to be refused when started with neither processor nor source, so that a configured deployment's code is exactly its configuration.
5. As an operator, I want a restart of `run` with a different `-p` to be a deploy, including one naming the predecessor (a rollback by configuration), with the existing start guard protecting a pending successor.
6. As an author, I want my dev loop to be `etherfold node` plus a watcher that calls `etherfold upload` on each build, so that development exercises the path production uses.
7. As a maintainer, I want the re-read endpoint, the CLI reconfigurer and the `re-read` arrival value deleted, so that there is one way code reaches a running Node process.
8. As an operator, I want one database to be openable by either command: `run` over a `node` database treats it as a configured start (configuration is the truth, the start guard protects a pending upload), and `node` over a `run` database runs what the registry names.
9. As a reader of the docs, I want the command set, the CLI README, CONTEXT.md, the examples and the guides to describe seven commands, `node` among the deployment intents and `upload` as a client.

## Implementation Decisions

- `node` shares `run`'s assembly (the waiting-mode wiring built for ADR-0093: `openWaitingFolding`, `prepareWaiting`, the late per-stream fetchers) and its server shape; it is a new row in the ownership table, not a flag on `run`.
- `node` takes `--promotion` as `run` does. It takes no `--override`, since its starts replace nothing.
- `run` loses: the upload route, the waiting mode, the re-read route, `ReconfigureArrival`'s `re-read`. It keeps: `-p`, the source flags, the start guard, successor-at-open, the per-stream fetchers, `fetchesItsOwnStreams`.
- The upload route's configured-source branch is deleted (on `node` there is never a configured source).
- ADR-0093's `status: superseded in part by ADR-0094` is already set. ADR-0094's `status: accepted, not yet implemented` line is REMOVED by the last task, leaving no status line.
- The task `an-arrival-of-the-predecessor-re-arms-it-as-successor` (already in the staging folder) should land AFTER `run` stops receiving uploads, so that no build ever has a `run` on which a stale `-p` rolls back an upload.

## Testing Decisions

- The existing upload suites (`aBundleIsUploadedToARunningNode`, `anUploadCommandSendsABuiltBundle`, `aRunNodeWithNothingConfiguredWaits`, `anUploadedProcessorSurvivesARestart`, `aSuccessorOnANewStreamIsFetchedByItsOwnWriter`) move to `node` rather than being rewritten; their assertions stay.
- New assertions: `run` does not serve the upload route; `run` with neither input is refused; `node` refuses each code or source input by name; the cross-over in both directions (story 8).
- The re-read suites (`anEndpointReconfiguresARunningRun`, `aReconfigureReachesARunningDeployment`) are deleted with the route, and anything else they covered that still matters is re-homed.

## Proposed tasking (for review)

1. `node-is-a-command-that-receives-uploads`: add `node` (ownership row, program, help, README), move the waiting mode and the upload route to it, move the upload suites, refuse code and source inputs on it. `run` stops serving the route in the SAME task, so no intermediate state has both.
2. `the-re-read-endpoint-is-deleted`: delete the route, the reconfigurer, `re-read`, their suites, and every doc that describes the re-read as a dev loop; point at `node` plus `upload`.
3. `an-arrival-of-the-predecessor-re-arms-it-as-successor` (exists): re-point its tests from `run` to `node` for the upload arm and add the `run -p` rollback-by-configuration arm; blockedBy 1.
4. The last of these removes ADR-0094's status line and adds the dated amendments to ADR-0048, ADR-0057, ADR-0085 and ADR-0093, and updates CONTEXT.md's command-set entry.

## Out of Scope

- A split form of `node` (a receiver of uploads fed by a separate `fetch`): ADR-0093's "later".
- A `deploy` command that builds and uploads, and any file watcher inside the CLI.
- Renaming `ReconfigureReport`.
- The browser's hot update, which is unchanged.
