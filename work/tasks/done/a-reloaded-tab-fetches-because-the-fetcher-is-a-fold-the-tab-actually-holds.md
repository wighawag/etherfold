---
title: 'A reloaded tab goes on FETCHING, because the generation that fetches a stream is the oldest one the tab actually HOLDS'
slug: a-reloaded-tab-fetches-because-the-fetcher-is-a-fold-the-tab-actually-holds
blockedBy: []
covers: []
---

## What to build

ADR-0088, implemented. The measurement that decided it is already done and kept; this task is the fix it names, and nothing more.

**The defect, already measured rather than argued.** A browser tab that reloads after a PROMOTION opens healthy and never asks the chain for another log. Session 1 indexes on fold A, a save registers B beside it, the default `on-catch-up` policy promotes B, and `dropOnPromotion` defaults to false so A survives as `predecessor`. Session 2 is a full page load of B's bundle, which is all a tab can supply, because A's code is not in it. B is already canonical so the container opens, but `fetcherOf` names A -- older, registered, and NOT held -- so B becomes a follower of a stream nothing writes:

```
chain reads:        {eth_chainId: 1}      <- the load-time handshake, and nothing else
eth_getLogs ranges: []                    <- none, ever
node tip:           107
tab cursor:         lastToBlock 105
reported phase:     "at-tip"              <- and this is the worst part
```

It reports itself AT-TIP while the chain is two blocks ahead, because a follower never calls `eth_blockNumber`, so `latestBlock` stays where the last fetch left it and the host's own pacing rule compares 105 with 105. There is a UI attached to this and nothing about it looks wrong.

**The decision.** ADR-0088: the candidate set for "which generation fetches this stream" narrows from REGISTERED to PRESENT. `follows` is derived from the oldest generation the CONTAINER HOLDS on the stream, so there is always exactly one fetcher and it is always one that exists. `fetcherOf` keeps its meaning, its home and its purity -- what changes is which set it is asked about. Read the ADR in full before you start; it also records what was rejected and why, which is most of the design.

**The part that is not a one-line predicate, and the reason this task is not small.** The obvious patch was written and measured, and it is kept at `docs/spikes/the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has/the-narrow-fix-candidate.patch`. It removes the stall and leaves no duplicate and no hole, and it is still WRONG, because it reads the held set while that set is still being built: `open` calls `add` once per spec and `add` freezes `readOnlyStream` into the engine's config at construction. So the answer depends on the order the caller listed its specs in. Measured, with the same two folds listed edited-first:

```
today                 scenario 5:  ONE fetcher
the obvious patch     scenario 5:  2 FETCHERS on one stream
```

Two identical `eth_getLogs`, and one log stored twice -- seven rows where six are correct, which is the same sentence ADR-0087 writes about `_emissions` holding four where two are correct. **So `open` must decide `follows` once it knows every fold it will hold.** That restructuring is the substance of this task; the predicate itself is the easy half.

**Three things in this same file are NOT yours, and a builder narrowing "registered" to "present" will be tempted by all three.**

First, `Indexer.add` carries a long comment block immediately above the derivation (around `container.ts:789-838`) that ARGUES FOR the current registered-set reading, in terms -- "asked of the durable REGISTRY rather than of this process's `held` array, which is whatever order the caller passed its specs in and does not survive a restart". That sentence is precisely the objection ADR-0088 has to answer rather than ignore, and after this change it is actively false. **Rewrite that block** so it states ADR-0088's rule and says WHY the held set is safe to read now (because the decision is taken once the fold set is complete, which is the thing that was not true when the comment was written). Keep the ADR-0071 / ADR-0072 history in it, which is still true.

Second and third, `wouldStrandAFollower` (around `container.ts:1561`) and the strand clause in `dropSuperseded` (around `container.ts:1437`) ask their question over the REGISTERED records on purpose, and `wouldStrandAFollower`'s own JSDoc explains why: the generation a slot names may be one this process holds no engine for at all. Those are a different question -- what would deleting this record strand -- over a set that is deliberately not the held one. **They are out of scope, they are correct as they are, and harmonising them with your new derivation is a defect, not a tidy-up.**

