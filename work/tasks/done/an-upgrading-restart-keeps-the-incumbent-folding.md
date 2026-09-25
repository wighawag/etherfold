---
title: 'An upgrading restart keeps the incumbent FOLDING while the successor catches up'
slug: an-upgrading-restart-keeps-the-incumbent-folding
spec: a-generation-retains-the-code-that-folds-it
blockedBy: [a-revert-resumes-folding]
covers: [3]
---

## What to build

ADR-0092, the upgrade window. A Node deployment restarted with a changed processor holds a fold only for the new one, so the canonical generation's answers freeze for the whole time the successor takes to catch up. After this task, a canonical generation this container holds no fold for is instantiated from its stored bundle AT OPEN, and goes on folding until the promotion moves the pointer.

**This is ADR-0092's "when it has to fold", and it is not a contradiction of "not at open".** The canonical generation answers every read, so it has to fold from the moment the process starts. What ADR-0092 rules out is instantiating the OTHER stored generations eagerly; this task instantiates exactly the canonical one, and only when this process holds no fold for it.

**Reuse the previous task's injected seam.** Instantiating at open and instantiating at a revert are the same act at two moments; there should be one way stored bytes become a fold.

**The promotion must still work.** ADR-0084's 2026-09-19 amendment made the promotion trigger evaluable with NO held incumbent, reading the incumbent's cursor from its namespace. With the incumbent now held and advancing, make sure the trigger compares against a MOVING cursor correctly, and that a promotion still happens.

> **FORWARD-POINTER (from the conductor, 2026-09-22).** The maintainer wants a deployment's UX to approach The Graph's, where a processor is uploaded to a running node. Once canonical can be instantiated from stored bytes at open, a deployment could in principle boot running whatever the registry's canonical generation names, with the configured processor merely a candidate. That is NOT this task's to build. Just avoid tying "instantiate canonical at open" to an assumption that the configured processor must be the successor.

## Acceptance criteria

- [ ] During a restart-upgrade, the incumbent's cursor MOVES while the successor catches up, rather than sitting frozen. This is the spec's third testing claim, asserted end to end.
- [ ] The successor is still promoted when it catches up, and the incumbent stops being folded after the pointer leaves it.
- [ ] Only the canonical generation is instantiated at open; no other stored generation is.
- [ ] A restart where the process already holds a fold for the canonical generation behaves exactly as before.
- [ ] Instantiation goes through the same seam the revert uses.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

ADR-0092's status line STAYS; `a-generation-says-whether-it-can-run-here` owns removing it.

## Blocked by

- `a-revert-resumes-folding` -- it builds the seam this reuses, and both edit the receiving container, so the dependency also serialises them.

## Prompt

The goal is that upgrading a Node deployment is not a window of stale answers.

Read ADR-0092, then ADR-0084 and its 2026-09-19 amendment (how a restart finishes an upgrade, and the cursor seam that made the trigger work with no held incumbent), and ADR-0046 for how a promotion is armed. The prior art for the test shape is `packages/cli/test/aRestartFinishesTheUpgrade.test.ts`.

The decision most likely to be got wrong is instantiating every stored generation at open because it is simpler. The second is breaking the promotion trigger now that the incumbent's cursor moves.

Done means: the incumbent keeps advancing through an upgrade, and the upgrade still completes.

FIRST, check this task against current reality: both earlier tasks in this chain will have landed, and the seam is whatever they built. If they landed differently than this assumes, route to needs-attention with the discrepancy.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself.

## Decisions

- **The canonical generation is instantiated after the configured fold is added, not before.** By then the promotion policy has already acted. Under `immediate`, or when a successor already caught up in a previous process, the pointer has left the incumbent and nothing is instantiated for a generation nobody reads. It also keeps `opening` as the configured fold. Nothing assumes the configured fold is the successor, as the forward-pointer asked. The alternative was instantiating first, which would build an engine that `immediate` throws away at once and would make the incumbent `folds[0]`. This touches `open`.
- **Broken stored code at open is logged, and the deployment still starts.** A `GenerationInstantiationError` there is logged as an error, and the canonical generation answers reads frozen, which is how every restart behaved before. The successor still catches up and can be promoted. Any other error is re-thrown. The alternative was refusing to start, which would turn one bad predecessor bundle into an outage of the new build too. This differs from the revert, which refuses the move with a 409. The difference is deliberate: at open there is nothing to decline. A canonical generation on a stream this deployment doesn't fetch (a filter change) is logged and left frozen.
- **"Stops being folded after the pointer leaves it" applies to folds built from stored bytes, on any move.** Folds built from stored bytes are tracked in memory (`instantiatedHere`). A promotion off such a fold stops folding it, which covers the incumbent kept for an upgrade window and a generation instantiated at a revert. A fold the host was handed (its own build, or one added by a reconfigure) keeps its old retention after a promotion, so in-session reconfigure behaviour is unchanged. The alternatives:
  - Stop folding on every promotion: this would change reconfigure behaviour, and would freeze hosts that have no seam after a later revert.
  - Keep folding the instantiated incumbent: this is the "engines nobody reads" state ADR-0092 rejects.

  It also touches `drop-on-promotion`, which still wins when it is set.
- **Promotion is checked and performed on the incumbent's advance chain.** Where the incumbent is held, the cursor comparison and the pointer move are queued on that fold's advance chain. The incumbent therefore cannot take a block between its cursor being read and the pointer leaving it, so the successor is promoted at or past where the incumbent finally stood and a reader never sees answers step back. With no held incumbent the read is as before. The alternative was leaving the unserialised read, which could promote a successor one block behind. A guard in `offerToFolds` skips a fold that stopped being driven while a block for it was queued.
- **The seam is unchanged.** It is still `ReceivingIndexerOptions.instantiateGeneration`, reached through the same private `instantiate`, so open and revert share one path from stored bytes to a fold. The CLI needed no code change. Its option JSDoc now says the seam is called at a pointer move and at open, for the canonical generation only.
