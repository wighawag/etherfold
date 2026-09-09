---
title: 'Measure the indexing loop before optimising it (exploration)'
slug: measure-the-indexing-loop-before-optimising-it
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **This is an EXPLORATION spec.** Its "done" is CONFIDENCE plus a de-risked build plan, not a shipped optimisation. It emits no performance improvement of its own, deliberately.

## Problem Statement

Etherfold is believed to be bottlenecked on log fetching. Nobody has measured it, and a design decision already rests on the belief: `MutationContext` in `@etherfold/state-store` justifies typing every handler read as async on the grounds of "saving a microtask on a path whose cost is dominated by fetching logs".

Reading the code gives a different and narrower description, but not a number. Nothing overlaps anything: a cycle is `eth_chainId`, `eth_blockNumber`, `eth_getLogs`, enrichment, `eth_chainId` again, strictly in sequence; the fold then loops blocks doing one `batch()` round trip each for a median of 7 mutations; and roughly three quarters of handler reads miss the per-block staging area (16,871 of 66,113 on the real stratagems capture). Which of those dominates a backfill is unknown, and they suggest opposite remedies.

There is no benchmark in the repo. `work/notes/observations/` holds 26 signals and not one is about performance, so there is nothing to regress against and no way to defend a change.

Optimising in this state means guessing which half to fix, and shipping seam changes (`work/specs/proposed/the-fold-packs-blocks-into-round-trips.md`) whose payoff is unquantified.

## Solution

Build the measurement, run it against real public workloads, and emit a build plan that ORDERS the candidate optimisations by what the numbers actually say.

A per-phase timing hook around each named phase of a cycle, reported per cycle and aggregated per run, cheap enough to leave in so an operator can answer the same question about their own deployment. A harness that runs a small set of real workloads end to end, on axes that matter (provider latency, storage backend, batch bounds), recording memory as well as time.

Then the deliverable that makes this an exploration rather than a chore: a written build plan saying which optimisations are worth doing, in what order, with the numbers that justify the ordering, and which candidates the measurement RULED OUT.

## User Stories

1. As a maintainer, I want a per-phase timing breakdown of one indexing cycle (chain identity, tip read, log fetch, enrichment, stream write, fold reads, fold writes), so that "the bottleneck is log fetching" becomes a measurement instead of a comment in a docstring.

2. As a maintainer, I want a repeatable benchmark harness over real public workloads, so that a performance change is defended by a number a third party can reproduce rather than by an argument.

3. As a maintainer, I want at least one workload to overlap Ponder's published benchmark set (Uniswap and BasePaint), so that our numbers sit beside a project that has already published where its time went, and a wild divergence is a signal rather than a mystery.

4. As a maintainer, I want a SPARSE workload alongside the dense ones, so that the empty-range case (dominated by round trips) and the busy case (dominated by the fold) are not conflated, since an optimisation tuned on one can regress the other.

5. As a maintainer, I want the benchmark to run against a local node or a captured stream as well as a public provider, so that provider latency and rate limiting are an AXIS of the measurement rather than noise inside it.

6. As a maintainer, I want memory recorded alongside time, so that the in-memory staging window proposed by the fold spec has its trade visible before it is built rather than discovered as an OOM later.

7. As an operator, I want the batch bounds to be an explicit axis, including a COLOCATED SQLITE profile, so that the shipped default (set by the tightest hosted free tier) is not silently treated as the only shape that exists.

8. As a maintainer, I want the colocated profile's real limits PROBED rather than quoted, and captured as a finding with a dated source, so that a recommended profile rests on a measurement of the build actually in use.

9. As a maintainer, I want a written build plan ordering the candidate optimisations by measured payoff, so that the follow-on build specs are sequenced by evidence instead of by which one was easiest to write.

10. As a maintainer, I want the `MutationContext` docstring corrected or confirmed by the result, so that the assumption this spec exists to test does not outlive its test.

### Autonomy notes

Neither gate is set. Every story is build-taskable now: the approach is ordinary instrumentation and benchmarking, nothing here is an unproven seam, and no open question gates any of it.

The reason this is an EXPLORATION rather than a build spec is the shape of its done, not uncertainty about how to do it: it delivers confidence and an ordering, and the capability work lives in the follow-on specs.

## Out of Scope

- **Every actual optimisation.** They are `work/specs/tasked/the-fetcher-reads-the-hints-providers-already-send.md` (which is independent of this measurement and need not wait for it) and `work/specs/proposed/the-fold-packs-blocks-into-round-trips.md` (which does wait, via `taskedAfter`).
- **Swapping to a faster log source** (HyperRPC, HyperSync, a bulk archive). Story 5 makes the experiment cheap by making the endpoint an axis, but choosing a source has a correctness surface of its own (ADR-0004's absence inference against a source that may lag the tip or truncate silently) and belongs in its own spec.
- **A CI regression gate on wall-clock.** ADR-0032 already establishes that the acceptance gate does not assume an idle machine, so the harness reports numbers a human compares. Only correctness assertions gate.

## Further Notes

Ponder's published account is the closest prior art and it argues against this project's working assumption: they identify their bottlenecks as blocking database queries and blocking RPC, and their wins were an in-memory write buffer, deferred unique-constraint errors and profile-driven prefetching, not a faster log source. If our measurement lands in the same place, the fold spec is the priority and the fetcher spec is the smaller half. If it does not, that is worth knowing before either is built.
