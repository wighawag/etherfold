---
title: 'An uploaded processor SURVIVES a restart, including one still catching up'
slug: an-uploaded-processor-survives-a-restart
spec: a-processor-artifact-is-pushed-to-a-running-deployment
blockedBy: [a-run-node-with-nothing-configured-waits-for-its-first-upload]
covers: [10]
---

## What to build

For a node whose processors arrive by upload, the stored bytes are the only copy of the code it runs (ADR-0085's amendment). An upload must therefore be a deployment and not a session: after a restart the node goes on folding what was uploaded, whether or not a processor is configured.

Two gaps stand between today's code and that, and the maintainer decided both on 2026-09-26:

1. **A `successor` also folds from `open`.** `an-upgrading-restart-keeps-the-incumbent-folding` instantiates exactly the CANONICAL generation at `open`. An upload that is still catching up sits in `successor`; after a restart nothing folds it, so it never catches up and is never promoted. Extend instantiate-at-open to the generation `successor` names, when this process holds no fold for it, through the SAME seam (`instantiateGeneration`). The promotion then works exactly as in-session: under `on-catch-up` the successor is promoted when it catches up, and the fold instantiated for the incumbent stops being folded. `predecessor` is still NOT instantiated at open: nobody reads it and it is not catching up, so ADR-0092's "no live engines for generations nobody reads" still holds for it; it is instantiated only if a revert moves onto it. Amend ADR-0092 with a dated amendment.
2. **A configured `--processor` is an ARRIVAL, and a START may not SILENTLY replace a pending successor.** If a node is started with `--processor` naming a processor different from the one the registry's canonical generation folds, that processor registers as the new `successor` exactly as today, and the promotion policy decides from there. A configured processor that names the canonical generation, or the successor already pending, changes nothing. But registering into `successor` REPLACES what it held and deletes it (row, state and bytes), and a pending successor is work in progress, often an upload somebody sent to a running node. So when a START would replace a DIFFERENT pending successor, whatever it arrived by:
   - **Interactive** (stdin is a TTY): the start ASKS, naming both generations, before anything is registered, and proceeds only on a yes.
   - **Non-interactive**: the start is REFUSED by name, before anything is registered, unless **`--override`** is given (the maintainer's name for it, 2026-09-26).
   - Only the START is guarded. The re-read endpoint and an upload are already deliberate acts on a running node, and replace a pending successor as they do today.

   This changes ADR-0084's redeploy-per-commit case: a pipeline that restarts with a new processor while the previous successor is still catching up now passes `--override` (once, in its deploy configuration). Record the rule as dated amendments to ADR-0084 (the replace-on-registration rule it describes) and ADR-0093 (whose Consequences left open how a configured processor relates to uploads), including the exception it makes to story 10: an upload survives a restart unless the operator restarts with a different configured processor AND confirms replacing it.

## Acceptance criteria

- [ ] **Upload, restart with NOTHING configured, still folding:** the uploaded generation is canonical, the restarted node instantiates it from its stored bytes and its cursor advances. Asserted end to end with `etherfold upload`.
- [ ] **Upload a successor, restart mid-catch-up:** the restarted node folds BOTH canonical and successor, the successor catches up, and under `on-catch-up` it is promoted with nobody asking; the incumbent's fold then stops.
- [ ] `predecessor` is not instantiated at open, asserted.
- [ ] Restarting with `--processor` naming a different processor registers it as `successor`; restarting with `--processor` naming the canonical processor changes nothing.
- [ ] Where a start would replace a DIFFERENT pending successor: non-interactive without `--override` is refused by name with nothing registered or deleted; with `--override` the successor is replaced (row, state and bytes deleted as any replaced successor's are); interactive asks first. Each asserted, including a successor that arrived by upload.
- [ ] The re-read endpoint and an upload still replace a pending successor without a question.
- [ ] ADR-0084 and ADR-0093 carry the dated amendments.
- [ ] ADR-0092 carries the dated amendment for the successor at open (`## Amendment, 2026-MM-DD (...): ...` plus a pointer under each title).
- [ ] **ADR-0085's `status: accepted, not yet implemented` line is REMOVED, leaving NO status line** (`work/protocol/ADR-FORMAT.md`: absent means accepted and current; `accepted, implemented` is not a valid value). This task is the last in the upload chain and owns the removal. ADR-0085's section of decisions relocated from the upload spec says "None of them is built yet", which becomes false with this task: correct it in the same change.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- `a-run-node-with-nothing-configured-waits-for-its-first-upload` -- the restart-with-nothing-configured case needs that mode.

## Prompt

The goal is that uploading a processor is a deployment that outlives the process it was sent to.

Read ADR-0092 and its amendments (stored bytes, instantiate when a generation has to fold), the done record of `an-upgrading-restart-keeps-the-incumbent-folding` (instantiate-at-open for the canonical generation, and why it runs AFTER the configured fold is added), ADR-0084 (the three slots and what replacing a `successor` deletes), ADR-0093 and ADR-0085's amendment.

The seams: the receiving container's `open` and its canonical-at-open step (extend it; do not write a second instantiation path), the promotion trigger (which already compares against a moving incumbent), and the CLI's `run` wiring. The CLI suites `anUpgradingRestartKeepsTheIncumbentFolding` and the upload suites are the test shapes.

The decisions most likely to be got wrong: instantiating every stored generation at open because it is simpler (the predecessor must stay cold); instantiating the successor BEFORE the configured fold is added, which would fold an uploaded successor that a configured processor is about to replace; and putting the guard on the re-read or upload paths, which are already deliberate.

Done means: upload, restart, and the node is still doing what the upload told it to, including finishing an upgrade that was in flight.

FIRST, check this task against current reality: every earlier task in the upload chain will have landed. If they landed differently than this assumes, route to needs-attention with the discrepancy.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.

## Decisions

- **Only `run` checks its start; `build` and `index` still replace a pending successor as before and refuse `--override`.** Why: the task names `run`'s wiring as the place for this, and `run` is the only command an upload reaches. The alternative was checking every command that opens with a configured processor, which would change how a split `index` deployment and a re-run `build` upgrade. Touches: the `override` flag table, the refusal message `ONLY_RUN_GUARDS_ITS_START`, and `openFolding`, where the check is optional. Going from refused to accepted later is additive.
- **`--override` is a flag with no environment variable.** Why: the task says pipelines pass `--override` in their deploy configuration, and adding a variable would name a new setting nobody asked for. The alternative was an `OVERRIDE_…` variable. Touches: the CLI's inputs list and README.
- **`--override` is accepted on a `run` started with nothing configured, where it has nothing to permit.** Why: it is a permission, and a start that replaces nothing honours it trivially. Refusing it would break a deploy configuration that always passes it. The alternative was refusing it there under the repo's "nothing is accepted and ignored" rule. Touches: `run` in nothing-configured mode.
- **The core option is a callback that throws to refuse; core defines no refusal error of its own.** Why: the refusal text has to name the CLI's flag and the terminal, which core does not know about. The alternative was a boolean answer plus a core error type. Touches: `ReceivingIndexerOptions.confirmReplacingSuccessorAtStart` and the exported `SuccessorReplacementAtStart` type (public API; covered by the changeset).
- **"Interactive" means stdin is a TTY, and a test or embedder can override that.** A yes is `y` or `yes`, case-insensitive. `--override` wins over asking. Why: the task gives stdin-is-a-TTY as the test. The alternative was also requiring stdout to be a TTY. Touches: the `startGuard` field on the CLI's dependencies.
- **The successor instantiated at open gets the promotion policy applied to it, the same as a re-added configured successor.** So under `immediate` it is promoted at open. Why: this matches how a configured successor is treated at open today. The alternative was only waiting for it to catch up. Touches: nothing beyond `open`.
- **A successor whose stored code fails to build, or that sits on a stream this node does not fetch, is logged and reported frozen, and the node starts anyway.** Why: this mirrors ADR-0092's rule for the canonical generation. The alternative was refusing to start. Touches: what `folding` reports for that successor.
