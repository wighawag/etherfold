---
title: 'A server whose start fails before the bind closes the database it opened from a URL'
slug: a-server-whose-auto-setup-fails-closes-the-database-it-opened
blockedBy: []
covers: []
---

## What to build

Found while building `a-server-that-fails-to-bind-closes-the-database-it-opened` (#262), which closes a URL-opened database when the BIND fails. `startServer` in `@etherfold/platform-nodejs` (`platforms/nodejs/src/index.ts`) awaits `ensureFixedSchema` (the automatic schema setup) BEFORE it binds; if that throws, the call rejects with no `RunningServer`, so a database it opened from a URL is leaked the same way. Make every failure of `startServer` after it opened a database from a URL (the auto-setup, and anything else between opening and a successful bind) close that database before rejecting with the original error, reusing the close #262 introduced (`openNodeDB`) rather than adding a second path. A handle the caller passed is never closed, as today.

## Acceptance criteria

- [ ] A test makes the auto-setup throw on a `file:` URL database (in a temp dir) and asserts `startServer` rejects with that error and the client it opened is closed, observed the way `serve.test.ts` already observes it for the failed bind.
- [ ] The same auto-setup failure with a caller-passed handle leaves it open (a query on it still answers, if the failure mode allows one; otherwise assert it was not closed).
- [ ] The failed-bind tests from #262 still pass, and there is one close path, not two.
- [ ] Changesets: `@etherfold/platform-nodejs` (patch), plus any other published package whose directory you change (patch or minor, never major).
- [ ] CI: the PR's CI green as a whole.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: `startServer` leaks nothing it opened itself on any failure, and never closes what it was given. Look at `startServer`, `openNodeDB`, `ensureFixedSchema` in `platforms/nodejs/src/index.ts` and the failed-bind tests in `test/serve.test.ts` (from `a-server-that-fails-to-bind-closes-the-database-it-opened`).
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-29. Check that an auto-setup failure still rejects without closing a URL-opened database. If it already closes it, route to needs-attention saying so (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files. Tests bind only ephemeral local ports and write only to their own temp directories.
