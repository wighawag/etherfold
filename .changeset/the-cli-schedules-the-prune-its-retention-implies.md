---
'@etherfold/state-store': minor
'etherfold': minor
---

**A CLI deployment that configures a retention floor now actually reclaims what falls below it**, and the loop that does it is budget-driven, so a serverless host can drive the same one.

Retention has two halves and only one of them ran on the server side. A window has always bounded what a READ may ask about from the moment it is configured (`assertRetained`, at the seam, on every backend); `prune` is what physically drops the versions it no longer covers, and ADR-0022 makes it an explicit call the HOST schedules -- and no host in this repository scheduled one. So `--retention 50000` bought the refusals of a bounded store and the footprint of an unbounded one, which is strictly worse than either honest position, and nothing anywhere detected it.

**`pruneMore(states, {maxVersions})` (`@etherfold/state-store`) is that pass, written once.** It prunes every state a host holds, spends ONE budget across them (not one each), skips a state it was handed twice, and reports `{passes, versionsDeleted, complete}`. The shape is `rebuildMore`'s: bounded work per call, reporting whether it finished, with the host looping -- which is what lets a CLI cycle and a Worker's `scheduled` handler drive one loop rather than two implementations of it. The budget is a PARAMETER because the number belongs to the caller's schedule: a Worker passes `d1PruneBudget(plan)` (its per-invocation query allowance), a CLI passes its own.

**The CLI schedules it, and the two commands loop differently because their lives differ.** `run` takes one bounded pass in the gap it already waits between fetch cycles, so a backlog drains over cycles instead of stalling the one that met it; `build` runs bounded passes until the state is at its floor once it has reached the tip, because the database it exits with is a publishable artifact and "prunes eventually" is not a property an artifact has. Neither is in the ingest or apply path: a prune costs time proportional to what it drops (1.1 s at 62,553 versions) and a block carrying a median of 7 mutations must not pay for it.

**The trigger is a FLOOR, not a window.** `revert-only` states a floor too -- the finality depth this deployment protects against -- so it is pruned as well; that is the case a binary window-or-not implementation gets wrong, and getting it wrong leaves the setting a reorg-safe deployment is told to prefer refusing every historical read while retaining every version for ever.

**Nothing changes for an `unbounded` deployment, which is the default and probably most of them.** A prune with no floor is a no-op, which is exactly why the host may schedule it without first asking what it is holding. `DEFAULT_PRUNE_BUDGET` (10,000 versions per pass, exported from `etherfold`) bounds one pass and is not a way to turn pruning off: `--retention` is where a deployment says what it wants kept.

`createD1Store`'s docstring now shows that scheduled call with the shared pass (documentation only; no D1 behaviour changed).

**Not covered:** `etherfold index`, the receiving half, still schedules no prune -- it is fed over the wire and has no cycle of its own, and a prune inside the ingest path is what ADR-0022 refuses. And nothing here `VACUUM`s: SQLite reuses the freed pages, so the file stops growing without shrinking.
