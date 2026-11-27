---
title: 'Two tickers of one app never work at once: a per-app lease in the trigger core'
slug: two-tickers-of-one-app-never-work-at-once
spec: one-trigger-service-serves-several-apps
blockedBy: [the-trigger-cli-reports-and-acts-per-app, a-trigger-database-refuses-apps-the-config-does-not-know]
covers: [19, 20, 22]
---

## What to build

Two tickers of the same app over one database (two processes, a rolling deploy's overlap, overlapping Cron Triggers on a future Worker host) would today both deliver the same due rows. Put a per-app LEASE in the core (`@etherfold/triggers`), so the guarantee holds whatever drives the ticks (ADR-0101: the lease is in the core, not a host obligation). The core still owns no timer: a host calls `tick()`.

- **Columns**: `consumers` gains `lease_owner` (a random id per service instance, `crypto.randomUUID()`, available on Node, Bun and Workers) and `lease_expires` (ms since epoch).
- **Acquire or renew**: one statement, `INSERT INTO consumers (app, ..., lease_owner, lease_expires) VALUES (...) ON CONFLICT (app) DO UPDATE SET lease_owner = excluded.lease_owner, lease_expires = excluded.lease_expires WHERE consumers.lease_owner = excluded.lease_owner OR consumers.lease_expires < ? RETURNING ...`. It creates the row on an app's first tick; an empty `RETURNING` means another owner holds a live lease, and the tick does nothing (no `expire`, no feed, no `deliverDue`) and reports `not-leased`. The renewal writes ONLY `lease_owner` and `lease_expires`, never the cursor, stream, generation or pause, so it can neither undo an operator's `resume` nor move a cursor backwards after a takeover.
- **Cadence**: the lease lasts 60 s by default, configurable per app beside the per-call timeout (and exposed in `etherfold-triggers`' per-app config). The acquire-or-renew statement is executed ONLY when the ticker holds no lease or its known expiry is under half the lease away: a ticker keeps the expiry it last wrote in memory, so a tick of a `run` loop holding a fresh lease writes nothing for it. Between renewals, the consumer-row read every step already does also returns `lease_owner` and `lease_expires`, so checking ownership costs no extra query. Cost: about one write per 30 s per app.
- **Fencing by deadline**: before EACH call the core makes, the four the previous task bounds (the gate, each feed read, each predicate invocation, each delivery attempt), the tick checks the time left on its lease (a clock read). Under half the lease, it renews first (any fence check may renew, not only the tick's start); under the FENCE MARGIN after that, it stops the round. The margin is the per-call timeout plus a commit allowance (5 s) plus a clock-skew allowance (5 s): 20 s of the 60 s lease with the defaults, so every call started inside the lease ends inside it (the core gives up on a call at its timeout whatever the callee does). The service refuses to start when the margin is not under half the lease, naming both values.
- **Fencing by the commit**: every statement of a step's commit batch (delivery inserts, the rewind's updates, the state write, journal rows) is guarded by the lease: inserts become `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM consumers WHERE app = ? AND lease_owner = ? AND lease_expires > ?)` (keeping the delivery insert's `ON CONFLICT DO NOTHING`), updates carry the same predicate. Every settle (delivered, retry, dead, expired, the no-adapter dead letter) is guarded too. So a stale holder changes nothing even if the deadline was wrong.
- **Lease-free, deliberately**: the registration API's writes (subscribe, renew, cancel, the replay record) and the operator's `resume` and `requeue`, which are a person's row-level actions, each already safe beside a ticker (`resume` acts only on a paused consumer, whose ticks do nothing; `requeue` only flips a dead row to pending).
- **Release**: `UPDATE consumers SET lease_expires = 0 WHERE app = ? AND lease_owner = ?`, done by the core's `run` when its signal aborts (graceful stop) and exposed for a one-shot host; `etherfold-triggers tick` releases at the end of its round. A crashed ticker's lease lapses within the lease duration.
- **Clock assumption**: documented in the core README: tickers of one app agree within the skew allowance (NTP-synchronised hosts; the platform clock on Workers).
- Delivery stays at-least-once (adapters honour the idempotency key); the lease removes the systematic double delivery of concurrent tickers, not the rare retry after a crash.

## Acceptance criteria

- [ ] Two services over one database for the same app, ticked concurrently, deliver each due row exactly once, and the one without the lease reports `not-leased` and runs neither `expire` nor `deliverDue`.
- [ ] The first tick of an app with no `consumers` row creates it and holds the lease.
- [ ] After the holder stops renewing, the other takes over once the lease lapses.
- [ ] A tick whose remaining lease is under the margin stops before the next call; a page invoking several predicates renews the lease mid-page when it falls under half.
- [ ] A `run` loop ticking every 5 s while holding a fresh lease writes the lease about once per half-lease, not once per tick.
- [ ] A stale holder (its lease lapsed and taken) that commits a page with deliveries, a rewind and a cursor leaves the database unchanged; its settle of a delivery is a no-op.
- [ ] An operator `resume` that sets a new stream cursor is not undone by the ticker's next renewal.
- [ ] Two `etherfold-triggers tick` commands in a row both deliver; a gracefully stopped `run` lets a new `run` tick at once.
- [ ] A per-call timeout whose margin is not under half the lease is refused at start, naming both values; `etherfold-triggers` accepts the lease duration and the timeout per app.
- [ ] The statements run on libSQL in the suite, and stay within D1's documented limits (100 bound parameters per query).
- [ ] Add the lease's mechanics to ADR-0101 only if building it changed a decision there (otherwise leave the ADR as is).
- [ ] The core README documents the lease, the fence, the release and the clock assumption.
- [ ] A changeset for each package changed (0.x: minor).
- [ ] Tests cover the new behaviour (mirror the core's existing style; a controllable clock, as the suite already injects).

## Blocked by

- `the-trigger-cli-reports-and-acts-per-app` (the same `tick` command; serialized to avoid conflicts).
- `a-trigger-database-refuses-apps-the-config-does-not-know` (the same platform start-up and config).
- Transitively, `every-outbound-call-of-the-trigger-service-times-out`, whose timeout sizes the fence margin.

## Prompt

> Goal: a per-app lease in the trigger core so two tickers of one app never work at once, with release on a finished tick and on graceful stop. Read ADR-0101 (the decision, its cost argument and the twofold fencing), ADR-0009 (at-least-once delivery and the idempotency key) and ADR-0012. Code: `packages/triggers/src` (the consumer's state row, step and commit batch; the deliverer's due scan and settles; the outbox insert; the service's `tick` and `run`) and `platforms/nodejs-triggers/src` (the `tick` command's release). The spec `work/specs/tasked/one-trigger-service-serves-several-apps.md` frames it (stories 19, 20, 22). The finding `work/notes/findings/a-database-costs-almost-nothing-on-d1-and-turso.md` gives the write allowances the lease's cost was judged against; `work/notes/findings/a-worker-cannot-hold-a-timer-across-requests.md` is why the core owns no timer.
>
> FIRST, check this task against current reality (written 2026-11-26). The app-keyed schema, the per-call timeouts, the multi-app platform and the per-app CLI must have landed; if any landed with a different shape than this task assumes, adapt, and if that changes a decision here, route to needs-attention (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> The SQL shapes above are decided; SQLite 3.35+ supports `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` (a false DO UPDATE WHERE returns no row) and `INSERT ... SELECT ... WHERE ... ON CONFLICT DO NOTHING` (the registry already uses both shapes). Verify them on libSQL in the suite.
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles. Never leave a `run` process behind after a test.

## Decisions

- **`TickReport` became a union**: `{lease: 'held', ...RoundReport} | {lease: 'not-leased'} | {lease: 'lost', reason}`, with the old fields moved to the new `RoundReport`. This is a breaking type change (blank slate, changeset minor). I chose it because a `not-leased` report with zeroed counts would be misleading. The alternative was keeping the flat report and adding a `lease` field. It touches the CLI's per-app JSON lines (`etherfold-triggers tick` now prints `"lease"`) and several existing tests.
- **A fence stop is a report, not an error.** When the fence stops a round, `tick` returns `{lease: 'lost'}`. It does not throw, does not journal `stalled`, and skips `deliverDue`. A lost lease is not a failure: another ticker is doing the work. Throwing would make `run` and the CLI treat it as a failed round, and the CLI exit 1.
- **A stale commit stops the round too.** The guarded state write and the guarded settles carry `RETURNING`. When one writes nothing under the lease, the step or `deliverDue` throws `LeaseLostError`, so the round stops instead of carrying on writing nothing. The task's "the settle is a no-op" still holds. The alternative was a silent no-op that lets the stale ticker keep making outside calls.
- **The lease is an optional `lease` on `createConsumer` and `createDeliverer`** (plus `fence` on `registry.matcher` and `{lease}` on `registry.expire`). `createTriggerService` always passes it; built without one, these pieces are unfenced. This keeps them usable on their own and keeps their existing tests intact. The consequence is that stepping `service.consumer` or `service.deliverer` outside `tick()` now needs `service.lease.acquire()` first (documented in the README). The alternative was a mandatory lease everywhere.
- **Guarded beyond the task's explicit list**: subscription expiry and the service's `stalled`/`recovered` journal rows. ADR-0101 says "every statement a tick commits or settles", and these are tick writes. The registration API, `resume` and `requeue` stay outside the lease, as the task requires.
- **`setup` refuses an old `consumers` table** that has no `lease_expires`, with a new `NO_LEASE_MESSAGE` that sits beside the existing old-layout refusal. There is no migration (conventions: blank slate). The alternative was an obscure "no such column" error at the first tick. This is a new refusal at start-up for an older database.
- **`lease_expires` is `INTEGER NOT NULL DEFAULT 0`**, so a row written by an unleased consumer can still be acquired; with NULL the `lease_expires < ?` takeover test would never pass. A takeover needs the old expiry to be strictly before now.
- **Delivery rows' `created_at` is now taken after matching**, at commit time, together with the guard. Before, it was taken before the predicates ran. This only matters when predicates take a long time.
- **The CLI's `tick` releases inside `.finally()`**, so it releases even after a failed round. If the release itself fails, that error surfaces; the lease would lapse anyway. `NodeService.tick` itself does not release, so a caller that ticks repeatedly does not pay a write per tick.
- **ADR-0101 left as is**, including its `status: accepted, not yet implemented` front matter; none of its decisions changed.
