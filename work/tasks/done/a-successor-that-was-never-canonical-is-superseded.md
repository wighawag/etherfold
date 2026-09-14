---
title: 'A successor that was never canonical is SUPERSEDED by a newer one, instead of holding a slot for ever'
slug: a-successor-that-was-never-canonical-is-superseded
spec: a-reconfigure-is-not-an-outage
blockedBy: []
covers: []
needsAnswers: true
---

## What to build

An ENABLER for its spec rather than a story of its own: that spec's premise is that reconfiguring is cheap enough to do whenever you want, and a bound that refuses after a handful of reconfigures is the premise failing in practice rather than a separate concern.

The missing half of the generation lifecycle: a successor that is still catching up, and that a newer successor has just made pointless, stops existing.

Today the container knows one kind of supersession, and it is a PROMOTION: the incumbent becomes the predecessor and is RETAINED, because the pointer must be able to move back to it. There is no notion of a successor that was **never** canonical becoming dead work when a newer one arrives for the same role. So it keeps its registry row, keeps its state namespace, and keeps being advanced by the scheduled bounded rebuild, re-folding the same stream as the newer successor and competing with it for the same database handle.

That is wasted work in every case, and a wall in the case that matters. A generation cap "REFUSES at the bound and never evicts", which is the right mechanism against slow accumulation and the wrong one against CHURN: under churn the count grows for a reason nobody will ever want. A developer whose source change lands first and whose processor follows a moment later (possibly after a failed compile) produces several successors in a row, reaches `maxGenerations` within a few saves, and has to delete generations by hand. A browser tab, at two of each, reaches it on the second.

So bound the count by retiring what is provably dead rather than by raising the cap, which only moves the wall.

**The rule is narrow and the narrowness is the whole safety argument.** A generation is dead work only while it has NEVER been canonical. A generation that was ever canonical is what a revert moves back to and must be retained on exactly the terms it is retained on today. So this adds one predicate and retires on it; it must not touch the retention of a predecessor, and it must not be reachable for the canonical generation under any circumstances.

Dropping is not a new mechanism either: deleting a generation is already a `DROP` of its table namespace, injected by whoever named the tables, and the registry already exposes deletion. What is new is deciding WHEN, without being asked.

## Acceptance criteria

- [ ] Registering a successor retires an existing successor that is still catching up and has never been canonical, so a run of N rapid changes leaves one successor rather than N.
- [ ] A generation that HAS been canonical is never retired by this path, including the incumbent and any predecessor kept for a revert. Asserted directly, since this is the property that makes it safe.
- [ ] The retired generation's state is actually reclaimed (its namespace dropped), not merely unregistered, so the slot and the disk both come back.
- [ ] A rapid succession of changes no longer reaches the generation cap: a loop of several changes in a row keeps registering rather than being refused.
- [ ] A succession of SOURCE changes, each making a new stream, no longer reaches `maxStreams` either, since retiring the previous never-canonical successor frees its stream slot. This is what makes the cross-stream rule above testable rather than a claim.
- [ ] The stream a retired successor was folding is untouched if anything else still needs it, and the one-writer rule is unaffected: retiring a follower never disturbs the generation that writes its stream.
- [ ] A retirement is REPORTED, naming what was dropped and why, so an operator watching a dev loop sees bounded churn rather than silent deletion.
- [ ] The generation caps are UNCHANGED. This task bounds the count; it does not raise the bound.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None. It can start immediately, and it is worth landing before the reconfigure trigger, which makes churn much easier to produce.

## Prompt

The goal is that a development loop can change its mind as often as it likes without an operator having to go and delete things.

Read `work/notes/observations/rapid-change-succession-hits-the-generation-cap.md` for the scenario and the three constraints that shape it. Then read `@etherfold/core`'s receiving container: the caps and the reasoning printed above them (`SERVER_GENERATION_CAPS`, and the rule that a cap refuses and never evicts), the registration path at open, and the existing supersession vocabulary, which is entirely about a promotion's predecessor and is NOT what this task is about. `ADR-0053` is why deleting a generation is a namespace `DROP`, and `ADR-0044` is why a follower holds a read-only view of a stream it does not own.

The decision most likely to be got wrong is the predicate. "Not canonical right now" is NOT the test: a predecessor kept for a revert is not canonical right now either, and retiring it would silently destroy the thing story 4 promises. The test is "has NEVER been canonical", and it is answered IN MEMORY, from what this container has done since it opened.

