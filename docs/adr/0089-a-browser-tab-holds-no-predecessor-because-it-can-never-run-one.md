# A browser tab holds no PREDECESSOR, because it can never run one

> **AMENDED 2026-09-22 (ADR-0090): the two limits this ADR records under "What it wins" were LIFTED the same week, and the amendment at the end says which.** The decision here is unchanged and still stands: a pointer move on the chain-facing container assigns no `predecessor`. What no longer holds is the narrowness of what that bought, because a promotion on that runtime now discards what it superseded and hands over its stream.

`predecessor` is the slot a revert moves back to (ADR-0084), and it is retained so that moving the canonical pointer back is a revert rather than a re-index. On a server that is worth what it costs. **In a browser it is worth nothing, because the code that fold needs is not in the build, and the tab cannot go and get it.** We decide that a pointer move on the CHAIN-FACING container assigns no `predecessor`: the superseded generation is not named by a slot, and is collectable like any other unslotted generation. The slot itself stays in the vocabulary and stays live on the receiving runtime.

## Why the browser case is different, and it is not a matter of degree

A browser tab has exactly two environments and neither one can use a retained predecessor.

**In DEVELOPMENT the processor is the code in the editor.** A save produces a new generation beside the live one and the policy promotes it; the generation left behind is the previous edit. Reverting that edit is what a developer does anyway, and it costs a keystroke. Nothing is gained by the registry also holding a seat for it.

**In a PRODUCTION BUILD there is no second processor at all.** The app ships one bundle containing one processor. When a new bundle is deployed and a tab loads it, the previous generation's code is not merely un-promoted, it is **absent from the build**: it is code that no longer exists in the program that is running. A slot naming it names something the tab is structurally unable to instantiate. That is the whole argument, and it is why this is not a trade-off about how much a revert window is worth: on this runtime the revert window does not exist to be valued.

## The revert still works, and it works by the mechanism that was already there

Removing the slot does not remove the ability to go back, because in a browser going back has always meant SUPPLYING THE OLD CODE, and the code is what names a generation.

Identity is derived from the code and never declared (ADR-0086), and `GenerationRegistry.create` RESOLVES an identity it already holds rather than registering a second one:

```ts
const found = current.generations.find((record) => sameGeneration(record, wanted));
if (found) { resolved = found; ... }
```

So undoing an edit, which restores the same handler source text and therefore the same derived identity, or redeploying the previous bundle, which restores the same `sha256`, lands on the SAME generation record. What the `predecessor` slot adds to that is only that the record is protected from collection in the meantime.

**And the cost of losing that protection is now small, because of ADR-0087.** A dropped generation takes its registry row and its state namespace, and **never its stream**. So a tab that supplies the old code again re-folds it from the stream already on disk: a local scan, not a re-fetch from a public node that frequently refuses historical ranges. The expensive half is kept by a decision already made; what this drops is the cheap, recomputable half.

## What it costs, stated plainly

**One case stops working: a same-session revert in development.** After a save and a promotion, the superseded generation's processor object is still in memory for the life of the page, so today a revert to it would work without any retained bytes. Under this decision it is collectable instead, and going back costs re-supplying the code and a local re-fold.

That is the entire cost, and it is accepted on the grounds that the developer reverting an edit has the editor open.

## What it wins, stated as what was MEASURED

This section is deliberately narrow, and it is narrower than the first draft of this ADR claimed. That draft argued the change frees the second seat outright and removes ADR-0088's defect at the root. Both claims assumed UNSLOTTED implies COLLECTED, and on this runtime it does not: there is no `reclaim` verb on the chain-facing container, and a registration deliberately leaves a record no slot names alone unless dropping it is safe. The claims were built, measured and found false before this decision was implemented, so they are corrected here rather than preserved: they never described the code for even one commit, and keeping them as a reasoning trail would only mislead.

