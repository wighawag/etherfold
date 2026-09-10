---
title: 'The workload and the cf-worker platform hold writable stores'
slug: the-workload-and-cf-worker-hold-writable-stores
spec: a-second-writer-writes-nothing
blockedBy: [the-seam-splits-into-a-readable-and-a-writable-store]
covers: []
---

## What to build

Move `@etherfold/conformance-workload-stratagems` and `platforms/cf-worker` onto the writable shape, so what writes is typed as writing and what only reads is typed as reading.

This is one batch of the MIGRATE step. It is independently green because the split task left the old surface working, which is the whole reason that task exists. Keep the change to this batch: the batches are file-orthogonal by design and must not collide.

The sites: `packages/conformance-workload-stratagems/src/workload.ts`, `replay.ts`, and `project.ts` which only reads; and `platforms/cf-worker/src/d1.ts` where `createD1Store` returns a store.

Both are small: cf-worker has exactly ONE mutating site, a factory return type, and the workload has two. The golden output of the workload is FROZEN: a diff on it means the processor changed meaning, which is a finding and a STOP, never a fixture update.

`covers: []` deliberately: a migration batch is the mechanical middle of expand/migrate/contract and delivers no user story on its own.

## Acceptance criteria

- [ ] Everything in this batch that MUTATES holds the writable shape, obtained through `openForWriting`.
- [ ] Everything in this batch that only READS holds the readable shape, so the split is expressed rather than merely available. Name at least one site where this applies, or state that none does.
- [ ] No behaviour changes: this batch's existing tests pass UNMODIFIED, and where it has golden output that output is byte-identical.
- [ ] No package outside this batch is touched, and no backend test suite is touched.
- [ ] The gate is green with BOTH store shapes still present, since the old surface is not removed until the final task.
- [ ] No changeset: both packages here are `private`, and `privatePackages: false` in `.changeset/config.json` means changesets ignores them. Adding one would be noise.

## Blocked by

`the-seam-splits-into-a-readable-and-a-writable-store`.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md` for the framing, then the task `the-seam-splits-into-a-readable-and-a-writable-store` (in `work/tasks/done/` once it has landed) for the exact type shape and the ONE call signature of `openForWriting`. Use that signature; do not invent a second one.

The property that makes this batch safe: the split task left the OLD surface working, so you are moving a caller rather than migrating a seam. Do not remove anything from the base store type here. The removal is the final contract task, blocked by every batch including this one. If you find yourself deleting a member from `StateStore`, you are in the wrong task.

Domain vocabulary you may need: the **sync cursor** lives BEHIND the storage seam as an opaque string, written in the SAME transaction as the block it describes (ADR-0027), so it moves with the writable shape. A **generation** builds its own state through its own factory, so "the store" may be several stores.

Done means this batch holds writable stores where it writes and readable ones where it reads, and nothing else in the repository moved.
