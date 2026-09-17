---
title: 'Two concurrent `dorfl do` jobs on ONE repo delete each other''s worktree and claim, so a correct run dies with no execution surface'
slug: two-concurrent-dorfl-do-jobs-on-one-repo-delete-each-others-worktree
observed: 2026-09-17
---

2026-09-17 — Noticed while driving the ADR-0086 bundle-identity family, by dispatching the two dependency-free tasks (`a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp` and `a-processor-artifact-is-bytes-a-hash-and-a-loader`) as two concurrent `dorfl do task:<slug> --isolated` jobs. `dorfl` is 0.13.4. Both jobs died, and neither death was the agent's fault.

The failure is mutual worktree destruction. The second job's setup removed the FIRST job's worktree under `~/.dorfl/work/` and replaced the per-item claim in `~/.dorfl/claim/` with its own, while the first job was still claimed and still doing correct work. Its agent diagnosed the teardown itself: every subsequent shell call failed with `Working directory does not exist`, so it had no execution surface, could not write a source file, could not even write an observation note (`work/notes/observations/` lived in the deleted tree), and correctly refused to write into the surviving sibling's worktree because that tree belongs to a different item under a different lock. `dorfl` then reported the symptom rather than the cause, as `failed to spawn 'git': not found (tried '/run/current-system/sw/bin/git')` — git was present and on PATH the whole time; the spawn failed because the process's cwd had been deleted, and Node reports that as `ENOENT`.

It is symmetric. When the first job exited, its cleanup took the SURVIVOR's worktree with it: the second job ran on for another twenty-five minutes and then failed with `git add -A failed (exit 128): fatal: not a git repository`, its directory still present but its `.git` link gone. So the pair loses both runs, and the second loss arrives long after the cause.

Two things make this expensive rather than merely annoying. The cleanup is not job-scoped, so the blast radius is any sibling job on the same repo mirror rather than the exiting job's own tree. And the reported error names neither the deleted path nor the sibling that deleted it, so the obvious reading (a broken PATH, a missing git, a NixOS store problem) is wrong in a way that costs a while to rule out.

`maxParallel: 2` with `perRepoMax: 2` is the resolved config here, so per-repo concurrency is something the tool advertises. It appears to hold for `run`, which owns the whole tick and schedules the jobs itself; it does NOT hold for two independently dispatched `do` invocations against one repo. A conductor driving a family of tasks therefore has to serialise, whatever the parallelism rules in the task bodies say: the four `*-takes-its-identity-from-the-arrival` migrate batches are deliberately file-orthogonal so they COULD build in parallel, and that permission is unusable through `do` until this is fixed.

This is an observation about the RUNNER, not about `etherfold`. It is recorded here because this is the repo where it was measured and where the next drive will meet it.
