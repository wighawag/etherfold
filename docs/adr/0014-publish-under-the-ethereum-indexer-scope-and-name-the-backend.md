---
status: superseded in part by ADR-0017
---

# Packages move to the `@ethereum-indexer` scope, and a store names its backend

> **Superseded in part by [ADR-0017](0017-rename-to-etherfold.md).** The scope is now `@etherfold`, and the CLI sits outside it under the flat name `etherfold`. Everything else below still holds: the move to a scope at all, the expand/migrate/contract mechanics, `<role>-store-<backend>`, directory-follows-leaf-name, and mandatory `publishConfig.access`. Read every `@ethereum-indexer` below as `@etherfold`.

The published packages move from the flat `ethereum-indexer-*` prefix to the **`@ethereum-indexer` npm scope** (owned), and packages that implement a storage role take the shape **`<role>-store-<backend>`**. The first package born under it is `@ethereum-indexer/state-store-sqlite`, the versioned-row state store. Existing packages migrate by expand/migrate/contract rather than in one cut, so nothing published breaks on the day the scope arrives.

## Why a scope

The flat prefix has run out of room in the one place it matters. `ethereum-indexer-server` is taken by the Koa/PouchDB server that ADR-0010 puts on a retirement path, while the indexer-server that ADR-0003 describes is the thing that actually deserves the name. `work/tasks/done/agnostic-server-skeleton.md` escalated that to a human as an open question and listed three options, all of them bad: a temporary name meaning two renames, a permanent second-choice name, or taking the name and breaking existing consumers immediately.

A scope dissolves it, because `@ethereum-indexer/server` is a fresh namespace: the new server takes the obvious name while `ethereum-indexer-server` keeps working untouched until it is deprecated. That is not a cosmetic gain. It converts a forced choice between "break consumers now" and "rename twice" into no choice at all, and it does the same for every future name the flat prefix has already spent.

The scope also removes the prefix as a per-package tax. `@ethereum-indexer/browser` says what `ethereum-indexer-browser` says, and leaves the name itself to carry the distinction rather than the boilerplate.

## Why the backend is named, not abstracted as `sql`

A store package names the backend it actually implements: `state-store-sqlite`, not `state-store-sql`. The tempting reading is that `remote-sql` is a portability layer and the package is therefore backend-neutral. It is not, and pretending otherwise costs a rename later.

- `remote-sql` exposes a transaction only as `batch`, which is D1/libSQL/SQLite semantics, and the store's atomicity model is built on exactly that.
- The design (`docs/design/historical-state-database.md` §8) settles that Postgres would use range types and GiST exclusion constraints, where SQLite uses two integer columns plus a partial unique index. A second backend is therefore a different implementation, not a dialect flag on this one.
- The `revertTo` ordering rule this package is built around exists because SQLite enforces a partial unique index per statement with no deferred mode. It is a property of one engine.

So the honest generalisation is a **sibling package**, and a package claiming `sql` while implementing SQLite would have to be renamed the day the sibling exists. Naming the backend now makes that day free.

Role comes first, backend last, following the convention the surrounding ecosystem already uses (`@sveltejs/adapter-node`, `@vitest/coverage-v8`). Consumers pick a role and then a backend, and it keeps variants of one role adjacent in a scope listing:

```
@ethereum-indexer/state-store-sqlite      built
@ethereum-indexer/state-store-postgres    only if §8's conditions are ever met
@ethereum-indexer/stream-store-sqlite     the other store ADR-0006 requires
```

The word **`state` is load-bearing and must not be trimmed to `sqlite-store`**: ADR-0006 commits the indexer-server to storing two things, the versioned state and the emission stream. A bare `store` names neither.

## Consequences

- **New packages are born scoped; existing ones migrate.** A package with no published history costs nothing to name correctly, so `@ethereum-indexer/state-store-sqlite` starts there. Each existing package migrates as expand/migrate/contract: publish the scoped package, republish the unscoped name as a thin re-export that depends on it, then `npm deprecate` the unscoped name pointing at the scoped one. The unscoped packages are not unpublished, since `stratagems` and `stratagems-snapshots` depend on them.
- **The directory name follows the leaf name**, so `packages/state-store-sqlite/` rather than `packages/ethereum-indexer-sql-state-store/`. During the migration the tree will be mixed, which is visible and temporary.
- **`publishConfig.access: "public"` becomes mandatory, not decorative.** npm defaults a scoped package to restricted, so a scoped package missing that field publishes private, or fails outright on a free org. `.changeset/config.json` currently sets `"access": "restricted"`; every package's own `publishConfig` overrides it today, but that config should be flipped to `"public"` as part of the migration so the safety net is not one forgotten field deep.
- **`agnostic-server-skeleton`'s open question is answered by this ADR** and its open-questions block should be resolved rather than answered on its own terms: the new server is `@ethereum-indexer/server`.
- **Changesets cannot express a rename** any more than it could express the removal in ADR-0010. Each rename is a new package plus a deprecation of the old name, so the changelog will show a new package appearing rather than a package changing name, and `npm deprecate` is again the only user-facing channel for the old name.
- **`named-logs` namespaces follow the package name**, as they already do elsewhere in the repo, so log filters change with the rename.
- The scope is owned, so this is not contingent on a name being available.
