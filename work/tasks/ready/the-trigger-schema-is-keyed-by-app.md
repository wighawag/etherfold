---
title: 'The trigger service schema is keyed by app, so two apps on one database never cross'
slug: the-trigger-schema-is-keyed-by-app
spec: one-trigger-service-serves-several-apps
blockedBy: []
covers: [6, 7, 8, 16]
---

## What to build

Today the trigger service's schema is only half keyed by consumer: `consumers` and `deliveries` carry a consumer name, but `deliveries_by_key` is unique on `(action, key)`, `subscriptions` on `(kind, recipient, filter)`, the replay record carries none, the journal has no `app` column (the consumer's own rows name it in their detail, the deliverer's and registry's rows name nothing), and the deliverer's due scan reads every consumer's rows and sends them through its own actions. So two configs naming the same database (both default to `file:triggers.db`) silently drop each other's deliveries on key collisions, deliver each other's rows through the wrong push action and domain, match each other's registrants for a shared kind name, and mix their journals. Make the APP the key of everything, in the core (`@etherfold/triggers`), so two trigger services over ONE database, each with its own app name, are fully isolated.

- **The app slug is the consumer name.** Rename the `consumer` column of `deliveries`, `consumers.name`, `MatchContext.consumer` and the delivery record's `consumer` field to `app` (no duplicate column). `createTriggerService`'s `name` option becomes `app`. The reward target's body field follows the rename.
- **Every table carries `app`, every unique and lookup index leads with it**: deliveries unique on `(app, action, key)` (still partial on `status != 'retracted'`), the due index and the by-block index; subscriptions unique on `(app, kind, recipient, filter)` and its live and by-recipient indexes; `subscription_conditions` looked up by `(app, kind, arg, value)`; `accepted_requests` keyed by `(app, key)`; journal rows carry `app`.
- **Every query is scoped to the app**: the deliverer's due scan, the rewind's count and its two updates, the subscription matcher (unfiltered and filtered lookups), the `subscribe` upsert and its conflict target, the `subscription_conditions` insert-select from `subscriptions`, the per-recipient quota count, `renewAll`, `list`, `cancel`, `find`, `expire`, `acceptOnce`, and the operator reads (`deliveries`, `requeue`, journal listing) the platform calls.
- **No migration** (no live deployments, maintainer 2026-11-26): `setup` over a database in the old layout (a `consumers` table with a `name` column, or `deliveries` without `app`) refuses with an error saying the schema changed and to start from an empty database.
- The `identity.ts` comment justifying "one app per service" is rewritten: the domain is per app because each app has its own verifier and push action.
- The nodejs platform keeps working as ONE app (it passes its consumer name as `app`; its multi-app config is a later task). Update its README's reward-target body example.

## Acceptance criteria

- [ ] Two `createTriggerService` instances over ONE database, apps `a` and `b`, each following its own in-process indexer, with the SAME action name (`push`), the SAME subscription kind name and the SAME semantic rule key, each deliver exactly their own deliveries through their own adapters; no row of `a` is dropped by a key collision with `b`, and no adapter of `b` ever receives a row of `a`.
- [ ] The same recipient subscribed to the same kind and filter in `a` and `b` holds two independent subscriptions: `renew`, `renewAll`, `list`, `cancel` and the quota in `a` never see or touch `b`'s.
- [ ] A signed-request replay key accepted for `a` is not a replay for `b`.
- [ ] A rewind in `a` retracts only `a`'s pending deliveries.
- [ ] Every journal row names its app, including `paused` on a generation change.
- [ ] `setup` over an old-layout database refuses with the documented message.
- [ ] The existing core and nodejs-triggers suites pass after the rename.
- [ ] ADR-0101 is respected (it records this decision; do not remove its `accepted, not yet implemented` status line, a later task in the chain does).
- [ ] A changeset for `@etherfold/triggers` and `@etherfold/platform-nodejs-triggers` (0.x: minor, it is breaking).
- [ ] Tests cover the new behaviour (mirror the core's existing style: an in-process `@etherfold/server` folding a real processor, read over `fetch`).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: key the trigger service's whole schema and every query by an APP slug (which IS the consumer name), so two apps sharing one database are isolated. Read ADR-0101 (the decision), ADR-0005 and ADR-0100 (the service's boundary), ADR-0012 (never a quiet DELETE), ADR-0013 (the data/code split and the inverted index). The code is `packages/triggers/src`: the schema module, the consumer (state row, step, rewind), the outbox insert, the deliverer (due scan, settles, requeue), the trigger registry (subscribe, quota, renew, list, cancel, find, expire, acceptOnce, matcher), the journal helper and the service composition; `platforms/nodejs-triggers/src` passes the name. The spec `work/specs/tasked/one-trigger-service-serves-several-apps.md` frames it (stories 6, 7, 8, 16).
>
> FIRST, check this task against current reality (written 2026-11-26 at `@etherfold/triggers@0.2.0`). If the schema is already app-keyed, or a task already renamed the consumer column, route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> Keep the core free of anything about HOSTING several apps (that is the platform's, in a later task): the core gains the app key only. Statements must stay valid on SQLite, libSQL and D1 through `remote-sql` (D1 caps bound parameters per query at 100: `work/notes/findings/d1-caps-bound-parameters-per-query-at-100.md`).
>
> The hazard was first written down as an observation, discharged at tasking: this task carries the keying and `a-trigger-database-refuses-apps-the-config-does-not-know` carries the guard.
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles.
