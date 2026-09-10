---
title: 'The browser package holds a writable store'
slug: the-browser-package-holds-a-writable-store
spec: a-second-writer-writes-nothing
blockedBy: [the-seam-splits-into-a-readable-and-a-writable-store]
covers: []
---

## What to build

Move `@etherfold/browser` onto the writable shape, so what writes is typed as writing and what only reads is typed as reading.

This is one batch of the MIGRATE step. It is independently green because the split task left the old surface working, which is the whole reason that task exists. Keep the change to this batch: the batches are file-orthogonal by design and must not collide.

The sites: `packages/browser/src/storage/state-store/BrowserStateStore.ts` (the factory type and `createBrowserStateStore`) and `packages/browser/src/IndexerState.ts` (the `createState` factory type and the processor factory).

This package has ZERO mutating calls of its own: it constructs and hands on, so the migration is entirely about the TYPES it names. Get the signature right: `createBrowserStateStore(declarations, config?)` does NOT take a `GenerationContext`. It is the host-supplied `createState: (context: GenerationContext) => StateStore` in `IndexerState.ts` that receives one. If you notice that the documented example ignores that context and puts every generation in the default database, capture it as an observation rather than fixing it: it is a known separate defect.

`covers: []` deliberately: a migration batch is the mechanical middle of expand/migrate/contract and delivers no user story on its own.

## Acceptance criteria

- [ ] Everything in this batch that MUTATES holds the writable shape, obtained through `openForWriting`.
- [ ] Everything in this batch that only READS holds the readable shape, so the split is expressed rather than merely available. Name at least one site where this applies, or state that none does.
- [ ] No behaviour changes: this batch's existing tests pass UNMODIFIED, and where it has golden output that output is byte-identical.
- [ ] No package outside this batch is touched, and no backend test suite is touched.
- [ ] The gate is green with BOTH store shapes still present, since the old surface is not removed until the final task.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

`the-seam-splits-into-a-readable-and-a-writable-store`.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md` for the framing, then the task `the-seam-splits-into-a-readable-and-a-writable-store` (in `work/tasks/done/` once it has landed) for the exact type shape and the ONE call signature of `openForWriting`. Use that signature; do not invent a second one.

The property that makes this batch safe: the split task left the OLD surface working, so you are moving a caller rather than migrating a seam. Do not remove anything from the base store type here. The removal is the final contract task, blocked by every batch including this one. If you find yourself deleting a member from `StateStore`, you are in the wrong task.

Domain vocabulary you may need: the **sync cursor** lives BEHIND the storage seam as an opaque string, written in the SAME transaction as the block it describes (ADR-0027), so it moves with the writable shape. A **generation** builds its own state through its own factory, so "the store" may be several stores.

Done means this batch holds writable stores where it writes and readable ones where it reads, and nothing else in the repository moved.
