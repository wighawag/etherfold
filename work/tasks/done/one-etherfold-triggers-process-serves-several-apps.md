---
title: 'One etherfold-triggers process serves several apps from one config'
slug: one-etherfold-triggers-process-serves-several-apps
spec: one-trigger-service-serves-several-apps
blockedBy: [every-outbound-call-of-the-trigger-service-times-out]
covers: [1, 2, 3, 4, 5, 9, 10, 11, 12, 13]
---

## What to build

With the schema keyed by app (`the-trigger-schema-is-keyed-by-app`), make the nodejs platform (`etherfold-triggers run` and `tick`) host several apps in one process. (The start-up guard against a database holding apps the config does not know, and `retired`, are the next task, `a-trigger-database-refuses-apps-the-config-does-not-know`.)

- **Config shape, always**: the config module's default export is `{database?, api?, intervalMs?, apps: {[name]: <per-app config>}}`. The per-app config is today's config minus the process-level fields and minus `name` (the key of `apps` is the app's name, a URL-safe slug, validated). A per-app `database` overrides the top-level one; the top-level default is `file:triggers.db`. Today's flat one-app shape is removed (no live deployments): a flat config is refused with a message showing the `apps` shape. Everything ADR-0013 calls operator code (rules, renders, predicates, action adapters) and the verifier stay per app. `defineConfig` types the new shape.
- **Composition**: one core `createTriggerService` per app over its database (apps naming the same database URL share one connection). The core gains nothing about several apps.
- **Rounds**: `run` runs each app's own loop (the core's `run`) concurrently in the one process, so one app's slow or failing round never delays another's; each app's round is bounded: a maximum number of feed pages per round (a new core option on `catchUp`/`tick`; a round that reaches it returns normally, reporting that more pages remain, and is not journalled as a stall; the existing 10 000-page guard that throws stays only for an unbounded call) and a maximum number of delivery attempts per round (the deliverer's existing batch size, exposed). `tick` runs one round of every app (or of one, see the CLI task) and reports per app.
- **Routing**: one HTTP server; app `x`'s registration API is mounted at `/x/...` always, whatever the number of apps. The verifier checks the full path the client signed, prefix included (Hono's `c.req.path` is the full mounted path; prove it with a test). CORS answers app `x`'s origin on `/x/...` only. An app without a verifier serves no routes.
- **README**: rewrite `platforms/nodejs-triggers/README.md` around the `apps` shape (its "one service serves one app" goes), with a two-app example, the `/{app}/` routes, the shared-database default, and the note that a synchronous infinite loop in one app's code still freezes the whole process (one operator's own apps only).

## Acceptance criteria