That is a DECISION, not an oversight, and an earlier draft of this task got it wrong by asserting a durable registry field that does not exist. `GenerationRecord` is `GenerationId & {createdAt}` and the durable row is `{stream, processor, createdAt}`; the only ever-canonical fact in the system is the in-memory one (`everCanonical`, a set of held folds in `receivingContainer.ts`, and the flag on the entry in `container.ts`). Nor can it be derived from what is stored: with the pointer at C and a newer generation N, "N was never canonical" and "N was canonical and the pointer was reverted away from it" are indistinguishable from the schema, and those are exactly the two cases that must not be confused.

So NARROW the predicate to what one process can honestly answer: retire only a fold THIS container added as a successor AFTER `open`, that was not canonical when it was added, and that the pointer has not named since. A generation this process did not add is NEVER retired.

State the residual rather than hiding it: across a restart nothing is retired, so a deployment that reconfigures by RESTARTING still accumulates generations until the cap refuses. That is correct rather than a gap. A cap is the right mechanism against slow accumulation and the wrong one against churn, and churn is what arrives through `add` on a live container; restart-paced accumulation is deploy-paced, and refusing at start-up while naming what to delete is what that path already chose deliberately. It also fails in the safe direction ADR-0057 already records for `everCanonical`: a fold this process has not seen the pointer on is treated as a revert, and nothing is dropped.

The second: do not make this a cap-pressure eviction. Retiring on "we are near the bound" would make the behaviour depend on how full the registry happens to be, which is how a deterministic lifecycle becomes a heuristic. A superseded successor is dead the moment a newer one takes its role, whether the registry holds two generations or none to spare.

The third is ANSWERED here rather than left to you: "the same role" means successor to the current incumbent, REGARDLESS OF STREAM. Retiring only same-stream successors would not remove the wall, because the scenario opens with a SOURCE change and a source change makes a new stream. `maxStreams` is counted as the distinct streams among registered generations (`generation/registry.ts`), so two source edits reach 2 of 2 and the next registration is refused with generations still well under their own bound. Retiring the previous never-canonical successor whatever stream it sits on is what frees the stream slot as well. Drop the retired generation's own state namespace, and leave the STORED STREAM alone: the cap is reclaimed even though the raw logs are not.

The seam to test at is the container with a registry over a real database, registering successors in a row and asserting on what the registry holds afterwards and on what a revert can still reach.

Done means: several changes in a row leave one successor catching up, the incumbent and any predecessor are untouched, the cap is never reached, and the disk comes back.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The two decisions that used to sit here (what "the same role" means across streams, and where the never-been-canonical fact is read from) are ANSWERED above and are not yours to re-open; record instead what you had to decide in order to implement them, such as how a retirement is REPORTED and how the in-memory set is kept in step with `add` and with a pointer move. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**The concept is named an ABANDONED successor, not a "retired" or "superseded" one.** Both of the task's own words are already taken in this system and mean the *opposite* case: `supersededRecord` / `dropSuperseded` / the `CONTEXT.md` "drop-on-promotion" entry use *superseded* for the generation a PROMOTION moved the pointer off, and "the retired generation" is used in the same sense in ~8 prose sites (`container.ts:59`, `browser/IndexerState.ts`, `browser/host/serve.ts`). Both of those are RETAINED because a revert moves back to them; this one is DELETED because nothing can. Reusing either word would make one term mean a thing and its opposite. I kept the verb the system already has for this (`DROP`, as in ADR-0053 and `dropSuperseded`) and changed only the adjective, and wrote the distinction into the `CONTEXT.md` entry. Touches: the glossary, the changeset, the new test file name, and any later artifact that reuses the term.

**The stream IS reaped when nothing is left folding it, which departs from one sentence of the Prompt** ("leave the STORED STREAM alone: the cap is reclaimed even though the raw logs are not"). I used `registry.deleteGeneration` unchanged, which reaps exactly when the dropped generation was the last registered on its stream. Leaving an unclaimed subtree alive breaks the invariant the sweep exists to maintain ("a stream subtree no registered generation claims is what the sweep collects"), and it is reachable in the very loop this task is for: the developer flips the source back, a fresh generation registers on that stream, is the only one on it, is therefore its writer, has an empty cursor, and appends the whole stored range a second time — the silent second history ADR-0052/ADR-0055 exist to prevent. Alternatives considered: a `reapStream: false` option on `deleteGeneration` (rejected: it buys only "the raw logs survive until the next open sweeps them" and pays for it with that corruption), and keeping the subtree plus a guard against re-registration (rejected as a new mechanism for a case the reap already answers). Touches: `maxStreams` relief is unaffected (the cap counts registry rows either way); what changes is that a flip back to a previous source re-fetches that stream instead of re-folding it.

