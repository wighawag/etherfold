---
title: 'A published snapshot carries the history it was asked for'
slug: a-published-snapshot-carries-the-history-it-was-asked-for
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy: [a-state-snapshot-round-trips-from-a-build-database, publish-writes-a-state-snapshot-a-browser-app-starts-from]
covers: [2]
---

## What to build

`publish` (and the producer under it) takes `--history all|<depth>|none`, default `none` (ADR-0095). `none` puts the FLOOR at the cut; a depth `N` puts it `N` blocks below the cut, clamped at the source's start block; `all` puts it at the source's start block. The body then carries the live rows at the floor plus the changes of every block from the floor to the cut, and installing replays them.

The installed store reports the FLOOR as its history floor, so a consumer can revert to, and read as of, any block from the floor up, and refuses under it (ADR-0028). A requested depth reaching below what the database itself retains (its `--retention`) is refused by name rather than silently shortened.

## Acceptance criteria

- [ ] For `none`, a depth and `all`, the installed store answers an as-of read at several blocks between the floor and the cut exactly as the source database does.
- [ ] A revert to a block between the floor and the cut, followed by re-applying the same blocks, lands on the same state; a revert under the floor is refused.
- [ ] A depth reaching below the database's retention is refused, naming both numbers.
- [ ] The same body installs on the tip-only patch store, which keeps only the tip and ends in the same live state.
- [ ] Tests cover the new behaviour, mirroring the existing snapshot and time-travel suites.

## Blocked by

- `a-state-snapshot-round-trips-from-a-build-database`
- `publish-writes-a-state-snapshot-a-browser-app-starts-from` (it creates the `publish` command this task adds `--history` to)

## Prompt

> Goal: the history option of format 2 (ADR-0095). Format 2's shape already has room for it (rows at a floor, then per-block changes); this task fills the changes and moves the floor. Look at how the versioned SQLite store keeps version ranges and at ADR-0028's floor. Note: this edits the same producer and format code as `a-state-snapshot-round-trips-from-a-build-database`, hence the ordering, and it adds a flag to the `publish` command `publish-writes-a-state-snapshot-a-browser-app-starts-from` creates, hence the second.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
