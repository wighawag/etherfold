---
title: 'The request planner issues its list concurrently, bounded'
slug: the-request-planner-issues-its-list-concurrently
spec: the-fetcher-reads-the-hints-providers-already-send
blockedBy: []
covers: [11]
---

## What to build

When indexed-argument filters are configured, the request planner turns one logical fetch into several `eth_getLogs` calls. They are issued in a loop with an `await` inside it, so N filters cost N round trips of latency in sequence.

Issue them concurrently instead, bounded.

This changes no answer. The results are already unioned, sorted by block and log index, and de-duplicated afterwards, precisely because overlapping filters can return the same log twice or out of order. Concurrency only removes the waiting.

Two properties that must survive, both of which the existing code already treats as load-bearing:

- **The single-request path stays byte-for-byte what it is today.** With no filters configured the planner emits exactly one request and the result is returned as the node answered it, with no sort and no de-duplication. That is the unfiltered case, which is most deployments, and it must not acquire a sort or a merge step by accident.
- **The concurrency is BOUNDED, never an unbounded fan-out.** A public provider answers a burst with a rate limit, and the number of requests scales with the number of configured filters, which is caller-controlled.

## Acceptance criteria

- [ ] With several filters, requests are issued concurrently rather than sequentially
- [ ] The returned log list is identical (same order, same de-duplication) to what the sequential path produced, asserted against the existing behaviour
- [ ] The single-request path is unchanged, with no sort or de-duplication introduced, asserted directly
- [ ] Concurrency is bounded by a stated limit rather than by the size of the request list
- [ ] A failure in one request behaves sensibly: the fetch fails rather than silently returning a partial union, since a partial range is exactly what ADR-0004 turns into a false reorg
- [ ] A CHANGESET accompanies the change. The repo's acceptance gate runs `changeset status --since=main`, so a touched package with no changeset is a RED GATE rather than a style nit. Describe the change in prose, as the repo's existing changesets do, not in one line

## Blocked by

- None, can start immediately. Touches the request-planning module only.

## Prompt

> Remove sequential waiting from a path that already merges its results. Look in `@etherfold/core` for the request planner that expands filters into `eth_getLogs` calls and the function that issues them and unions the results.
>
> Domain vocabulary: a topics array is POSITIONAL, so several topic0s travel as one nested slot rather than several slots; a filter restricts a (contract, topic0) pair. The planner may emit several requests whose results overlap, which is why the union sorts and de-duplicates. Emitting MORE requests is always safe for correctness there and costs only round trips, which is the property this task exploits.
>
> The last acceptance criterion is the one with teeth. Under ADR-0004 a range delivered with logs missing is read by the receiver as an absence, an absence is concluded as a reorg, and a reorg reverts state. So a partially-failed union must FAIL, never return what it managed to collect. Verify how the current sequential path behaves on a mid-loop failure and preserve that, rather than assuming a concurrent gather does the right thing by default.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the planner and the union still have the shape described.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
