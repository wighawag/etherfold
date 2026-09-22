---
title: 'An UNSLOTTED generation on the chain-facing container is collected by NOTHING, so removing a slot frees no seat'
slug: an-unslotted-generation-on-the-chain-facing-container-is-collected-by-nothing
observed: 2026-09-22
---

2026-09-22 — Measured while driving `a-promotion-in-a-browser-tab-assigns-no-predecessor`, which routed to needs-attention on it. Recorded here because a stopped build leaves no diff, because it falsifies BOTH claims in one landed ADR's "What it wins", and because the question it opens is owned by no ADR, task or note today.

**The assumption, stated once so it can be checked elsewhere: ADR-0089 assumes UNSLOTTED implies COLLECTED. On the chain-facing container it does not, and nothing on that runtime makes it so.** Every consequence below follows from that one gap.

## What was measured

`moveCanonicalTo(id, options?: {assignPredecessor?: boolean})` was implemented with the flag read before the commit and applied INSIDE the plan (so the assignment is never drafted, per ADR-0089's atomicity consequence), `Indexer.movePointerTo` passing `{assignPredecessor: false}`, and `ReceivingIndexer.movePointer` untouched. Harness: `packages/browser`, real `openGenerationRegistryOnIndexedDB` over fake-indexeddb, `fakeChain`, the fixtures of `aTabHoldsItsGenerationsInSlots.test.ts`. It was then reverted; the tree is clean and no branch was pushed.

**The assignment change itself works.** After `add(B)` + `promote(B)` the slots are `{canonical: B}` with no `predecessor`.

**The seat is not freed, in either shape.**

1. **IN-SESSION (the HMR save loop, one stream).** The next save is still refused with `GenerationCapReachedError`, `dropped: []`, both rows still registered. The superseded generation IS displacement-eligible now, but `Indexer.wouldStrandAFollower` (`packages/core/src/container.ts:1669-1676`) declines the drop: `fetcherOf(registered, stream)` is A and the arriving generation is on that same stream, so `record.stream === arrivingStream` returns `true`. Dropping A would leave the promoted fold folding a stream nothing appends to. **That decline is correct** (ADR-0044). So the second seat after a browser promotion is held by the stream's FETCHER, not by the `predecessor` slot, and removing the slot cannot free a seat the fetcher is sitting in.

2. **AFTER A RELOAD.** The superseded generation is unheld and unslotted. `displacedBySuccessor` (`packages/core/src/generation/registry.ts:594`) deliberately leaves an unheld, unslotted record alone: its last clause is `return heldHere(record)`, and its JSDoc says collecting those is an operator's verb (`ReceivingIndexer.reclaim`). The chain-facing container **has no such verb** — ADR-0084's amendment of 2026-09-16 says so in as many words, and says the verb was deliberately not ported. The save is refused again.

So on this runtime the superseded generation moves from "named by `predecessor`" to "named by nothing, collectable in principle and collected by nothing, ever", while occupying the seat either way.

**The headroom is real in exactly one shape:** a CROSS-stream change (a source or filter edit), where the superseded generation is alone on its old stream, `wouldStrandAFollower` returns `false`, and the drop proceeds. That is not the case ADR-0089 argues from, which is the developer save loop on one stream.

## Both of ADR-0089's stated wins are falsified, for the same reason

- **"The save loop always has room."** False, per measurement 1. The refusal it promises to remove survives, and its cause has nothing to do with the `predecessor` slot.
- **"It removes ADR-0088's defect at the root ... with no predecessor assigned there is no surviving A."** Also false, and this half was missed by the stopped build's own re-scope suggestion. **A survives either way**, because nothing collects an unslotted generation. Separately, ADR-0088's stall is already unreachable by ADR-0088's OWN fix: `follows` is derived from `fetcherOf(willHold, ...)` (`packages/core/src/container.ts:946`), the set the container WILL HOLD, so an unheld A is never named as the fetcher whatever any slot says. Removing the assignment adds nothing here.

What survives untouched is ADR-0089's **structural** argument, which is the load-bearing one: in a browser the code a predecessor's fold needs is absent from the build, so the slot names something the tab cannot instantiate. The decision is still right. Its stated WINS were not.

## The open question, owned by nobody

**What collects an unslotted generation on the chain-facing container, and may the fetch duty leave a generation that is being collected?**

The second half is ADR-0044 territory and is why this is not a small gap: in-session, the generation occupying the seat is the stream's fetcher, and ADR-0044's rule is that the duty is never reassigned. Any collector must therefore either decline exactly the case that matters, or change who may fetch. `ReceivingIndexer.reclaim` is an operator verb on a runtime that HAS an operator and an `ADMIN_TOKEN`; a browser tab has neither, which is precisely why ADR-0084 declined to port it, so "just port `reclaim`" is not available without answering what fires it.

**New evidence for a deferred decision.** ADR-0084's 2026-09-16 amendment explicitly deferred raising `BROWSER_GENERATION_CAPS.maxGenerations` to three as "a separate decision with its own storage argument". This measurement is evidence for it: it is the only route that relieves the seat pressure **without** adding a deleter and without reopening ADR-0044. Recorded here rather than opened, deliberately.

## 2026-09-22, appended: the blockers are TWO and this note named the second one first

The question above points at ADR-0044 as the blocker. That is the IN-SESSION blocker and it is real, but reading this note as written leads to a fix that cannot work, so the ordering is corrected here.

**In the RELOAD case the strand rule is never reached.** `replaceTheSuccessor` builds its candidate list through `displacedBySuccessor`, passing an INJECTED "do I hold a fold for this" predicate, and that function's last clause is `return heldHere(record)`. An unheld, unslotted record is filtered out THERE, so `wouldStrandAFollower` never sees it. Narrowing the strand rule alone therefore changes nothing in this case. The primary blocker is the displacement predicate, plus ADR-0084's refusal to make collection automatic on a runtime with no operator.

The strand rule is still a SECOND, dependent blocker: clear the first and the drop is still declined, because `wouldStrandAFollower` derives the fetcher from the REGISTERED set, where the dead row is the oldest and so still reads as the fetcher, even though `follows` on the live fold was derived from the HELD set (ADR-0088) and says the live fold fetches. Two sites, two answers, one of them about a generation that no longer exists in any fold.

**In the IN-SESSION case the blocker is neither of those.** It is `dropSuperseded`'s `if (!superseded.follows && strands)` decline, and behind it the fact that `follows` is frozen into the engine config at construction. The superseded generation fetches the stream the promoted one was built to follow, and that relationship is an artifact of which folds were held when the successor was constructed: the same successor, built alone after a reload, IS the fetcher.

**The mechanism is cheaper than this note implies.** `heldHere` is injected per container, so the chain-facing side can widen what counts as collectable without touching the receiving container's rule at all. What is missing is a decision, not a refactor.

Both halves, and the hand-over that makes the in-session case work, are now proposed in ADR-0090. This note stays until that decision lands or is refused.