- [ ] A config with two apps (different indexers, chains or gates, actions and verifiers) over one shared database runs both under one `run`: each app's subscriptions register at `/{app}/subscriptions` and its deliveries reach only its own adapters.
- [ ] An app with its own `database` keeps its rows there and none in the shared one.
- [ ] A one-app config (`apps` of one) serves `/{name}/subscriptions`, and the existing registration and CORS behaviour holds under that prefix; a flat old-shape config is refused with the documented message.
- [ ] A proof for app A's domain is refused on `/b/subscriptions`; a request signed for `/a/subscriptions` succeeds there and is refused if replayed; a request signed for the unprefixed path is refused on `/a/subscriptions`; CORS answers only app a's origin on `/a/...`.
- [ ] One app whose predicate always throws, or whose feed never answers, stalls (journalled under its name) while the other app's deliveries proceed in the same period.
- [ ] An app with more due deliveries than its per-round bound leaves the rest for its next round, and its feed pages per round are bounded likewise.
- [ ] Until the per-app CLI lands, `resume` and `requeue` refuse when more than one app is configured, naming the apps.
- [ ] An app name that is not a URL-safe slug is refused.
- [ ] The platform README is rewritten as described.
- [ ] A changeset for each package changed (0.x: minor).
- [ ] Tests cover the new behaviour (mirror `platforms/nodejs-triggers/test` and the core's in-process server style).

## Blocked by

- `every-outbound-call-of-the-trigger-service-times-out` (the hung-feed isolation criterion relies on the timeout, and both edit the core service module).

## Prompt

> Goal: one `etherfold-triggers` process hosts several apps from one config, each with its own loop and routes under `/{app}/`. Read ADR-0101 (the decision and its consequences), ADR-0005 and ADR-0100 (the boundary: nothing in the indexer packages changes), ADR-0012 and ADR-0013. Code: `platforms/nodejs-triggers/src` (config, service, CLI, commands) and the core's service composition in `packages/triggers/src`. The spec `work/specs/tasked/one-trigger-service-serves-several-apps.md` frames it (stories 1 to 5, 9 to 13). The finding `work/notes/findings/a-database-costs-almost-nothing-on-d1-and-turso.md` is why the shared database is the default for layout reasons, not price.
>
> FIRST, check this task against current reality (written 2026-11-26). The app-keyed schema and the per-call timeouts must have landed; if they landed with a different interface than this task assumes (the `app` option, the timeout option), adapt, and if the difference changes a decision here, route to needs-attention (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> The CLI's `--app` flag and per-app reporting are the NEXT task (`the-trigger-cli-reports-and-acts-per-app`); here `status`, `deliveries` and `journal` may simply cover every app, but `resume` and `requeue` must refuse when more than one app is configured (resuming every paused app at once is the hazard that task guards against). The lease is a later task too; do not build it here.
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles. Never leave a server or `run` process behind after a test.

## Decisions

- **Default round bounds of 100 pages and 100 deliveries, set in the core.** These are new service options, `maxPagesPerRound` and `maxDeliveriesPerRound`. The delivery bound reuses the deliverer's existing batch size of 100, and the platform passes both through per app. I bounded rounds by default because ADR-0101 says each round is bounded; the alternative was leaving `tick` unbounded unless configured. A bare `consumer.catchUp()` stays unbounded with its throwing guard. This touches `TickReport` (new `hasMore` field) and `CatchUpReport`.
- **`run` skips the wait after a round that stopped at its page bound.** Otherwise a long catch-up would be slowed to 100 pages per interval. It only triggers on `hasMore` from the feed; a delivery backlog still drains at one batch per interval. Alternative: always wait `intervalMs`. Touches the core `run`.
- **Fixed a listener leak in the core `run`.** Each wait used to add an abort listener that was never removed, and with rounds that no longer wait those would pile up quickly. The listener is now removed when the timer fires. It sits inside the loop I was already changing.
- **App-name rule:** `^[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 64 characters, exported as `APP_NAME`. Underscores, dots and upper case are refused so the name reads the same in a route, a future `--app` flag and a log line. A looser rule allowing `_` was the alternative. This is user-visible and the next CLI task's `--app` will inherit it.
- **More config refusals:** an empty `apps`, a `name` inside an app, and any old per-app field (`chainId`, `etherfold`, `gate`, `triggers`, `actions`, `verifier`, `lane`) at the top level are all refused. That catches half-migrated configs loudly. `loadConfig` and `createNodeService` both validate, so a config built in code is checked too. `callTimeoutMs` stays per app, as today.
- **`createNodeService` returns `{apps, api, tick, run, close}` instead of `{service, db, close}`.** The `options.db` injection is gone and `openDatabase` now takes a URL. The return shape had to change once there are several services and databases, and nothing outside these two packages uses it.
- **CLI `tick` output and exit code:** one JSON line per app, either `{app, ...TickReport}` or `{app, error, code?}`, and the exit code is 1 if any app's round failed. Previously a failure threw. This lets one app's failure be reported beside the others' rounds. The per-app CLI task may refine it.
- **Wording of the `resume`/`requeue` refusal:** "resume acts on one app, and this config declares several apps (a, b): run it with a config of that app alone". `requeue` refuses even though delivery ids are unique per database, because the rule is "one app only" until `--app` lands. That later task should replace the message.
- **New dependencies:** `hono` on the platform to mount sub-apps without rewriting paths, since the verifier must see the full path. `delegated-identity` as a dev dependency so the prefix proof is tested with the real verifier. The alternative was a hand-written router, but that would rewrite the path the verifier checks.