**What this change IS, then, is correctness and hygiene: a tab stops reserving a seat for a generation it could never run.** A slot is a claim about what a deployment is USING, and a claim no code on this runtime can act on is a wrong claim, whatever it costs. That argument is structural and stands on its own.

**The seat it frees is the CROSS-STREAM one.** After a promotion the superseded generation is named by nothing, so an arriving registration may drop it -- and on a source or filter edit it is alone on its old stream, so the drop proceeds and a save that previously met `maxGenerations` now lands. That is real headroom and it is asserted (`packages/browser/test/aTabHoldsItsGenerationsInSlots.test.ts`).

**The SAME-STREAM save loop still meets the cap, and that refusal is correct.** A developer editing a handler stays on one stream, and there the superseded generation is the FETCHER of the stream the arriving fold is on: dropping it would leave that fold folding a stream nothing appends to, so the drop is declined (ADR-0044) and the second seat stays occupied. The seat is held by the FETCH DUTY, not by a slot, which is why removing the slot cannot free it. What would free it is something that COLLECTS an unslotted generation on this runtime, plus an answer to whether the fetch duty may leave a generation being collected; that is ADR-0044 territory, it wants its own decision, and it is deliberately not taken here. **It was taken four days later, by ADR-0090; see the amendment at the end.**

**ADR-0088's rule is NOT reverted and is not weakened.** Deriving the fetcher from the folds a container HOLDS is correct independently of what any slot names, and it is the rule that makes the answer true by construction rather than true by luck. Nor does this change touch that stall in either direction: the superseded generation survives here whether or not a slot names it, since nothing collects an unslotted one, and `follows` is already derived from the set the container WILL HOLD, so an unheld generation is never named as a fetcher whatever any slot says. That ADR removes the class, and it removes it alone. (Under ADR-0090 the superseded generation no longer survives at all on this runtime; the conclusion about ADR-0088 is unaffected either way, which is the point of the sentence.)

## Considered options

**Retain the processor's BYTES so the tab can instantiate a predecessor** (the browser half of `a-generation-retains-the-code-that-folds-it`). Rejected, and this is the option this ADR exists to decline. It was spiked before being tasked, and the measurement is unambiguous: `blob:` and `data:` module imports and `new Function` are all refused under every policy a real app ships, including the reference deployment's own gateway, and the ONE mechanism that survives is a service worker holding the bytes and answering a same-origin URL (`work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md`). That is a real mechanism and it works in all three engines, but it makes a service worker a REQUIRED component of any app wanting the feature, which is a large and permanent addition to what embedding this library means. Paying it to enable a revert target that the two arguments above say has no value is the wrong trade. The finding stands and is kept; it is simply no longer load-bearing.

**Default `dropOnPromotion` to true in the browser.** Rejected, though it reaches a similar end state. It conflates two things that should stay separate: `dropOnPromotion` is a POLICY an operator sets about whether a demonstrated promotion discards what it superseded, and this is a STRUCTURAL fact about what a runtime can run at all. It also arrives too late, as a second act after the pointer has moved, which can fail on its own and leave the slot populated.

**Remove `predecessor` from `SLOT_NAMES` entirely.** Rejected. The slot is live and useful on the receiving runtime, where an operator reverts without redeploying and the code arrives by a route the browser does not have. Forking the slot vocabulary between the two containers would make one model into two for no gain; what differs is which runtime ASSIGNS it, not what it means.

## Consequences

**The assignment must not be made and then undone.** `moveCanonicalTo` sets `canonical` and `predecessor` in ONE commit, deliberately, and the registry's own comment says that atomicity is the point. So this is a decision the pointer move itself takes, not a clear-afterwards: a move that assigns nothing must be a move that never drafted the assignment. Where the runtime's answer lives is an implementation choice; it must be readable at the moment of the commit, and `GenerationCaps` is not it (that type is documented as a COUNT and never a policy). As built it is an OPTION ON THE MOVE -- `moveCanonicalTo(id, {assignPredecessor: false})`, passed by `Indexer.movePointerTo` and by nothing else, read before the commit and applied inside the plan -- because what differs is the CONTAINER doing the moving rather than the substrate holding the rows, and the default is the assignment, so a caller that says nothing keeps its revert window.

