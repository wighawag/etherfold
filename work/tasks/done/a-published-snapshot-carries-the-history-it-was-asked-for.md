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

> FORWARD-POINTER (conductor, after #218): format 2's later-blocks section is already DECODED and installed by `bootstrap` (tested in `packages/state-store/test/snapshot.test.ts`, 'a snapshot that carries history above its floor'); this task adds the PRODUCER side (`produceStateSnapshot` in `@etherfold/state-store-sqlite` gains the floor/history option) and the `--history` flag. Also check, and cover if needed: a download that fails partway through a history install leaves the floor and some later blocks installed; the next `openAndBootstrap` must not treat that store as a complete install.

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

## Decisions

- **The "source's start block" is the first block the generation recorded.** The database does not store a usable start block (the stored source identity always has a block-0 entry), and the document's floor needs a recorded block with a hash and timestamp. Below the first recorded block the state was empty, so the store only refuses reads it could have answered as "empty", never gives a wrong one. Alternatives: derive it from the stored cursor's source entries (unreliable), or invent a floor block with no real hash (would corrupt lookups by block). This affects `produceStateSnapshot` and `publish --history`.
- **A floor between recorded blocks points at the highest recorded block at or below it,** the same rule ADR-0095 uses for the cut. The reported floor can therefore sit slightly below the requested height, never above it. The retention check is judged on the requested height, because nothing changed between that height and the block the floor points at.
- **"What the database retains" is the higher of the reading handle's own retention and the floor its last prune recorded.** `publish` refuses `--retention` and the folding deployment's setting is not stored in the database, so the prune record is the only fact about what was actually deleted. This is the new `VersionedStateStore.retainedFrom()`, plus a newly exported `recordedPruneFloor` in `@etherfold/state-store`. An alternative was letting `publish` accept `--retention`; I rejected it because it would be an unverifiable claim about another process. The check also applies to `none`; with a real retention window and `publish`'s cut at `tip - finality` it never triggers.
- **An install over a store that already has a snapshot origin wipes it first,** using `revertTo(-1)` once the new document's head and floor are checked. This is a behaviour change for `openAndBootstrap` and `bootstrapFromSnapshot`: replacing an older complete install with a newer snapshot now also wipes it. That is correct, since laying floor rows over old state would keep rows the newer snapshot no longer has. Alternatives: resume the interrupted install (it cannot tell whether it is the same document), or wipe only when there is no cursor (a special case with no benefit). On the memory-only patch store the wipe needs the undo record for each block. Those exist for any install made in the same session; if the host has pruned them in the meantime, the wipe throws instead of wiping.
- **`--history` is a new input in the CLI's per-command flag table: optional on `publish` and refused everywhere else, `build` included.** `build --publish` belongs to `build-publishes-at-the-tip-it-stops-at`, which can open it up. Depth is in blocks, like retention, and anything other than `all`, `none` or a whole number is refused rather than read as the default.
- **The refusal is a new `PublicationRefusedError` reason, `history-not-retained`,** wrapping the producer's `HistoryNotRetainedError` so its message, with both block numbers, reaches the CLI unchanged.
