---
title: 'The store reports whether its window is actually enforced'
slug: the-store-reports-whether-its-window-is-enforced
spec: a-configured-window-is-actually-pruned
blockedBy: [the-browser-indexing-loop-schedules-its-prune, the-server-and-cli-schedule-their-prune]
covers: [2, 3, 9, 10, 11, 13]
---

## What to build

Close the gap the two scheduling tasks leave: a host that rolled its own loop, sets a window, and never prunes. It gets the refusals of a bounded store and the footprint of an unbounded one, and nothing detects it.

This spec launched expecting a REFUSAL at construction, and the answer is a REPORT instead, for reasons recorded in the prompt below. The store already reports what it actually provides, which is ADR-0019's own mechanism: "a deployment SETS it and a store REPORTS what it actually provides, so a caller discovers at startup what history is available instead of from a wrong answer". Retention has two halves and the report currently covers only one of them, so extend it to say whether the window has ever been ENFORCED, not merely configured.

Together with the shipped hosts pruning unconditionally when a window is set, the misconfiguration becomes impossible for anyone using a host we ship and VISIBLE for anyone who wrote their own.

## Acceptance criteria

- The capability report says whether this store has been pruned, and at what block, distinguishing "never pruned" from "pruned, floor at block N".
- A caller can therefore discover at STARTUP that a window is configured and unenforced, rather than inferring it from disk usage months later.
- The value is durable across a reload or a restart, so a store that was pruned before the process died does not report "never".
- An `unbounded` store reports honestly too: there is no floor, so there is nothing to enforce and the report says that rather than looking unenforced.
- The addition is additive: existing consumers of the capability report keep compiling.
- The conformance suite asks every backend the same question, so a new backend inherits the obligation rather than rediscovering the hazard.
- No default and no configuration shape changes in this task.
- A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is part of the acceptance gate.

## Blocked by

Both prune-scheduling tasks: what "enforced" MEANS is defined by what they do, and a report written before them would be describing a thing that had not happened yet.

## Prompt

Read `work/specs/tasked/a-configured-window-is-actually-pruned.md`, then `packages/state-store/src/capabilities.ts` (the report shape and why `asOf` is separate from `retention`) and `packages/state-store/src/retention.ts` (`resolveRetention`, `retentionFloor`, `PruneReport`).

**Why a report and not a refusal, since the spec launched expecting one.** Three candidates were considered and two were rejected on hard grounds. A store that owns its own SCHEDULER is impossible on a first-class platform: `workerd` forbids moving I/O across requests, so a background timer inside a store cannot exist on Cloudflare Workers at all. An ATTESTATION knob ("I promise to prune") is a promise rather than a proof, and it is NOT parallel to the precedent it would claim: `{blocks: N}` requires `finalityDepth` beside it because that value is DATA used to compute the floor, not because it expresses an intention. What is left is the one the seam already does: the deployment sets, the store reports, the caller discovers at startup.

**The other half of the answer lives in the two blocking tasks**: a configured window prunes, unconditionally, in every host we ship. Pruning is not an extra a deployment opts into on top of setting a window; setting a window IS saying "I keep only this much", so deleting what falls outside it is the MEANING of the setting rather than an addition to it.

Domain vocabulary: **retention** is measured in BLOCK NUMBERS and never in updates or duration (ADR-0019), and its floor is the finality depth. Its two halves are `assertRetained`, which bounds what a read may ask about from the moment a window is configured, and `prune`, which physically drops what the window no longer covers. The **capability report** is readable BEFORE `migrate` and before the database is even opened, which is the point of it: a caller learns at startup rather than from a wrong answer later. Check whether that stays true of whatever you add, since a value read from storage may not be available that early, and if it cannot be, say so in the type rather than lying.

Done means a bespoke host that sets a window and never prunes is visibly broken at startup, and every store we ship is not broken at all.
