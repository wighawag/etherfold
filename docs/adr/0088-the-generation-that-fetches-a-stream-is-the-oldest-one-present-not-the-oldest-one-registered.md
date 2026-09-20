---
status: accepted, not yet implemented
---

# The generation that FETCHES a stream is the oldest one PRESENT, not the oldest one REGISTERED

On the chain-facing `Indexer` a stream is fetched by a generation, and which one is derived from registration order (`fetcherOf`, ADR-0044). That order is a fact about the durable RECORDS, while fetching is something a fold in THIS process does, and the two come apart at a page reload: **the oldest registered generation can be one the tab holds no fold for, so the tab's only fold becomes a follower of a stream nothing writes, opens healthy, answers reads, reports `at-tip`, and never asks the chain for another log.** We decide that the candidate set narrows from REGISTERED to PRESENT: `follows` is derived from the oldest generation the CONTAINER HOLDS on the stream, so there is always exactly one fetcher and it is always one that exists. `fetcherOf` keeps its meaning and its home; what changes is which set it is asked about. The fix is a follow-on task; this records the direction and what it costs.

This is a decision about the browser engine and nothing else. It does not extend ADR-0087 to it, and the reason is measured rather than argued (below).

## The defect, measured

Evidence and the re-runnable harness: `docs/spikes/the-reloaded-tab-stall-is-measured-on-the-configuration-a-tab-actually-has/`. Read off source it was `work/notes/observations/a-reloaded-tab-with-a-changed-handler-folds-its-stream-and-never-fetches.md`; what follows was RUN.

**The trigger is a reload after a PROMOTION, not a reload with a changed handler.** Session 1 indexes on fold A, a save registers fold B beside it, and the default `on-catch-up` policy promotes B. `dropOnPromotion` defaults to `false` and a generation `predecessor` names is untouchable, so A survives. Session 2 is a full page load of B's bundle -- which is all a tab can supply, since A's code is not in it. B is already `canonical`, so `resolveCanonical` succeeds and the container opens. But `fetcherOf` names A, which is older and not held, so B `follows`:

```
chain reads:        {eth_chainId: 1}      <- the load-time handshake, and nothing else
eth_getLogs ranges: []                    <- none, ever
node tip:           107
tab cursor:         lastToBlock 105, latestBlock 105
reported phase:     "at-tip"              <- through the host's own pacing rule
stored stream:      frozen at 105
```

The last two lines are why it is worse than a stall: `latestBlock` stays at 105 because a follower never calls `eth_blockNumber`, so `someGenerationBehind` compares 105 with 105 and the host reports itself LIVE while the chain is two blocks ahead. There is a UI attached to it and nothing about it looks wrong. It is the same silent shape ADR-0087 was written to close, and the same measured signature (`["eth_chainId"]` and nothing more, for ever).

**Two things bound it, and both are part of the decision.** It needs an opt-in DURABLE registry: both real entry points default to a memory one (`IndexerState.ts:1202`, `host/serve.ts:374`) which does not survive a reload, and nothing in `packages/*/src`, `examples/`, `platforms/` or `docs/` passes `openGenerationRegistryOnIndexedDB`. And the OTHER reload -- changed handler, no promotion -- is a loud `CanonicalGenerationNotHeldError` rather than a stall. So this is not shipping-broken today; it is reachable by the documented configuration an app takes when it wants a revert target, which is exactly the configuration `predecessor` exists for.

## Why the candidate set, and not something bigger or something smaller

**It keeps ADR-0044's rule and narrows one clause of it.** "A generation is a stream plus a fold over it", and a follower re-folds the stored stream and never polls the head: untouched, and load-bearing here (see the next section). "The first generation registered on a stream keeps the duty" was chosen so the writer is STABLE -- so that moving the canonical pointer does not hand the append duty to a different engine mid-flight. Narrowing the candidates to the folds the container holds keeps that property exactly: within one process the set does not change under a promotion, so the answer does not either. What it drops is the claim that a generation absent from this process can hold a duty, which is the same false claim ADR-0087 removed on the receiving side, in the one form that still applies where the thing that fetches genuinely IS a generation.

**It is derived, not elected, and not stored.** No pointer, no stand-down mark, no coordination: every reader of the held set gets the same answer, and `fetcherOf` remains a pure function of records that nothing persists. ADR-0087 rejected an elected-writer pointer for those reasons and they are unchanged.

