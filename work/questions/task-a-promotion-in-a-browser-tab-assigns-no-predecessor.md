<!-- dorfl-sidecar: item=task:a-promotion-in-a-browser-tab-assigns-no-predecessor type=task slug=a-promotion-in-a-browser-tab-assigns-no-predecessor allAnswered=false -->

## Q1

**'task:a-promotion-in-a-browser-tab-assigns-no-predecessor' was bounced — how should we proceed?**

> ADR-0089's central WIN, which acceptance criterion 5 encodes, does not follow from the change this task asks for. I implemented the decision fully and MEASURED it; the refusal it is supposed to remove survives, for a reason that has nothing to do with the `predecessor` slot.
>
> WHAT IS TRUE (premise confirmed, as the task asked): `GenerationRegistry.create` still RESOLVES an identity it already holds (`packages/core/src/generation/registry.ts:852`), so re-supplying the old code lands on the same generation record. The browser revert story without a slot is sound.
>
> WHAT IS FALSE: ADR-0089 "What it wins" -- "a registration needing the third meets the cap and is REFUSED. That refusal ... simply disappears under this one, because the third seat is never occupied" -- and therefore acceptance criterion 5 ("a tab at BROWSER_GENERATION_CAPS can now save repeatedly without meeting the cap on a third seat. The registration that previously failed with GenerationCapReachedError because a predecessor held the second slot is the case to assert").
>
> MEASUREMENT (implemented, run, then reverted; the tree is clean). Change: `moveCanonicalTo(id, options?: {assignPredecessor?: boolean})`, the flag read before the commit and applied INSIDE the plan so the assignment is never drafted (`registry.ts:1015`); `Indexer.movePointerTo` passes `{assignPredecessor: false}` (`container.ts:1433`); `ReceivingIndexer.movePointer` untouched. Harness: `packages/browser`, real `openGenerationRegistryOnIndexedDB` over fake-indexeddb, `fakeChain`, the fixtures of `aTabHoldsItsGenerationsInSlots.test.ts`.
>
>   1. IN-SESSION (the HMR save loop, one stream): open with fold A, `add(B)`, `promote(B)`. Slots afterwards are `{canonical: edited-by-2}` with NO predecessor -- the change works. The next save is still refused: `GenerationCapReachedError: this indexer is at its maxGenerations of 2`, with `dropped: []` and both rows still registered. Reason, checked directly against the built dist: `displacedBySuccessor(arriving, [A,B], {canonical: B}, heldHere) -> ['app']`, so the superseded generation IS displacement-eligible now, but `Indexer.wouldStrandAFollower` (`packages/core/src/container.ts:1669-1676`) declines the drop, because `fetcherOf([A,B], stream) === A` and the arriving generation is on that same stream. Dropping A would leave the promoted fold folding a stream nothing appends to. THAT DECLINE IS CORRECT (ADR-0044, and it is precisely ADR-0088's stall), so the second seat after a browser promotion is held by the stream's FETCHER, not by the `predecessor` slot. Removing the slot cannot free a seat the fetcher is sitting in.
>
>   2. AFTER A RELOAD (a fresh container holding only the fold the new bundle carries): the superseded generation is unheld and unslotted. `displacedBySuccessor` deliberately LEAVES an unheld, unslotted record alone (`registry.ts:594` plus its JSDoc: "collecting those is an operator's verb (`ReceivingIndexer.reclaim`)"), and the chain-facing container HAS NO SUCH VERB -- ADR-0084's amendment of 2026-09-16 says so in as many words. The save is refused again (`GenerationCapReachedError`). So on this runtime the superseded generation goes from "named by `predecessor`, reachable by a documented revert" to "named by nothing, collectable in principle and collected by nothing, ever" -- while still occupying the seat.
>
>   The headroom IS real in exactly one shape: a CROSS-STREAM change (a source/filter edit), where the superseded generation is alone on its old stream, `wouldStrandAFollower` returns false and the drop proceeds. That is not the case ADR-0089 argues from, which is the developer save loop on one stream.
>
> WHY THIS IS A STOP AND NOT A `## Decisions` NOTE: criteria 4 and 5 are in direct conflict on this runtime. Criterion 5 can only be met by something that COLLECTS an unslotted generation (in-session it must also solve "the unslotted generation is the fetcher"); criterion 4 forbids adding a deleter, the task forbids touching the caps and `dropOnPromotion`, and ADR-0044 says the fetch duty is never reassigned. Every candidate resolution is load-bearing, hard to reverse, and belongs to a decision this task does not carry. Building the assignment change alone and quietly rewriting criterion 5's test to assert the refusal it was meant to remove would land an ADR claiming a win the code does not deliver.
>
> SUGGESTED RE-SCOPE (pick one, at the human's discretion):
>   (a) SPLIT. Land the assignment change on its own (it is correct, small, and removes ADR-0088's trigger at the root: no predecessor, no surviving A named as the fetcher across a reload), with criterion 5 REMOVED from the acceptance and ADR-0089's "What it wins" AMENDED to say what the measurement says -- the third seat is freed only where the superseded generation is not the fetcher of the arriving stream, and a same-stream save loop after a promotion still meets the cap. Then task the remaining half separately: what collects an unslotted generation on the chain-facing container, and whether the fetch duty can leave a generation that is being collected (this is ADR-0044 territory and wants its own ADR).
>   (b) WIDEN this task to include that collector, and say in the acceptance which of the two blockers it must clear (the in-session fetcher decline, the post-reload unheld-and-unslotted record, or both), accepting that it contradicts criterion 4 as written.
>   (c) Re-open the `BROWSER_GENERATION_CAPS: 3` question that ADR-0084's 2026-09-16 amendment explicitly deferred; it is the only route that needs no deleter, and this measurement is new evidence for it.
>
> I changed nothing in the repo: both edited files were restored byte-for-byte from backups, the scratch test was deleted, `packages/core/dist` was rebuilt from the restored source, and `git status --porcelain` is empty.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
