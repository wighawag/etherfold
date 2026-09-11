---
'etherfold': minor
---

**`--prune-interval <seconds>` (`PRUNE_INTERVAL`) sets the prune cadence on `etherfold index`.**

`index` receives pushes and has no cycle, so its scheduled prune runs on a clock rather than in a gap that already exists. That clock is now configurable instead of fixed: `--prune-interval 300` to prune every five minutes, `--prune-interval 0` to turn the schedule off entirely. It defaults to 60 seconds.

`0` is accepted here, unlike a prune BUDGET of zero, which the seam refuses. The difference is that this is a cadence and not an amount: an operator can coherently want no schedule (a database pruned by something else, deletes scheduled outside the process), while asking for passes that delete nothing is a miscomputed budget. It is also not a way to say you want nothing dropped. That is `--retention unbounded`, the default, where the store answers every historical read rather than refusing the ones it silently stopped keeping.

**It is REFUSED on every other command, each naming why.** `run` and `build` prune in the gap their cycle already waits, so their prune cadence IS their poll interval and a second clock would be a second answer to a settled question. `fetch` holds no state to prune. `serve` folds nothing and enforces no retention: it reads a database something else wrote, and that writer is what schedules the prune. The asymmetry is deliberate and documented at the point of refusal rather than left to be discovered.
