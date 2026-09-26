---
title: 'An arrival naming the PREDECESSOR re-arms it as successor, so a rollback by upload actually rolls back'
slug: an-arrival-of-the-predecessor-re-arms-it-as-successor
blockedBy:
  - a-successor-on-a-new-stream-is-fetched-by-its-own-writer
covers: []
---

## What to build

Today, when an arrival (the re-read, an upload) names the generation the `predecessor` slot holds, the registry resolves the identity to the record it already has, the record STAYS in `predecessor` (a slot already naming it is not re-armed), the answer is `registered`, and this process starts FOLDING it (`folding: held`). So a "rollback by upload" does not roll back (nothing puts it in `successor` or moves the pointer), and it leaves an engine running for a generation nobody reads, which ADR-0092 says a predecessor should not have. This is the observation `an-upload-of-the-predecessor-folds-it-without-promoting-it`, and the behaviour is pinned today by `packages/cli/test/aBundleIsUploadedToARunningNode.test.ts` ("uploading the bytes of the `predecessor` behaves exactly as a re-read of that identity").

**Decided by the maintainer on 2026-09-26: RE-ARM it.** An arrival naming the generation `predecessor` holds MOVES it into `successor`: the `predecessor` slot is emptied, and the slot's usual rules apply from there. Registering into an occupied `successor` replaces its occupant as it always does (ADR-0084), and a START doing that to a DIFFERENT pending successor is guarded exactly as any start is (ADR-0084's 2026-09-26 amendment: asks on a TTY, refused non-interactively unless `--override`); the re-read and an upload replace without asking. The promotion policy then decides as for any successor: under `on-catch-up` it catches up (from where its own state stood, so usually quickly) and is promoted, and the generation it replaces as canonical becomes `predecessor` as on any promotion. The answer stays `registered`, since a generation now sits in `successor` that did not.

- The rule belongs to the registry / container and is the same for every arrival and both containers where the slot rule is shared (`displacedBySuccessor` and its twin); do not special-case the upload route.
- An arrival naming the CANONICAL generation, or the pending successor itself, is unchanged (`unchanged` / nothing moves).
- A START with a configured `--processor` naming the predecessor re-arms it too (it is an arrival like any other).
- Where the predecessor sits on a stream this deployment does not fetch, it is fetched as any new-stream successor now is (`a-successor-on-a-new-stream-is-fetched-by-its-own-writer`).

## Acceptance criteria

- [ ] Upload the predecessor's bytes to a running node: it moves to `successor`, `predecessor` is empty, it catches up, and under `on-catch-up` it is promoted; the generation it replaced becomes `predecessor`. Asserted end to end with `etherfold upload`.
- [ ] The same through the re-read, asserted: the two arrivals still behave identically.
- [ ] Under `manual` it waits in `successor`, folded, and is promoted only when asked.
- [ ] Re-arming over a DIFFERENT pending successor replaces it (row, state, bytes) without a question for the re-read and the upload, and is guarded for a START.
- [ ] No engine is left running for a generation `predecessor` names, asserted.
- [ ] The existing test that pins today's behaviour is changed to the new behaviour, not deleted.
- [ ] ADR-0084 and ADR-0092 carry dated amendments; CONTEXT.md's slot entry says what is now true. Grep `docs/adr/` and `CONTEXT.md` for claims this makes false (for instance "a slot already naming it is not re-armed").
- [ ] The observation `an-upload-of-the-predecessor-folds-it-without-promoting-it` is DELETED.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- `a-successor-on-a-new-stream-is-fetched-by-its-own-writer` -- both change the container's slot and fetch logic, so they are serialised, and a predecessor on another stream relies on it.

## Prompt

The goal is that sending the previous version's bundle to a node is a rollback: it becomes the live version again, through the same catch-up-and-promote path every deploy takes.

Read ADR-0084 and all its amendments (slots; what replacing a successor deletes; the start guard), ADR-0092 and its amendments (no engine for a predecessor; the successor at open), ADR-0057 (the revert, which is the OTHER way back and stays as it is), and ADR-0085's relocated decisions.

The seams: the generation registry in `@etherfold/core` (how `add` resolves an identity it already holds, and the slot assignment), `ReceivingIndexer.add` and its chain-facing twin, and the CLI suites `aBundleIsUploadedToARunningNode` and `anUploadedProcessorSurvivesARestart`.

The decisions most likely to be got wrong: copying the predecessor into `successor` while leaving it in `predecessor` (one generation in two slots, which the registry forbids); moving the pointer directly instead of going through `successor` and the promotion policy; and putting the rule in the upload route rather than the registry.

Done means: upload the old bundle, and the node goes back to it through a normal promotion, with nothing left running for a generation nobody reads.

FIRST, check this task against current reality. If the registry already re-arms somewhere, route to needs-attention with the measurement.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.