**It must be derived over a set that does not depend on the order the caller listed its specs in.** This is the trap, and it was measured. `this.held` is populated INCREMENTALLY by `open`, which calls `add` once per spec, and `add` freezes `readOnlyStream` into the engine's config at construction. A derivation that reads that half-built array gives a different answer per spec order: with the edited fold listed first, TWO generations decide they fetch, the same range is requested twice, and the stored stream holds block 106's log twice -- seven rows where six are correct, which is the sentence ADR-0087 writes about `_emissions` holding four where two are correct. So the work this decision names is not a one-line predicate: **`open` must decide `follows` once it knows every fold it will hold**, and that is the largest single piece of the follow-on task.

## What was rejected, and why

**Extend ADR-0087 to the chain-facing container** -- split `IndexerGeneration`'s fetch from its fold, so a tab fetches regardless of which generation it holds. Rejected for now, and NOT on principle: it is the cleaner end state and it dissolves this question rather than answering it. It is rejected on proportion, and on a measured fact. The proportion: it is a restructure of the browser engine that nothing has asked for, against a defect reachable only on an opt-in configuration nothing ships, and ADR-0087's own amendment scoped itself away from it deliberately. The fact: the reason that move was FORCED on the receiving side does not arise here. There, handing the duty to the present fold re-appended history the stream already covered, because the restarted successor's state was empty and it fetched from `defaultFromBlock` through an append-only appender with no guard. Here the fold REPLAYS the stored stream at `load` before anything is fetched, so it lands exactly ON the coverage: measured, the stream holds six events over blocks 100, 102, 104, 106, none of them twice, covering to 107. That is ADR-0044's follower rule doing the work, and it is why the narrow family is not disqualified on this runtime the way it was on the other one.

**Refuse at open when the registered fetcher is not held**, symmetrically with `CanonicalGenerationNotHeldError`. Rejected as the answer, though it is the honest fallback if a derivation ever cannot decide. It trades a silent stall for a loud refusal, which is the right direction, but it refuses a tab that has done nothing wrong: promote a successor, reload, and the app cannot open at all until someone supplies the previous handler's code (which is not in the bundle) or edits the registry. A routine sequence must not end in a container that will not start.

**Make `dropOnPromotion` default to `true`**, so no predecessor survives to be named. Rejected outright. It destroys the revert window that slots, the promotion policy and `predecessor` exist for (ADR-0084), to work around a derivation that is wrong on its own terms, and it would silently discard a generation's state which may not be re-indexable at all from a public node. The caps already REFUSE rather than evict for exactly this reason.

## Consequences

**`fetcherOf` is unchanged and so is the registry.** It still answers "which generation was this stream fetched for" over the records it is given; the change is that the chain-facing container gives it the records it HOLDS. `CONTEXT.md`'s sentence -- a stored stream has one writer and it is whoever fetches it, the fetching generation on a chain-facing runtime -- stays true word for word.

**"Which generation writes this stream" becomes a fact about the PROCESS on this runtime.** Two tabs holding disjoint folds of one stream would each elect a fetcher. That hazard is real, it is NOT introduced here -- two tabs each holding the same canonical fold already both fetch and both write today, because each has its own registry instance and `fetcherOf` names their own fold in both -- and its answer is the single-indexer lease (`one-tab-indexes-and-the-others-read`), not this rule. Naming it so the next reader does not mistake it for a regression.

**`open` gains a phase.** It must know the whole fold set before it decides `follows`, because the alternative is the order-dependent duplicate measured above. `add` at runtime is unaffected: by then the held set is complete.

**The reload test can finally assert the property it claims.** `packages/browser/test/aTabHoldsItsGenerationsInSlots.test.ts` asserts "AND IT STILL FETCHES" while opening with BOTH folds, which no entry point can produce (`createIndexerState` and both worker hosts build a one-element `generations` list). Today that is a constraint and not an oversight -- with one fold that container THROWS. Under this decision the promotion-then-reload shape opens with ONE fold and fetches, so the assertion becomes a statement about the configuration a tab actually has. That re-scope lands with the fix, green, and not before.

**ADR-0087 is not extended and is not contradicted.** Its amendment says the browser engine was deliberately not restructured, that there the thing which fetches IS a generation, and that the residue is precisely "the registered fetcher can still be a generation the tab holds no fold for". This decides that residue in the small, and leaves the restructure available as its own decision if the balance ever changes.

**This `status` line comes off in the same change that lands the fix.** It is a claim about the code and it goes stale the moment the code lands (`work/protocol/ADR-FORMAT.md`); this family has already paid for that line surviving once.
