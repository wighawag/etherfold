---
title: 'An arrival naming the PREDECESSOR re-arms it as successor, so a rollback by upload or by configuration actually rolls back'
slug: an-arrival-of-the-predecessor-re-arms-it-as-successor
spec: run-is-configured-and-node-receives-uploads
blockedBy: [the-re-read-endpoint-is-deleted]
covers: [5]
---

> Rewritten 2026-09-26 when the spec `run-is-configured-and-node-receives-uploads` was tasked: the re-read arm is gone (the endpoint is deleted by the task before this one), the upload arm is on `node`, and a configured start naming the predecessor re-arms it too.

## What to build

Today, when an arrival names the generation the `predecessor` slot holds, the registry resolves the identity to the record it already has, the record STAYS in `predecessor` (a slot already naming it is not re-armed), the answer is `registered`, and this process starts FOLDING it (`folding: held`). So a rollback by upload does not roll back (nothing puts it in `successor` or moves the pointer), and an engine runs for a generation nobody reads, which ADR-0092 says a predecessor should not have. This is the observation `an-upload-of-the-predecessor-folds-it-without-promoting-it`; the behaviour is pinned today in `aBundleIsUploadedToARunningNode` (the predecessor case, on `node` since `node-is-a-command-that-receives-uploads`).

**Decided by the maintainer on 2026-09-26 (ADR-0094): RE-ARM it.** An arrival naming the generation `predecessor` holds MOVES it into `successor`: the `predecessor` slot is emptied, and the slot's usual rules apply from there. The arrivals are:

- **an upload on `node`**: replaces a different pending successor without asking, as any upload does;
- **a configured start on `run`, `build` or `index` whose `-p` names it**: a rollback by configuration (ADR-0094: configuration is the truth). Replacing a DIFFERENT pending successor is guarded by the start guard as any start is; with nothing pending there is nothing to ask.

The promotion policy then decides as for any successor: under `on-catch-up` it catches up (from where its own state stood) and is promoted, and the generation it replaces as canonical becomes `predecessor`. The answer stays `registered`.

- The rule belongs to the registry / container, the same for every arrival and for both containers where the slot rule is shared (`displacedBySuccessor` and its twin); do not special-case the upload route.
- An arrival naming the CANONICAL generation, or the pending successor itself, is unchanged (`a-configured-start-folds-toward-exactly-its-configuration` owns what a start naming the canonical generation does).
- Where the predecessor sits on a stream this deployment does not fetch, it is fetched as any new-stream successor is (ADR-0087's 2026-09-26 amendment).

## Acceptance criteria

- [ ] Upload the predecessor's bytes to a running `node`: it moves to `successor`, `predecessor` is empty, it catches up and under `on-catch-up` is promoted; the generation it replaced becomes `predecessor`. End to end with `etherfold upload`.
- [ ] `run -p v1` after `v2` was promoted over `v1` (by a `run -p v2` restart, and by an upload to a `node` over the same database): `v1` is re-armed and promoted back; with a DIFFERENT generation pending, the start guard applies.
- [ ] Under `manual` it waits in `successor`, folded, and is promoted only when asked.
- [ ] No engine is left running for a generation `predecessor` names, asserted.
- [ ] The test pinning today's behaviour is changed to the new behaviour, not deleted.
- [ ] ADR-0084 and ADR-0092 carry dated amendments; CONTEXT.md's slot entry says what is now true. Grep `docs/adr/` and `CONTEXT.md` for claims this makes false (for instance "a slot already naming it is not re-armed").
- [ ] The observation `an-upload-of-the-predecessor-folds-it-without-promoting-it` is DELETED.
- [ ] **ADR-0094's `status: accepted, not yet implemented` line is REMOVED, leaving NO status line** (`work/protocol/ADR-FORMAT.md`: absent means accepted and current; `accepted, implemented` is not a valid value). This task is the last of the chain and owns the removal. Check first that every consequence of ADR-0094 is built; if one is not, route to needs-attention rather than removing the line.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- `the-re-read-endpoint-is-deleted` -- the last task before this in the chain; this one removes ADR-0094's status line.

## Prompt

The goal is that sending the previous version to a node, or configuring it again, is a rollback through the same catch-up-and-promote path every deploy takes.

Read ADR-0094, ADR-0084 and all its amendments, ADR-0092 and its amendments, ADR-0057 (the revert, the OTHER way back, unchanged).

The seams: the generation registry in `@etherfold/core` (how `add` resolves an identity it already holds, and the slot assignment), `ReceivingIndexer.add` / `open` and its chain-facing twin, the upload suites and `anUploadedProcessorSurvivesARestart`.

The decisions most likely to be got wrong: copying the predecessor into `successor` while leaving it in `predecessor` (one generation in two slots, which the registry forbids); moving the pointer directly instead of going through `successor` and the policy; and putting the rule in the upload route rather than the registry.

Done means: upload the old bundle, or restart `run` with the old `-p`, and the node goes back to it through a normal promotion, with nothing running for a generation nobody reads, and ADR-0094 no longer says it is unimplemented.

FIRST, check this task against current reality. If the registry already re-arms somewhere, route to needs-attention with the measurement.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.

## Decisions

- **A `run` restarted with an unchanged `-p` after an operator's revert now undoes the revert.** After a revert, `predecessor` names the generation the operator reverted away from, and an unchanged `-p` still names it. So under ADR-0094's literal rule ("a start naming the generation `predecessor` holds RE-ARMS it") it is re-armed and promoted. I followed the rule, because ADR-0094 makes configuration the truth on `run` and rejects rules that treat configuration as stale in some states. The alternatives were to STOP, or to exempt reverts, which the slots can't tell apart from promotions. On `run`, a revert that should survive a restart now needs `-p` changed too; a `node` restart keeps the revert. The suite "a REVERT survives a restart" is rewritten to show both, and this is recorded in the ADR-0046 and ADR-0084 amendments and the changeset. It touches `run`, `build`, `index` and the ADR-0057 revert, whose verb is unchanged. It is cheap to reverse, but a maintainer should ratify it.
- **A predecessor the process still folds is also re-armed.** A same-stream promotion keeps folding the old generation it built in this process, and uploading its bytes used to answer `unchanged`. `add` now resolves a held identity without a second fold, like the browser-side container already does. The upload route reads the slots only to decide whether to answer `unchanged`; the re-arm itself stays in the registry. The alternative, leaving `unchanged` there, would have left the most common in-session rollback broken. This touches `ReceivingIndexer.add` and the upload's `unchanged` answer.
- **Re-arm applies only to registrations into `successor`.** A `create` with no slot leaves the predecessor where it is. It touches `GenerationRegistry.create` only.
- **I did not change the same-stream retention of an old fold.** Within one `node` session, the fold that `add` built for a superseded generation keeps running as `predecessor`. That is existing behaviour for every promotion, not just rollbacks, and changing it would affect reverts on hosts that can't rebuild code from stored bytes. So the "no engine for `predecessor`" criterion is asserted in the restart shape, where it holds, and the in-session gap is captured in `work/notes/observations/a-same-stream-promotion-keeps-folding-the-predecessor-it-built.md`.
