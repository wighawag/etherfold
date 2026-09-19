---
title: 'An `index` process ADVANCES the successor it registered, so a split deployment can finish a processor upgrade'
slug: an-index-process-advances-the-successor-it-registered
blockedBy: [promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade]
covers: []
---

## What to build

The other half of a gap whose first half lands in the task this is blocked by.

Restarting `etherfold index` with a changed processor opens the container with the successor beside the incumbent, and then nothing ever carries that successor to level. Two separate things were missing. It was never ARMED, because the promotion policy does not speak for a fold added at `open`, and that is fixed by `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`. It is also never ADVANCED, because `index` schedules no bounded rebuild at all: only the combined `run` drives cycles. Arming a fold that nothing advances just moves the stall one step later.

So `index` must schedule the bounded rebuild for the generations it holds, the way the combined process already does. A split deployment's receiving half is exactly the shape that folds a stream somebody else writes, which is what a follower's bounded rebuild is for, so this is wiring an existing driver into a command that never got it rather than inventing a second one.

While in there, settle the related claim the module header makes: it says a batch naming a fold this process has not seen CREATES a generation beside the live one, and no code path does that. Either make the header true or correct it, and say which you did and why.

**The measured account, folded in from the observation this was raised from** (which is discharged, so this task carries it rather than pointing at it). Restarting `etherfold index` with a changed processor opens the container with the successor beside the incumbent, and nothing ever carries it to level, for two independent reasons:

- **Never ARMED.** `ReceivingIndexer.applyPolicyTo` returns immediately while `opened` is false, so a fold added by `open()` is never even a candidate. That half is `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`, which this task is blocked on.
- **Never ADVANCED.** `packages/cli/src/indexCommand.ts` schedules no `rebuildMore` at all; only `driveCycles` in `packages/cli/src/index.ts` does, and that runs on `run`. This half is THIS task.

So the incumbent stays canonical for ever, the successor stays at nothing, and a split deployment's only route to an upgraded fold is to delete a generation by hand. `run` has both halves and is unaffected.

The stale module-header claim above is probably the same gap seen from the other side: `container.add` is called only by `open()` and by `packages/cli/src/reconfigure.ts`, which `index` does not wire up.

## Acceptance criteria

