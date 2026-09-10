---
title: 'Retention refuses reads but reclaims nothing, because no host in this repo ever calls `prune`'
slug: retention-is-advisory-because-no-host-schedules-a-prune
observed: 2026-09-09
source: 'design discussion on browser retention defaults. Read at 924718fc: every `.prune(` call site in `packages`, `examples` and `platforms`, plus `IndexedDBStateStoreOptions`, `assertRetained` and `createBrowserStateStore`. READ, not executed.'
---

ADR-0022 makes `prune` an explicit call the HOST schedules, deliberately, because it costs time proportional to what it drops. **No host in this repository schedules one.** Every `.prune(` outside the tests is a pass-through in a wrapper:

- `EntityEventProcessor.prune` forwards to `this.store`
- `VersionedStateEventProcessor.prune` forwards to `this.inner`
- `openSnapshotAware`'s wrapper forwards to `this.inner`

Not the browser hook, not the server, not the CLI. The one place a real call appears is a DOCSTRING: `platforms/cf-worker/src/d1.ts` tells a host to schedule `store.prune({maxVersions: d1PruneBudget(plan)})` "because a prune is never a side effect of a write (ADR-0022)". Correct advice; nothing in the repo takes it.

**So the two halves of retention have come apart**, and only one of them runs. A configured window bounds what a read may ask about the moment it is configured (`assertRetained`, at the seam, on every backend), while `prune` is what physically drops the versions it no longer covers. Today the first half is live and the second never fires. A deployment that sets `{blocks: N}` therefore gets the REFUSALS of a bounded store and the FOOTPRINT of an unbounded one: strictly worse than either honest position.

This is not the same gap the sqlite finding recorded. That one said `@etherfold/state-store-sqlite` had no pruning implementation at all, so every backend was "effectively `unbounded`". `IndexedDBStateStore.prune` now EXISTS and is written well (a range scan over `UPPER_INDEX`, so it does not full-scan, and a live version has `upper: null` and is therefore unreachable from that index however old it is). The gap moved: the capability is implemented and nobody invokes it.

**It bites hardest in a browser**, which is where this surfaced. The store is on a user's device under a quota and subject to eviction, `retention` defaults to `unbounded` in `IndexedDBStateStoreOptions`, and `createBrowserStateStore` passes it through without scheduling anything. So a long-lived browser deployment accumulates versions with no ceiling. The real measured workload reached 4,072 live rows against **29,393 versions**, so unbounded is roughly seven times the live set on a game that ran to completion, and the ratio grows with churn rather than settling.

**The trap for whoever fixes this**: the fix is NOT to bound the browser default at the finality depth, which is the number that looks right. Retention is measured in BLOCK NUMBERS and event-bearing blocks on the real stream are median **429 blocks apart** (max 1,226,194), so a 64-block window contains zero or one event-bearing block. Bounding there does not keep a little history, it removes as-of reads while still advertising them, which is the wrong answer ADR-0019 exists to prevent. If reorg safety is all that is wanted, `revert-only` is the honest claim and already supported (it sets `capabilities.asOf` false, so a caller learns at startup). If some history is wanted, the window has to be sized against that 429 median.

Fix shape, in order: schedule a prune in the hosts (the browser indexing loop and the server, bounded per call, reporting whether it finished, which is the shape ADR-0022 and `rebuildMore` already have); only THEN reconsider defaults, since moving a default before pruning runs adds refusals and reclaims nothing; and consider making `createBrowserStateStore` REQUIRE a retention claim rather than defaulting silently, on ADR-0019's own ground that a deployment SETS it and a store REPORTS it, so an unstated retention is a decision nobody made.

## Appended 2026-09-09: the machinery is BUILT, so do not start by deleting it

A correction to the paragraph above, which reads as though only the IndexedDB backend has a prune. **Both do.** `VersionedStateStore.prune` (`packages/state-store-sqlite/src/store.ts`) is implemented, takes a `pruneBudget`, deletes against the floor and logs what it dropped. Its own docstring already states this note's finding almost word for word: a deployment that never prunes "gets a store bounded in what it answers and unbounded in what it holds". So the sqlite finding's "every backend it ships today is effectively `unbounded`" is no longer true of either backend's CODE. It remains true of every DEPLOYMENT, and only because nobody calls it, which sharpens rather than weakens the note.

The cf-worker platform goes further: `d1PruneBudget` (`platforms/cf-worker/src/d1.ts`) computes how many versions a prune may delete per invocation given the plan's query allowance, because a prune on D1 has to be chunked to fit one Worker request. Pruning on the serverless platform was designed for, not merely contemplated.

**Considered and rejected, 2026-09-09: disallow bounded retention server-side and add it back when it is needed.** The appeal is real (nothing to schedule, and the half-state disappears), but the cost of "add it later" has already been paid: it would mean deleting or refusing working, budgeted, documented code and orphaning `d1PruneBudget`, in exchange for nothing, while leaving the actual defect (nobody schedules it) exactly where it was. What IS adopted from that direction is the DEFAULT: `unbounded` stays the server default and no host is obliged to prune.

**So the fix shape narrows, and gets cheaper.** The broken state is not "the option exists", it is "a window is configured and nothing ever prunes it", which nothing detects. Make a BOUNDED setting carry its obligation at construction, exactly as `{blocks: N}` already requires `finalityDepth` beside it and is refused naming both numbers when a window would sit below reorg depth. A bounded retention that is not accompanied by the host's prune scheduling is refused where it was CONFIGURED, naming the remedy. Unbounded deployments (the default, and most of them) are untouched, nothing is deleted, and the hazard becomes an unreachable configuration rather than a documented one.

One caveat for whoever writes the default down: deferring is cheap in API terms and not in DATA terms. A deployment that runs unbounded for a year and then wants a window prunes a large backlog in one pass, and the only measurement in hand is prune plus `VACUUM` at 1.1 seconds on a 7 MB database, which does not extrapolate and has no `VACUUM` available on D1 at all.
