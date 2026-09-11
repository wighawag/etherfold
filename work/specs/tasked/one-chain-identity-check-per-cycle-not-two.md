---
title: 'One chain-identity check per cycle, not two'
slug: one-chain-identity-check-per-cycle-not-two
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> Tasked 2026-09-11. The technical detail moved into the three tasks this produced; the durable rationale — why the AFTER call is the survivor, why a `chainChanged` subscription cannot replace it, and why the survivor is unconfigurable — moved to **ADR-0081**.

## Problem Statement

Every indexing cycle makes two `eth_chainId` calls, one before the fetch and one after, and refuses to proceed if the answer is not the chain the source names. On a quiet range that is two of the three chain round trips a cycle spends before `eth_getLogs` returns nothing.

**There are two such pairs, one per deployment shape.** The in-process engine makes its pair around the fetch in its per-cycle path, throwing bare `Error`s. The split deployment's log fetcher makes its own pair through a private chain assertion, throwing the typed `UnexpectedChainError` that already carries the expected chain, the actual one, and which side of the fetch caught it. This spec launched seeing only the first pair and describing the problem as one pair; story 1 was amended when it was tasked, so the deletion covers both.

The two calls in a pair are not equally valuable, and only one of them is a guard:

- The **after-fetch** call is the safety one. It catches a provider that swapped chains DURING the fetch, which is exactly the window in which logs from chain B would otherwise be folded into chain A's stream.
- The **before-fetch** call only fails fast. It saves a wasted range fetch when the provider had already swapped before the cycle began, and catches nothing the after-fetch call does not.

So one of the two is redundant, and it is the cheap-to-identify one.

## Solution

Delete the before-fetch call in both deployment shapes. Keep the after-fetch call, unconditional and unconfigurable.

That halves the identity cost of every cycle, for every deployment, with no new configuration surface and no reduction in what is actually detected.

**No flag, deliberately.** An earlier draft proposed making the survivor optional with a per-deployment default. It is withdrawn, and the three reasons are in ADR-0081 along with the reason the guard is permanent machinery rather than a stopgap: `chainChanged` was promised in a comment beside these very calls and never built, the provider type used throughout structurally cannot carry a subscription, and an asynchronously delivered event could not replace a check that runs at a known point after the fetch and before anything is applied.

A refusal on any of these paths should name what it expected and what it got. The fetcher's already does; the engine's three sites (per-cycle, load, reconfigure) do not, and that is the other half of the work.

## User Stories

1. As an operator, I want the before-fetch chain-identity call removed **from both the in-process engine and the split deployment's fetcher**, so that a cycle costs one fewer round trip in either shape while detecting exactly what it detected before.

2. As a maintainer, I want the reason the AFTER call is the one kept recorded where the code is, so that a future reader does not restore the before call for symmetry or delete the wrong one of the pair.

3. As a maintainer, I want the comment promising a `chainChanged` mechanism corrected, so that the code stops describing a design nobody built and a reader stops assuming a second line of defence exists.

4. As an operator, I want a chain-identity refusal to name what it expected and what it got, so that the failure is diagnosable in one read rather than needing a debugger.

5. As a maintainer, I want a test that a provider swapping chain mid-fetch is caught, so that the surviving guard is demonstrated rather than assumed, and so that deleting it later fails loudly.

## Out of Scope

- **Making the surviving check optional.** Deferred to `work/specs/proposed/measure-the-indexing-loop-before-optimising-it.md`, which is where a number would come from. Recorded as a decision, not an omission: if that measurement shows the remaining call is significant at the tip, the follow-on decides the knob's name, its polarity, and whether it joins the `skipGenesisCheck` / `strictProcessorDrift` family (whose docstring pins them as LOAD-TIME gates, so a per-cycle gate does not obviously belong).

- **Building the `chainChanged` subscription.** A genuine improvement and worth doing on its own merits, but it needs an events-capable provider at the browser seam, which is a real change to a public type. It also cannot retire this check, per ADR-0081, so it is additive work rather than a prerequisite or a replacement.

- **`eth_blockNumber`.** The third round trip in a cycle is a tip read, load-bearing, and not a guard.

- **The genesis-hash check.** Live at load, gated by `skipGenesisCheck`, and untouched here. Its `earliest`-instead-of-block-0 bug has been fixed, which retired two of this spec's original premises: the commented-out per-cycle genesis check that used to sit beside these calls is now deleted rather than commented out, and reviving a per-cycle genesis read means calling `checkGenesisHash`, which is now the single place that question is asked. That revival is still its own decision with its own per-cycle cost.

## Further Notes

This is one of two stories that went missing when the original round-trip spec was split three ways (`work/specs/dropped/the-indexing-loop-is-round-trip-bound.md`, story 7). The other, multi-filter concurrency, went to the fetcher spec as its story 11.

Three corrections are recorded because each was confidently wrong, and all three came from reading the lines immediately around the code being changed rather than the surrounding module. The first draft asserted the genesis-hash check was commented-out dead code; it is live at load. The first draft proposed a new optional-guard concept without noticing that `ProvidedIndexerConfig` already carried a named family for exactly that. And the spec described ONE pair of calls when there are two, in two deployment shapes, one of which already threw the typed error story 4 asks for — caught at tasking, by grepping for the call rather than reading the file the spec named.
