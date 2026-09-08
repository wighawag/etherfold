---
title: 'The fetcher reads the hints providers already send it'
slug: the-fetcher-reads-the-hints-providers-already-send
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

`eth_getLogs` has no portable page size. Providers cap it in two incompatible ways (block span or result count) and the numbers differ by more than an order of magnitude: measured across public Ethereum endpoints, 50 blocks, 1,000 blocks, and 10,000 results. So a fetcher must discover the limit at runtime, and etherfold's does, by halving on refusal.

What it does not do is READ what the provider told it. `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` records four hints currently discarded:

- A provider that returns a STRUCTURED refusal (`error.data` carrying `from`, `to` and `limit`) has its prose message regex-parsed instead, and the structured field is never consulted. That field also carries the node's real result cap.
- `-32000` is not handled at all, and several providers put range complaints behind it.
- A provider stating its cap in prose ("up to a 2K block range", "Exceed maximum block range: 5000") has that number dropped, and the fetcher halves blindly instead.
- An ARCHIVE refusal (history behind a token) is retried by halving forever, though no range size will ever satisfy it.

The result cap is the sharpest of these, because `suspectResultCount` is the knob that decides whether a truncated answer is detected at all, and a wrong value means a short range is delivered as a complete one, read by the receiver as an absence, concluded as a reorg, and paid for by deleting state. Today an operator must configure that number by hand, guessing their node's cap, while some providers report it in every refusal.

## Solution

Read the hints. Each improvement is strictly ADDITIVE to the existing halving path, which stays as the fallback for a provider that says nothing useful, because that path is what makes the fetcher work at all against an unknown endpoint.

Prefer structured error data over parsed prose; accept `-32000` under the same hint gate that already guards `-32602`; extract a stated numeric cap as a ceiling; treat a reported result limit as a DISCOVERED `suspectResultCount` rather than a configured one; and recognise an archive refusal as terminal for that endpoint instead of grinding.

## User Stories

1. As an operator, I want the fetcher to read a provider's STRUCTURED refusal (`error.data` with `from`, `to`, `limit`) before it regex-parses the prose message, so that the one provider shape telling us exactly what to do next is not the one we parse least reliably.

2. As an operator, I want `-32000` refusals subject to the same range-hint handling as `-32602`, so that a provider's choice of error code does not silently discard its advice.

3. As an operator, I want a provider's stated numeric cap extracted from its refusal and used as a ceiling, so that a provider that TELLS us its limit is not answered by blind halving.

4. As an operator, I want a reported result `limit` to become the effective `suspectResultCount`, so that the sharpest correctness knob in the fetcher stops depending on an operator guessing their node's cap correctly.

5. As an operator, I want a hand-configured `suspectResultCount` to still win over a discovered one, so that a deployment that knows something the provider does not report can say so.

6. As an operator, I want an archive-gated refusal recognised as TERMINAL for that endpoint rather than retried by halving, so that a deep backfill against a non-archive endpoint fails with the real reason instead of grinding.

7. As an operator, I want the range the fetcher has learned to be readable in the status surface, so that I can see what it believes about my provider instead of inferring it from timings.

8. As an operator restarting a process, I want the learned range limits to survive the restart, so that every restart does not re-pay the adaptive discovery from the starting range upwards.

9. As a maintainer, I want the existing `looksLikeRangeHint` gate preserved and tested, so that the case it already earns its keep on (an archive refusal arriving as a `-32602` that mentions neither "results" nor "block range") does not regress into a bogus parsed `toBlock`.

10. As a maintainer, I want every hint path covered by a test built from a REAL captured provider response, so that this code is verified against what providers actually send rather than against what we imagine they send.

11. As an operator with `parseConfig.filters` configured, I want the request planner's list issued CONCURRENTLY rather than one await at a time, so that N filters cost one round trip of latency instead of N. This changes no answer: the results are already unioned, sorted and de-duplicated afterwards, precisely because overlapping filters can return one log twice or out of order. Two properties must survive: the SINGLE-request path stays byte-for-byte the call it is today (the code already treats that as worth preserving, and it is the unfiltered case, which is most deployments), and the concurrency is BOUNDED rather than an unbounded fan-out, since a public provider answers a burst with a rate limit.

### Autonomy notes

Neither gate is set. Every story is committed direction with a known implementation, and the ground truth they depend on is already captured as a finding with dated, reproducible sources.

Explicitly independent of `measure-the-indexing-loop-before-optimising-it`: these are correctness and robustness improvements that happen to also save round trips, and their value does not depend on where the measurement lands. No `taskedAfter` is set for that reason.

## Out of Scope

- **The `eth_chainId` guard's round trips.** A cycle also pays for the chain-identity check that brackets the fetch, and reducing it is a SAFETY decision rather than a parsing one, so it has its own spec: `work/specs/proposed/one-chain-identity-check-per-cycle-not-two.md`.

- **Aligning fetch ranges to fixed buckets.** That is a cache-key precondition rather than a fetcher improvement, and it only pays off if a shared cache is built. It lives with `work/notes/ideas/a-shared-log-cache-in-front-of-the-node.md`.
- **Anything about the FOLD's round trips.** Separate spec.
- **Recovering bloom-omitted logs.** Section 3 of the finding records that a successful `eth_getLogs` can be silently incomplete on some chains and nodes. The only known remedy is a receipt-based path, which is a per-transaction cost ADR-0002 forbids. It is a documented limit, not a bug this spec fixes.

## Further Notes

Every number and error shape this spec reacts to lives in `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md`, with a dated source. Those figures are per-provider and per-plan and providers revise them, so the finding says to re-run the probes before treating any single number as current. A task here should do that rather than trusting a months-old capture.
