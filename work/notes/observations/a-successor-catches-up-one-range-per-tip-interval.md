---
title: 'A generation catching up beside a canonical one at the tip advances once per tip interval'
slug: a-successor-catches-up-one-range-per-tip-interval
observed: 2026-09-11
---

Noticed while building `a-tab-controls-the-indexer-across-the-port`, and NOT fixed (out of that task's scope, and it is not this task's code: the main-thread hook has the same shape).

Both browser drivers decide whether to REST on the CANONICAL generation's cursor alone -- `serveIndexerHost`'s loop (`advanced.lastToBlock >= advanced.latestBlock`, `packages/browser/src/host/serve.ts`) and `createIndexerState`'s `indexMoreAndCatchupIfNeeded` / `indexToLatest` (`lastSync.lastToBlock !== lastSync.latestBlock`). `Indexer.indexMore` advances every generation one step per call, so a successor added by a reconfigure while the canonical generation is already at the tip gets ONE fetch range per rest interval: at the default four seconds, a successor on a new stream with a thousand ranges of history to fetch takes over an hour of wall clock to catch up, while the process sits idle between advances. The fixtures do not show it (five blocks, a 0.05-0.25 s interval).

The fix is presumably to rest only when every generation the container holds is level, which needs care in the other direction: a generation that has not loaded, or a follower that cannot advance, must not turn the rest into a hot loop.

**RESOLVED 2026-09-12.** Both drivers now decide the rest over EVERY generation the container holds (`someGenerationBehind`), not over the canonical cursor alone, and both wake a resting loop when a generation is added rather than making the app pay out the remainder of an interval for work it just asked for. A generation with no cursor yet counts as BEHIND, since that is exactly what a just-added one looks like. The hot loop the fix had to avoid is guarded by resting on a cycle that moved NOTHING. Pinned by `packages/browser/test/everyGenerationIsLevelBeforeTheDriverRests.test.ts`, which covers the worker host and the main-thread host and fails against the old rule.

The DUPLICATION that made this bug possible is gone too: the rule (which phase a cycle ended in, and whether to rest) now lives in `packages/browser/src/host/pacing.ts` and is the only copy, so the two drivers keep only their scheduling, which genuinely differs. Breaking that one function fails the end-to-end cases for BOTH hosts, which is what says there is one implementation rather than two that agree today. It also closed a second defect the split was hiding: the main-thread host computed its PHASE from the canonical cursor while resting on the whole container, so it could report `at-tip` while still driving a successor.
