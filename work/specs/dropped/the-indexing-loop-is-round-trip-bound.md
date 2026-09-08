---
title: 'The indexing loop is round-trip bound end to end, and nothing overlaps anything'
slug: the-indexing-loop-is-round-trip-bound
needsAnswers: true
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK, stripped by the apply rung on full resolution.
  These are seam-contract and policy decisions, not implementation detail. Story 1 (measure) is
  NOT blocked by any of them and can be tasked first; the rest are.
-->

## Open questions

1. **Does `applyBlocks` join the `StateStore` interface, or stay an optional capability?** It exists today only on the SQLite backend and is not on the seam. Putting it ON the seam obliges every backend (`-indexeddb`, `-patch`, and any third-party one) to implement it and obliges `-conformance` to assert it, for a win that only the network-backed backend actually collects. Leaving it OFF means the fold has to branch on a capability, which is the thing `StateStoreCapabilities` exists for but also a second code path through the most correctness-critical loop in the project. Decide before anything is built on it.

2. **How wide is the cross-block staging window, what bounds it, and what happens when the bound is hit?** Packing blocks requires read-your-writes to span the pack, which means holding mutations in memory across N blocks. Ponder names memory as the explicit trade of this design and reports having to manage it to avoid OOM. Is the bound a block count, a mutation count, a byte estimate, or the batch bounds themselves; and on overflow does it flush early (safe, just less packing) or refuse?

3. **What does the seam take for a cursor across a packed batch?** `BlockUpdate` is `{block, mutations}` with no cursor field, while `applyBlock`'s whole third argument exists so block and cursor commit atomically (`cursor.ts`: a cursor ahead of state is silent loss, a cursor behind is a wedge). One cursor for the batch, describing its LAST block, is atomic and appears correct because a batch is one transaction. Confirm that against the revert path, and decide whether `BlockUpdate` grows a cursor field or the batch carries one alongside.

4. **`eth_chainId` becomes OPTIONAL, and the open part is what the default is and how an operator says so.** Direction is decided: the check is a defence against a provider silently pointing at another chain, and whether that risk exists is a property of the DEPLOYMENT, not of the engine. A server pointed at a pinned endpoint it controls cannot suffer it; a browser tab attached to an injected wallet provider very much can. So it becomes configuration rather than an unconditional pair of round trips. What is still open: (a) is the default on or off, and is the default the SAME in both deployment shapes, given the risk is not (a tab should probably default on, a server off); (b) is the granularity per-cycle, every N cycles, or once at load; (c) when it is off, does anything else catch a swapped provider, or is the answer honestly "nothing does, and that is the operator's choice"; (d) the before-fetch and after-fetch calls do different jobs (fail fast before a range is fetched, versus catch a swap that happened DURING the fetch), so does one flag govern both or does each get its own?

5. **Is the browser deployment in scope, and if not, is that stated?** IndexedDB is the browser default (ADR-0024) and `work/notes/findings/sqlite-in-the-browser.md` measured its cost as the storage write path, not a network hop, so batching round trips buys it little. Most of this spec is a SERVER and remote-SQL win. Either the spec names browser-specific work (the log-fetch concurrency and pipelining stories DO help a tab) or it states plainly that the fold stories do not, so nobody later reads a benchmark from one deployment as a claim about the other.

<!-- /open-questions -->

## Problem Statement

Etherfold is slow to backfill, and the working assumption is that log fetching is why. That assumption is not measured. It is, however, WRITTEN DOWN: `MutationContext` in `@etherfold/state-store` justifies typing every handler read as async on the grounds of "saving a microtask on a path whose cost is dominated by fetching logs". A design decision rests on an unverified belief about where the time goes.

Reading the code, the honest description is narrower and worse: **nothing in etherfold overlaps anything**. Every phase of every cycle waits for the one before it, on both sides of the engine.

On the chain-facing side, one cycle is `eth_chainId`, then `eth_blockNumber`, then `eth_getLogs`, then enrichment, then a second `eth_chainId`, strictly in sequence. Three round trips that are not log fetches, before any log arrives. Where several filters are configured, the request planner's list is issued in a `for` loop with an `await` in it. Where a node does not supply `blockTimestamp` on the log, block and transaction enrichment is one call per hash, also in a loop.

