---
title: '`etherfold node` RECEIVES uploads, and `run` stops receiving them'
slug: node-is-a-command-that-receives-uploads
spec: run-is-configured-and-node-receives-uploads
blockedBy: []
covers: [1, 2, 3, 4, 9, 10]
---

## What to build

ADR-0094: `run` is CONFIGURED and never receives code; a new seventh command, `etherfold node`, takes no processor and no source and receives code only by `etherfold upload`. This task adds `node` and moves everything upload-shaped from `run` to it, in ONE change, so no build ever has both or neither serving uploads.

- **`node`'s ownership row** is `run`'s with `processor` (`-p` / `--processor`), `source` (`--deployments`) and `override` REFUSED by name, the refusal pointing at `etherfold upload`. The environment variable `INDEXING_SOURCE` is NOT refused and NOT read (ADR-0048: an ambient variable a command does not own is simply not read; `NO_SOURCE_SERVE` in `config.ts` is the existing pattern). It takes `--promotion` and `--drop-on-promotion`; the indexer name defaults as on `run` (ADR-0052); chain, store and database as on `run`.
- **`node` is the waiting mode of ADR-0093 as its own command**: it reuses `openWaitingFolding`, `prepareWaiting`, the per-stream fetchers and `fetchesItsOwnStreams` as they are, serves the upload route (`POST /{indexer}/admin/upload`) and `/status`'s `cursor.waiting`, and never wires the re-read route (until `the-re-read-endpoint-is-deleted` removes it, it answers what a host without the seam answers).
- **`run` stops serving the upload route**, and `run` with neither processor nor source is REFUSED again, naming `etherfold node`. The upload path's configured-source branch (the match against `--deployments` / `INDEXING_SOURCE`) is DELETED: `node` never has a configured source.
- **`--promotion` / `--drop-on-promotion` are owned by `run` AND `node`.** Leave the `--promotion` rationale block in `config.ts` for `the-re-read-endpoint-is-deleted` to rewrite, but do not make it say only `run` takes the flag.
- **One database opened by both commands** (story 9): `run` over a `node` database is an ordinary configured start under TODAY's rules (the DISCARD rule is the next task's); `node` over a `run` database instantiates the canonical generation over the contracts its bundle carries, and where `run` had been given a source that bundle does not carry, serves it FROZEN with the reason and waits for the next upload. Measure that last case before asserting it.
- **Tests:** every row marked `1` in the spec's Testing Decisions table (spec slug above), including the two cases whose UPLOAD half moves to `node` while their re-read half stays on `run`, the `configuration.test.ts` rows, and the `anUploadedProcessorSurvivesARestart` helpers that start `run` with nothing configured. A moved suite keeps its assertions except where the table says otherwise.
- **Texts**: rewrite what this task makes false: `resolveRunProcessor`'s "give NEITHER ... waits for its first upload", the `run` help line "may be started with NEITHER", `startGuard.ts`'s "or with none, to keep it" (name `etherfold node`), `OVERRIDE_IS_THE_NODES`, `UPLOAD_DOES_NOT_PROMOTE`, `UPLOAD_CARRIES_ITS_CONTRACTS`, the CLI README (the command table, the upload and restart sections, a `node` section with the dev loop: `node` plus a watcher calling `etherfold upload`).

## Acceptance criteria

