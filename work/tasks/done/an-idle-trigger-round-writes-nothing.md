---
title: 'An idle trigger round writes nothing'
slug: an-idle-trigger-round-writes-nothing
spec: one-trigger-service-serves-several-apps
blockedBy: [two-tickers-of-one-app-never-work-at-once]
covers: [21]
---

## What to build

Today every advanced step of the trigger consumer rewrites its `consumers` row, even when the page carried nothing: at the 5 s default interval that is about 518k writes a month per idle app, more than the lease costs and a real share of a metered host's allowance (`work/notes/findings/a-database-costs-almost-nothing-on-d1-and-turso.md`). Make an idle round write nothing but the lease renewal:

- Skip the step's state write when the page carried no entries, inserted no delivery, and changed neither stream, generation nor pause.
- The cursor may still differ (it carries the stream's high-water `since` mark), but on an empty page the POSITION does not move, so keeping the older cursor is deliberate and safe: an older mark only makes the fork check conservative, and an empty canonical page always reports `hasMore: false`, so `catchUp` cannot spin on it.
- The newest cursor is written by the next GUARDED step write (a non-empty page, a rewind, a pause), never by the lease renewal (which writes only the lease columns).
- A rewind and a stream change always write, as now.

This is the last task of the chain that builds ADR-0101: remove ADR-0101's `status: accepted, not yet implemented` line in this change (ADR-FORMAT.md: removing it is part of the work that implements it).

## Acceptance criteria

- [ ] An idle tick on an app holding a fresh lease issues no write at all (counted at the `remote-sql` seam: no `batch` or write statement executed).
- [ ] An empty page whose cursor moved is not written, and the next read from the older cursor returns no entries; the first non-empty page afterwards writes the newest cursor.
- [ ] A rewind and a stream change are still written on an otherwise empty page.
- [ ] ADR-0101's `accepted, not yet implemented` status line is removed (check that the app-keyed schema, the timeouts, the multi-app platform, the guard, the per-app CLI and the lease have all landed first; if one has not, keep the line and say so in the Decisions block).
- [ ] A changeset for `@etherfold/triggers` (0.x: patch).
- [ ] Tests cover the new behaviour (mirror the core's existing style).

## Blocked by

- `two-tickers-of-one-app-never-work-at-once` (the lease's guarded commit and renewal shape what "idle" writes; same consumer module).

## Prompt

> Goal: an idle trigger round (nothing new on the feed, nothing due) writes nothing except the lease renewal. Read ADR-0101 (its "an idle round writes nothing" consequence) and the canonical feed's cursor semantics in `@etherfold/server` (the feed route and the canonical view: an empty page moves only the `since` mark and reports `hasMore: false`). Code: the consumer's step and its state write in `packages/triggers/src`. The spec `work/specs/tasked/one-trigger-service-serves-several-apps.md` frames it (story 21).
>
> FIRST, check this task against current reality (written 2026-11-26). If the step already skips idle writes, or the lease landed with a renewal that does write the cursor, route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles.

## Decisions

- **An empty page only counts as idle when it also says `hasMore: false`.** The task's skip condition lists no entries, no delivery, and no change to stream, generation or pause. I added `!page.hasMore`. The real canonical view never sends an empty page with `hasMore: true`, so this changes nothing for the real server. But a feed that did would make each step re-read the same old cursor until `catchUp`'s page bound ran out, so committing that page is the safe choice. I considered following the task's condition exactly and trusting the server's guarantee. This only affects the consumer step, and a test covers it.
- **The idle check needs a stored state.** If no state row exists yet (a consumer without a lease, on its first step), the page is written. When the row exists but has never been written (the lease creates it, with the stream still null), the page is also written, because null differs from the page's stream. So an app's first page always records the stream and generation it follows, which is what the existing "stream change always writes" rule implies. Nothing outside the consumer is affected.
- **ADR-0101's status line removed.** The six tasks it waited on (app-keyed schema, timeouts, multi-app platform, the guard that refuses unknown apps, per-app CLI, lease) are all in `work/tasks/done/`, and this task was the last of the chain. The ADR had no other front-matter keys, so I removed the whole block. No other ADR refers to that status line.
- **An idle step no longer refreshes `consumers.updated_at`.** I checked: nothing in the triggers or platform code reads `updated_at`, so it now means "last committed step" rather than "last step". The lease renewal still does not touch it.