**The evidence is already bought, so do not pay for it twice.** `docs/spikes/the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has/` holds a re-runnable harness (`measureTheReloadedTab.ts`), the raw output of all seven scenarios today, and the raw output under the obvious patch. Use it to check your work: the scenarios that must CHANGE are 2a and 2b (stall becomes fetch), and every other scenario must be unchanged, including scenario 5, which is the one the obvious patch broke.

## Acceptance criteria

- [ ] A tab that reloads after a promotion over a durable registry, holding ONE fold, FETCHES. Asserted on the chain reads it makes -- the methods and the `eth_getLogs` ranges -- and never on the `follows` flag, because a flag that looks right is exactly what this defect already had.
- [ ] The derivation is ORDER-INDEPENDENT: the same set of folds, listed in either order, yields exactly ONE fetcher on a stream, one set of ranges, and no log stored twice. Both halves are required; the rejected patch satisfies the stall half and fails this one.
- [ ] `follows` is decided only once the container knows every fold it will hold. A derivation that reads a half-built held set is the defect this criterion exists to prevent, whatever answer it happens to give on the orders that were tested.
- [ ] The reload test `packages/browser/test/aTabHoldsItsGenerationsInSlots.test.ts` is re-scoped to the PROMOTION-THEN-RELOAD shape -- a promotion makes the edited fold canonical, and the reload then opens holding exactly ONE fold -- and is GREEN. Read that carefully, because the obvious re-scope does not work and the spike says so: simply opening the EXISTING scenario with one generation THROWS `CanonicalGenerationNotHeldError`, because there the incumbent is still canonical and `open` refuses when canonical is not held. The promotion is what makes a one-fold reload legal, which is exactly why it is also the shape that reaches the stall.
- [ ] A generation added at RUNTIME beside a live fold on the same stream still becomes a follower, unchanged. ADR-0088 states this under Consequences ("`add` at runtime is unaffected: by then the held set is complete") and it is the property most likely to be broken by accident when the derivation moves.
- [ ] The changed-handler reload (no promotion) still REFUSES loudly with `CanonicalGenerationNotHeldError`, unchanged. It is a different bug class from the stall and this task does not touch it.
- [ ] The default configuration is unchanged: on a memory registry, which is what both entry points default to, a reload registers afresh and fetches exactly as it does today.
- [ ] `fetcherOf` stays a pure function of the records it is given, with no pointer, no stand-down mark and nothing persisted. ADR-0087 rejected an elected writer and ADR-0088 does not reintroduce one.
- [ ] ADR-0088's `status: accepted, not yet implemented` line is REMOVED, and only if the decision is actually implemented. The correct end state is NO status line at all, because `work/protocol/ADR-FORMAT.md` says an absent status means accepted and current. Do not invent a value: `accepted, implemented` is not one of its seven and a previous build in this repo had to have it reverted.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None -- can start immediately. ADR-0088 is landed and its measurement is kept under `docs/spikes/`.

## Prompt

The goal is that a browser tab which reloads after a promotion goes on indexing, and that the fix does not buy that by letting two folds fetch the same stream.

Read `docs/adr/0088-the-generation-that-fetches-a-stream-is-the-oldest-one-present-not-the-oldest-one-registered.md` first -- it is the decision, including what it rejected and why. Then read the spike directory named above: the harness, both raw measurements, and the candidate patch that was measured and deliberately NOT shipped. ADR-0044 is the follower rule, which this narrows in one clause and otherwise leaves standing. ADR-0087 is the receiving side's answer to the same family of question and is deliberately NOT extended here; its own amendment says so.

Note that a separate, deliberately tiny task (`the-chain-facing-drop-stops-documenting-a-reap-it-cannot-perform`) is correcting stale prose lower down in this same file. It does not change behaviour and it does not touch the derivation, but if it has landed before you, rebase rather than reverting its wording.

The decision most likely to be got wrong is treating this as the one-line predicate. It is not, and the reason is measured and written down: `open` populates the held set incrementally and `add` freezes the read-only stream view into the engine config at construction, so a predicate over a half-built set is order-dependent. Whatever shape you choose, the property to hold is that the answer does not depend on the order a caller listed its specs in.

