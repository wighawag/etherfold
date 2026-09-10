---
title: 'The CLI schedules the prune its retention implies, on a budget a serverless host can use'
slug: the-cli-schedules-the-prune-its-retention-implies
spec: a-configured-window-is-actually-pruned
blockedBy: []
covers: [1, 4, 5, 6, 7, 12]
---

## Continuing from a bounced run — read this first

A previous run built this task and its work is preserved on the branch this claim continues from. It was bounced by the acceptance gate for ONE reason, and that reason was NOT the implementation:

`pnpm changeset status --since=main` refused the changeset, so the gate stopped there. **`pnpm build`, `pnpm typecheck` and `pnpm test` never ran against that work at all.**

The refusal:

```
Found mixed changeset the-cli-schedules-the-prune-its-retention-implies
Found ignored packages: @etherfold/platform-cf-worker
Found not ignored packages: @etherfold/state-store etherfold
Mixed changesets that contain both ignored and not ignored packages are not allowed
```

`@etherfold/platform-cf-worker` is `private: true`, and `.changeset/config.json` sets `privatePackages: false`, so changesets treats it as IGNORED and refuses any single changeset spanning both sides of that line.

**The fix is one line: DELETE `'@etherfold/platform-cf-worker': patch` from the changeset's frontmatter.** Do not split the changeset in two. A private package is never published, so it needs no changeset entry at all, and the change to `platforms/cf-worker/src/d1.ts` is a JSDoc block with no executable change. Keep the changeset PROSE exactly as it is.

Then expect the rest of the gate to run for the first time. Fix whatever real failures build, typecheck and test surface behind it, and re-check the acceptance criteria below against what is actually on the branch rather than assuming the previous run met them.

Background: `work/notes/observations/a-changeset-mixing-private-and-published-packages-fails-late.md`.

## What to build

The same gap on the server side. `VersionedStateStore.prune` is implemented, budgeted and logs what it dropped, and no host calls it.

**The host here is the CLI, not `@etherfold/server`.** Verified: `packages/server` has no state-store dependency at all (its deps are `@etherfold/core`, `hono`, `named-logs`, `remote-sql`) and zero mutating calls; its only `StateStore` mentions are two prose comments. The server-side store is constructed in `packages/cli/src/folding.ts` and the recurring loop is `packages/cli/src/run.ts`. Note the CLI package is named **`etherfold`**, not `@etherfold/cli`.

**The trigger is a FLOOR, not a window.** `retentionFloor` (`packages/state-store/src/retention.ts`) returns a floor for `'window'` AND for `'revert-only'` when a `finalityDepth` is stated, and `undefined` for `'unbounded'` and for `revert-only` with no depth. So the condition is "this store has a floor", never "a window is set". Getting this wrong leaves a `revert-only` deployment refusing every historical read while retaining every version for ever, which is the exact defect this spec exists to kill, on the setting a browser app is told to prefer.

**The budget is the serverless story too.** `d1PruneBudget` (`platforms/cf-worker/src/d1.ts`) already computes how many versions may be deleted per invocation for a D1 plan, and is already exercised by `platforms/cf-worker/test/d1-limits.test.ts`. What has never existed is a host that LOOPS on `complete` with such a budget. Build the loop so that a budget is an argument rather than a constant, which is what makes it usable from a Worker's `scheduled` handler without this task inventing one.

## Acceptance criteria

- [ ] A CLI deployment whose store has a floor drops versions below it, asserted on stored version counts.
- [ ] A `revert-only` store with a `finalityDepth` prunes, because it has a floor.
- [ ] The live version of an entity survives a prune however old it is.
- [ ] The pruning loop takes its budget as a PARAMETER and loops until `complete`, so a caller with a per-invocation query allowance (a D1 host supplying `d1PruneBudget`) can drive the same loop without reimplementing it.
- [ ] A budgeted sequence of passes reaches the same end state as one unbounded pass, asserted rather than assumed.
- [ ] Nothing in the ingest or apply path performs a delete.
- [ ] `@etherfold/server` is not given a state-store dependency by this task. If you believe it needs one, that is a STOP: it would invert the layering the CLI and server already document.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

None, can start immediately.

## Prompt

Read `work/specs/tasked/a-configured-window-is-actually-pruned.md`, then `packages/state-store/src/retention.ts` (`retentionFloor`, every arm; `pruneBudget`; `PruneReport.complete`) and `packages/state-store-sqlite/src/store.ts`, whose `prune` already exists and whose docstring states the defect this closes: a deployment that never prunes "gets a store bounded in what it answers and unbounded in what it holds".