On the storage-facing side, `applyEventStream` loops blocks and per block runs the handlers (whose reads go to the store) and then calls `applyBlock`, which is one `batch()` round trip. A block carries a median of 7 mutations. So on a network-backed backend the fold pays a full round trip per block to write about 7 rows, and pays further round trips inside the handlers: on the real stratagems capture, only 16,871 of 66,113 reads (25.5%) were served from the block's own staging area, so roughly three quarters of handler reads went to the store.

The fix for the storage half is already written and unreachable. `SQLiteStateStore.applyBlocks` packs blocks into batches via `planBatches`, and its own docstring states the thesis: "Backfill is bound by round-trips, not by SQLite work, so packing blocks is the difference that matters there." It is not on the `StateStore` interface and its only caller anywhere is its own unit test.

Finally, nothing here can be defended or regressed, because there is no benchmark. `work/notes/observations/` holds 26 signals and not one is about performance.

## Solution

Measure first, then remove the serialisation, in that order, with the correctness suite as the gate throughout.

A benchmark harness runs a small set of real, public, DENSE workloads end to end and reports a per-phase breakdown, so "the bottleneck is X" becomes a number that a third party can reproduce and that a change can be judged against. The workloads are chosen to overlap Ponder's published benchmark set (Uniswap, BasePaint), so the numbers are comparable to a project that has already done this work and published where its time went.

Then the serialisation is removed in independent pieces, each of which is separately valuable and separately revertible: pack blocks into batches, batch the handler reads a block will make, drop or amortise a redundant chain round trip, issue the independent request lists concurrently, and overlap the next fetch with the current fold.

