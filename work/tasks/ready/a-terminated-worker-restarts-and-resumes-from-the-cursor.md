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
