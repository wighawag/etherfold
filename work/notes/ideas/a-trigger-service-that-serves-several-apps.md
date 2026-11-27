---
title: A trigger service that serves several apps, each registering its triggers as an uploaded bundle
type: idea
status: incubating
created: 2026-11-26
slug: a-trigger-service-that-serves-several-apps
---

# A trigger service that serves several apps

> **2026-11-26, split in two.** The multi-app half (several apps in one process, one app-keyed schema that one database or several can hold) is now the spec `work/specs/tasked/one-trigger-service-serves-several-apps.md`. What stays incubating here is the UPLOADED-BUNDLE half ("definitions arrive as a bundle" and the hot-reload dev loop), deferred for the reasons under "Why the bundle half waits" below.

## Why

The template tree (jolly-roger and the games built on it) wants push notifications driven by chain events in many apps at once: a public demo of jolly-roger with every feature, and several games (template-commit-reveal's descendants) that opt into notifications. push-notification-server and missiv already serve many apps from one deployment (a token per domain). The trigger service does not: `platforms/nodejs-triggers`'s README says "the push action pushes under one domain, so one service serves one app", and `createTriggerService` composes ONE consumer over ONE named indexer with ONE set of definitions. So every app needs its own trigger process (and its own `etherfold run` for the feed), its own database, port, config and deployment. For a handful of small apps on one operator's box that is a lot of moving parts for very little load.

## The idea

One trigger service process (and one database) hosting several APPS, each an entry keyed by its domain:

- **per app**: the domain (push action's domain, the verifier's domain), the indexer feed it follows (`etherfold` URL + indexer name, possibly on one shared `etherfold node` holding several indexers), the chain and its gate, its push token, and its trigger DEFINITIONS;
- **definitions arrive as a bundle**, the way `etherfold node` receives processors through `etherfold upload` (ADR-0094, ADR-0085): an app builds its triggers module (events, subscription kinds, rules, render functions) and uploads it; the service checks self-containment, stores the bundle, and instantiates it. ADR-0013 ("trigger conditions are data, actions are code") stays: the code is the app's render and rule functions, run by the service in the same place the config file's are today;
- **routes namespaced by app**: `/{app}/subscriptions` for registration (the verifier checks the proof against that app's domain), one outbox with the app in every row and key, one consumer loop per app (each its own cursor, gate and pause on a generation change, as now);
- **isolation**: an app's failing render or rule dead-letters its own deliveries and never stalls another app's consumer; per-app rate limits (ADR-0011's delivery-rate bound applies per app); an operator can pause, resume or remove one app.

## What it would unlock

- One deployment of three services (push, missiv, triggers) for a whole family of apps, which is what a demo site and a set of games can realistically operate.
- A dev loop like `etherfold node` + `upload`: rebuild the triggers bundle on save and upload it, without restarting the service.

## Open questions

- Trust: running uploaded code from several apps in one process. Fine for one operator's own apps (the demo case); for third parties it needs a sandbox (workers, isolates) or stays single-tenant. Start with "one operator, several of their own apps" and say so.
- Whether the shared feed should be one `etherfold node` with several indexers (it already holds one named indexer per process; the registry allows more) or one `etherfold run` per app as today.
- How a generation change in one app's fold (which PAUSES that app's consumer) is surfaced to its operator when there are many.
- Migration: today's single-app config becomes a one-entry registry, so the existing CLI and config keep working.

## Why the bundle half waits

- **ADR-0094's lesson applies.** A service whose apps can come both from its config file and from uploads needs a rule for every interaction between the two; `etherfold` settled this by giving each command one source of truth (`run` is configured, `node` receives). A bundle-receiving trigger service should be a separate mode of its own, never uploads added to the configured one.
- **Today's definitions are not bundle-shaped.** Predicates close over `stateReader({url})` and action adapters over `process.env` tokens. A bundle would export `(context) => definitions`, the service supplying the state reader and the feed, while actions and secrets stay in operator config.
- **A Worker cannot run one.** `work/notes/findings/a-worker-cannot-instantiate-a-processor-from-bytes.md`: no `import(data:)`, `blob:`, `eval` or `new Function` in-isolate, so on Cloudflare the definitions must be bundled into the deployed script (or reach a separate isolate through Dynamic Workers). Uploads would be a Node-only feature.
- **The dev loop is mostly available already.** `node --watch` on the config file restarts the process, and the cursor, outbox and subscriptions are durable, so a restart loses nothing.
- **Trust**: an upload route runs code, so it needs operator authentication, and it stays acceptable only while the uploader is the operator (ADR-0013's "user-supplied code is never executed").

## Hosting it on Cloudflare (from the spec's further notes, 2026-11-26)

- The core is already platform-neutral (Hono, viem, `remote-sql`, `fetch`; no Node API), and `TriggerService.tick()` is already one round callable by any host, so a Cloudflare host is mostly a new platform package: a `scheduled` or alarm handler calling `tick()` per app, a fetch handler mounting the registration APIs, D1 through `remote-sql`, and a config that is a function of the Worker's `env` (secrets are bindings, not `process.env`). The constraints it must respect are in the finding above: Workers Paid, 1,000 D1 queries and 10,000 subrequests per invocation (each feed page, gate read, state read and delivery is at least one), bounded rounds, and no overlapping ticks of one app, which the core's lease now enforces (a Cron Trigger suffices; a Durable Object alarm is only for sub-minute latency).
- A synchronous infinite loop in one app's render or predicate still freezes the whole process; acceptable for one operator's own apps, and the README should say so.
