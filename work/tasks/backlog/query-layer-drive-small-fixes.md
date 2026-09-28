---
title: 'Small fixes from the query-layer drive: a parent''s children are typed on the query surface, every import guard sees a multi-line import, `startServer` reports the port it bound'
slug: query-layer-drive-small-fixes
blockedBy: []
covers: []
needsAnswers: true
---

## What to build

Three independent fixes, batched because they touch disjoint files and share one gate (vitest plus `typecheck`). Each is its own commit-sized change; none depends on another.

1. **The SQLite query surface types a parent's children, and cannot lose them to its own names.** `createQuerySurface` (`@etherfold/state-store-sqlite`, `query-surface.ts`) spreads `createReadSurface`'s per-entity reads, so a declared relation's collection (for example `surface.placement.players`) is there at run time, but `EntityQueries<E>` is `EntityReads & {queryCurrent, queryAsOf}` and omits `CollectionsOf` (`@etherfold/state-store`, `read-surface.ts`), so a consumer needs a cast to reach it. Add the relation collections to the type, the way `createReadSurface`'s own type carries them. Also `READ_SURFACE_NAMES` (`@etherfold/state-store`, `entities.ts`) reserves only `getCurrent`, `getAsOf`, `listCurrent`, `listAsOf`, so a child declaring `as: 'queryCurrent'` or `as: 'queryAsOf'` is accepted and its collection is silently overwritten by the query tier on that surface. Add both names, so the declaration is refused at declaration time on every backend identically (ADR-0098: an `as` must not collide with "a name the generated read surface already uses").
2. **Every import guard sees a multi-line import.** Several packages carry a test that scans their sources for forbidden imports, and two match with `/^\s*import\s+(?:type\s+)?.*?from\s+'([^']+)'/gm`, whose `.` does not cross a newline, so an import whose braces span several lines (the house style for more than a few names) is never checked: `packages/state-store-sqlite/test/no-platform-leakage.test.ts` and `packages/state-store-patch/test/stays-light.test.ts`. `packages/state-store-indexeddb/test/stays-a-primitive.test.ts` was widened to `[^;]*?` already, and `packages/graphql/test/runtime-neutral.test.ts` also catches `export ... from`. Search every package's, platform's and example's tests for any other copy (by the shape of the regex, not only these names) and bring every copy to one form that crosses newlines and also catches `export ... from` re-exports.
3. **`startServer` reports the port it actually bound.** `platforms/nodejs/src/index.ts` reads `server.address()` straight after `serve(...)`; with a `hostname` (for example `127.0.0.1`) Node binds asynchronously, so `address()` is still `null` and the returned `url` and `port` say `:0`. Wait for the server's `listening` event before reading the address (whether or not a hostname is given), so `etherfold serve --host 127.0.0.1 --port 0` prints a usable URL.

## Acceptance criteria

- [ ] Type-level tests (`expectTypeOf` or `// @ts-expect-error`, as the repo already uses): on a `createQuerySurface` over a parent and a child with `parent: {entity, as: 'players'}`, `surface.<parent>.players` is typed as the collection read with no cast, and a name that is not a declared relation is a type error; `pnpm typecheck` covers the test file.
- [ ] A declaration whose `as` is `queryCurrent` or `queryAsOf` is refused by `normalizeEntities` with the existing read-surface-name message, asserted in `@etherfold/state-store`'s tests and in the conformance group `a declared relation is checked against the ids` if that is where the other reserved names are asserted.
- [ ] Every import-guard copy uses the one multi-line form, and each guarded package has a case proving that a multi-line forbidden import (braces over several lines) and a multi-line forbidden `export ... from` are caught, by running the guard's matcher over a fixture string rather than planting a forbidden import in the package's sources.
- [ ] A test starts the server with `hostname: '127.0.0.1'` and `port: 0` and asserts the returned `port` is non-zero and `url` answers an HTTP request; and one CLI-level assertion that `etherfold serve --host 127.0.0.1 --port 0` reports a non-zero port.
- [ ] Changesets (patch or minor, never major): `@etherfold/state-store` (minor, a newly refused declaration), `@etherfold/state-store-sqlite`, `@etherfold/platform-nodejs`, and every other published package whose directory changes, tests included (`@etherfold/state-store-patch`, and `@etherfold/state-store-indexeddb` or `@etherfold/graphql` if their guards are touched), since `changeset status --since=main` counts a test-only change.
- [ ] CI: dorfl's `verify` gate runs vitest only, so the PR's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs green are part of done (`@etherfold/state-store`'s declaration check runs in every tab and worker).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: three small, independent fixes found while building the query layer (ADR-0098, ADR-0099). Look at `createQuerySurface` and `EntityQueries` in `@etherfold/state-store-sqlite`, `CollectionsOf` and `createReadSurface` in `@etherfold/state-store` (`read-surface.ts`), `READ_SURFACE_NAMES` and the relation checks in `entities.ts`, the import-guard tests named above, and `startServer` in `@etherfold/platform-nodejs` with its `serve.test.ts`, plus the CLI's `serve` command. `the-read-surface-offers-a-parents-children` and `a-declaration-names-a-childs-parent` (both done) are where the relation and its collection came from.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-28. For each of the three, check the defect is still there as described. If one was already fixed, drop that part and say so in `## Decisions`; if the code moved so the fix no longer fits, route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified `*.bundle.js` files. Tests bind only ephemeral local ports and write only to their own temp directories.
>
> CI: dorfl's gate runs vitest only. The real-browser suites run in CI's `browser (chromium)`, `browser (firefox)` and `browser (webkit)` jobs; the PR is done only when those three are green too.

## Requeue 2026-09-28

The acceptance gate failed on a real collision, not a flake. Adding `queryCurrent` and `queryAsOf` to `READ_SURFACE_NAMES` in `@etherfold/state-store` is correct: keep it. But it puts those literal strings into every tab bundle, and `packages/browser/test/bundlesForABrowser.test.ts` ("a tab that only reads across the port > pulls in NO query runtime, and no store implementation either", around line 130) asserts that the tab bundle's text contains neither name. Keep that canary's INTENT (a tab that reads across the port must not carry `createQuerySurface`'s SQL query tier), but make it detect the query tier's IMPLEMENTATION, not its reserved method names: for example, assert that no module of `@etherfold/state-store-sqlite` (or its `query-surface`) is among the metafile inputs that contribute bytes to the output, or match a string unique to the query tier's code. Never match the bare names that the reserved-name list now legitimately carries. Explain the change in the test's comment and in `## Decisions`. This touches `packages/browser`'s test directory, so add an `@etherfold/browser` patch changeset. Do not weaken the check to nothing, and do not remove the reserved names.
