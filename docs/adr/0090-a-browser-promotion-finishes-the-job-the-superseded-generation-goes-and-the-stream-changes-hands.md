---
status: accepted, not yet implemented
---

# A browser promotion FINISHES THE JOB: the superseded generation goes, and the stream CHANGES HANDS

ADR-0089 stopped a browser promotion from naming a `predecessor`. It did not make the superseded generation GO, and measurement showed it does not go at all: it keeps its registry row and its state namespace for ever, and the developer's next save meets `maxGenerations` and is REFUSED (measured in the observation `an-unslotted-generation-on-the-chain-facing-container-is-collected-by-nothing`, and asserted in `packages/browser/test/aTabHoldsItsGenerationsInSlots.test.ts`). We decide that on the CHAIN-FACING container a promotion DISCARDS what it superseded, and that the FETCH DUTY moves to the promoted generation in the same act. The receiving container is untouched: there an operator reverts, and `predecessor`, `reclaim` and the retention default all stay exactly as they are.

**The one-line argument:** on this runtime the promoted generation is the only one that can still run, so it should hold everything a running deployment holds, including the pen.

## What is already there, and why the missing piece is small

`dropOnPromotion` is BUILT. It defaults to `false`, and under `immediate` it already defers rather than refuses: retention CONTINUES until the successor reaches the cursor the previous generation had at the promotion, and the drop happens then (`arrangeDrop`). So the obvious objection to discarding a complete state for an empty one is already answered by machinery in the tree.

Under the default `on-catch-up` policy there is no such objection to answer. The promotion IS the event "the successor caught up", and a generation folds into its OWN state namespace, so at the moment the pointer moves the promoted generation already holds a complete state of its own. Nothing blanks, nothing replays, and no progress indicator is needed. What the superseded generation's state was FOR was answering reads while it was canonical, and it has just stopped being canonical.

So what is missing is not retention policy and not a collector. It is one thing: the STREAM.

## The real blocker, stated exactly

In the common case a save keeps the same source and filter, so both generations sit on ONE stream. Which generation fetches it is the oldest one the container holds (ADR-0088), so when the successor was constructed the incumbent was present and the successor was built as a FOLLOWER: `follows` is derived once, at construction, and frozen into the engine's config as `readOnlyStream`. Dropping the incumbent would leave the follower folding a stream nothing appends to, so `dropSuperseded` DECLINES, and says so: "delete it explicitly once nothing follows its stream."

That decline is correct under ADR-0044 and this ADR does not weaken it. What this ADR observes is that **the follower relationship here is an artifact of CONSTRUCTION ORDER, not a fact about the two generations.** The same successor, in a tab reloaded one second later, is built alone and IS the fetcher. Same code, same stream, different answer, decided by who happened to be held at the moment it was built.

**So the fix is to make the promotion do what the reload already does**, rather than to weaken a safety rule or to wait for a reload to repair the state.

## The decision

1. **A promotion on the chain-facing container discards the generation it superseded.** `dropOnPromotion` becomes the browser's default rather than an operator's opt-in. Under `immediate` the EXISTING deferral stands unchanged: the drop waits until the promoted generation reaches the cursor the superseded one had.
2. **The fetch duty moves to the promoted generation in the same act.** Where the superseded generation was the fetcher of a stream the promoted one follows, the promoted generation stops following and takes the stream. This is safe at exactly this moment and is the reason the hand-over is tied to the promotion rather than offered as a general verb: under `on-catch-up` the promoted generation has reached the incumbent's cursor by definition, and under `immediate` the deferral has already waited for that same condition. There is no gap to lose appends in, because the successor is at the point the writer had reached.
3. **A generation this runtime holds NO FOLD for, that no slot names and that is not canonical, is collectable when a registration needs room.** This is the reload case, where the superseded generation survived an earlier session: it can never answer a read and can never fetch, because its code is not in the bundle. Collecting it needs no hand-over, because nothing follows it.
4. **The receiving container is UNCHANGED** on all three points.

## Why this is not the automatic reclaim ADR-0084 refused

ADR-0084 declined to port `reclaim` to this runtime and declined to fire it on a timer or at `open`, because "an automatic reclaim deletes with nobody present". That objection is about a deletion with no author. **Neither deletion here is authorless.** Both are consequences of an act a developer just performed: point 1 and 2 happen because a promotion happened, and point 3 happens because a registration needs room. Nobody is deleting anything in the background, on a clock, while the tab sits idle. The operator VERB stays exactly where ADR-0084 put it, on the container that has an operator.

## What it costs, stated plainly

**A same-session revert to the superseded generation stops working**, which ADR-0089 already accepted and priced: in development the way back is the editor, and in a production bundle the old processor's code is absent from the build, so the target was never instantiable. What is new here is only that the RECORD goes too, rather than lingering un-runnable.

**The re-fold is real but cheap.** Supplying the old code again derives the same identity (ADR-0086), and since the stream outlives every fold over it (ADR-0087), what it costs is a local scan of a stream already on disk rather than a re-fetch a public node may refuse.

## Considered options

**Leave it, and let a reload repair the state.** Rejected. It is what happens today, and it means the developer's save loop hits a hard wall (`GenerationCapReachedError`) whose only remedy is a page reload, while the DB keeps a generation nothing can ever run. The wall is also mis-explained by its own error: the seat is held by the fetch duty, not by the cap being too small.

**Collect the dead generation but leave the fetch duty alone** (the narrow version of this ADR, points 3 and 4 only). Rejected as the whole answer, though it is kept as point 3. It fixes the case AFTER a reload and does nothing for the in-session save loop, which is the case a developer actually lives in. Taken alone it would also leave the misleading half-state where a promotion "succeeds" and the thing it replaced is still fetching for it.

**Raise `BROWSER_GENERATION_CAPS.maxGenerations` to three** (deferred by ADR-0084's amendment of 2026-09-16). Rejected as the answer to this problem, and it should stay deferred on its own storage argument. It buys one more save before the same wall, since nothing is ever collected; it treats a retention defect as a sizing problem.

**Recompute `follows` continuously rather than handing it over at the promotion.** Rejected. The initial derivation is deliberately taken ONCE, and its completeness is load-bearing (`container.ts`); a fetcher that can change under a held fold at any moment is a much larger claim than this ADR needs. The hand-over is tied to the one moment the successor is provably at the writer's cursor.

## Consequences

**`dropOnPromotion` keeps its meaning and changes its default on ONE runtime.** It remains the policy it always was, and an embedder may still turn it off; what changes is which way it points when nobody says.

**The hand-over is the part to build carefully, and it is the part that can strand a fold if it is wrong.** The existing decline (`dropSuperseded`) is what currently makes that unreachable, so it must not simply be deleted: it stays as the guard for every case the hand-over does NOT cover, and the hand-over is what removes the case it was declining.

**ADR-0044 is amended on one axis and not reversed.** The duty still belongs to exactly one generation per stream, and it is still the oldest one present. What is added is that a PROMOTION is a moment at which that answer may legitimately change, because the new answer has provably reached the old one's cursor.

**ADR-0089's "What it wins" gets its second correction, and this time upward.** The cross-stream headroom it claims stays true, and the same-stream save loop it could not fix is what this ADR fixes.

**This is a browser-shaped decision and does not generalise to the receiving runtime**, where the deployment fetches and no generation holds the pen at all (ADR-0087), so points 1 to 3 have no subject there.
