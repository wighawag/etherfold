---
title: 'The promotion policy is unreachable from the CLI, and `on-catch-up` rests on a premise that fails when the successor is on a NEW stream'
slug: the-promotion-policy-is-unreachable-from-the-cli
observed: 2026-09-13
---

2026-09-13 — Raised by the author while reviewing the filter-change reconfigure: "on a new source the old processor will likely be invalid, so it should switch as soon as possible, or there should be an option to either wait for catch-up or switch instantly." Two separate things came out of checking that, one mechanical and one a judgement about a default.

## The mechanical half: the capability is built and unreachable

`@etherfold/core` has three policies (`PromotionPolicy = 'on-catch-up' | 'immediate' | 'manual'`), and `immediate` is documented as the opt-in for very nearly this case: "the successor becomes canonical the moment it is created, before it has caught up ... what a developer iterating on a handler wants, because stale-but-complete answers from the fold they just replaced are more confusing than incomplete answers from the new one".

But **no CLI command ever passes a `promotion` config.** `openFolding` calls `openReceivingIndexer({port, caps, source, stream, recordReorg, appendEmissions, replay, generation})` with no `promotion` key, and there is no flag or environment variable for one (`config.ts` has no promotion input). So every CLI deployment silently takes `on-catch-up`, and an operator who wants `immediate` or `manual` cannot ask for it. The capability exists, is argued for, and is unreachable from the shape most people run.

That part is a straightforward gap, and it is what the author's "option to either wait catch-up or instantly" asks for.

## The judgement half: the default's premise is change-type dependent

`on-catch-up` is argued on this premise: "the app keeps rendering the **complete old answers** and switches when the new fold is ready, so a user who did not ask for the reconfigure never sees the state go backwards."

That premise is sound when the successor SHARES the stream. A processor-only change folds the same events differently, so the incumbent's answers really are complete and really are about the same world.

It is much weaker when the successor is on its **own stream**, which is exactly what a filter or source change produces (ADR-0044):

- The incumbent folded a **different event set**. After a contract upgrade to a new deployment address, its answers are about a contract that is no longer the source of truth. They are not stale-but-complete, they are current-looking and wrong.
- The processor usually changes WITH the source, because new events need new handlers, so the successor may declare **different entities**. Reads go to whichever generation is canonical, and its state lives in its own namespace under its own schema, so an app updated for the new schema can be querying an incumbent that does not carry it.

So on a new stream, "wait for catch-up" can mean "serve answers about the wrong contract, under the wrong schema, for the whole catch-up window", which is the opposite of what the default is trying to buy.

## Why proposing a change-type-dependent default does NOT contradict the existing rule

`promotion.ts` refuses per-runtime and per-environment defaults, in strong terms: "there is deliberately no per-runtime and no per-environment default, because the axis that would select one is NOT DETECTABLE ... Do not add a `process.env` sniff, an `import.meta.env.DEV` check or a per-package default."

That rule is about an **undetectable** axis (development versus production). The axis here is **detectable and already computed**: whether a successor shares a stream is what ADR-0044 decides structurally, and it is the same fact that already selects follower-versus-own-stream behaviour. Selecting a default on something the system has already determined is a different act from sniffing the environment, so this can be proposed without reopening that decision. It should still be argued explicitly rather than assumed, because it makes the promotion default non-uniform for the first time.

## What to decide

1. **Expose the policy on the CLI** (a flag plus the matching environment variable, following ADR-0048's one-name-per-input shape). Small, and it alone gives the author the "wait or instant" option asked for.
2. **Separately**, decide whether the DEFAULT should be `immediate` when the successor is on its own stream, or whether that stays an explicit operator choice. The safe-by-default principle in `promotion.ts` argues for keeping the unsafe value opt-in; the argument above says the currently-safe value is not the safe one in this case. Worth an ADR amendment rather than a quiet change, since the current default's reasoning is recorded.

Note the interaction with `a-filter-change-freezes-the-incumbent-in-run`: these are alternatives rather than duplicates. If the choice is to WAIT for catch-up, the incumbent must keep advancing, and that note's fix is required. If the choice is to switch INSTANTLY, the incumbent stops being canonical almost at once and its freshness matters much less. Both paths need to work, because "wait" stays legitimate whenever an operator wants to inspect a successor before it answers anybody.