- [ ] An `index` process holding a successor ADVANCES it, so its cursor moves without a second process or an operator doing anything.
- [ ] Combined with the arming that already landed, a restarted `index` with a changed processor FINISHES the upgrade: the successor catches up and the pointer moves under the default policy.
- [ ] The incumbent goes on folding and answering throughout, and the one-writer rule is unaffected: advancing a follower never disturbs the generation that writes its stream.
- [ ] The rebuild is BOUNDED the way the combined process's is, so a large catch-up cannot starve the ingest path this command exists to serve.
- [ ] The stale claim in the command's module header is either made true or corrected, deliberately and stated.
- [ ] `run` is unchanged, since it already has both halves.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`. Not a code dependency but a correctness one: advancing a successor that can never be promoted produces a fold that reaches level and then sits there, which is a more expensive version of the same bug. Landing the arming first means this task's end-to-end criterion is actually reachable.

## Prompt

The goal is that a deployment split into a fetching half and an indexing half can upgrade its processor by restarting, like the combined process can.

Read the CLI's `index` command beside the combined `run`, specifically where `run` schedules its drive cycles and what `index` does instead. ADR-0044 is why a follower holds a read-only view of a stream it does not own and folds it rather than fetching; the generation rebuild in `@etherfold/core` is the bounded driver itself.

The decision most likely to be got wrong is scheduling. `index` exists to receive pushed batches and fold them, so its loop is driven by arrivals rather than by a clock, and a rebuild bolted on without regard to that can compete with the ingest path for the one database handle. Decide explicitly where the rebuild gets its turn, prefer the shape `run` already uses if it transfers, and say what you chose and what it costs under load.

The second: do not give `index` a fetcher. It has no chain-facing half by design, and a successor on a DIFFERENT stream is one this process cannot feed. That case should be honest rather than silently stalled, so if the successor follows a stream nothing here writes, say so where an operator will see it.

The third, on the stale header claim: check it before you act on it. If nothing creates a generation from an unseen batch, the honest fix is probably to correct the header, because inventing that path is a feature and not a cleanup. If you conclude it should exist, that is a separate task and a needs-attention signal, not something to add here.

The seam to test at is a deployment stood up the way the CLI tests already stand one up, restarted with a changed processor, driven until the pointer moves.

Done means: `index` advances what it holds, an upgrade completes on a restart, ingest is not starved, and the header says something true.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise -- route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Where the rebuild gets its turn against the ingest path, what an unfeedable successor reports, and what you did about the module header, are all such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**Where the rebuild gets its turn: a host-owned TIMER at 4s, not the ingest path, and not the prune's clock.** `index` is driven by arrivals, and that is precisely why the turn is not taken there: ADR-0022 makes the rebuild a call the host schedules and never a side effect of a write, and "one chunk after each batch" would put an arbitrarily long catch-up between a sender and its acknowledgement for work that batch did not cause. That is the same argument the scheduled prune beside it already records, so the shape transfers. **Cost under load:** a tick with nothing to advance is a few registry reads (the bargain `run`'s unconditional call already states); a tick with something to advance is bounded at `DEFAULT_MAX_EMISSIONS_PER_CHUNK` (2000), so the two contend for the one handle for the length of one chunk and the ingest path wins the next tick outright, because an overlapping tick is skipped rather than queued. **Alternatives considered:** riding the ingest path (rejected, above); riding the existing prune timer (rejected — it would re-mean `--prune-interval`, so `--prune-interval 0`, which a deployment and several tests use to disable a disk reclaim, would silently disable processor upgrades, and 60s is the wrong cadence for a promotion); a new flag (rejected — no command in the set takes one, the number a deployment wants is the one the constant argues for). **4 seconds** is `run`'s own cadence rather than a new number: the gap a caught-up `run` waits is its poll interval, default 4000ms. **Touches:** the prune schedule in the same command (they now share one in-flight guard, so a tick of either kind can be skipped while the other runs), and `IndexDependencies` gains `rebuildIntervalSeconds` as a test-only instrument with no flag behind it.

**What an unfeedable successor reports: a start-up line, not a new refusal or a fetcher.** On this command a fold added at `open` is never a follower (`add` decides that from "do I already hold a fold on this stream", and at `open` the fold list is empty), so it holds no rebuild over the stored stream and is fed by the wire alone. The one way the upgrade silently never finishes is a sender pushing a different `{source, config}`, whose refusal is visible on the sender and nowhere here, so the honest place to say it is at start-up on this half. **Alternatives considered:** giving `index` a fetcher so it could feed its own successor (rejected — it deletes the property that defines the command); refusing to start when a successor is held (rejected — the ordinary restart upgrade is exactly this state and it is supposed to work); a new `/status` field (rejected — that reporter answers progress per fold, and this is a fact about the deployment's configuration, not a moving number). **Touches:** nothing else; it adds no flag, no route and no refusal.

**The module header is CORRECTED, and so are the other three places that repeated it.** Nothing creates a generation from an unseen batch, and inventing that path would be a feature — a receiver taking its deployment's shape from a sender's say-so — so correcting is the honest fix, as the task expected. I did not open a needs-attention signal for it, because I concluded the path should NOT exist rather than that it should. **Touches:** `CONTEXT.md`'s glossary entry for the two containers carried the identical sentence; correcting one and leaving the other is how a false claim survives being fixed, so both moved.

**The `--promotion` refusal on `index` keeps refusing, but its REASON changed, because my change falsified it.** It said the receiving half "schedules no rebuild, so nothing is ever added beside its live fold and the policy would have nothing to act on". After this change a successor its configuration named at start-up *is* carried to level and promoted here, under the default policy — so the second half is false. **I did not make `index` accept the flag:** that is a user-visible new input on another command's ownership row, the acceptance criterion asks only for the default policy, and ADR-0048's recorded direction is that refusal → optional is additive later while the reverse is breaking. The refusal now says it is about this command's INPUTS and that whether it should take the flag is a question nothing has answered. **Touches:** `config.ts`'s ownership/refusal table, `packages/cli/README.md`, and whichever future task gives `index` a reconfigure or a promotion input — the done record for `the-cli-selects-its-promotion-policy` already flagged that cell as the one to flip.
