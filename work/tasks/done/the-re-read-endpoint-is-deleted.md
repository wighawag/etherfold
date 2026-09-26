---
title: 'The re-read endpoint is DELETED: code reaches a running Node process only by upload'
slug: the-re-read-endpoint-is-deleted
spec: run-is-configured-and-node-receives-uploads
blockedBy: [a-configured-start-folds-toward-exactly-its-configuration]
covers: [6, 7, 8]
---

## What to build

ADR-0094: the re-read endpoint (`POST /{indexer}/admin/reconfigure`) is deleted. Its dev loop is now `node` plus a watcher calling `etherfold upload`; a configured `run` changes its code by restarting.

**Delete, all of it** (the spec's re-read deletion list): the server route and `reconfigure-not-held` (`packages/server/src/api/admin.ts`); the `IndexerRegistryEntry.reconfigure` seam and its forwarding (`packages/server/src/registry.ts`); `ReconfigureArrival`'s `re-read` value (`packages/core/src/arrival.ts` and its export); the CLI reconfigurer and its exports (`reconfigurerFor`, `ReconfigureContext`). KEEP `arrivalQueue`, `ArrivalQueue` and `sameIdentity`, which `upload.ts` imports, moving them if their module goes. `ReconfigureReport` keeps its name.

**Re-home, don't lose, what the re-read was used for in tests**: every row marked `3` in the spec's Testing Decisions table. The re-read-only suites (`anEndpointReconfiguresARunningRun`, `aReconfigureReachesARunningDeployment`) are deleted. Each suite that used the re-read as its way to add a successor keeps the PROPERTY it asserts and reaches the successor by an upload to `node` or a `run` restart with a different `-p` or source; record which, per suite. `theDeploymentSelectsItsPromotionPolicy` needs both (the policy in-process on `node`, and `run`'s flag on a start-registered successor).

**Rewrite the `--promotion` rationale** (`config.ts`, "WHY ONLY ONE COMMAND SELECTS A PROMOTION POLICY"): it cites the re-read. Now `run` takes the flag because a successor registered at START still catches up while it runs, and `node` because uploads register successors while it runs. `NEVER_PROMOTES_BUILD` and `NEVER_PROMOTES_INDEX` cite the reconfigure route; reword them. The `--override` help ("A re-read and an upload replace...") too.

**Docs**: every doc naming the re-read: the browser README and `hotUpdate.ts` / `src/index.ts` JSDoc, `docs/guide/indexing-in-a-browser-app/index.md`, the CLI README, CONTEXT.md's generation entry (which describes the endpoint as how a reconfigure reaches a running deployment), ADR-0084:101 ("Only the START is guarded. The re-read..."), ADR-0085's "beside the re-read", ADR-0087's amendment (a re-read after a configured-source change). Dated amendments where the text described code.

## Acceptance criteria

- [ ] `POST /{indexer}/admin/reconfigure` no longer exists on any host; no `re-read` arrival value, no reconfigurer, no `IndexerRegistryEntry.reconfigure`.
- [ ] Every row marked `3` in the spec's table is handled as stated, and each re-homed test still asserts its property.
- [ ] The `--promotion` rationale, `NEVER_PROMOTES_BUILD`, `NEVER_PROMOTES_INDEX` and the `--override` help no longer cite the re-read.
- [ ] `grep` for `reconfigure` / `re-read` across `packages/*/src`, `packages/*/README.md`, `docs/guide/`, `docs/adr/` and `CONTEXT.md` finds only historical ADR text and `ReconfigureReport`; the hot update's docs describe two arrivals.
- [ ] ADR-0094's status line is NOT touched.
- [ ] Tests pass with the gate unchanged.
- [ ] Changesets for core, server, the CLI and browser (public types change).

## Blocked by

- `a-configured-start-folds-toward-exactly-its-configuration` -- serialised on the same files; its tests use the start path this re-homes onto.

## Prompt

The goal is ONE way code reaches a running Node process: the upload.

Read ADR-0094 and the spec (slug above), ADR-0085's sections after its 2026-09-22 amendment, and the arrival type's JSDoc in `@etherfold/core`.

The decisions most likely to be got wrong: deleting a test's property along with its re-read (re-home it); deleting `arrivalQueue` / `sameIdentity` with the reconfigurer; and leaving flag rationales that cite a route that no longer exists.

Done means: nothing in the code or the current docs describes a re-read endpoint, and every property the re-read suites asserted is still asserted.

FIRST, check this task against current reality. If the re-read's footprint differs from the list above, route to needs-attention with the discrepancy.

RECORD non-obvious in-scope decisions (in particular how each re-homed suite now adds its successor) in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.

## Decisions

- **How each re-homed suite now adds its successor:**
  - `theDeploymentSelectsItsPromotionPolicy`: both ways. Every case runs once on `node`, where the edited bundle is uploaded to the running process, and once on `run`, where the edited bundle is written to the same `-p` path and the process restarted with the flag over the same database. On `run` the "level" check now reads the registry's state cursor instead of `/status`, because a restarted `run` need not hold a fold for the incumbent.
  - `aRestartedDeploymentGoesOnAppending` ("the UPLOAD path to a running `node`") and `aRestartReFoldsTheStoredStream` ("holds TWO folds"): upload to `node`, since both properties are about a process that never stopped.
  - `aDeploymentRunsFromABundle`: a `run -p BUNDLE` start, then a `node` over the same database sent the same bytes (`unchanged`, same hash) and then the edited bytes (`registered`, new hash). This keeps the "a start and an arrival never name the same bytes differently" property.
  - `aSuccessorOnANewStreamIsFetchedByItsOwnWriter`, the configured-source case: a `run` restart with a changed `--deployments`.
  - Re-read halves dropped per the table: in `aBundleIsUploadedToARunningNode` the predecessor case now pins only the upload's behaviour; in `anUploadedProcessorSurvivesARestart` the `run` re-read case is gone and the upload case stays.
  - `anUploadReachesARunningDeployment` (server): the unused `reconfigure` stub was removed from the entry.
- **Reading of the grep criterion:** read literally it cannot be met. "reconfigure" is also the name of the in-place verbs (`ReconfigureOutcome`, `reconfigureFromHotUpdate`, `HostReconfigure`, the port's `reconfigure({source})`), and "re-read" is used generically in dozens of places. Renaming those public APIs is outside this task (the spec leaves the hot update unchanged), so I read the criterion as "nothing describes the re-read endpoint or arrival" and removed every such reference. The alternative was renaming public browser and core APIs.
- **A deleted route answers `404`, not `501`:** a missing capability (`501`) no longer applies because the route itself is gone. This is user-visible for anyone still calling the old path.
- **ADR history is amended, not rewritten:** statements in ADR-0084, 0085, 0087 and 0093 that named the re-read as current code are superseded by dated amendments. The original text is left as history; only one sentence in ADR-0087 was edited in place, with an inline dated note quoting what it used to say.
