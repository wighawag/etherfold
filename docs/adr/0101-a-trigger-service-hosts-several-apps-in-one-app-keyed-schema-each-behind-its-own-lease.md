---
status: accepted, not yet implemented
---

# A trigger service hosts several apps in one app-keyed schema, each app behind its own lease

One `etherfold-triggers` process (and one database, by default) hosts several APPS, each named by an operator-chosen slug and each carrying its own feed, chain and gate, actions, verifier and trigger definitions. Every table and every unique index of the service's schema is keyed by the app, so one shared database and one database per app are the same schema; and each app's tick runs under a lease held in that database, so two tickers of one app never work at once. We chose this because a family of small apps run by one operator (a demo of jolly-roger and the games built on it) should cost one deployment, as push-notification-server and missiv already do, and because the schema was only half keyed by consumer: two services sharing a database would cross their deliveries and subscriptions. Decided by the maintainer on 2026-11-26, from the spec `one-trigger-service-serves-several-apps`, before any trigger-service deployment held live data, so it is a clean 0.x break with no migration. It complements ADR-0005 and ADR-0100 rather than superseding them: the trigger service still runs outside the indexer-server and owns its state; what ADR-0005 calls "its own database" may now be an app-keyed slice of a database the operator shares across apps.

## Consequences

- **The app slug is the consumer name.** It is what `deliveries`, `consumers`, the journal and the match context carry (the column is named `app`, and no second column duplicates it). An app is named by a slug, not by its domain, so routes, flags and log lines read cleanly for a domain such as `localhost:5173`; the domain stays inside the app's verifier and push action, as before.
- **Every query is scoped to one app**, including the ones keyed only by recipient (the per-recipient quota, renew-all, list, cancel) and the replay record (`(app, key)`). A query that forgets the app is a cross-app leak, which is why the schema leads every index with it.
- **A shared database is the default**, an app may name its own. Per-database cost is not the reason: it is negligible on Turso and on D1 Paid (`work/notes/findings/a-database-costs-almost-nothing-on-d1-and-turso.md`). Fewer moving parts and, on D1, static bindings that need no redeploy to add an app are.
- **Routes are always `/{app}/...`**, whatever the number of apps, and the verifier checks the full path the client signed, the prefix included.
- **One loop per app**, concurrently, each round bounded in feed pages and delivery attempts, and every call the core makes (the gate, a feed read, a predicate with the state reads it makes, a delivery) bounded by a timeout that the core enforces whether or not the callee honours its signal: one app's slow or hung endpoint holds only that app.
- **The lease is in the core, not a host obligation.** Its cost is about one row written per 30 s per app (a 60 s lease renewed under half-life), negligible against any SQL host's allowance, while relying on the host (one process, one Durable Object per app, non-overlapping Cron Triggers) would turn a rolling deploy or a misconfigured scheduler into duplicate notifications. Fencing is twofold: a deadline checked before each call the core makes (renewing under half the lease, stopping under a margin of the per-call timeout plus commit and clock-skew allowances), and a lease predicate on every statement a tick commits or settles, so a stale holder changes nothing even when the deadline was wrong. The renewal writes only the lease, never the cursor, so it cannot undo an operator's `resume` or move a cursor backwards after a takeover. A finished one-shot tick and a gracefully stopped `run` release it. The registration API and the operator's CLI actions are deliberately outside it.
- **An idle round writes nothing**, the lease renewal aside: on a metered host an idle cursor rewrite every few seconds per app would cost more than the lease itself.
- **Removing an app leaves its rows** (ADR-0012), and the platform refuses a database holding an app the config neither declares for it nor lists as `retired`.

## Considered Options

- **A process (or deployment) per app**, today's shape. Rejected: N processes, ports, configs and databases for a handful of mostly idle apps, which is the cost the change exists to remove.
- **A database per app as the only layout**, with the schema left unkeyed. Rejected: it makes the shared database impossible later and leaves two services pointed at one database silently crossing data.
- **Single-ticker as a host obligation.** Rejected as above: the lease is cheap and the failure it prevents is silent.
- **Definitions uploaded as bundles**, hot-loaded. Deferred, in `work/notes/ideas/a-trigger-service-that-serves-several-apps.md`: it needs ADR-0094's one-source-of-truth split and is impossible inside a Worker isolate.
