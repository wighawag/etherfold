---
title: 'A restarted deployment HANDS OVER the write duty it cannot discharge, so a stored stream does not silently stop growing'
slug: a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge
blockedBy: []
covers: []
---

## What to build

A data-loss defect, measured, with no feature in front of it.

Restart a `run` deployment with a changed processor, over the same database. The container comes up holding exactly one fold, the successor. That fold reports `writesStream: false`, so `appendEmissions` is handed to nobody and **nothing appends to the stored emission stream**, while the successor happily consumes the wire and folds it. No refusal, no warning, and the state itself looks fine.

The mechanism is the one-writer rule working exactly as specified, in a shape it was never considered against. `writerOf` names the OLDEST SURVIVING generation registered on the stream, which is the INCUMBENT: it is still registered, and it is older. The container holds no fold for the incumbent, because the old processor's code is not in the build. So the write duty belongs to a generation that is not present to discharge it, and the generation that IS present is correctly refused it. `reconcileWriters` does not repair this: `shouldWrite` is `false` and already matches `fold.writesStream`, so it is a no-op rather than a hand-over.

**This is not the retention feature, and must not wait for it.** `work/specs/ready/a-generation-retains-the-code-that-folds-it.md` says so itself: retained code would dissolve this as a side effect, but it "is a defect with its own fix and should not be parked behind a feature". A deployment that loses appends is worse than one that merely fails to advance, and the fix does not need the old processor's code -- it needs the duty to follow what is actually HELD.

Note the sibling that was already fixed, because it is the same family and its fix is the shape to learn from rather than to copy. `a-reloaded-container-makes-its-canonical-generation-a-follower` was the reload version of this, and it was closed by making `follows` derive from `writerOf` rather than from "is any OTHER generation already registered on this stream" (`packages/core/src/container.ts`, and ADR-0071's expired-rejection note). That unified the rule; it did not answer what happens when the generation `writerOf` names is not HELD, which is this task.

## Acceptance criteria

- [ ] A restarted deployment whose incumbent is not held APPENDS to its stored stream: the generation that is actually present takes the write duty, asserted end to end on a restart over the same database with a changed processor.
- [ ] The one-writer rule is NOT weakened: at no point do two generations write one stream, including across the hand-over itself, and a deployment that DOES hold its incumbent is unaffected.
- [ ] The duty follows what is HELD rather than what is merely registered, and the rule has ONE home -- `writerOf` and `reconcileWriters` agree about who writes rather than each deciding separately.
- [ ] A generation that is registered but not held still ANSWERS reads exactly as it does today (ADR-0053: a read resolves a pointer to a table namespace, never to an engine). Nothing here makes an unheld generation less readable.
- [ ] Whether the hand-over is permanent or is returned if the incumbent's fold ever appears again is decided deliberately and stated, since a silent re-handover would be the same class of bug in the other direction.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- None. It can start immediately.

## Prompt

The goal is that restarting a deployment with a changed processor never silently stops recording the stream it is folding.

Read **ADR-0044** for why a follower holds a read-only view of a stream it does not own, and **ADR-0071** for the one-writer rule and where it lives -- specifically the block in `packages/core/src/container.ts` recording that ADR-0071's rejection of the `writerOf` form has EXPIRED, which is the reasoning that closed the reload sibling. Then `writerOf` in `packages/core/src/generation/registry.ts` and `reconcileWriters` / `handOverTheWire` in `packages/core/src/receivingContainer.ts`, which is the machinery that already exists for moving the duty and which currently declines to.

The measurement that found this was taken while driving `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`, and it is worth reproducing before you change anything: stand a `run` deployment up the way `packages/cli/test/theDeploymentSelectsItsPromotionPolicy.test.ts` does, stop it, and re-run over the SAME handle with a changed processor. `writesStream` is `false` on the only fold present.

The decision most likely to be got wrong is reaching for retention. It is tempting, on finding the container cannot run the incumbent, to make it able to -- by saving the module or re-importing it. Do not: that is `a-generation-retains-the-code-that-folds-it` and it is a whole spec. The duty needs to move to a fold that is present, not the absent fold to be resurrected.

The second: do not simply invert the rule to "the newest generation writes". The one-writer rule's value is that the answer is stable and derivable by every reader independently, which is why it keys on registration order; a rule that depends on what one process happens to hold must still give every reader the same answer, or two processes will disagree about who writes. Say how yours does.

Done means: a restarted deployment appends, one writer still, an unheld generation still answers reads, and the hand-over's permanence is a stated decision.
