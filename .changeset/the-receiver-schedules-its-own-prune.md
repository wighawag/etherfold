---
'etherfold': minor
---

**`etherfold index` now prunes what its retention no longer covers, on a schedule it owns.**

`--retention` is accepted on `index` exactly as it is on `run`, and the flag's own help text promises that what falls outside the window is "both refused on read and DROPPED from storage". The refusal half always worked. The storage half did not: `run` and `build` prune in the gap their cycle already waits, and a receiver has no cycle, so a bounded `index` deployment got the answers of a windowed store and the footprint of an unbounded one. That is the worst-of-both the retention work exists to kill, and it was reachable from a documented flag.

The schedule is a TIMER, because a receiver has nothing else to hang it on. ADR-0022 forbids a prune as a side effect of a write, and ingest is the only other thing that happens in this process, so "between batches" would be that side effect under another name. A clock is owned by the HOST, which is what the ADR asks for, and `index` is a long-lived Node process that can hold one: the constraint recorded for Cloudflare Workers is about a STORE on that platform and does not reach a CLI host.

One bounded pass per tick at `DEFAULT_PRUNE_BUDGET`, defaulting to `DEFAULT_PRUNE_INTERVAL_SECONDS` (60), called unconditionally because a prune with no floor is a no-op. Overlapping ticks are guarded, so a pass slower than the interval cannot stack and spend the budget several times over. The timer is `unref`'d and cleared on stop, so it never holds the process open and never outlives the server.

A failed prune does not fail the fold: receiving is what the process is for, and a delete that could not run leaves a store larger than it asked to be, which is worth logging and not worth refusing a batch over.

`deps.pruneIntervalSeconds` is new on `IndexDependencies`, for tests that want to observe a pass without waiting a minute (`0` disables the schedule). A deployment leaves it alone: retention is configured with `--retention`, and starving the schedule is not how a deployment says it wants nothing dropped.

The `--retention` help text now says "on a schedule it owns" rather than "between cycles", because both are now true and only one was.
