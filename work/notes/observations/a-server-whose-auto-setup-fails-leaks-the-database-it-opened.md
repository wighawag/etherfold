# A server whose auto-setup fails leaks the database it opened

2026-09-29. In `platforms/nodejs/src/index.ts`, `startServer` awaits `ensureFixedSchema` before binding; if that throws, the call rejects with no `RunningServer`, so a database it opened from a URL is never closed. The same shape as the failed-bind leak fixed by `a-server-that-fails-to-bind-closes-the-database-it-opened`, which was scoped to the bind only.
