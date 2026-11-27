---
title: 'The trigger CLI reports and acts per app'
slug: the-trigger-cli-reports-and-acts-per-app
spec: one-trigger-service-serves-several-apps
blockedBy: [one-etherfold-triggers-process-serves-several-apps]
covers: [14, 15]
---

## What to build

With several apps in one process, an operator must see WHICH app is paused, stalled or dead-lettering. Give the operator commands of `etherfold-triggers` (`status`, `resume`, `deliveries`, `requeue`, `journal`, and `tick`) an `--app <name>` flag:

- With `--app`, a command reports or acts on that app only; an unknown name is refused, listing the configured apps.
- Without `--app`, the reporting commands (`status`, `deliveries`, `journal`) cover every configured app, each entry labelled with its app name; `tick` runs one round of every app and reports per app.
- `resume` without `--app` acts only when exactly one app is paused, and otherwise refuses, naming the paused apps, so an operator never resumes the wrong one by accident.
- `requeue <id>` refuses an id whose row belongs to another app than `--app` (and, without `--app`, works on any app's row and says which app it belonged to).
- `status` for a paused app says why, including a generation change (from, to), with the app's name.
- Update the platform README's "Operating it" section.

## Acceptance criteria

- [ ] `status`, `deliveries`, `journal` with `--app a` show only app a; without it they show every app, labelled by name.
- [ ] `status` of an app paused on a generation change names the app, the old and the new generation.
- [ ] `resume --app a` resumes a only; `resume` without `--app` with two paused apps refuses, naming both.
- [ ] `requeue --app a <id of a row of app b>` is refused.
- [ ] `tick --app a` runs one round of a only; `tick` runs all and reports per app.
- [ ] An unknown `--app` is refused, listing the configured apps.
- [ ] The README's operating section documents `--app`.
- [ ] A changeset for `@etherfold/platform-nodejs-triggers` (0.x: minor).
- [ ] Tests cover the new behaviour (mirror `platforms/nodejs-triggers/test/cli.test.ts`).

## Blocked by

- `one-etherfold-triggers-process-serves-several-apps` (the multi-app config and composition this builds on; same modules).

## Prompt

> Goal: `etherfold-triggers`' operator commands take `--app <name>` and label every report by app. Read ADR-0101 and the platform README's "Operating it" section. Code: `platforms/nodejs-triggers/src` (the commands module and its injected IO, which keeps every command testable). The spec `work/specs/tasked/one-trigger-service-serves-several-apps.md` frames it (stories 14, 15).
>
> FIRST, check this task against current reality (written 2026-11-26). If the multi-app task already added per-app flags, or shaped the config differently, adapt or route to needs-attention (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles.

## Decisions

- **`resume` with no app paused is refused.** Without `--app`, if no app is paused it says "no app is paused" and exits 1. This applies to single-app configs too, which used to get a silent no-op and exit 0. I chose it because the task says `resume` acts "only when exactly one app is paused, and otherwise refuses". The alternative was a no-op with exit 0 when nothing is paused. `resume --app x` on an app that is not paused stays a no-op that prints its status and exits 0. This touches only the `resume` command.
- **`requeue` when two apps hold the same id.** Apps on their own databases can each have a row with the same id. Without `--app`, `requeue` then refuses, naming the apps that hold it, and asks for `--app`. Guessing would requeue the wrong app's row, so I refused instead. It touches only `requeue`.
- **`requeue` prints a line on success.** It now writes `{"app": ..., "requeued": <id>}` to stdout, where before it printed nothing. This is how it "says which app it belonged to"; the README documents it. It touches only `requeue`.
- **New `id` filter on `listDeliveries` in the core.** The CLI needs to know which app a row belongs to. The core deliverer's `requeue` returns `false` both for "not this app's row" and for "not a dead letter", so it cannot tell them apart. I chose to add the filter rather than write raw SQL in the platform or scan a whole outbox. It touches the public API of `@etherfold/triggers`, which is why that package is in the changeset.
- **`NodeService.tick(only?: string[])`.** `tick --app` needs to run one app's round. Adding a name filter to the existing `tick` keeps one code path for reports and exit codes. The alternative was the CLI calling `app.service.tick()` and duplicating the report formatting. It touches the platform's public `NodeService` type.
- **The app name is checked before any database is opened.** A typo then never sets up a database or ticks anything. It applies to every command except `run`.
- **`status` stays JSON.** The pause reason (`{"kind": "generation-changed", "from", "to"}`) is already in the JSON line beside `app`, so I added no human-readable sentence.
