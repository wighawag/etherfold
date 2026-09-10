---
title: 'The server and the CLI schedule the prune their retention implies'
slug: the-server-and-cli-schedule-their-prune
spec: a-configured-window-is-actually-pruned
blockedBy: []
covers: [1, 4, 6, 7, 12]
---

## What to build

The same gap as the browser, on the server side: `VersionedStateStore.prune` is implemented, budgeted and logs what it dropped, and no host ever calls it. A server or CLI deployment that configures a retention window gets the refusals of a bounded store and the footprint of an unbounded one.

Give the server and the CLI a scheduled prune, bounded per call, looping on the report's `complete` flag rather than blocking on one pass.

Unbounded remains the default and must stay untouched, which on a server is the common case: history is the product there and disk is cheap.

## Acceptance criteria

- A server deployment configured with a retention window physically drops versions below the floor, asserted on stored version counts rather than on statements issued.
- The live version of an entity survives a prune however old it is.
- Each prune call is bounded and the host loops until `complete`, so a large backlog cannot block one request or one tick for an unbounded time.
- Applying a block performs no deleting.
- An `unbounded` deployment behaves exactly as today, and the default is not changed by this task.
- Tests assert external behaviour: what a read returns and how many versions remain.
- A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is part of the acceptance gate, so a missing changeset is a red gate for a reason unrelated to the work.
- Pruning is UNCONDITIONAL when a window is set: it is not a second opt-in on top of configuring retention. Setting a window is a deployment saying it keeps only that much, so dropping what falls outside it is the meaning of the setting rather than an addition to it.

## Blocked by

None, can start immediately.

## Prompt

Read `work/specs/tasked/a-configured-window-is-actually-pruned.md`, then `packages/state-store/src/retention.ts` (`PruneOptions.maxVersions`, `PruneReport.complete`, `retentionFloor`) and `packages/state-store-sqlite/src/store.ts`, whose `prune` already exists, takes a budget and logs. Its own docstring states the defect this task closes: a deployment that never prunes "gets a store bounded in what it answers and unbounded in what it holds".

Domain vocabulary: **retention** is in BLOCK NUMBERS (ADR-0019), its floor is the finality depth, and `prune` is a call the HOST schedules, never a side effect of a write (ADR-0022). The shape to follow is the one `rebuildMore` already has: bounded work per call, reporting whether it finished, with the host looping.

Where to look: the server's container and the CLI's command layer, whichever owns the recurring work in each. Do not put the prune inside the ingest or apply path.

Note that `remote-sql` exposes transactions only as `batch`, so a prune is a sequence of ordinary batched deletes rather than one long transaction. Do not attempt to add a transaction verb to that seam.

Out of scope here: `VACUUM`, or returning space to the filesystem. Dropping rows and shrinking a file are different operations and only the first is this task's.

Done means a bounded server deployment shrinks, an unbounded one is untouched, and no request pays an unbounded delete.
