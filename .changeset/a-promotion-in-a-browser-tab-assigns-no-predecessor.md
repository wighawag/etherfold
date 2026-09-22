---
'@etherfold/core': minor
'@etherfold/browser': patch
---

**A pointer move on the CHAIN-FACING container assigns no `predecessor`** (ADR-0089). `GenerationRegistry.moveCanonicalTo` takes a second argument, `{assignPredecessor?: boolean}`, defaulting to TRUE, and `Indexer.movePointerTo` is the one caller that passes `false`. A promotion in a browser tab therefore leaves the generation the pointer came off named by NO slot; on the receiving container (server, CLI) nothing changes and a revert works exactly as it did.

**Why.** `predecessor` is what a revert moves back to, and a revert needs the CODE of the fold it returns to. A browser tab cannot have it: a production bundle ships one processor, so the superseded generation's code is not merely un-promoted, it is absent from the build, and the slot names something the tab is structurally unable to instantiate. Going back in a browser is what it always was -- supply the old code, which derives the same identity and RESOLVES to the same generation record (ADR-0086), re-folding the stream already on disk since a stream outlives every fold over it (ADR-0087).

**The assignment is never DRAFTED rather than being drafted and cleared.** The flag is read before the commit and applied inside the plan, so there is no second write that could fail on its own and leave the slot populated. `SLOT_NAMES` is unchanged, `dropOnPromotion` is unchanged, the caps are unchanged and no deleter is added.

**What it means for a tab at `BROWSER_GENERATION_CAPS`, measured rather than assumed.** Unslotted is not collected: there is no `reclaim` verb on this runtime, so what decides the second seat after a promotion is whether an arriving registration may DROP the superseded generation. A CROSS-STREAM save (a source or filter edit) may -- it is alone on its old stream -- so a save that previously met `maxGenerations` now lands. A SAME-STREAM save loop may NOT, because that generation FETCHES the stream the arriving fold is on (ADR-0044), so it is retained and the registration still fails with `GenerationCapReachedError`. That refusal is unchanged behaviour with a different cause, and the cause is the fetch duty rather than a slot.

**If you call `moveCanonicalTo` directly:** it behaves exactly as before unless you pass `{assignPredecessor: false}`.
