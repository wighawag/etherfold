---
title: 'One chain-identity check per cycle, not two'
slug: one-chain-identity-check-per-cycle-not-two
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

Every indexing cycle makes two `eth_chainId` calls, one before the fetch and one after, and refuses to proceed if the answer is not the chain the source names. On a quiet range that is two of the three chain round trips a cycle spends before `eth_getLogs` returns nothing.

The two are not equally valuable, and only one of them is a guard:

- The **after-fetch** call is the safety one. It catches a provider that swapped chains DURING the fetch, which is exactly the window in which logs from chain B would otherwise be folded into chain A's stream.
- The **before-fetch** call only fails fast. It saves a wasted range fetch when the provider had already swapped before the cycle began, and catches nothing the after-fetch call does not.

So one of the two is redundant, and it is the cheap-to-identify one.

## Solution

Delete the before-fetch call. Keep the after-fetch call, unconditional and unconfigurable.

That halves the identity cost of every cycle, for every deployment, with no new configuration surface and no reduction in what is actually detected.

**No flag, deliberately.** An earlier draft of this spec proposed making the survivor optional with a per-deployment default (on in a browser, off on a server). That is withdrawn for three reasons, each sufficient on its own:

1. **Nothing has measured the remaining call.** One round trip per cycle is noise on a server catching up in thousand-block ranges, and only plausibly matters when tip-following with short cycles. Adding a permanent public config knob to reduce an unmeasured cost is the exact move `work/specs/proposed/measure-the-indexing-loop-before-optimising-it.md` exists to argue against, and this spec should not be the exception to its own sibling.
2. **ADR-0048 already sets the house rule for inputs: never a default.** A knob whose default differs by deployment either breaks that rule or forces every host to name it, and neither is worth it for a cost nobody has sized.
3. **The guard is the ONLY chain-swap detection that exists.** See below. Making the only guard optional is a large thing to do casually.

If the measurement later shows the remaining call matters, the knob can be added then, with a number attached and with the polarity question answered deliberately rather than in passing.

## What we learned while writing this, and why the guard is permanent

**`chainChanged` is promised in a comment and was never built.** The only two mentions of it in the repo are the comments beside these very calls, saying it is "important to warn the indexer as soon as possible via chainChanged event". No listener exists anywhere, and the provider type used throughout, INCLUDING in `@etherfold/browser`, is `EIP1193ProviderWithoutEvents`, which structurally cannot carry a subscription. So the per-cycle poll is not one of two mechanisms. It is the only one.

**And building the subscription would not retire the poll.** An event is delivered asynchronously, so it can arrive part-way through a cycle that is already executing: the fetch may be in flight, or the logs may be fetched and awaiting the fold. A guard that runs at a known point, after the fetch and before anything is applied, is what makes the check meaningful, and no amount of event plumbing gives that. A `chainChanged` subscription is therefore an IMPROVEMENT on top of this check (it can warn earlier, and it can pause the loop rather than failing a cycle), never a replacement for it.

This is why the after-fetch call is permanent machinery rather than a stopgap, and it is the strongest argument against making it configurable.

## User Stories

1. As an operator, I want the before-fetch chain-identity call removed, so that a cycle costs one fewer round trip while detecting exactly what it detected before.

2. As a maintainer, I want the reason the AFTER call is the one kept recorded where the code is, so that a future reader does not restore the before call for symmetry or delete the wrong one of the pair.

3. As a maintainer, I want the comment promising a `chainChanged` mechanism corrected, so that the code stops describing a design nobody built and a reader stops assuming a second line of defence exists.

4. As an operator, I want a chain-identity refusal to name what it expected and what it got, so that the failure is diagnosable in one read rather than needing a debugger.

5. As a maintainer, I want a test that a provider swapping chain mid-fetch is caught, so that the surviving guard is demonstrated rather than assumed, and so that deleting it later fails loudly.

### Autonomy notes

Neither gate is set. The spec launched with an open question about how a new config flag should join an existing family of deployment gates; that question is retired rather than answered, because the flag it was about is no longer proposed.

`humanOnly` is NOT set. Nothing here is a release, a secret or a security boundary.

## Out of Scope

- **Making the surviving check optional.** Deferred to `measure-the-indexing-loop-before-optimising-it`, which is where a number would come from. Recorded as a decision, not an omission: if that measurement shows the remaining call is significant at the tip, the follow-on decides the knob's name, its polarity, and whether it joins the `skipGenesisCheck` / `strictProcessorDrift` family (whose docstring pins them as LOAD-TIME gates, so a per-cycle gate does not obviously belong).

- **Building the `chainChanged` subscription.** A genuine improvement and worth doing on its own merits, but it needs an events-capable provider at the browser seam, which is a real change to a public type. It also cannot retire this check, per the reasoning above, so it is additive work rather than a prerequisite or a replacement.

- **`eth_blockNumber`.** The third round trip in a cycle is a tip read, load-bearing, and not a guard.

- **The genesis-hash check.** Live at load, gated by `skipGenesisCheck`, and untouched here. Its `earliest`-instead-of-block-0 bug, confirmed since, has been FIXED (`work/tasks/done/the-genesis-check-asks-for-block-zero-not-the-earliest-tag.md`), which changes two of this spec's premises: the commented-out per-cycle genesis check that used to sit beside the calls this spec deletes is now DELETED rather than commented out, so there is no dead block here to trip over, and reviving a per-cycle genesis read means calling `checkGenesisHash`, which is now the single place that question is asked. That revival is still its own decision with its own per-cycle cost, and still out of scope here. Note also that the load-path `eth_chainId` refusal is a bare uncaught `Error`, a third site neither that task nor this spec has scoped: story 4's expected-vs-received wording is the natural place to fix it.

## Further Notes

This is one of two stories that went missing when the original round-trip spec was split three ways (`work/specs/dropped/the-indexing-loop-is-round-trip-bound.md`, story 7). The other, multi-filter concurrency, went to the fetcher spec as its story 11.

Two corrections from review are recorded because both were confidently wrong. The first draft asserted the genesis-hash check was commented-out dead code; it is live at load. The first draft also proposed a new optional-guard concept without noticing that `ProvidedIndexerConfig` already carries a named family for exactly that. Both came from reading the lines immediately around the code being changed rather than the surrounding config type. The flag those corrections were about is now gone, but the lesson survives them.
