---
title: A trigger service that serves several apps, each registering its triggers as an uploaded bundle
type: idea
status: incubating
created: 2026-11-26
slug: a-trigger-service-that-serves-several-apps
---

# A trigger service that serves several apps

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
