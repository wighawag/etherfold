---
title: 'A re-run `build` with changed bytes registers a successor and exits with the pointer still on the old generation'
slug: a-rerun-build-registers-a-successor-and-exits-without-ever-settling-the-pointer
observed: 2026-09-19
---

2026-09-19 — Noticed while driving `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`, which scoped its drive-loop fix to `run`. NOT fixed and not measured end to end; read off the code.

`build`'s docstring says a one-shot "opens the container with one fold and exits, so it never adds a second and never promotes". The first half stops being true the moment a `build` is re-run over a database it already wrote with CHANGED processor bytes: that is a different identity, so the container registers it into `successor` beside the existing canonical generation, exactly as a restarted `run` does. The second half then bites: `driveCycles` skips the whole rebuild-and-settle block under `stopAtTip` (`packages/cli/src/index.ts`), and `build` has no other settle, so it folds the successor to the tip and exits with the canonical pointer still naming the old generation. The artifact it emits therefore serves the OLD fold, with a fully caught-up newer one sitting in the database beside it.

Two things worth deciding rather than assuming: whether a `build` should settle once before it exits (it has an EXIT, which is the same argument that gives it `pruneHeldUntilComplete` there), and whether the docstring's "never adds a second" should instead be made true by refusing. `run` is unaffected; its loop settles every cycle.
