---
title: 'A server that fails to bind closes the database it opened from a URL'
slug: a-server-that-fails-to-bind-closes-the-database-it-opened
blockedBy: []
covers: []
---

## What to build

Found in the Decisions of `query-layer-drive-small-fixes` (#257). `startServer` in `@etherfold/platform-nodejs` (`platforms/nodejs/src/index.ts`) now waits for `listening` and REJECTS on a bind `error` (for example `EADDRINUSE`). When it was given a libSQL URL (`options.db` a string, `env.DB`, or the `file:./etherfold.db` default), it opened that database itself with `createNodeDB`; on a failed bind the rejection hands the caller no `RunningServer`, so nobody holds the `db` and the connection it opened is never closed. A handle the server was GIVEN stays the caller's to close (the documented rule on `StartOptions.db` and `RunningServer.close`), so it must not be closed.

On a failed bind, close the database only when `startServer` opened it from a URL, then reject with the bind error (if closing also fails, the bind error is still the one reported). Nothing else about `startServer` changes.

## Acceptance criteria

- [ ] A test binds a second `startServer` on a port the first holds, with a `file:` URL to a temp database, and asserts it rejects with the bind error and that the database it opened was closed (for example by observing the `RemoteSQL` handle's close, or that the temp file is no longer held open, whichever the adapter makes observable without a new public API; state which in `## Decisions`).
- [ ] The same failure with a handle the caller passed leaves that handle open and usable (a query on it still answers).
- [ ] Changesets: `@etherfold/platform-nodejs` (patch), plus any other published package whose directory you change (patch or minor, never major).
- [ ] CI: the PR's CI green as a whole.

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a failed bind leaks nothing the server opened itself, and never closes what it was given. Look at `startServer`, `createNodeDB`, `StartOptions.db` and `RunningServer` in `platforms/nodejs/src/index.ts`, its `test/serve.test.ts` (the `EADDRINUSE` case added by `query-layer-drive-small-fixes`), and `RemoteLibSQL`.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-29. Check that a failed bind still rejects without closing a URL-opened database. If it already closes it, route to needs-attention saying so (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files. Tests bind only ephemeral local ports and write only to their own temp directories.

## Decisions

- **How the close is observed:** the test replaces `@libsql/client`'s `createClient` (with `vi.mock`) to record every client created, then reads each client's own `closed` flag. `RemoteLibSQL` has no `close` or `closed`, and a failed start hands back no handle, so the client underneath is the only thing the adapter makes observable without a new public API. I did not choose "the temp file is no longer held open" because it would mean scanning `/proc/self/fd`, which only works on Linux and is fragile. This touches only this test file.
- **Private `openNodeDB` helper instead of changing `createNodeDB`:** `createNodeDB` is exported and shared with the CLI and tests, so its `RemoteSQL` return type stays as it is. The alternatives were widening its return type, or having `startServer` call `createClient` inline and so no longer share the factory. Nothing outside `startServer` is affected.
- **A failed close is logged, not thrown:** it goes to the package's existing `logger.error` so the bind error stays the reported rejection, as the task requires. The alternative was swallowing it silently. No user-visible default changes.
- **Scope kept to the bind:** a failure in the automatic schema setup before the bind leaks the same way, but the task says nothing else about `startServer` changes. I left it alone and recorded it in the observation note above.
