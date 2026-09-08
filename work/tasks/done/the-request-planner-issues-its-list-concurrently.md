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

## Decisions

- **The bound is `4`, a module constant, not a `LogFetcherConfig` knob.** Chosen because a browser allows six connections per origin on HTTP/1.1 and the engine has three other declared methods sharing that pipe, so 4 leaves headroom while still collapsing the common filtered configurations (2-3 requests) into one round trip of latency. Alternatives considered: `Promise.all` over the whole list (rejected: the list length is caller-controlled via `filters`, so it is an unbounded fan-out at a public provider, and the rate-limit refusal that comes back is then mis-read by `RangeLogFetcher` as a range hint and halved against); a `LogFetcherConfig.maxConcurrentRequests` knob (rejected: it is a user-visible default nobody can currently pick better than this, nothing measures it yet, and it would sit next to `learnedRange` as a second, unmeasured performance surface). Touches: `LogParseConfig.filters` (the thing that decides how long the list is) and, if it ever becomes a knob, `LogFetcherConfig` and the `/status` fetcher report.
- **When several requests fail, the error that surfaces is the LOWEST-INDEXED one, not the first to reject.** The pool claims indices in order, so the started set is always a prefix, which makes the lowest-indexed failure exactly the error the sequential loop would have thrown. This is load-bearing rather than cosmetic: `RangeLogFetcher.getLogs` READS that error for an archive refusal, a stated block cap, a reported result cap and a suggested `toBlock`, so a non-deterministic "whichever lost the race" would make the adaptive path depend on network timing. Alternative considered: rethrow the first rejection observed (simpler, rejected for the above).
- **No new request is started once a failure is known, and the in-flight ones are awaited before the error is rethrown.** The first half preserves "the loop never reached the requests after the failing one" (no wasted round trips on an answer that cannot be returned); the second half is what stops a concurrent gather leaving orphaned rejections behind it, since `Promise.all` short-circuits on rejection while its siblings keep running. Asserted directly in the test (`settled === started` after the rejection).
