---
title: 'A `predecessor` can be REVERTED TO but not RESUMED: the slot is durable and the code that would activate it is not'
slug: a-predecessor-can-be-reverted-to-but-not-resumed
observed: 2026-09-16
---

2026-09-16 — Noticed while reviewing the ADR-0084 family, and sharpened by the question that prompted it: we now store `predecessor` durably, but if the predecessor's PROCESSOR is not accessible, that predecessor can never be activated.

## What works, and is deliberate

A generation with no held fold still ANSWERS. Reads resolve the canonical pointer to a table NAMESPACE (ADR-0053) rather than to an engine, so the receiving container deliberately does not refuse a canonical generation it holds no engine for, and `promote` deliberately does not require a held fold for its target. Both carry the reasoning in their docstrings, and both are right: refusing would mean a revert could only be performed by a process first rebuilt with the old processor, "which is the re-index this design exists to remove".

So moving the pointer back works, and CONTEXT.md's claim that it "restores answers EXACTLY" is true.

## What does not

Answering is not advancing. A generation can only FOLD new blocks through its processor, and after a redeploy the process holds only the new one. So a post-redeploy revert lands on a canonical generation that serves correct answers frozen at its cursor and never moves again.

The asymmetry is the point, and it is new with ADR-0084. The slot was made DURABLE precisely so the fact survives a restart. The code that would activate what the slot names is the one thing that does not survive a restart. So the registry now durably promises a way back to something a redeployed process is structurally unable to run.

The resulting state is also inverted in a way worth seeing plainly. Revert V2 to V1 and the slots become `canonical` = V1, `predecessor` = V2. The container holds an engine for V2 and none for V1. The deployment therefore goes on FOLDING the generation the operator just rejected, while SERVING, frozen, the one they chose.

## Severity ramp

- **Revert inside one process** (no redeploy): fine. The incumbent's engine is in memory, it kept folding throughout, and it resumes as canonical with nothing lost. This is the case the tests cover.
- **Revert after a redeploy**: the pointer moves, answers are restored exactly and correct as of the old cursor, and the deployment stops advancing. This is the case an operator actually reaches for, because the reason to revert is usually that a deploy went wrong.

## The remedy that exists, and is not written down

Redeploy the old build. That is coherent: the pointer move is the emergency stop that takes bad answers out of service immediately, and the redeploy is the recovery that resumes folding. It is a perfectly reasonable two-step story. But nothing says so, and the surrounding prose reads as though the pointer move were the whole remedy ("one small write, which is why promotion has no meaningful cost"). An operator following the documents would expect a reverted deployment to be working, not frozen.

At minimum the revert's documented promise should say which of the two it delivers, and `predecessor` retention should say that it preserves STATE and not the ability to run.

## If it should be closed rather than documented

Closing it means a generation retains the CODE that folds it, not merely its state. Note what that cannot be: keeping the source file is not enough, because a processor module is an entry point rather than a unit (it imports the ABI, sibling modules, `node_modules`), so re-importing a saved V1 entry point inside a V2 process yields neither version while `getVersionHash()` would still report V1. Whatever is retained has to be a self-contained bundle, at which point it is ADR-0085's content-addressed artifact and the hash-is-its-version property comes with it.

That is a real feature with its own lifecycle questions and it is NOT proposed here: does `reclaim` delete a generation's artifact, does holding `predecessor` pin one, and what does an artifact per generation cost in a browser tab at `BROWSER_GENERATION_CAPS`. Recorded so the choice is made deliberately rather than discovered by an operator mid-incident.

Related: `the-promotion-trigger-cannot-be-evaluated-with-no-held-incumbent` is the same missing-engine fact on the PROMOTION side, but it does not need this and should not wait for it: the trigger needs only a cursor, which is a row addressed by identity.