**The retirement is reported through `named-logs` only, not through a new return type or signal.** `add` still returns `HeldFold`, `onStateMoved` still carries nothing about it. Alternatives: returning a drop report from `add` (a breaking signature change for a fact no caller acts on), or publishing it as a state-moved notification (wrong: nothing a reader can see moved, and rotating the coherence token would have every reader throw its cache away because a *second* generation was tidied up). The log line names the dropped generation, the successor that took its role, why it is safe, and whether the stream was reaped — which matches how `dropSuperseded` and writer succession already report. Touches: `/status`'s `generations` array is the existing place an operator sees the shorter list.

**`everCanonical` is keyed on the generation identity and filled on every pointer READ, not on the moves this process makes.** Previously it was a `Set<HeldFold>` written only by `movePointer`/`add`. Keyed on objects it would read a *second fold for a generation already registered* (a reconfigure back to a still-registered fold resolves rather than creates) as one the pointer had never named — which is precisely how the predicate would have deleted a predecessor kept for a revert. Filling it in `noteCanonical` means a pointer move made by another process counts the moment this container reads it. Side effect, deliberate and in the safe direction: `movePointer` now classifies a move back to a generation this container merely *observed* as canonical as a REVERT, so drop-on-promotion declines there too. Touches: `dropSuperseded`'s `wasRevert`, and ADR-0057's recorded consequence (unchanged in direction, only more observant).

**`successorsAddedHere` records only a generation this container actually REGISTERED, which costs one extra `registry.list()` per `add`.** `create` resolves-or-creates, so without the pre-read a reconfigure onto an identity another process registered would be marked as this container's own and become droppable. `add` is called at open and at reconfigure, so the read is not on any hot path.

**A same-stream churn settles at three generations, not two, and that is the residual.** When the abandoned fold writes the stream the newcomer is about to follow, the drop is declined, so `incumbent + that writer + the newest` coexist. With `SERVER_GENERATION_CAPS` (four) the loop never meets the bound, which is what the criteria ask; a host that states `maxGenerations: 2` would still wall on that shape. The alternative — dropping the writer first and letting the newcomer become the writer of a stored stream — is the double-append above. Touches: any host choosing its own caps, and the browser's tighter numbers if the chain-facing container ever adopts this rule.

**Scope is the RECEIVING container only.** `Indexer` (`container.ts`, chain-facing, what a browser tab runs) is unchanged. The task names the receiving container, its caps and its `add`, and the seam it asks to be tested at is the receiving one; porting the rule to the chain-facing twin is a separate change with its own `everCanonical` shape (a flag on the entry) and its own cap arithmetic.

**Two existing tests encoded the old behaviour and were adapted rather than deleted.** `packages/core/test/rebuild.test.ts` ("orders across STREAMS too") counted three registry rows after three adds; it now registers its third generation through `resolveGeneration` so all three coexist, since its subject is how `create` stamps `createdAt` while the others are present. `packages/server/test/twoNamedIndexers.test.ts` ("a cap refuses in that one only") reached `maxStreams` with a successor the pointer had never named; it now promotes that successor first, so the two generations it counts are ones nothing may reclaim, and its actual subject (whose registry the bound is counted over) is untouched. Related, worth knowing: deleting the newest generation lets the next `create` re-issue its `createdAt`; ADR-0072's invariant (no two *surviving* records tie, so `writerOf` is never ambiguous) still holds, because `create` takes `max(now, newest surviving + 1)`.

**`scripts/check-work-refs.mjs` now exempts `work/questions/`, which is a repo-wide gate change I did not set out to make.** The `verify` gate includes `check:refs`, and it was already RED on `main` for four dead citations inside two question sidecars — verbatim bounce reports quoting the paths items were at when they were raised, one of which exists *precisely* to report that the launch snapshot and the item's real folder disagreed. Left alone it would bounce this task (and every other) for an unrelated reason. Rewording the quotes would falsify the record, which is the script's own stated argument for exempting `.changeset/` and `work/notes/observations/`, and the script's failure message prescribes exactly this fix for a historical surface. Alternative considered: fixing the four citations in place (rejected: it edits another task's sidecar and destroys the observation one of them makes). Touches: every future item with a question sidecar — dead `work/` paths inside one are no longer reported.
