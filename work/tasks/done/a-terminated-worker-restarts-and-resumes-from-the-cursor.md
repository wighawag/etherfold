---
title: 'A terminated worker restarts and resumes from the cursor'
slug: a-terminated-worker-restarts-and-resumes-from-the-cursor
spec: the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
blockedBy: [checktxinclusion-answers-from-the-tab]
covers: [8, 9]
---

## What to build

Browsers evict workers. Treat that as an expected event with a defined outcome rather than as a failure nobody handled.

When the worker host dies: **tell the app, reject every in-flight call with a typed error, restart, and resume.** Each of the four is load-bearing.

Silence is the worst available outcome, because a stalled app and a slow app look identical from the outside, and that is where "is it broken?" reports come from. So a death is an event the app can observe, not something inferred from nothing happening.

In-flight calls are REJECTED rather than silently retried. A hung promise is worse than a rejection, and a silent retry hides an event an app may want to know about — a client that wants to retry can, and most already do. The rejection must be recognisable by type, so an app can tell "the worker died under this call" apart from "this call was refused for a reason of its own".

Resume is nearly free and must be demonstrated to be. The state is in the store and the cursor is written in the SAME transaction as the block it describes (ADR-0027), so restarting means reading the cursor and carrying on. The test that matters is a termination in the middle of a fold, followed by a restart that does not re-index from the start block and does not skip a range.

The restart should not become its own hazard: a worker dying immediately and repeatedly must not turn into a hot restart loop, and a restart must not leave two hosts writing to one store.

## Acceptance criteria

- [ ] An app can observe that the host died, as an event, without polling for it.
- [ ] Every call in flight at the moment of death rejects with a typed error naming that cause; none hangs.
- [ ] After a restart, indexing resumes from the persisted cursor: no re-indexing from the start block, no skipped range, and the resulting state matches an uninterrupted run of the same workload.
- [ ] A termination deliberately induced mid-fold is the case that proves it, in a real browser.
- [ ] Calls made after the restart work normally, on every surface that existed before it.
- [ ] A worker that dies repeatedly does not produce an unbounded restart loop, and the app can tell that this is happening.
- [ ] At no point are two hosts writing to the same store; the writer claim is still held by exactly one.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`checktxinclusion-answers-from-the-tab`, so that every surface the port carries exists before the death path has to define what happens to calls in flight on each of them.

## Prompt

The goal is that a browser evicting the worker costs a few seconds, not an afternoon of syncing, and that an app can see it happen.

Read `work/specs/tasked/the-indexer-runs-in-a-worker-and-the-tab-talks-to-it.md`, **ADR-0082** (whose closing section is exactly this decision and includes the reasoning for rejecting rather than retrying), and the **indexer host** entry in `CONTEXT.md` for the vocabulary.

Where to look: **ADR-0027** is the one that makes resume cheap — the sync cursor lives behind the storage seam as an opaque string written with the block it describes, so there is no window in which the cursor is ahead of the data. Read it before designing anything clever; the design is "read the cursor and continue". The writer claim is the other constraint: `openForWriting` takes a claim, a second writer is refused, and `@etherfold/browser` already knows how to demote a refused writer to a reader (`CONTEXT.md`'s **demotion** entry is the full model, including why it is one-way for the container that took it). A restarted host must end up holding the claim cleanly rather than racing the corpse of the old one.

The seam to test at is the browser harness, terminating the worker from the test mid-fold. Assert on the state after the resumed run matching an uninterrupted run, and on the range actually re-fetched, rather than on timing.

Two traps worth naming. First, a restart that re-runs load rather than resuming looks correct on a small workload and is wrong on a real one — assert on what was fetched, not just on the end state. Second, a termination during a store write is the case where "cursor written with the block" earns its keep; make sure the test can produce that case rather than only terminating between cycles.

Done means: a death is observable, in-flight calls reject by type, and a mid-fold termination resumes exactly where it left off.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The restart policy (how many, how fast, what an app is told) is exactly such a decision. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**A hosting shape takes the LINE THAT BUILDS a host, not a host.** `dedicatedWorkerHost(worker)` became `dedicatedWorkerHost(() => worker)`, and `HostAccess` gained an optional `reopen`. A shape *is* "how a port is obtained" (ADR-0082, `CONTEXT.md`), so obtaining one again after a death belongs there. Alternative considered: accept `Worker | (() => Worker)`, which keeps every call site compiling but leaves ports that silently cannot restart, with nothing in the types saying the restart half is missing. Touches: the 5 `cut.ts` call sites, `bundlesForABrowser.test.ts`, and the two remaining shape tasks (`a-sharedworker-serves-several-tabs-from-one-host`, `createindexerstate-becomes-the-main-thread-host`) — a shape that genuinely cannot be re-obtained omits `reopen` and its port reports `restarting: false` instead of pretending. I also corrected the code snippet in the earlier task's unreleased changeset (`.changeset/the-indexer-is-hosted-in-a-dedicated-worker.md`), since release notes teaching an API that will not exist is a defect a reader pays for.

**A death is concluded from SILENCE, by a probe on a timer.** New `ping` case; if the host has said nothing for `watch.everyInSeconds` (default 5) the port probes, and an unanswered probe within another interval is a death (so a death is noticed within ten seconds by default). This is liveness polling sitting next to ADR-0082's "status is PUSHED", which is why both the case and the watch say in their own docs that what is polled is LIVENESS and never STATUS. Alternatives considered and rejected: the `MessagePort` `close` event (not available on all three engines this package tests against); the `Worker` `error` event (an uncaught error is not a death — a worker survives it); concluding a death only from a call already in flight (an idle tab, or one resting at the tip, would never learn). `watch: false` is offered and documented as honest-but-silent: it is right only for a host that cannot die independently (the coming main-thread shape).

**The restart policy: 5 consecutive restarts, 0.5s doubling to 30s, and a host alive 60s is SETTLED.** The app is told on every death which attempt it is and whether a replacement is coming, so "this keeps happening" is renderable. Alternative considered: restart unboundedly (a worker that dies on boot becomes a hot loop and the app is never told), or reset the counter on any successful restart (same loop, slower). The settle window is what keeps the budget a crash-loop budget rather than a lifetime quota. All four are configurable; nothing else in the repo reads them.

**A call made between a death and the restart is REJECTED, not queued.** Same typed error as the calls that were in flight. Queueing would be the silent retry ADR-0082 refuses, one step later. Consequence a caller must expect: a waiting loop over `progress()` has to tolerate `IndexerHostDiedError` as "not yet" (`cut.ts`'s `asking` helper shows the shape).

**Kill first, then replace.** The port releases the access it is replacing (for a dedicated worker: `terminate()`) *before* it opens a successor, including when no restart is coming. So a host merely suspected of being dead costs a restart, never a second writer; the writer claim is the guarantee underneath rather than the mechanism. The node test asserts the ordering (`['open', 'close', 'open']`) rather than trusting it.

**`IndexerHostDiedError` is narrowed by `instanceof`, unlike every refusal on `PortError`.** Those are raised in the host and rebuilt from data, so their prototype cannot survive the crossing and the `name` is the narrowing. This one is raised in the tab about a host that is not there, so nothing crossed and the class is exact. The `name` is pinned all the same for code that narrows the whole surface one way.
