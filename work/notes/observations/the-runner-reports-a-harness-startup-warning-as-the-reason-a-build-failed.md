---
title: 'The runner reports a harness STARTUP WARNING as the reason a build failed, so a machine-capacity kill is filed as a model problem'
date: 2026-09-20
---

When a `dorfl do` build agent dies, the reason the runner records can be a line the harness printed at STARTUP that has nothing to do with why it died. Seen twice in a row, on the same task, with the true cause available in the job's own journal.

## What happened

Two consecutive isolated builds of `a-restarted-deployment-hands-over-the-write-duty-it-cannot-discharge` were killed by the kernel OOM killer. Both times the runner recorded, in the log, in the surface commit on `main`, and in the question it opened on the task:

```
agent failed: Warning: No models match pattern "ollama/glm-4.7:cloud"
```

That line is a pi startup warning about an unrelated model pattern in the harness configuration. It is printed on runs that go on to succeed. It was not the failure. The failure, from the same job's systemd journal:

```
dorfl-t4.service: The kernel OOM killer killed some processes in this unit.
dorfl-t4.service: Failed with result 'oom-kill'.
dorfl-t4.service: Consumed 10min 18s CPU over 18min 49s wall, 55.9G memory peak.
```

The apparent mechanism is that the runner takes the agent's stderr and surfaces the FIRST line, or the first line matching a warning/error shape, rather than the last. A harness that greets you with a warning therefore overwrites every subsequent diagnosis with its greeting.

## Why it is worth more than a shrug

The recorded reason is not merely unhelpful, it is actively misleading, and it is misleading in the direction that costs the most time.

**It names a subsystem that is not involved.** A reader, human or agent, sees a model-resolution failure and goes to look at harness configuration, model availability and provider auth. None of that is wrong with this machine. The actual answer -- the box ran out of memory -- is in a place the message gives no reason to look.

**It travels, and it outlives the run.** The reason is not just logged. It is committed to `main` as the surface commit's subject line, and it is pasted into the body of the `work/questions/` sidecar as the question the next person or agent must answer. So a phantom diagnosis becomes the durable record of why a task is blocked, and the re-dispatched agent reads it as its handoff.

**It converts a retryable event into an apparent judgement call.** An OOM kill is a capacity problem: requeue and re-dispatch, ideally with a cap. A model that cannot be resolved looks like broken configuration a human must fix. The runner gated the task with `needsAnswers: true` on the strength of the wrong one.

## What would fix it

Prefer the harness's LAST stderr output over its first, and prefer the process's exit signal over any of its output. A process killed by the OOM killer, or by any signal, is describable without reading its stderr at all: the wait status says so, and on a systemd-run unit `Failed with result 'oom-kill'` is one query away. A reason derived from the exit condition would have been right both times, with no parsing of harness chatter.

Failing that, an explicit suppression list for known-benign harness startup lines would have caught this exact one, though it only moves the boundary rather than removing the class.
