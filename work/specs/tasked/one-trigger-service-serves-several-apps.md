---
title: 'One trigger service serves several apps'
slug: one-trigger-service-serves-several-apps
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked; they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

## Problem Statement

An operator running several apps that want chain-driven notifications (a public demo of jolly-roger, several games built on template-commit-reveal) must run one `etherfold-triggers` process per app today: `createTriggerService` composes ONE consumer over ONE named indexer with ONE set of definitions, the verifier accepts ONE domain, and the push action pushes under ONE domain. Each app then costs its own process, port, config, database and deployment, while push-notification-server and missiv already serve many apps from one deployment. On top of that, two configs that name the same database (both default to `file:triggers.db`) silently cross their deliveries and subscriptions (an observation, since carried by the task `the-trigger-schema-is-keyed-by-app`).

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
18. As an operator, I want the service to refuse to start when two apps name the same app slug, or when a database already belongs to a consumer the config does not declare, so that a misconfiguration fails loudly instead of crossing data; and I want to name the apps I have retired from a database, so that removing an app or moving it to its own database does not make every later start refuse.
19. As an operator who may later host this on Cloudflare, I want the core to keep running one bounded round per app without owning a timer, so that a Worker or a Durable Object alarm can drive the same core.
20. As an operator, I want two tickers of the same app (two processes on one database, overlapping Cron Triggers) never to work at once, enforced by the service itself, so that a host misconfiguration cannot send every notification twice.
21. As an operator on a metered SQL host, I want an idle round (nothing new on the feed, nothing due) to write nothing, so that several mostly idle apps ticking every few seconds do not spend my write allowance.
22. As an operator driving the service from a scheduler (`etherfold-triggers tick` from cron, or a restart of `run`), I want a finished or stopped ticker to release its lease, so that the next tick or the restarted process works at once instead of waiting out the lease.
23. As an operator, I want every call the service makes to the outside (the feed, the gate, a state read, a delivery) to time out, so that a hung endpoint of one app neither holds that app for ever nor stalls another app.

Implementation and testing detail moved to the tasks of this spec (`work/tasks/*/the-trigger-schema-is-keyed-by-app.md` and the six that follow it in `blockedBy` order) and the rationale to ADR-0101.

## Out of Scope

- **Uploaded trigger bundles** (definitions arriving like `etherfold upload`, hot-loaded without a restart). Deferred and kept in `work/notes/ideas/a-trigger-service-that-serves-several-apps.md`: it needs ADR-0094's one-source-of-truth split, a `(context) => definitions` interface so bundles carry no secrets or URLs, and it is impossible inside a Worker isolate (`work/notes/findings/a-worker-cannot-instantiate-a-processor-from-bytes.md`).
- **A Cloudflare platform for the trigger service** (a `platforms/cf-worker-triggers` on D1, driven by a Cron Trigger, or a Durable Object alarm where sub-minute latency matters). Its own spec; this one only keeps the core drivable that way (story 19).
- **Third-party tenants**: every app here belongs to the one operator who runs the service; running mutually untrusted apps' code in one process needs a sandbox and is not attempted.
- **The feed side**: whether the apps' indexers live on one multi-indexer `etherfold node` or on one `etherfold run` each (`work/notes/ideas/the-combined-run-holds-several-named-indexers.md`). Each app names its feed URL and indexer, whatever serves them.
- **Per-app rate limits of ADR-0011 (digests, the delivery-rate bound)**: still unbuilt (`what-the-first-build-left-out.md`); when built they are per app by construction.
