---
title: '@push-notification/server 0.1.0 imports typia 7 without depending on it'
slug: push-notification-server-0-1-0-needs-typia-7
source: 'measured 2026-11-18: `npm i @push-notification/cli@0.1.0` in an empty directory (npm on Node 24), then `import("@push-notification/cli")`; and the same import from this repo''s tests under pnpm 11.25 before and after pinning typia'
---

The published `@push-notification/server` 0.1.0 (and so `@push-notification/cli` 0.1.0, which this repo's tests run in process) is compiled by typia's transformer: its `dist/esm/api/index.js` imports `typia/lib/internal/_validateReport.js.mjs`, typia 7's runtime. Its `package.json` does not list `typia` among its dependencies; the only package that names typia is `@hono/typia-validator`, as a peer with a wide range, so an install resolves the newest typia (12.2.1 on 2026-11-18), which has no `.js.mjs` files. The import then fails:

```
Cannot find module '.../node_modules/typia/lib/internal/_validateReport.js.mjs' imported from .../@push-notification/server/dist/esm/api/index.js
```

It fails the same way under npm in an empty directory, so `npx push-notification-server` (the Node.js platform's command) does not start either. push-notification-server's own repo does not see it: its workspace has `typia ^7.6.4` (locked 7.6.4) as a dev dependency.

**What this repo does about it**: `packages/triggers` lists `typia` at exactly `7.6.4` as a dev dependency (push-notification-server's own lock), which pnpm then also gives `@hono/typia-validator`'s peer and the hoisted `typia` the server's import reaches. Remove it once a fixed `@push-notification/server` is the one depended on.

**The fix belongs in push-notification-server**: `typia` (`^7.6.4`) as a runtime dependency of `@push-notification/server`, released as a patch (`@push-notification/cli` takes it through `0.1.0`'s exact dependency only with a new cli release too, since the cli pins `@push-notification/server: 0.1.0`). Until then any deployment from npm (jolly-roger's F2 dev stack among them) meets this.
