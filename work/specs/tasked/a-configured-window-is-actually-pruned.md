---
title: 'A configured window is actually pruned'
slug: a-configured-window-is-actually-pruned
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

Retention has two halves and only one of them runs.

A configured window bounds what a read may ask about from the moment it is configured (`assertRetained`, at the seam, on every backend). `prune` is what physically drops the versions the window no longer covers, and ADR-0022 makes it an explicit call the HOST schedules, deliberately, because it costs time proportional to what it drops.

**No host in this repository schedules one.** Every `.prune(` outside the tests is a pass-through in a wrapper: `EntityEventProcessor.prune` forwards to its store, `VersionedStateEventProcessor.prune` forwards to its inner store, `openSnapshotAware`'s wrapper forwards to its inner store. Not the browser hook, not the server, not the CLI. The only real call site anywhere is a DOCSTRING in `platforms/cf-worker/src/d1.ts`, telling a host to schedule `store.prune({maxVersions: d1PruneBudget(plan)})` "because a prune is never a side effect of a write (ADR-0022)". Correct advice; nothing takes it.

So a deployment that sets `{blocks: N}` gets the **refusals** of a bounded store and the **footprint** of an unbounded one: strictly worse than either honest position, and nothing anywhere detects it. The store's own docstring already describes the state it is in, which is how confident we can be that this is real: a deployment that never prunes "gets a store bounded in what it answers and unbounded in what it holds".

It bites hardest in a browser, where the store sits on a user's device under a quota and subject to eviction, `retention` defaults to `unbounded`, and `createBrowserStateStore` passes that through while scheduling nothing. The real measured workload reached 4,072 live rows against **29,393 versions**, so unbounded is roughly seven times the live set on a game that ran to completion, and the ratio grows with churn rather than settling.

**The machinery is built. Only the scheduling is missing.** `IndexedDBStateStore.prune` is a range scan over `UPPER_INDEX` (so it does not full-scan, and a live version has `upper: null` and is therefore unreachable from that index however old it is). `VersionedStateStore.prune` takes a `pruneBudget`, deletes against the floor and logs what it dropped. `d1PruneBudget` computes how many versions a prune may delete per invocation given a D1 plan's query allowance, because a prune there must be chunked to fit one Worker request. This supersedes the sqlite finding's "every backend it ships today is effectively `unbounded`", which was true of the CODE when it was written and is now true only of every DEPLOYMENT.

## Solution

**Schedule it, and make the unscheduled state unreachable rather than merely undocumented.**

Two halves, and the second is what stops this recurring. The hosts gain a prune they schedule, with the shape ADR-0022 and `rebuildMore` already share: bounded work per call, reporting whether it finished, so a host loops until done rather than blocking on an unbounded delete. And a **bounded retention setting carries its obligation at construction**: configure a window without the scheduling to enforce it and the store refuses where it was configured, naming the remedy.

That second half is the same idiom the retention options already use. `{blocks: N}` is refused today unless `finalityDepth` is beside it, naming both numbers, because a window below the depth a reorg can reach would prune the versions the revert itself needs. This adds one more thing a window cannot be configured without.

Unbounded deployments, which is the default and probably most of them, are untouched by both halves.

## User Stories

1. As an operator, I want a configured window to actually reclaim space, so that setting retention is a storage decision rather than only a read restriction.
2. As an operator, I want a window I configure without the means to enforce it to be refused at startup, so that I cannot deploy the worst-of-both state at all.
3. As an operator, I want that refusal to name the remedy, so that I fix it in the config file I am already looking at.
4. As an operator who wants no retention, I want nothing to change, so that `unbounded` stays the zero-effort default it is today.
5. As an operator on D1, I want each prune to fit inside one Worker invocation, so that a prune cannot exceed the request's query allowance. `d1PruneBudget` already computes the number; this gives it a caller.
6. As an operator, I want a prune to report whether it finished, so that I can loop until it has rather than guess an interval.
7. As an operator, I want a prune never to run as a side effect of a write, so that ADR-0022's guarantee holds: an indexing cycle's cost does not silently include a delete proportional to history.
8. As a browser app developer, I want a long-lived tab not to accumulate versions without limit, so that a user who plays for months does not hit a quota or an eviction.
9. As a browser app developer, I want to state what history I want and get it, so that retention is a promise rather than a hint.
10. As a browser app developer who wants reorg safety and no history, I want `revert-only` to be the obvious way to say that, so that I am not tempted to approximate it with a small window.
11. As a maintainer, I want the obligation expressed at the seam or in each backend's construction rather than in prose, so that a future host cannot forget it the way every current host has.
12. As a maintainer, I want a test that a bounded store actually drops versions, asserted on external behaviour (what a read returns, what a count reports), so that the two halves cannot come apart again silently.
13. As a maintainer, I want the conformance suite to ask every backend the same question, so that a new backend inherits the obligation.
14. As a reviewer, I want the sqlite finding's superseded claim corrected where a reader will meet it, so that "no backend prunes" does not keep being quoted after it stopped being true.


> **Tasked.** The technical detail this spec launched with (Implementation Decisions, Testing Decisions, and the Task order) now lives in the tasks it produced, which is where it can go stale against code rather than beside it. Durable rationale is relocated to an ADR by the task that lands it. What remains here is the durable framing: Problem, Solution, User Stories, Out of Scope.

## Out of Scope

- **Changing any default.** Both halves here leave `unbounded` exactly where it is. A default change is a breaking change to READS (`assertRetained` starts refusing) and should be argued on its own.
- **A background or automatic prune policy.** ADR-0022 settled that a prune is a call the host schedules and never a side effect of a write; this spec gives that call a caller, not a policy engine.
- **Retention for the stream cache or the emission stream.** Different objects with different rules; this is entity versions only.
- **`VACUUM` and space actually returned to the filesystem.** Dropping rows and shrinking a file are different operations, SQLite needs the second, and D1 does not expose it.

## Further Notes

One caveat for whoever writes the defaults down: deferring is cheap in API terms and not in DATA terms. A deployment that runs unbounded for a year and then wants a window prunes a large backlog in one pass, and the only measurement in hand is prune plus `VACUUM` at 1.1 seconds on a 7 MB database, which does not extrapolate and has no `VACUUM` available on D1 at all. So the escape hatch is real and it gets more expensive the longer it goes unused.

This spec exists because `work/specs/proposed/the-same-query-runs-against-a-worker-and-a-server.md` leans on retention meaning something: its browser `block:` path is bounded by churn since the pinned block, and under a genuinely unbounded store that churn is unbounded for an old block, so the bound there is doing real work rather than being a formality. That is a dependency in spirit and not in tasking order: the query spec refuses past its bound either way.
