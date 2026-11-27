---
title: 'One trigger service serves several apps'
slug: one-trigger-service-serves-several-apps
humanOnly: true
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked; they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

## Problem Statement

An operator running several apps that want chain-driven notifications (a public demo of jolly-roger, several games built on template-commit-reveal) must run one `etherfold-triggers` process per app today: `createTriggerService` composes ONE consumer over ONE named indexer with ONE set of definitions, the verifier accepts ONE domain, and the push action pushes under ONE domain. Each app then costs its own process, port, config, database and deployment, while push-notification-server and missiv already serve many apps from one deployment. On top of that, two configs that name the same database (both default to `file:triggers.db`) silently cross their deliveries and subscriptions (`work/notes/observations/two-trigger-services-on-one-database-cross-their-deliveries.md`).

## Solution

One `etherfold-triggers` process hosts several APPS, each declared in the one config file under a short app name, each with today's per-app settings (domain, feed, chain and gate, actions with their tokens, verifier, trigger definitions). Every app's state lives in tables keyed by the app, so all apps can share ONE database (the default) or an app can be given its own, with the same schema either way. Each app runs its own consumer, cursor, gate, outbox and registration API, under `/{app}/...`; a failure in one app holds only that app. No deployment of the trigger service holds live data (maintainer, 2026-11-26), so this is a clean 0.x break: one config shape, one route layout, no migration.

## User Stories

1. As an operator, I want to declare several apps in one config file, so that one process and one deployment serve my demo and my games.
2. As an operator, I want each app named by a short slug of my choosing (not its domain), so that routes, CLI flags and log lines read cleanly even for a domain like `localhost:5173`.
3. As an operator, I want every app to carry its own domain, feed (`etherfold` URL and indexer), chain and gate, actions and tokens, verifier and trigger definitions, so that apps on different chains, indexers and push domains coexist.
4. As an operator, I want all apps to share one database by default, so that a remote SQL host (Turso, D1) holds one database for the whole family.
5. As an operator, I want to give one app its own database when I choose, so that a noisy or sensitive app can be separated without a different schema.
6. As an operator, I want the schema to be identical whether apps share a database or not, so that moving an app between the two layouts is copying its rows, never a redesign.
7. As an operator, I want two apps that both name an action `push`, a subscription kind `new-greeting` or a rule key `third-greeting:<account>` never to collide, so that app names alone isolate them.
8. As an operator, I want each app's deliveries sent only through that app's own action adapters, so that no app is ever pushed under another app's domain or token.
9. As an app developer, I want my app's registration API at `/{app}/subscriptions` (and `/renew`, `/cancel`, `/list`) on the shared service, with the verifier checking my proof against MY domain and the path I signed including the prefix, so that one service origin serves every app's clients.
10. As an app developer, I want CORS answered for my app's origin on my app's routes only, so that one app's pages cannot call another app's registration API from the browser.
11. As an operator with a single app, I want the same config shape and the same `/{app}/...` routes as a multi-app operator (an `apps` map of one), so that there is one way to configure and call the service and adding a second app changes nothing for the first.
12. As an operator, I want one app's failing render, rule or predicate, or its unreachable feed, to hold only that app's consumer and never another app's, so that one broken game does not silence the demo.
13. As an operator, I want each app's delivery attempts bounded per round, so that one app with a large backlog cannot starve the others' deliveries.
14. As an operator, I want `status`, `resume`, `deliveries`, `requeue` and `journal` to take `--app <name>`, and with no `--app` to report every app with its name, so that I see which app is paused or stalled.
15. As an operator, I want a generation change that pauses one app's consumer to say which app in `status` and in the journal, so that with many apps I know which one waits for my `resume`.
16. As an operator, I want every journal row to name its app, so that one app's rewinds, stalls and dead letters can be read on their own.
17. As an operator, I want to remove an app by deleting it from the config, with its rows left in the database (ADR-0012: never a quiet DELETE), so that removing an app is reversible.
18. As an operator, I want the service to refuse to start when two apps name the same app slug, or when a database already belongs to a consumer the config does not declare, so that a misconfiguration fails loudly instead of crossing data.
19. As an operator who may later host this on Cloudflare, I want the core to keep running one bounded round per app without owning a timer, so that a Worker or a Durable Object alarm can drive the same core.
20. As an operator, I want two tickers of the same app (two processes on one database, overlapping Cron Triggers) never to work at once, enforced by the service itself, so that a host misconfiguration cannot send every notification twice.
21. As an operator on a metered SQL host, I want an idle round (nothing new on the feed, nothing due) to write nothing, so that several mostly idle apps ticking every few seconds do not spend my write allowance.

