---
title: 'A StreamWriter whose append silently does nothing grows without bound, rather than stalling'
date: 2026-09-20
---

A deployment whose `StreamWriter.saveNewEvents` reaches its append call and that call does NOTHING does not stall quietly. It grows until the kernel kills it. Measured, twice at full size and once under a cap.

## What was measured

The measurement was not sought. It arrived because two consecutive `dorfl do` runs on `a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge` were killed by the kernel OOM killer, on a 60 GB machine, taking the build agent with them:

```
dorfl-t4.service: OOM-killed, 55.9G memory peak,  6.7G swap peak, 19 min in
dorfl-t5.service: OOM-killed, 57.4G memory peak,  3.7G swap peak,  9 min in
```

Both died while running the same thing: the task's own new CLI test, `packages/cli/test/aRestartedDeploymentGoesOnAppending.test.ts`, under a NEGATIVE CONTROL that suppresses the append. The build agent had added a temporary hook in `packages/core/src/stream/writer.ts` to express that control:

```ts
if ((globalThis as any).process?.env?.NEGCTRL === 'no-append') return;
await this.appendEmissions({ ... });
```

Isolated and re-run under an 8 GB cgroup cap, the two configurations separate cleanly:

```
appender intact       8 tests pass in 1.17s. Peak well under the cap.
append suppressed     hits the 8 GB cap and is OOM-killed in under 50 seconds,
                      with 3.9 GB of swap paged on the way. No test completes.
```

So the growth is not slow and it is not a leak that needs a long run to show. It is roughly 8 GB in 50 seconds, and it does not stop: uncapped it took 56 GB and the whole machine.

## What this is, and what it is not

**It is not the family's data-loss defect wearing a different face.** That defect, measured before this family landed, is a deployment where the write duty belongs to a generation that is not HELD, so the gate never hands any fold the pen and `saveNewEvents` is never reached. The deployment stays live, stays small and keeps folding; the symptom is that `_emissions` stops at 2 rows. This is a different injection point: here the writer HAS the pen, believes it is writing, and the write evaporates beneath it.

**So this is not reachable on today's code**, which is exactly why the hook had to be hand-added to provoke it. It is a robustness finding, not a live bug, and it is recorded rather than tasked for that reason.

**What makes it worth recording** is the shape. The whole of ADR-0087 exists because a stored stream can stop growing with "no refusal, no warning". This measurement says the neighbouring failure -- a write that is attempted and silently accomplishes nothing -- has the opposite and equally unhelpful signature: not silence, but unbounded growth and a kill. Whatever is upstream of the appender is evidently holding what it has not yet been told was stored, and its bound is the append succeeding. A bound that exists only because a downstream call works is a bound worth knowing about, and neither failure mode announces itself as "the stream is not being written".

The mechanism was not isolated. The effect was measured; the cause inside the fetch/fold loop was not chased, because it was off the path of the task being driven.

## The operational half

A negative control that suppresses a write in this codebase must be run under a memory cap and a short timeout. Run bare, it does not fail the test, it kills the machine, and on an agent runner it kills the agent holding the work. Both OOM kills above were reported by the runner as `agent failed: Warning: No models match pattern "ollama/glm-4.7:cloud"` -- a harmless startup warning from the harness that had nothing to do with it -- so the recorded reason pointed at a phantom in a completely unrelated subsystem. That mis-attribution is filed separately.