Then read `packages/cli/src/folding.ts` around `stateFor` (this is where `new VersionedStateStore(...)` happens) and `packages/cli/src/run.ts` (the loop). Confirm for yourself that `packages/server` constructs no store before you accept this task's premise.

Domain vocabulary: **retention** is in BLOCK NUMBERS (ADR-0019); `prune` is a call the HOST schedules, never a side effect of a write (ADR-0022). The shape to copy is the one `rebuildMore` already has: bounded work per call, reporting whether it finished, with the host looping.

`remote-sql` exposes transactions only as `batch`, so a prune is a sequence of ordinary batched deletes and not one long transaction. Do not add a transaction verb to that seam.

Out of scope: `VACUUM` and returning space to the filesystem. Dropping rows and shrinking a file are different operations, and D1 has no `VACUUM` at all.

Done means a CLI deployment with a floor shrinks, the loop is budget-driven so a Worker could call it, and nothing about the unbounded default changed.

## Decisions

- **`build` prunes too, at its exit, not only `run`.** The task's prompt names `run.ts`'s loop, but the spec's tasking amendment says what ships is "unconditional pruning in every host this project ships", and a `build` database is a publishable artifact for which "prunes eventually" is not a property. Since `catchUpDelayMs` defaults to `0`, the between-cycles hook barely fires on a one-shot, so `build` drains with bounded passes *after* the loop ends (skipped after a `fatal`, and skipped when an external `deps.signal` stopped it: a caller asking a process to stop is not asking it to finish a delete). Alternative considered: `run` only, which would leave `build --retention 50000` emitting an artifact holding every version. This is what required editing the existing `entityStore.test.ts` assertion `expect(prune).not.toHaveBeenCalled()`; it now asserts the ADR-0022 property directly (every prune call is after the last `applyBlock`). Touches: `build`, `oneShot`/`equivalence` behaviour under a floor (unbounded default is a no-op, so those stay identical).
- **`etherfold index` is deliberately NOT covered.** The receiving half is fed over the wire and has no cycle to prune between; the only in-band place would be the ingest path, which ADR-0022 refuses. Giving it a timer or an admin route is a design decision with its own surface, so I left it out, said so in its README row, and captured the residual gap as an observation. Touches: the `index` command and anyone reading "every shipped host prunes".
- **A new concept in `@etherfold/state-store`: `pruneMore` / `ScheduledPruneReport`.** Checked against the glossary: `prune` keeps its exact meaning (one store's call), `retention` is untouched, and the name mirrors `rebuildMore` — the shape `CONTEXT.md` already names for "bounded work per call, reporting whether it finished, with the host looping". It sits at the seam layer rather than in the CLI because AC4 asks for a loop a D1 host can drive without reimplementing it, and `@etherfold/platform-cf-worker` cannot depend on the CLI. Alternative considered: CLI-local, which would have made the Worker claim aspirational. It also adds `@etherfold/state-store` as a direct dependency of `etherfold` (it was already a devDependency).
- **`DEFAULT_PRUNE_BUDGET = 10_000`, a constant with no flag.** A pass must be bounded or the first cycle meeting a backlog pays for all of it; the number is argued from the measured 1.1 s at 62,553 versions (≈0.2 s per pass) against a 4 s poll interval, and drains the measured 29,393-version footprint in three cycles. I deliberately added no `--prune-budget` flag: the CLI's command table treats every input as owned/optional/refused per command and a new flag is a surface change bigger than this task, while a local database imposes no allowance of its own (the platform that does passes `d1PruneBudget` to the same parameter). It is exported so a caller can see it, and it is not an off switch — `--retention` is where a deployment says what it wants kept. Touches: `run`/`build` cycle cost, and any future `--prune-budget` task.
- **The budget is spent across the states held, not per state.** A host mid-upgrade holds two generations; a per-store budget would do twice the work it budgeted for, which on a platform where the budget IS the request's query allowance is the difference between a scheduled prune and a rejected invocation. Touches every caller of `pruneMore`, including the Worker example now in `d1.ts`.
- **A failed prune is logged and the cycle continues** (both commands), mirroring the rebuild chunk beside it: indexing is what the process is for, and a delete that could not run leaves a store larger than it asked to be rather than a wrong answer. A `build` whose final prune fails still exits `0`, because it folded everything it was asked to fold.

None of these met the ADR gate: each is local and reversible in a line, and ADR-0022 already carries the load-bearing decision they implement.
