---
title: 'A trigger database refuses apps the config does not know, unless they are retired'
slug: a-trigger-database-refuses-apps-the-config-does-not-know
spec: one-trigger-service-serves-several-apps
blockedBy: [one-etherfold-triggers-process-serves-several-apps]
covers: [17, 18]
---

## What to build

With several apps in one config and an app-keyed schema, a database can hold rows of an app the config does not declare for it: a config pointed at the wrong database, or another operator's service sharing it. Make `etherfold-triggers` refuse to start then, and give the operator a way to say an app is retired:

- **Guard, in the platform** (the core knows nothing about several apps): at start, for each database the config opens, read its `consumers` rows and refuse when one names an app that the config neither declares for THAT database nor lists in a new top-level `retired: string[]`, naming the app and the database.
- **`retired`** is how an operator removes an app (deletes it from `apps`) or moves one to its own database: the old rows stay (ADR-0012: never a quiet DELETE), and the guard lets them be. An app both declared and listed in `retired` is refused as a contradiction.
- Document `retired` and the guard in the platform README.

## Acceptance criteria

- [ ] A database holding rows of app `a` is refused by a config declaring only `b` for it, with a message naming `a` and the database.
- [ ] Listing `a` in `retired` lets the same config start, and `a`'s rows are untouched.
- [ ] Removing an app from `apps` (and adding it to `retired`) leaves all its rows in the database.
- [ ] Moving app `a` from the shared database to its own: the shared database still holding `a`'s old rows is accepted once `a` is in `retired`, and `a` runs on its own database.
- [ ] An app both in `apps` and in `retired` is refused.
- [ ] The platform README documents `retired` and the guard.
- [ ] A changeset for `@etherfold/platform-nodejs-triggers` (0.x: minor).
- [ ] Tests cover the new behaviour (mirror `platforms/nodejs-triggers/test`).

## Blocked by

- `one-etherfold-triggers-process-serves-several-apps` (the `apps` config and the per-app databases this checks).

## Prompt

> Goal: `etherfold-triggers` refuses a database holding an app its config does not declare for it, unless that app is listed in `retired`. Read ADR-0101 (its last consequence), ADR-0012 (rows are never quietly deleted), and the platform README. Code: `platforms/nodejs-triggers/src` (config loading and the start-up that opens each database and composes the services). The spec `work/specs/tasked/one-trigger-service-serves-several-apps.md` frames it (stories 17, 18). This closes the hazard first recorded as an observation (two services on one database crossing data), whose keying half the task `the-trigger-schema-is-keyed-by-app` carries.
>
> FIRST, check this task against current reality (written 2026-11-26). If the multi-app config landed with a different shape (where databases are named, how apps are keyed), adapt, and if that changes a decision here, route to needs-attention (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> This task may run in parallel with `the-trigger-cli-reports-and-acts-per-app` (it touches start-up and config, not the operator commands). Both edit the platform README (different sections) and may touch config loading, so expect a small merge to rebase; keep the edits to the README's configuration section and to the start-up path.
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles.
