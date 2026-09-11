---
status: accepted, not yet implemented
---

# One chain-identity check per cycle, after the fetch, and never optional

Every indexing cycle brackets its log fetch with two `eth_chainId` calls and refuses to proceed if either answer is not the chain the source names. There are two such pairs, one per deployment shape: the in-process engine's, in `promiseToIndex`, and the split deployment's fetcher, in `assertChain('before' | 'after')`. We decided to **delete the BEFORE-fetch call in both, keep the AFTER-fetch call, and keep it unconditional and unconfigurable.** That halves the identity cost of every cycle in every deployment while detecting exactly what was detected before.

## Why the after-fetch call is the one that survives

Only one of the pair is a guard. The **after** call catches a provider that swapped chains DURING the fetch, which is precisely the window in which chain B's logs would otherwise be folded into chain A's stream. The **before** call only fails fast: it saves a wasted range fetch when the provider had already swapped before the cycle began, and it catches nothing the after call does not.

This is recorded because the pair looks symmetric and is not. Deleting the wrong one of the two, or restoring the deleted one for symmetry, is the specific mistake this ADR exists to prevent, and the code carries the same note beside the surviving call.

## Why a `chainChanged` subscription cannot replace it

Before this decision, the repository's only mentions of `chainChanged` were the comments beside these very calls, saying it is "important to warn the indexer as soon as possible via chainChanged event". No listener existed anywhere, and the provider type used throughout, INCLUDING in `@etherfold/browser`, is `EIP1193ProviderWithoutEvents`, which structurally cannot carry a subscription. So the per-cycle poll was never one of two mechanisms; it was the only one.

Building the subscription would not retire it either. An event is delivered asynchronously, so it can arrive part-way through a cycle that is already executing: the fetch may be in flight, or the logs may be fetched and awaiting the fold. A check that runs at a KNOWN point, after the fetch and before anything is applied, is what makes the answer meaningful, and no amount of event plumbing gives that. A `chainChanged` subscription is therefore an IMPROVEMENT on top of this check (it can warn earlier, and it can pause the loop rather than failing a cycle), never a replacement for it.

## Why the survivor has no flag

An earlier draft proposed making the survivor optional, with a per-deployment default: on in a browser, off on a server. It is withdrawn, for three reasons each sufficient on its own.

**Nothing has measured the remaining call.** One round trip per cycle is noise on a server catching up in thousand-block ranges, and only plausibly matters when tip-following with short cycles. Adding a permanent public knob to reduce an unmeasured cost is the exact move `work/specs/proposed/measure-the-indexing-loop-before-optimising-it.md` exists to argue against.

**A knob whose default differs by deployment fits nothing we already do.** ADR-0048 sets the house rule for CLI inputs — a flag, then the one environment variable behind it, then a refusal naming both, never a default — and the nearest library-side family (`skipGenesisCheck`, `strictProcessorDrift`) is pinned by its own docstring as LOAD-TIME gates, which a per-cycle gate does not obviously join. So the knob would either break the rule or force every host to name it, for a cost nobody has sized.

**It is the only chain-swap detection that exists**, per the section above. Making the sole guard optional is a large thing to do in passing.

If the measurement later shows the remaining call matters at the tip, the knob can be added then, with a number attached and with the polarity question answered deliberately.

## Consequences

The pair's asymmetry becomes visible in the code: one deployment-shape-agnostic check, after the fetch, before anything is applied. A reader who finds one call where they expected two should find this ADR before concluding the other was lost.

The two shapes converge on one refusal type. `UnexpectedChainError` already carried the expected chain, the actual one and which side of the fetch caught it on the fetcher path; the in-process engine's three bare `Error`s (per-cycle, load and reconfigure) move onto the same type, so an operator reads one refusal rather than four spellings of it.
