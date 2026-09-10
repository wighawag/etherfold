---
title: '`etherfold index` schedules no prune, so a bounded retention there still reclaims nothing'
slug: etherfold-index-schedules-no-prune
---

2026-09-10, noticed while landing `the-cli-schedules-the-prune-its-retention-implies`. `run` and `build` now schedule the prune their retention implies (`packages/cli/src/pruning.ts`, driven from `driveCycles`), but `etherfold index` -- the RECEIVING half, which folds what a sender pushes at it -- has no cycle of its own to prune between, so it was left out: a `--retention 50000` there still refuses reads outside the window while holding every version for ever, which is the worst-of-both `work/specs/tasked/a-configured-window-is-actually-pruned.md` exists to kill. It needs a schedule that is NOT the ingest path (ADR-0022 forbids a prune as a side effect of a write), which is a design question rather than an oversight: a timer, an admin route, or a prune the receiving host runs between batches it is not receiving.