## Implementation Decisions

- **An app is the unit**, named by an operator-chosen slug (URL-safe), not by its domain. The domain stays a field of the app, used by the verifier and the push action as today.
- **Config shape**: the config file's default export is `{database?, api?, intervalMs?, apps: {[name]: <per-app config>}}`, always; today's flat one-app shape is removed (no live deployments). The per-app config is today's config minus the process-level fields. A per-app `database` overrides the top-level one. Top-level settings (database, API port and host, interval) are the process's; everything ADR-0013 calls operator code (rules, renders, predicates, action adapters) stays per app.
- **Schema keyed by app**: every table carries an `app` column, and every unique index and lookup index leads with it: deliveries unique on `(app, action, key)`, subscriptions unique on `(app, kind, recipient, filter)`, subscription conditions looked up by `(app, kind, arg, value)`, the journal and accepted requests carrying `app`. The `consumers` row is per app. The due-deliveries scan is per app, so each app's deliverer only ever sees its own rows. This is the decision that makes a shared database and a database per app the same schema.
- **Composition**: one `createTriggerService` per app over the shared (or its own) database, given its app name; the platform composes N of them. The core gains the app key and nothing about hosting several apps; the multi-app loop and routing are the platform's.
- **Rounds**: the process ticks each app in turn every interval, each tick isolated (a thrown error is reported for that app and the next app ticks). Each app's tick is bounded: a maximum number of feed pages and a maximum number of delivery attempts per round, so one app cannot hold the round.
- **Routing**: one HTTP server; app `x`'s registration API is always mounted at `/x/...`, whatever the number of apps, and the verifier checks the FULL path the client signed (the prefix included).
- **No migration**: the schema change is a breaking 0.x release; an existing database is not upgraded, and `setup` over a database in the old layout refuses with a message saying to start from an empty one.
- **A per-app lease, in the core.** Each app's tick starts by taking or renewing a lease on its `consumers` row with one conditional `UPDATE ... RETURNING` (owner and expiry columns) that replaces the tick's existing state read, so it adds one row written and no round trip. A tick that does not get the lease does nothing and reports so. The lease lasts 60 s by default and is renewed only when less than half remains, so its cost is about one write per 30 s per app (about 86k writes a month per app, under 2% of D1 Paid's included writes for 10 apps; see the finding below). The tick fences itself against its own lease: before each feed page and each delivery attempt it checks the lease deadline (a clock read, no query) and stops when too little remains, so a tick never acts after its lease could have passed to another ticker. A killed ticker lets the lease lapse and the next one takes over within the lease duration. Delivery stays at-least-once (adapters must honour the idempotency key, as now); the lease removes the systematic double delivery of two concurrent tickers, not the rare retry after a crash.
- **An idle round writes nothing.** Today every advanced step rewrites the `consumers` row even when the page was empty, about 518k writes a month per app at the 5 s default interval. The state write happens only when the cursor, stream, generation or pause changed (or a delivery was inserted in the same batch); the lease renewal is the only write an idle app makes.
- **Guard**: `setup` refuses a database whose `consumers` table names a consumer for which the config declares no app, naming it, unless the operator says otherwise. With the app-keyed schema it is what catches a database shared with a config that does not know it.
- **Cost basis**: per-database cost is negligible on Turso and on D1 Paid (`work/notes/findings/a-database-costs-almost-nothing-on-d1-and-turso.md`); the shared default is chosen for fewer moving parts and static-binding simplicity on D1, not for price.
- **ADR**: this amends the README's "one service serves one app" and makes "a trigger service hosts several apps, keyed in one schema" a recorded decision; it complements ADR-0005 (each consumer owns its state, now as an app-keyed slice rather than necessarily a whole database) and ADR-0100.

## Testing Decisions

- External behaviour through the core's existing seam (an in-process `@etherfold/server` folding a real processor, read over `fetch`, as the current tests do): two apps over one database, each following its own indexer, with colliding action names, kind names and rule keys, each receiving exactly its own deliveries through its own adapters.
- Isolation: one app whose predicate always throws stalls (journalled under its name) while the other app's deliveries proceed in the same rounds.
- Registration: a proof for app A's domain is refused on `/b/subscriptions`; a request signed for `/a/subscriptions` succeeds there and is refused if replayed; CORS answers only the app's own origin.
- Single app: an `apps` map of one serves `/{name}/subscriptions` and the existing behaviour suite passes once moved to that layout.
- Lease: two services over one database for the same app, ticked concurrently, deliver each due row once; the second tick reports it did not hold the lease; after the holder stops renewing, the other takes over once the lease lapses; a tick whose lease deadline is near stops before the next delivery attempt.
- Idle writes: an idle tick on an app holding a fresh lease issues no write (counted at the `remote-sql` seam).
- Guard: a database written by consumer `a` is refused by a config that declares only `b`.
- Bounded rounds: an app with more due deliveries than its per-round bound leaves the rest for the next round, and the other app is still attempted in the same round.

## Out of Scope

- **Uploaded trigger bundles** (definitions arriving like `etherfold upload`, hot-loaded without a restart). Deferred and kept in `work/notes/ideas/a-trigger-service-that-serves-several-apps.md`: it needs ADR-0094's one-source-of-truth split, a `(context) => definitions` interface so bundles carry no secrets or URLs, and it is impossible inside a Worker isolate (`work/notes/findings/a-worker-cannot-instantiate-a-processor-from-bytes.md`).
- **A Cloudflare platform for the trigger service** (a `platforms/cf-worker-triggers` on D1, driven by a Durable Object alarm per app). Its own spec; this one only keeps the core drivable that way (story 19).
- **Third-party tenants**: every app here belongs to the one operator who runs the service; running mutually untrusted apps' code in one process needs a sandbox and is not attempted.
- **The feed side**: whether the apps' indexers live on one multi-indexer `etherfold node` or on one `etherfold run` each (`work/notes/ideas/the-combined-run-holds-several-named-indexers.md`). Each app names its feed URL and indexer, whatever serves them.
- **Per-app rate limits of ADR-0011 (digests, the delivery-rate bound)**: still unbuilt (`what-the-first-build-left-out.md`); when built they are per app by construction.

## Further Notes

- The core is already platform-neutral (Hono, viem, `remote-sql`, `fetch`; no Node API), and `TriggerService.tick()` is already one round callable by any host, so a Cloudflare host is mostly a new platform package: a `scheduled` or alarm handler calling `tick()` per app, a fetch handler mounting the registration APIs, D1 through `remote-sql`, and a config that is a function of the Worker's `env` (secrets are bindings, not `process.env`). The constraints it must respect are in the finding above: Workers Paid, 1,000 D1 queries and 10,000 subrequests per invocation (each feed page, gate read, state read and delivery is at least one), bounded rounds, and no overlapping ticks of one app, which the core's lease now enforces (a Durable Object per app is still the natural driver, since it avoids losing ticks to the lease).
- A synchronous infinite loop in one app's render or predicate still freezes the whole process; acceptable for one operator's own apps, and the README should say so.
