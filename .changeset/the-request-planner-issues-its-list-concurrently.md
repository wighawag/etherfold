---
'@etherfold/core': patch
---

The request planner's list is issued concurrently, bounded

With `parseConfig.filters` configured, the planner turns one logical fetch into several `eth_getLogs` calls: one per (rule, `match` entry) plus the leftover groups. They were awaited one at a time, so N filters cost N round trips of LATENCY in sequence even though they are independent questions about the same block range. They are now issued together, bounded by `MAX_CONCURRENT_LOG_REQUESTS` (4).

THIS CHANGES NO ANSWER. The results were already unioned, sorted by (block, log index) and de-duplicated afterwards, precisely because overlapping filters can return one log twice or out of order; the union is now fed the per-request results in REQUEST order rather than in arrival order, so the list it produces is byte-for-byte the list the sequential loop produced.

WHAT IS DELIBERATELY UNTOUCHED:

- **The single-request path.** With no filter configured the planner emits exactly one request and its result is returned as the node answered it, with no sort and no de-duplication. That is the unfiltered case, which is most deployments, and it acquires no merge step here.
- **Failing on a partial union.** The bound is a worker pool and not a `Promise.all`: a rejection fails the whole fetch, the error that surfaces is the LOWEST-INDEXED failure (the one the sequential loop would have thrown, and the one `RangeLogFetcher` reads its range, result-cap and archive hints out of), no further request is started once a failure is known, and the requests already in flight are awaited before the error is rethrown so none is orphaned. A partial range is what ADR-0004 turns into a false reorg, which is paid for by deleting state, so returning what it managed to collect is never an option.

The bound is a stated constant rather than the length of the request list, because that length is caller-controlled and an unbounded fan-out at a public provider is a rate-limit incident. It is not configurable.

Covered by `packages/core/test/theRequestListIsIssuedConcurrently.test.ts`.
