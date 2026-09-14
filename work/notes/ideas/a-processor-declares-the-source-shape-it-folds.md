---
title: 'A processor declares the source shape it folds, so a source change without a matching processor is refusable'
slug: a-processor-declares-the-source-shape-it-folds
---

2026-09-13 — Raised by the author: in a dev loop a SOURCE change often lands before the processor that goes with it, so a reconfigure can register a generation whose processor does not handle the events the new source brings. The author's two candidate shapes were (a) a processor declares the source or ABI shape it works on, so a source change STREAMS but does not PROCESS until a matching processor arrives, and (b) the API takes both at once, which still needs a way to know they match.

## What is true today, checked

- **A processor declares `version` and `entities`, and nothing about the source.** There is no statement anywhere of "this fold expects that ABI", so a mismatch is not detectable, only survivable.
- **Stream identity is the FETCH FILTER**, derived from the source's contracts and their ABIs. So a source change moves the filter whether or not any processor handles the new events.
- **A stream has no independent existence.** Its writer is "the oldest surviving generation registered on it", so a stream is materialised BY a generation. "Stream but do not process" is therefore not expressible today, and shape (a) would need a new concept: a stream being fetched with no fold over it.

## The architecture already absorbs most of the cost, which changes the priority

The scenario is less expensive than it looks, because of the split the reconfigure spec rests on: a STREAM is the expensive thing (raw logs, fetched from a node that may not serve old ones) and a GENERATION is a cheap re-fold of one.

Walk it. The source change creates stream S2 and a generation on it with the not-yet-updated processor, which fetches S2's history once. The processor is then fixed, which is a PROCESSOR change over the same source, so the new generation is on the SAME stream S2: a follower that "fetches nothing at all" and re-folds what is stored.

So the expensive half happens once and is reused, and the waste is one fold over already-stored data, which is precisely the operation the design makes cheap. Shape (a)'s main benefit, not fetching twice, is therefore already delivered by streams being shared.

## What actually remains, and it is smaller

1. **The intermediate generation can be PROMOTED.** With `on-catch-up` (the default everywhere) the half-right fold becomes canonical the moment it is level, so reads flap through a generation that ignores the new events before the real one arrives. This is the genuine defect in the scenario, and it is addressed by choosing the policy rather than by declaring shapes (`the-cli-selects-its-promotion-policy`, and `manual` is exactly "let me say when").
2. **The intermediate generation holds a slot.** Addressed by `a-successor-that-was-never-canonical-is-superseded`.

Both are already tasked. So the scenario is mostly covered by work that exists, which is the argument for not building a declaration yet.

## Why the declaration is still interesting, and the hard part of it

What a declaration buys that the above does not is REFUSAL: today the mismatch is tolerated and then corrected, and with a declaration it could be rejected up front, which is a better error for an operator deploying a source change to production with the wrong build.

The hard part is that **"matches" cannot be inferred**. A processor with no handler for an event is indistinguishable from a processor that deliberately ignores it, and ignoring events you do not care about is the normal case rather than an error. So the declaration has to be EXPLICIT and authored, which is a real cost on every processor author and a new thing to keep in step with the ABI. A declaration that is merely derived from the handler set would refuse the ordinary case and be turned off immediately.

Shape (b), the API taking both at once, is already how the reconfigure trigger works: it re-reads configuration AND re-imports the processor together, and a processor that does not compile leaves the deployment untouched (`a-change-reaches-a-running-deployment`, story 3). So (b) is delivered for the compile-failure case, and only the "compiles but does not handle the new events" case is left, which is the one needing the declaration.

## Suggested position

Do not build it yet. Land the promotion policy and the supersession bound, which together make the scenario correct if slightly wasteful, then see whether the remaining flap is felt. If it is, the declaration is worth its cost, and the natural form is a statement the processor makes about the event signatures it requires to be present, checked against the source's ABIs at registration and refused there, in the same shape other capability mismatches are already refused.