**ADR-0084 is amended on one axis.** Its three slots stand and their meanings are unchanged. What changes is that `predecessor` is assigned by the RECEIVING runtime only, so its statement that a browser tab holds `canonical` + `predecessor` after a promotion stops describing anything reachable.

**`a-generation-retains-the-code-that-folds-it` loses its browser half** and is re-scoped to the server, where the problem it names is real and unaddressed: an operator reverts, the old state answers reads, and the deployment never advances because the process holds no engine for what it now serves.

**No migration.** Nothing is published and no disk anywhere holds state this project must preserve (`CONTEXT.md`), so a registry that already assigned a `predecessor` is not a case to carry forward.

**What a superseded browser generation becomes is UNSLOTTED, not deleted on the spot.** It is collectable, by the same rule as any generation no slot names; nothing here adds a new deleter, and ADR-0087's removal of the automatic reap is untouched. And on this runtime COLLECTABLE is all it is: the `reclaim` verb belongs to the receiving container (ADR-0084's amendment of 2026-09-16), so nothing collects such a generation here at all. That gap is deliberate, it is the reason the wins above are narrow, and it is captured rather than closed. **ADR-0090 closed it.**

## Amendment, 2026-09-22 (ADR-0090): both limits above are lifted, and a promotion now finishes the job

Everything above is kept as written, because unlike this ADR's first draft it was TRUE of the code: between this decision landing and ADR-0090 landing, a superseded browser generation really did survive uncollected, and the same-stream save loop really did meet the cap. That is a record of a real intermediate state rather than a claim that never described anything, which is why it is amended here instead of corrected in place.

What changed is the two limits, and they had one cause. This ADR assumed UNSLOTTED implies COLLECTED; on this runtime nothing collected an unslotted generation, so removing the slot freed no seat in the case a developer actually lives in. ADR-0090 supplies what was missing on both sides of that: a promotion DISCARDS the generation it superseded and the FETCH DUTY moves to the promoted one in the same act, which is safe because a promotion is precisely the moment the promoted fold has provably reached the writer's cursor; and a generation this runtime holds no fold for is collected when a registration needs room, which is the reload case.

So **"the seat it frees is the CROSS-STREAM one" is now too narrow** -- every promotion frees the second seat, on both kinds of save -- and **"the SAME-STREAM save loop still meets the cap" is no longer true**, which was the wall no page reload could clear. The structural argument this ADR actually rests on is untouched and is what made ADR-0090 reachable: in a browser the code a predecessor's fold needs is absent from the build, so the slot named something the tab could never instantiate.

The observation that carried the measurement was DISCHARGED into ADR-0090 and the tests, per the work contract's rule that a note leaves once a self-contained artifact carries its signal.

**Appended 2026-09-22: half of that gap is now closed, and it is the RELOAD half.** ADR-0090's point 3 is built (`a-generation-this-tab-holds-no-fold-for-is-collected-when-room-is-needed`): on this runtime a generation NO FOLD EXISTS FOR, that no slot names and that is not canonical, is COLLECTED by an arriving registration. So "nothing collects such a generation here at all" is true only while this process still HOLDS its fold, which is the session that made it; after a page reload the survivor goes on the next save, and the wall that no reload could clear is gone. Nothing above is retro-fitted, because it described the code when it was written and the rest of it still does: the SAME-STREAM in-session refusal stands unchanged (that generation is held and is the stream's FETCHER, so the drop is still declined), and what frees that seat is the fetch-duty HAND-OVER of ADR-0090's points 1 and 2, which is not built yet. ADR-0088's rule is still not reverted; it is EXTENDED, to the second site that asks who fetches a stream (its amendment of the same date).
