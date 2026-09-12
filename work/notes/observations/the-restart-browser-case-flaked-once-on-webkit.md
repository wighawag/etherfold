---
title: 'The restart-and-resume browser case flaked on WebKit: DIAGNOSED and fixed'
slug: the-restart-browser-case-flaked-once-on-webkit
observed: 2026-09-12
---

`browser/restartsAndResumes.spec.ts` failed intermittently on `webkit` (about one full run in eight), always the same way: the wait after the restart exhausted its 15 s and the case took about 16.5 s against a normal 2.3 s.

**RESOLVED AS A TEST 2026-09-12, and it was not a flake** -- but the underlying defect is NOT solved and its cause is still open. What the case was silently hitting is a WebKit-only stall: the replacement worker opens its database and then waits for the writer claim FOR EVER (measured out to 100 s; chromium and firefox 0 failures in 12 runs each). A first diagnosis blamed a terminated worker's transaction still holding the object store; a minimal probe FALSIFIED that, so the cause is unknown. Both halves are in `work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`, with the probe and its results under `docs/spikes/webkit-terminated-worker-wedges-indexeddb/`.

The case now asserts the guarantee that holds on every engine -- either the fold resumed, or the tab can still see exactly where it stopped -- and refuses the outcome that a tab cannot tell the difference. **0 failures in 20 WebKit-only runs and 12 full three-engine runs**, against roughly 1 in 8 before.

## Three things this got wrong on the way, worth keeping

**It was called a flake twice, then given a confident wrong cause.** The mechanism above was written into a finding, a spec comment and two source comments before it was tested minimally -- and the minimal test disproved it. The lesson is the same one as below, one level up: instrumenting beat reasoning, and the reasoning that felt most obviously right was the part that was wrong.

**It was called a flake twice before it was diagnosed.** The first note said "one unreproduced failure, probably load" on the strength of three clean baseline runs, which was far too small a sample. The second round measured properly (1/8 on stashed baseline versus ~3/20 with changes) and correctly concluded the work in flight had not caused it -- but stopped there, at "pre-existing", which is a true statement that is not a diagnosis. What actually moved it was instrumenting rather than reasoning: two hypotheses (a tight death-detection budget, then a blocked database OPEN) were both wrong and both were killed by a probe.

**The diagnosis was blocked by a diagnostic gap of our own.** `browser/cut.ts` recorded `error.stack` alone, and on JavaScriptCore `stack` carries no message -- so every WebKit-only failure arrived as bare frames saying nothing. It records the message now. That one-line gap is most of why this took several rounds.

**A second, unrelated problem was found while chasing it, and it was NOT the cause.** `playwright-browser-harness@0.3.0` never removes the `mkdtemp` directory it builds each case into (`dispose()` closes the server and nothing else), leaking about 4.5 MB per mounted case -- roughly 230 MB per three-engine run, into a `/tmp` that is a RAM-backed tmpfs. Repeatedly running the suite to chase this bug walked a 16 GB `/tmp` to 100% full: 3,013 directories holding 11 GB, after which esbuild began failing with `no space left on device` and everything slowed down. Wrapped locally in `browser/harness.ts` (only removing a directory the mount OWNS, since multi-tab cases share one via `prebuilt`). Fixing it did NOT change the failure rate, which is what said it was not the cause. Worth reporting upstream; 0.3.0 is the latest published version.