The second: measure the CHAIN READS. This defect's entire signature is that every flag and every status looked correct while the tab asked the node for nothing. Assert methods and ranges. The strongest work in this family reproduced a defect, patched the obvious fix, measured that it made things worse, and reported the numbers -- that is literally how the ADR you are implementing came to exist.

The third: the hazard of two tabs each electing a fetcher is REAL, is NOT introduced by this change, and is not yours. Two tabs holding the same canonical fold already both fetch today, because each has its own registry instance. Its answer is the single-indexer lease, tasked elsewhere. Do not widen this task to chase it; the ADR names it precisely so the next reader does not mistake it for a regression.

The seam to test at is the browser package's own container tests, which already stand a container up over a durable registry and a fake chain and reload it.

Done means: the reload-after-promotion tab fetches, the derivation is order-independent, the reload test asserts the configuration a real tab has and is green, and ADR-0088 stops saying it is unimplemented.

FIRST, check this task against current reality. Its measurement is days old at most, but the ADR is a decision and not a patch, and if the code has moved under it, say so and do what is right. Builders in this family have contradicted their task text repeatedly and have been right to every time.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT -- in particular the shape you chose for deciding `follows` once the fold set is known, and anything you found the ADR got wrong. Do not write the done record, the commit message or the PR body yourself.

## Decisions

**The shape for deciding `follows` once the fold set is known: two phases inside `open`, with the set passed as a parameter of records.** `open` calls `registerGeneration` for every spec, collects the `GenerationRecord`s it gets back, and passes that array to `holdGeneration` for each. Records were chosen as the carrier because they already hold the `createdAt` the ranking uses, so `fetcherOf` is called with exactly the set the ADR names and needs no second registry read. Alternatives considered: (a) a mutable `this.openingFoldSet` field read by `add` — rejected, it is hidden state and `add` would silently behave differently depending on whether `open` is on the stack; (b) an optional second parameter on the public `add` — rejected, it puts an internal phase in the published API; (c) computing the fold set from the SPECS before building anything, which is the obvious reading of "open must decide follows once it knows every fold it will hold" — **not available**, see the next entry. Touches: `Indexer.open` and `Indexer.add` only; `add`'s public signature is unchanged, and the two new methods are `protected`.

**The phase boundary is AFTER registration, not before the factories, and the ADR does not say why that is forced.** A generation cannot be named before it is built: a fold arriving as a module has no bytes to hash, so `GenerationSpec.processorIdentity` is filled in from inside `createProcessor` (ADR-0086, and `@etherfold/browser`'s `generationSpecFor` does exactly this). So the cheapest-looking implementation — derive every id from the specs up front, then run `add` unchanged — would throw `requireProcessorIdentity` on the browser's own entry point. Recorded because a later reader will otherwise ask why phase one does the expensive half.

**What the ADR got wrong: `CONTEXT.md` did NOT stay true word for word.** ADR-0088's Consequences say it does. That is right about the one-writer sentence it quotes and wrong about the clause after it: the **follower** glossary entry also said "WHICH generation fetches is the OLDEST SURVIVING one registered on the stream", which is the sentence this ADR exists to narrow. I updated that entry to state the present-set rule, why it is present rather than registered, and that the answer is taken once; and I added a sentence saying the DROP question (`wouldStrandAFollower`) is deliberately still asked over the registered records, so the next reader does not "harmonise" it. I deliberately did NOT touch the drop-on-promotion entry's parenthetical, which describes `fetcherOf` in the context of the drop clause and is still accurate there. ADR-0088's closing paragraph now records both the implementation and this correction.

**The changeset names `@etherfold/browser` as well as `@etherfold/core`, both `patch`.** No file under `packages/browser/src` changed — only its test fixture and its tests — but the behaviour change a browser app SEES is this one, and the package is where it is observable. The alternative was core alone; I took the wider one because it costs an unpublished version bump and the narrower one risks a land-time bounce.
