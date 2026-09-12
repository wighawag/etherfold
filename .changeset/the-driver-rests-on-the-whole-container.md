---
'@etherfold/browser': patch
---

**A catching-up generation no longer advances one fetch range per tip interval.**

Both browser drivers decided whether to REST from the CANONICAL generation's cursor alone, but `Indexer.indexMore` advances every generation the container holds. So a successor added by a reconfigure, while the canonical generation was already at the tip, got exactly ONE range per interval with the process idle in between: at the default four seconds, over an hour of wall clock for a successor with a thousand ranges of history to fetch. Nothing reported it, because the generation being reported on really was at the tip.

The rest is now decided over EVERY generation held, and a generation with no cursor yet counts as behind rather than level -- which is exactly what a just-added one looks like. Adding a generation also WAKES a resting driver, so an app no longer pays out the remainder of an interval before the work it just asked for begins.

**The rule is decided in ONE place now.** This package has two drivers and goes on having two, because they genuinely differ in how a rest is waited out -- the worker host `await`s a rest it can be woken from, the main-thread host re-arms a timer. What was duplicated between them was never that scheduling; it was the DECISION, which does not differ and had been written out twice. Twice meant two chances to be wrong and both were taken: each rested on the canonical cursor alone. It now lives in one internal module (`host/pacing.ts`), alongside `host/cases.ts`, which already played the same role for the boundary -- so what "one implementation over three hosting shapes" means is one implementation of the boundary and one of the cadence, over two schedulers.

One consequence is user-visible and is a fix in its own right: the main-thread host's PHASE used the canonical cursor while its rest used the whole container, so it could report `at-tip` while still driving a successor. Both now come from the same decision, and `SyncPhase.at-tip` means what it always claimed to mean -- every generation the container holds is level, not merely the one answering reads.

Two things deliberately did not change. With one generation held, which is the overwhelmingly common case, the rule is the same expression it always was. And a cycle that advances NOTHING still rests, even while something is behind, so a generation that cannot advance paces the loop exactly as before instead of spinning against a provider a browser user is rate-limited on.

**`HostProgress.failure` no longer outlives the drive it describes.** A driver stopped by a non-retryable refusal recorded `failure`, and it was only ever cleared by disposing the host -- so a host started again reported a phase that moved (`catching-up`, then `at-tip`) with the old failure still attached, and an app rendering from it showed an error over a fold that was running. Both drivers now clear it when a new attempt starts.

**The hook's progress figures are numbers before the first fetch.** A container publishes its cursor once at load, as `0` of `0`, and `ExtendedLastSync` derived `totalPercentage` as `lastToBlock / latestBlock` -- `NaN` -- and `syncPercentage` over a negative span. Both now come from `derivedProgress`, the same derivation the port already published from, and read `0` until a tip has been learnt: "nothing known yet", never a full progress bar.