The two structural blockers to packing blocks (the cursor's atomicity contract, and read-your-writes being per-block) are treated as first-class design work rather than as obstacles to route around, because both encode correctness properties the project has already paid for.

Nothing here is allowed to buy throughput with correctness. `@etherfold/state-store-conformance` and the reorg tests are the gate, and the ADR-0004 invariants (a short answer is a reorg, a reorg deletes state) are not negotiable at any speed.

## User Stories

1. As a maintainer, I want a per-phase timing breakdown of one indexing cycle (chain identity, tip read, log fetch, enrichment, stream write, fold reads, fold writes), so that "the bottleneck is log fetching" is a measurement instead of a comment in `mutation-context.ts`.

2. As a maintainer, I want a repeatable benchmark over real public workloads, so that a performance change is defended by a number a third party can reproduce rather than by an argument.

3. As a maintainer, I want at least one benchmark workload to overlap Ponder's published set (Uniswap and BasePaint), so that our numbers sit next to a project that has already published where its time went, and a wild divergence is a signal rather than a mystery.

4. As a maintainer, I want the benchmark to run against a LOCAL node or a captured stream as well as a public provider, so that provider latency and rate limiting are an axis of the measurement rather than noise inside it.

5. As an operator on a remote SQL backend, I want the fold to pack several blocks into one round trip, so that a backfill is not paying one network round trip per seven rows.

6. As an operator, I want the reads a block's handlers will make to be issued as ONE batched prefetch before the handlers run, so that a block with K distinct entity reads costs one round trip instead of K.

7. As an operator, I want a cycle to cost fewer chain round trips than it does today, without losing the protection the removed ones provided, so that a cycle over a quiet range is not three round trips of overhead for one range of logs.

8. As an operator with `parseConfig.filters` configured, I want the planner's request list issued concurrently, so that N filters cost one round trip of latency instead of N. (The results are already unioned, sorted and de-duplicated afterwards, so this changes no answer.)

9. As an operator, I want the per-hash enrichment loop GONE rather than made concurrent, so that the serial stall it causes cannot happen at any concurrency. (This is Ponder issue #1907's problem and we have the same loop, but our version has a better fix than theirs: `work/specs/proposed/etherfold-is-a-fold-over-logs.md` deletes the loop outright, because the timestamp is now on the log and the transaction data has no constituency. If that spec lands first this story is CLOSED by it and needs no work here; if it stalls, the fallback is bounded concurrency over the hash list, never an unbounded fan-out at a public provider.)

10. As an operator, I want cycle N+1's log fetch to overlap cycle N's fold and stream write, so that the chain-facing and storage-facing halves stop taking turns.

11. As a processor author, I want `update` not to pay a blocking read the store could have avoided, so that the most common write shape is not the most expensive one. (Ponder's equivalent, removing the read-before-write from `insert` by deferring the unique-constraint error to flush time, was worth about 10x on their Uniswap benchmark.)

12. As an operator, I want the batch bounds to be an explicit axis of the benchmark, including a profile for a **colocated SQLite** where the limits are the engine's own rather than a hosted backend's, so that the shipped default (currently set by the tightest hosted free tier) is not silently treated as the only shape that exists.

13. As an operator restarting a process, I want the fetcher's learned range limits to survive the restart, so that every restart does not re-pay the adaptive discovery from `numBlocksToFetchAtStart` upwards.

14. As a maintainer, I want every change in this spec gated by the existing conformance suite and reorg tests, so that a throughput win cannot silently buy speed with correctness.

15. As a maintainer, I want each optimisation to state WHICH deployment it serves (server on remote SQL, server on colocated SQLite, browser on IndexedDB, split fetcher), so that a benchmark from one is never read as a claim about another.

16. As a maintainer, I want the benchmark to record memory as well as time, so that the in-memory staging window's trade is visible at the moment it is introduced rather than discovered as an OOM later.

17. As an operator, I want the fetcher to read a provider's STRUCTURED refusal (`error.data.{from,to,limit}`) before it regex-parses the prose message, so that the one provider shape that tells us exactly what to do next is not the one we parse least reliably.

18. As an operator, I want a provider's stated numeric cap extracted from its refusal (`up to a 2K block range`, `Exceed maximum block range: 5000`) and used as a ceiling, so that a provider that TELLS us its limit is not answered by blind halving.

19. As an operator, I want a provider that reports its result `limit` to have `suspectResultCount` DISCOVERED from it rather than configured by hand, so that the sharpest correctness knob in the fetcher stops depending on an operator guessing their node's cap correctly.

20. As an operator, I want an archive-gated refusal recognised as TERMINAL for that endpoint rather than retried by halving, so that a deep backfill against a non-archive endpoint fails with the real reason instead of grinding.

21. As an operator, I want the range the fetcher learned to be expressible as configuration and reported in the status surface, so that a deployment can start where the last one ended and an operator can see what the fetcher believes about their provider.

22. As a future shared cache, I want the fetcher's ranges to be ALIGNED rather than arbitrary, so that two clients indexing the same contract ask the same questions and an answer can be reused between them.

### Autonomy notes

`humanOnly` is NOT set: once the open questions are answered these are ordinary, well-bounded builds with a strong existing test suite behind them.

`needsAnswers` IS set. Five questions above are genuine seam-contract and safety decisions (the `StateStore` interface's shape, an atomicity contract, and weakening a deliberate provider-swap defence), and tasking them unanswered would produce tasks that guess at a seam third parties implement. Story 1 (measure) is deliberately independent of all five and can be tasked first; in fact it SHOULD be, since its output should inform how much of the rest is worth doing.

## Implementation Decisions

### Measure before optimising, and the harness is the first deliverable

The per-phase breakdown comes first and the optimisations are ordered by what it says. This is not ceremony: if the fold's round trips turn out to dominate a backfill, then work on the log-fetch side is optimising the smaller half, and the reverse is equally possible. The instrumentation is a timing hook around each named phase, reported per cycle and aggregated per run, and it must be cheap enough to leave in (or trivially switchable) so that an operator can answer the same question about their own deployment.

### The workloads, and why these

- **Uniswap** and **BasePaint**, because Ponder publishes numbers for both and a comparable workload is worth more than a bespoke one.
- **The stratagems capture** already in `@etherfold/conformance-workload-stratagems`, because it is real, committed, dense in the way that matters (median 7 mutations per block, bursts to 457) and because the existing 16,871-of-66,113 read figure came from it, so a before/after on the staging window has a baseline already.
- A **sparse** workload (a low-traffic contract over a long range), because the sparse case is dominated by empty-range round trips and the dense case is dominated by the fold, and an optimisation set tuned on one can regress the other.

### `applyBlocks`, and the two blockers

Packing blocks is the single largest storage-side win available and it is mostly written. What is missing is the seam decision (open question 1), the cursor decision (open question 3), and the staging window.

**The staging window is the load-bearing new mechanism.** `MutationContext.get` currently answers from the block's own staged mutations and falls through to the store, and the fold flushes each block before the next one's handlers run, which is what makes that safe. Packing N blocks means the staging area must span the pack, so `get` answers from "everything staged in this pack, most recent write wins" and falls through to the store only for what the pack has not touched. That is exactly Ponder's in-memory buffer, arrived at from the same direction.

Two properties must survive it, and they are the acceptance criteria that matter more than any timing:

- **Versioned rows are NOT coalesced across blocks.** A row written in block N and again in block N+2 produces TWO versions, because as-of reads between them must still answer. Staging saves ROUND TRIPS, never rows. Within a single block the existing coalescing (one version per entity per block) is unchanged.
- **A revert must not be able to observe a half-flushed pack.** A pack is one transaction, so this holds by construction on a backend with real batch atomicity; it must be stated and asserted rather than assumed, and `planBatches` already refuses to split one block across two batches for the same reason.

### The batched prefetch, which needs no profiling

Ponder had to PROFILE handler bodies to predict which rows they would read, because the prediction had to happen before the handler ran and the only signal was history. **We do not need that.** The fold holds the entire block's decoded events before any handler runs, and entity ids are derived from event args. So the block's candidate read set can be computed directly from the events plus the entity declarations, issued as one batched read, and used to warm the staging area.

This is strictly a cache warm: a prefetch that fetches too much wastes bytes, and a prefetch that fetches too little falls through to the existing per-read path. It therefore cannot change an answer, which is what makes it safe to do early. The one case to name explicitly in the tests is a handler reading an id derived from an EARLIER handler's write in the same block, which the prefetch cannot predict and which staging already serves correctly.

### The chain round trips

Three separate changes, of decreasing safety sensitivity:

- **The two `eth_chainId` calls**: open question 4 decides. Whatever the answer, it is recorded as a rationale and not just as a diff, because a future reader will otherwise re-add the call that was deliberately removed (or remove the one that was deliberately kept).
- **The filter request list** (`getLogsWithVariousFilters`): issue concurrently. The single-request path stays byte-for-byte what it is today, which the existing code already treats as a property worth preserving. The union, sort and de-duplication afterwards are unchanged, so concurrency changes no answer.
- **Enrichment** (`blockFetcherFor` / `transactionFetcherFor`): issue concurrently when the provider does not support batching, with a bounded concurrency rather than an unbounded `Promise.all`, since the hash list is as long as the block count of a range and an unbounded fan-out at a public provider is a rate-limit incident. The `providerSupportsETHBatch` path is already one call and stays.

### Pipelining

Overlapping fetch(N+1) with fold(N) is safe here for a specific reason worth writing down: the receiver's cursor is authoritative (ADR-0004), the stream is written before the state advances (ADR-0052), and a re-fetched range is handled (ADR-0051). So a prefetched range that turns out to be wrong is discarded, not mis-applied. It is nonetheless the change with the largest blast radius in this spec and it goes LAST, after the cheaper wins are banked and the benchmark can attribute a regression.

### A smarter fetcher, and what "aligned buckets" means

`work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` is the ground truth for stories 17 to 20 and should be read before any of them is built. The short version: caps are of two incompatible kinds (block span versus result count) and range from 50 blocks to 10,000 results across public endpoints, so adaptive sizing is not optional; and our parser currently discards several hints that providers hand us for free.

All four improvements are strictly additive to the existing halving path, which stays as the fallback for a provider that says nothing useful. That matters because the halving path is what makes the fetcher work at all against an unknown endpoint, and none of this should make the unknown-endpoint case worse.

**On alignment, since it was raised as "the bucket approach" and deserves to be written down properly.** Today the fetcher asks for whatever range its adaptive sizing computed, so two clients indexing the same contract against two providers ask for two different, arbitrary, non-overlapping sequences of ranges. Nothing either of them fetched can ever be reused by the other, and nothing fetched by one RUN can be reused by the next unless the range boundaries happen to coincide.

Aligned buckets fix that by quantising the question: a request covers `[k*N, (k+1)*N - 1]` for a fixed N and an integer k, so "the logs of contract C in bucket k" is a question with ONE spelling that every client asks identically. That is what makes an answer addressable, cacheable, and shareable, and it is the precondition for `work/notes/ideas/a-shared-log-cache-in-front-of-the-node.md` being able to hit across clients at all.

The apparent conflict with adaptive sizing dissolves if the bucket sizes are POWERS OF TWO, and this is the part worth noticing: **halving an aligned bucket yields two aligned buckets.** So the existing behaviour on a refusal, halve and retry, already produces well-formed buckets at the next size down, and growing after a success is a doubling that stays aligned as long as it starts on a boundary. A binary radix of aligned ranges therefore makes the fetcher cache-friendly while keeping the adaptive loop it already has, rather than replacing it.

What this costs, stated plainly so it is weighed rather than discovered: alignment means the fetcher cannot ask for exactly the range it wants. Resuming from an arbitrary cursor means one partial bucket at the start, catching up to an arbitrary tip means one partial bucket at the end, and a partial bucket is not cacheable. It also gives up some of the precision of the current sizing, since the ideal range is rarely a power of two. Whether that is worth paying depends entirely on whether a cache is ever built, which is why this is ONE story here (22) and a design question in the idea note, not a rebuild of the fetcher.

### Batch bounds as a benchmark axis, including colocated SQLite

`DEFAULT_BATCH_BOUNDS` is `{maxStatementsPerBatch: 50, maxBytesPerBatch: 90_000, maxRowsPerStatement: 100}`, derived from the tightest hosted backend's FREE tier per `work/notes/findings/d1-caps-bound-parameters-per-query-at-100.md`, where `maxRowsPerStatement` is a CORRECTNESS bound and the other two are throughput. At a median of 7 mutations per block that default packs roughly 7 blocks per batch, so the shipped default caps the packing win at about 7x before anything else is considered.

The benchmark therefore runs at least three bounds profiles:

- the shipped default (hosted, tightest free tier),
- a hosted paid profile (the host adapter already expresses this: `platforms/cf-worker/src/d1.ts` keys limits by plan),
- a **colocated SQLite** profile, where the database is a local file or an in-process engine and the only real limits are the engine's own.

The colocated profile is the one that has never been characterised and it is the one an operator running SQLite next to the process actually has. Its bounds must be **established by the benchmark rather than asserted**: `batching.ts` currently documents "a stock SQLite build allows 999" bound parameters, which was SQLite's default before it was raised in a later release, so the real ceiling depends on the build in use (`@libsql/client` here) and should be probed, not quoted. The output of that probing is a `notes/findings/` entry with a `source:` naming the probe and the version it ran against, exactly as the D1 note does, plus a documented recommended profile so a colocated deployment is not stuck paying a hosted free tier's price forever.

### What we deliberately do NOT copy from Ponder

**Out-of-order or concurrent execution of handlers, driven by static analysis of user code.** Ponder built this (versions 0.2 to 0.4), suffered repeated regressions, found it "very complex and fragile" to debug, and DELETED it. Their stated takeaway is that safe and simple fallbacks matter when dealing with diverse and unknown user code, and our position is worse than theirs on exactly that axis: the handler seam is a public API, and a processor is meant to run unchanged in a tab and on a server. Event order is a guarantee we keep.

## Testing Decisions

- **Correctness gates first and unconditionally.** `@etherfold/state-store-conformance` must pass for every backend after every change here; it is the artifact that exists precisely so a backend cannot be "fast and slightly wrong". The reorg and revert tests are the second gate.
- **The staging window is tested on behaviour, not on internals**: for any pack size, the rows and versions produced must be IDENTICAL to those produced with the pack size set to 1. That equivalence is the whole correctness claim, it is cheap to assert over the stratagems capture, and it is immune to how the staging is implemented.
- **The prefetch is tested by the same equivalence** (prefetch on versus prefetch off produces identical state) plus the named case of a handler reading an id an earlier handler in the same block wrote.
- **The concurrency changes are tested for answer-identity**, not for speed: the multi-filter path must produce the same ordered, de-duplicated log list it produces serially, and the enrichment path the same fields.
- **A crash-mid-pack test**: kill between batches and assert the cursor and the state agree on restart, in both directions (no wedge, no silent loss). This is the test that actually defends open question 3's answer.
- **The benchmark is not a pass/fail test.** It reports. A regression gate on wall-clock in CI would be flaky by construction (ADR-0032 already establishes that the acceptance gate does not assume an idle machine), so the harness produces numbers a human compares, and only the equivalence assertions are gates.

## Out of Scope

- **Swapping to a faster log source** (HyperRPC, HyperSync, a bulk archive). Deliberately excluded so that this spec measures and fixes what etherfold itself does, before any conclusion is drawn about the source. It is also a decision with a correctness surface of its own (ADR-0004's absence inference against a source that may lag the tip or truncate silently) and deserves its own spec. The cheap experiment, pointing a backfill at an alternative endpoint by configuration and re-running the benchmark, is enabled by story 4 and costs nothing extra.
- **Building a per-chain all-logs system.** It is the HyperSync shape, it is a separate product rather than an optimisation, and it contradicts ADR-0002's decentralisation premise. Not rejected forever, but not this.
- **A shared log cache in front of the node.** Incubating at `work/notes/ideas/a-shared-log-cache-in-front-of-the-node.md`. It is complementary (it helps the SECOND client, this spec helps the first) and it has a real unanswered design question of its own in the cache key. Story 22 here is only the ALIGNMENT precondition, not the cache.

- **Deleting the block and transaction enrichment path.** Owned by `work/specs/proposed/etherfold-is-a-fold-over-logs.md`, which supersedes this spec's story 9 if it lands first. The two specs should be sequenced deliberately rather than raced: deleting the loop is strictly better than parallelising it, so if both are going to happen, that one goes first and this spec's story 9 is closed rather than built.
- **Serving `eth_getLogs` from an etherfold instance.** Already specified at `work/specs/proposed/node-log-api.md`.
- **Browser storage backend performance.** `work/notes/findings/sqlite-in-the-browser.md` characterised it and `work/notes/ideas/opfs-backed-browser-store.md` holds the follow-on. See open question 5 for where the boundary is drawn.
- **Multi-threading the fold.** On Ponder's own list of future work and plausibly right eventually, but it is a much larger change than anything here and every item in this spec is a prerequisite for knowing whether it would help.

## Further Notes

**On timing.** This is worth doing BEFORE publication rather than after, for a reason that is about the seam and not about speed: open questions 1 and 3 change the `StateStore` interface, which is the contract third-party backends implement and which `-conformance` polices. Changing it before anyone has implemented against it is free; changing it after is a breaking change to strangers.

**On where the belief came from.** The `mutation-context.ts` comment is not a mistake, and it should be corrected rather than mocked when the measurement lands. It was written when the storage seam was new and the log-fetching cost was the visible one, and it records an honest assumption at the time. What makes it worth naming in this spec is that it is a design decision (uniformly async reads) resting on it, so if the measurement contradicts it, that decision should be revisited too and not just the comment.

**On what the neighbouring specs took away.** Two stories left this spec after it was written, and both left because a better answer turned up rather than because they were wrong. Story 9 (concurrent enrichment) is superseded by deleting enrichment. Open question 4 (the two `eth_chainId` calls) stopped being a safety dilemma once the observation was made that the risk is a property of the deployment and not of the engine, so it is configuration now and only its defaults are open. Recorded because a reader of the git history will otherwise see two items quietly weaken and wonder what was conceded.

**On the size of the prize, stated honestly.** Nobody has measured any of this, so the only defensible claim right now is structural: on a network-backed backend the fold currently performs at least one round trip per block plus roughly 0.75 round trips per handler read, and none of them overlap anything. Whether removing them is worth 2x or 50x is exactly what story 1 exists to find out, and the ordering of everything after story 1 should be revisited once it answers.