- [ ] `etherfold node` starts with chain, store and database only, waits, and `/status` says so; `etherfold upload` to it registers, fetches and folds. Asserted end to end.
- [ ] `node` refuses `-p` / `--processor` and `--deployments` by name; `INDEXING_SOURCE` set in its environment is ignored (asserted: it is not used as the source).
- [ ] `node` honours `--promotion` (e.g. `manual` holds a caught-up upload until asked).
- [ ] `run` does not serve the upload route; `run` with neither input is refused naming `etherfold node`.
- [ ] Every upload behaviour previously asserted on `run` holds on `node` (the spec's table, rows marked 1).
- [ ] Story 9 both ways, including the frozen case, asserted.
- [ ] CONTEXT.md's command set says seven, with `node` a deployment intent and `upload` a client; ADR-0048 (its 2026-09-26 amendments), ADR-0057 (the command-set amendment), ADR-0085 (the route "served by `etherfold run`" section and the relocated bullets on the contract match), ADR-0087's and ADR-0093's amendments carry dated amendments where this makes them false. Grep `docs/adr/` and `CONTEXT.md` for more.
- [ ] ADR-0094's status line is NOT touched (`an-arrival-of-the-predecessor-re-arms-it-as-successor` owns it).
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None -- can start immediately.

## Prompt

The goal is two commands with one source of truth each: `run` does what its configuration says, `node` does what was uploaded.

Read ADR-0094 first, then the spec (slug above; its Testing Decisions table is your checklist), ADR-0093 and its amendments, ADR-0048 and its amendments, ADR-0085's sections after its 2026-09-22 amendment.

The seams: the CLI's command program and ownership table (`config.ts`), `prepareIndexing` / `prepareWaiting` and the `run` wiring in `index.ts` / `run.ts`, the upload path (`upload.ts`), the start guard (`startGuard.ts`).

The decisions most likely to be got wrong: making `node` a flag or mode of `run` rather than its own command; refusing `INDEXING_SOURCE` on `node`; leaving a moment where both or neither command serves uploads; and rewriting moved assertions instead of moving them.

Done means: `etherfold node` + `etherfold upload` is the upload story, `run` receives no code, and every upload assertion still holds.

FIRST, check this task against current reality. If the waiting mode, the upload route or the start guard differ from what this assumes, route to needs-attention with the discrepancy.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.

## Decisions

- **`node` shares `run`'s code rather than being a mode of it.** At the CLI it is a separate command with its own config type (`NodeConfig`) and its own row in the ownership table. Internally, `run` and `node` call one private server-setup function and differ only in which route they wire. I rejected a flag on `run` (the task forbids it) and a copied `node.ts` (the two copies would drift). This touches the exported `PreparedIndexing` type: its `reconfigure` and `upload` fields are now optional.
- **`run` with a source but no processor gets the same refusal as `run` with neither.** Both now say "`--processor` is required by `etherfold run`" and point at `etherfold node`. The old "give NEITHER" way out no longer exists. This is user-visible refusal text.
- **`node` refuses `--prune-interval`, the ingest flags, `--to` and `--admin-token` exactly as `run` does**, reusing `run`'s refusal messages. Only `-p`, `--deployments` and `--override` got new node-specific messages.
- **Deleted the now-dead "nothing to re-read" branch in `reconfigure.ts`.** `run` can no longer start without a processor, so the branch could not be reached. The rest of the module is left for `the-re-read-endpoint-is-deleted`.
- **The predecessor case in `aBundleIsUploadedToARunningNode` still compares upload against re-read.** The re-read half builds its deployment on `run` by a restart; the upload half builds it on `node` with two uploads, a promotion, and then a restart so that nothing in the process is folding the predecessor (I did not measure whether that restart is strictly needed). Both deployments end up with the same generations in the same slots, and the side-by-side assertion still passes. Task 3 drops the re-read half.
- **The configured shape of the new-stream "survives a restart" case restarts as `run -p` naming the pending upload's own bundle.** Restarting with the canonical bundle would depend on "naming the canonical generation changes nothing", which task 2 changes to a discard. Naming the pending successor itself changes nothing both before and after task 2.
- **The upload/re-read "replace without a question" case is split in two.** Uploads replace a pending successor on `node`. On `run`, two re-reads (a third bundle, then the edited one) create a pending successor and then replace it, with nobody asked.
- **`anUploadCommandSendsABuiltBundle` seeds its `node` by posting to the upload route directly**, so the request counts the suite asserts on `etherfold upload` are unchanged.
- **Renamed the suite** `aRunNodeWithNothingConfiguredWaits.test.ts` to `aNodeWaitsForItsFirstUpload.test.ts`, and updated a comment in core's `aContainerOpenedWithNothingConfigured.test.ts` that pointed at the old path. That is a test-comment-only change in `@etherfold/core`, so I added no core changeset. If `changeset status` counts that test file as a change to core, the gate may ask for one.
- **Added a test that `node` answers the re-read route `501 reconfigure-not-held`.** It pins "`node` never wires the re-read" and takes the place of the deleted "re-read answers `failed`" case. `the-re-read-endpoint-is-deleted` should remove or adjust it.
- **Changed the server's `501 upload-not-held` message to name `etherfold node`**, and updated the regex in the server test `anUploadReachesARunningDeployment` to match, with a `@etherfold/server` patch changeset.
- **`equivalence.test.ts` was not edited.** The table marks it "comment edits only", but I found no comment there that this change makes false; the re-read comments are task 3's.
- **`etherfold node` prints its upload URL at start**, as the line an operator reads (`upload: <url>/<indexer>/admin/upload`).
