---
status: accepted, not yet implemented
---

# A browser tab holds no PREDECESSOR, because it can never run one

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

## What it wins

**A tab stops having to choose between a revert window and a save loop.** At `BROWSER_GENERATION_CAPS` (`maxGenerations: 2`) a tab can hold `canonical` + `successor` or `canonical` + `predecessor`, and not all three; a registration needing the third meets the cap and is REFUSED with `GenerationCapReachedError`. That refusal is correct under the current model and simply disappears under this one, because the third seat is never occupied. The save loop always has room.

**It removes ADR-0088's defect at the root**, which is the strongest evidence that the slot was doing harm rather than nothing on this runtime. That ADR's stall reproduces because "`dropOnPromotion` defaults to `false` and a generation `predecessor` names is untouchable, so A survives" and is then named as the fetcher while unheld. With no predecessor assigned there is no surviving A and the trigger is unreachable.

**ADR-0088's rule is NOT reverted and is not weakened.** Deriving the fetcher from the folds a container HOLDS is correct independently of what any slot names, and it is the rule that makes the answer true by construction rather than true by luck. This removes one way of reaching the old bug; that ADR removes the class.

## Considered options

**Retain the processor's BYTES so the tab can instantiate a predecessor** (the browser half of `a-generation-retains-the-code-that-folds-it`). Rejected, and this is the option this ADR exists to decline. It was spiked before being tasked, and the measurement is unambiguous: `blob:` and `data:` module imports and `new Function` are all refused under every policy a real app ships, including the reference deployment's own gateway, and the ONE mechanism that survives is a service worker holding the bytes and answering a same-origin URL (`work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md`). That is a real mechanism and it works in all three engines, but it makes a service worker a REQUIRED component of any app wanting the feature, which is a large and permanent addition to what embedding this library means. Paying it to enable a revert target that the two arguments above say has no value is the wrong trade. The finding stands and is kept; it is simply no longer load-bearing.

**Default `dropOnPromotion` to true in the browser.** Rejected, though it reaches a similar end state. It conflates two things that should stay separate: `dropOnPromotion` is a POLICY an operator sets about whether a demonstrated promotion discards what it superseded, and this is a STRUCTURAL fact about what a runtime can run at all. It also arrives too late, as a second act after the pointer has moved, which can fail on its own and leave the slot populated.

**Remove `predecessor` from `SLOT_NAMES` entirely.** Rejected. The slot is live and useful on the receiving runtime, where an operator reverts without redeploying and the code arrives by a route the browser does not have. Forking the slot vocabulary between the two containers would make one model into two for no gain; what differs is which runtime ASSIGNS it, not what it means.

## Consequences

**The assignment must not be made and then undone.** `moveCanonicalTo` sets `canonical` and `predecessor` in ONE commit, deliberately, and the registry's own comment says that atomicity is the point. So this is a decision the pointer move itself takes, not a clear-afterwards: a move that assigns nothing must be a move that never drafted the assignment. Where the runtime's answer lives is an implementation choice; it must be readable at the moment of the commit, and `GenerationCaps` is not it (that type is documented as a COUNT and never a policy).

**ADR-0084 is amended on one axis.** Its three slots stand and their meanings are unchanged. What changes is that `predecessor` is assigned by the RECEIVING runtime only, so its statement that a browser tab holds `canonical` + `predecessor` after a promotion stops describing anything reachable.

**`a-generation-retains-the-code-that-folds-it` loses its browser half** and is re-scoped to the server, where the problem it names is real and unaddressed: an operator reverts, the old state answers reads, and the deployment never advances because the process holds no engine for what it now serves.

**No migration.** Nothing is published and no disk anywhere holds state this project must preserve (`CONTEXT.md`), so a registry that already assigned a `predecessor` is not a case to carry forward.

**What a superseded browser generation becomes is UNSLOTTED, not deleted on the spot.** It is collectable, by the same rule as any generation no slot names; nothing here adds a new deleter, and ADR-0087's removal of the automatic reap is untouched.
