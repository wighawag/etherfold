---
title: 'A deployment restarted with a CHANGED PROCESSOR appends nothing to its stored emission stream, because the writer is a generation it holds no fold for'
slug: a-restarted-deployment-appends-nothing-to-its-stored-stream
observed: 2026-09-16
---

2026-09-16 — Noticed and measured while driving `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`, beside the blockers in `the-promotion-trigger-cannot-be-evaluated-with-no-held-incumbent`. Not fixed, and deliberately left out of that build's tree. It is a separate subject with a separate fix, and it is arguably worse than the stall it was found next to, because it loses data rather than merely failing to advance.

Restart a `run` deployment with a changed processor, over the same database. The container comes up holding exactly one fold, the successor. That fold reports `writesStream: false` (measured), so `appendEmissions` is handed to nobody and **nothing appends to the stored emission stream** while the successor happily consumes the wire and folds it.

The mechanism is the one-writer rule working exactly as specified, in a shape it was not considered against. `writerOf` names the OLDEST SURVIVING generation registered on the stream (`generations.filter(on this stream).sort(byAge)[0]`), which is the INCUMBENT — it is still registered, and it is older. The container holds no fold for the incumbent, because the old processor's code is not in the build. So the write duty belongs to a generation that is not present to discharge it, and the generation that IS present is correctly refused it. `reconcileWriters` does not repair this: `shouldWrite` is `false` and already matches `fold.writesStream`, so it is a no-op rather than a hand-over.

Succession was designed for the case where the writer is DELETED — "deleting a writer makes the next-oldest one the answer, and this container moves the wire to it" (ADR-0044, and the `writesStream` docstring). It says nothing about a writer that is merely ABSENT from this process, which is the ordinary redeploy. The two are different: a deleted writer leaves no row, so the next-oldest genuinely becomes the writer; an unheld writer leaves its row exactly where it was, so `writerOf` keeps naming it for ever.

The consequence is not bounded to the upgrade window. Every later generation re-folds that ONE stored history, so a gap opened here is a gap every future successor inherits, and the promise that moving the canonical pointer back restores answers EXACTLY is only as good as the stream under it. Worth checking, when someone picks this up, whether the emission gap is silent to the deployment or shows up as a coverage claim that stops advancing.

Reproduced on `packages/core/src/receivingContainer.ts`, `add` / `reconcileWriters`, with a probe standing up a deployment the way `packages/cli/test/theDeploymentSelectsItsPromotionPolicy.test.ts` does and restarting it over the same handle.
