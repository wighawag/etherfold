---
title: 'The server and the CLI open their stores for writing'
slug: the-server-and-cli-open-their-stores-for-writing
spec: a-second-writer-writes-nothing
blockedBy: [a-store-opens-for-writing-or-for-reading]
covers: [10, 13]
---

## What to build

Move `@etherfold/server` and `@etherfold/cli` onto `openForWriting`, so it holds a store whose type says it writes rather than one that merely happens to.

This is one batch of the MIGRATE step. It is independently green because the expand task left both shapes working, which is the whole reason that task exists. Keep the change to this package: the point of one task per package is that the batches are file-orthogonal and cannot collide.

These hosts also own the emission-stream tables in the same database, so read how they share one handle with the entity tables before moving anything.

## Acceptance criteria

- `@etherfold/server` and `@etherfold/cli` constructs its store through `openForWriting` and holds the writing shape.
- Anything in it that only READS holds the reading shape, so the split is expressed rather than merely available.
- No behaviour changes: the package's existing tests pass unmodified, and where it has golden output, that output is byte-identical.
- No other package is touched by this task.
- The build, typecheck and test gate is green with both store shapes still present.
- A changeset accompanies the change (`pnpm changeset`). This touches PUBLISHED packages and `pnpm changeset status --since=main` is part of the acceptance gate, so a missing changeset is a red gate for a reason unrelated to the work.

## Blocked by

`a-store-opens-for-writing-or-for-reading`.

## Prompt

Read `work/specs/tasked/a-second-writer-writes-nothing.md`, especially its Task order: this is one batch of step 6, and the property that makes it safe is that step 4 left the OLD surface working, so you are moving a caller rather than migrating a seam.

Do not remove anything from the base store type in this task. The removal is the final contract task and it is blocked by every migration including this one. If you find yourself deleting a method from `StateStore`, you are in the wrong task.

Domain vocabulary you may need: the **sync cursor** lives BEHIND the storage seam as an opaque string, written in the SAME transaction as the block it describes (ADR-0027), so it moves with the writing shape. A **generation** builds its own state through its own factory, so "the store" may be several stores.

Done means this package holds a writing store, reads through a reading one where it only reads, and nothing else in the repository moved.
