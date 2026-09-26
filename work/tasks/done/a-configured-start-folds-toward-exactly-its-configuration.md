---
title: 'A configured start folds toward EXACTLY its configuration: naming the canonical processor discards a different pending successor'
slug: a-configured-start-folds-toward-exactly-its-configuration
spec: run-is-configured-and-node-receives-uploads
blockedBy: [node-is-a-command-that-receives-uploads]
covers: [5]
---

## What to build

ADR-0094: configuration is the truth on the configured commands (`run`, `build`, `index`). Today a start whose `-p` names the CANONICAL generation while a DIFFERENT generation is pending in `successor` changes nothing, so the pending successor goes on to be promoted and the command serves (or `build` publishes) code its configuration does not name. The maintainer decided on 2026-09-26 that such a start DISCARDS the pending successor (row, state and stored bytes, as any replaced successor is), behind the existing start guard (ADR-0084's amendment of 2026-09-26: asks at a terminal, refused elsewhere unless `--override`), on all three configured commands.

The other cases are unchanged: `-p` naming a different processor registers it as successor (guarded where it replaces a different pending one); `-p` naming the pending successor itself changes nothing. (`-p` naming the predecessor is `an-arrival-of-the-predecessor-re-arms-it-as-successor`'s.)

**Where it lives, in core.** `open()` discards the pending successor BEFORE `foldTheSuccessor`, through the registry's `deleteGeneration`, where the configured fold is the canonical generation and `successor` names a different one. Today `confirmTheStartMayReplace` returns early exactly in that case (`slotHolding(slots, arriving)`), and `SuccessorReplacementAtStart` means "arriving would take the successor slot", so the confirm payload gains a DISCARD variant and `startGuardFor` its own wording (its current "register ... in the `successor` slot, which REPLACES" is false for a discard). A refusal leaves the registry, slots, state and bytes untouched.

## Acceptance criteria

- [ ] On `run`, `build` and `index`: `-p` naming the canonical generation with a DIFFERENT pending successor is refused non-interactively without `--override` (nothing deleted), discards it with `--override` (row, state and bytes gone; not promoted; the canonical generation keeps folding), and asks at a terminal (no keeps everything, yes discards). Including a successor that arrived by upload to a `node` over the same database.
- [ ] `-p` naming the pending successor itself, or the canonical generation with nothing pending, changes nothing and asks nothing.
- [ ] A re-run `build -p v1` over a database with a pending `v2` publishes an artifact serving `v1` (with `--override`).
- [ ] The spec's rows marked `2` (core `aPendingSuccessorSurvivesARestart`'s "names the canonical generation, which changes nothing", and `anUploadedProcessorSurvivesARestart`'s "names the canonical processor" case) now assert the DISCARD.
- [ ] ADR-0084 and ADR-0093 carry dated amendments; CONTEXT.md's slot entry and the CLI README say what is now true. Grep `docs/adr/` and `CONTEXT.md` for "changes nothing" and similar claims.
- [ ] ADR-0094's status line is NOT touched.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`), for core and the CLI.

## Blocked by

- `node-is-a-command-that-receives-uploads` -- the cross-over case needs `node`, and both touch the start path.

## Prompt

The goal is that a configured command never serves code its configuration does not name.

Read ADR-0094 (its third consequence), ADR-0084 and its 2026-09-26 amendment (the start guard, what replacing a successor deletes), ADR-0092's 2026-09-26 amendment (the successor at open, and why it runs after the configured fold is added).

The seams: `ReceivingIndexer.open`, `confirmTheStartMayReplace`, `foldTheSuccessor`, `SuccessorReplacementAtStart` in `@etherfold/core`; `startGuardFor` in the CLI.

The decisions most likely to be got wrong: discarding AFTER `foldTheSuccessor` (building an engine for a generation about to be deleted); deleting without the guard; and leaving the guard's wording describing a replacement.

Done means: `-p v1` means v1, and whatever else was pending is either kept by the operator's no or gone by their yes.

FIRST, check this task against current reality. If the start guard or successor-at-open differ from what this assumes, route to needs-attention with the discrepancy.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.

## Decisions

- **A failed delete during a discard stops the start.** When a replacement's delete fails it is only logged, because the arriving generation takes the slot anyway. In a discard nothing takes the slot, so a failed delete would leave the successor to be promoted, which is exactly what this change exists to prevent. The alternative was to reuse `dropReplaced`'s log-and-carry-on behaviour. This affects only `ReceivingIndexer.open`, and it adds a new way for a start to fail: whatever error the database raises.
- **A host that passes no guard discards without asking.** This matches how an unguarded start already replaces without asking. The alternative, discarding only when a guard is supplied, would make the rule depend on whether a host passes a callback. In practice only core test setups pass no guard, since every CLI command passes one.
- **The type and method keep their names; `kind` tells the cases apart.** The discard variant carries `canonical`, not `arriving`, because nothing arrives in a discard. I considered renaming `SuccessorReplacementAtStart`, `confirmReplacingSuccessorAtStart` and `confirmTheStartMayReplace`, but the task names them as the seams, so I only widened their JSDoc. This changes a public type in `@etherfold/core`, which the changeset records. A rename to something like "deletion at start" is left for a human to decide.
- **Where "the state is gone" is tested.** The core test setup records no dropped state, so the state half of the deletion is checked in the CLI tests against a real SQLite database (the discarded generation's tables are gone). I did not change the shared core test helper, because other suites use it.
