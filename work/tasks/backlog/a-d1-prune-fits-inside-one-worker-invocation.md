---
title: 'A D1 prune fits inside one Worker invocation'
slug: a-d1-prune-fits-inside-one-worker-invocation
spec: a-configured-window-is-actually-pruned
blockedBy: [the-server-and-cli-schedule-their-prune]
covers: [5, 6]
---

## What to build

On Cloudflare D1 a prune must be chunked to fit one Worker invocation's query allowance. The helper that computes that budget already exists (`d1PruneBudget` in `platforms/cf-worker`) and has no caller: the only mention of a real prune call in the whole repository is the docstring beside it, telling a host to schedule `store.prune({maxVersions: d1PruneBudget(plan)})`.

Give that helper its caller, so the cf-worker platform schedules a prune sized to its plan.

## Acceptance criteria

- The cf-worker platform schedules a prune whose budget comes from `d1PruneBudget` and its plan, rather than from a guessed constant.
- A prune that cannot finish within its budget reports so, and the scheduled path calls again rather than treating a partial pass as failure or as completion.
- No prune runs inside the request path that applies a block.
- An unbounded deployment is unaffected.
- A test covers the budgeted-and-resumed path, asserting that a bounded pass followed by further passes reaches the same end state as one unbounded pass would.
- No changeset is needed: the package this touches is `private`, and `privatePackages: false` in `.changeset/config.json` means changesets ignores it. Do not add one.

## Blocked by

`the-server-and-cli-schedule-their-prune`, because the scheduling shape it establishes is the one this reuses. Serialised deliberately so the two do not invent two different schedulers.

## Prompt

Read `work/specs/tasked/a-configured-window-is-actually-pruned.md`, then `platforms/cf-worker/src/d1.ts` (the `d1PruneBudget` function and the docstring above `createD1Store` that describes exactly this call), and `packages/state-store/src/retention.ts` for `PruneOptions.maxVersions` and `PruneReport.complete`.

Domain vocabulary: a prune is a call the HOST schedules and never a side effect of a write (ADR-0022). On D1 the binding constraint is the number of QUERIES one invocation may issue, which is what `d1PruneBudget` computes from the plan, not the size of the database.

Note there is no `VACUUM` on D1 at all, so this task drops rows and does not reclaim file space; that limit is expected and should not be worked around.

Done means the helper has a caller, a prune spread across invocations reaches the same end state as one pass, and nothing about the unbounded default changes.
