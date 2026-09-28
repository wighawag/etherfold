---
title: 'Port stratagems and its snapshot job off the deprecated ethereum-indexer packages'
slug: port-stratagems-to-the-etherfold-packages
humanOnly: true
blockedBy:
  - a-build-published-app-starts-from-its-own-publication
  - a-browser-app-queries-its-worker-with-graphql
  - a-host-started-from-a-snapshot-answers-queries
covers: []
---

## Answered (2026-09-26, by the maintainer)

1. **Port, not retire.** Stratagems stays as a real consumer of the published packages: it serves as an example and as a test of them.
2. **Only `alpha1` matters.** `alpha1test` and `composablelabs` are already commented out of the snapshot job and are not ported.
3. **The static state file is replaced by what the CLI publishes**, which is a feature etherfold does not have yet: `build` folds into libSQL, and nothing writes that database out as the state snapshot and stream seed a browser app starts from. That producer is the spec `a-build-publishes-what-a-browser-app-starts-from` (ADR-0095), and this task waits for it (see Blocked by). For stratagems it means `build --publish` with history `none` and no seed, and `web/` loading the published processor bundle and starting from the publication index, with the same contracts and finality the job publishes with. Whether a deployed `web/` must keep reading the old files is moot: `web/` is ported with the job and reads the new artifacts.


## What to build

Move the two consumers we own off the seven `ethereum-indexer*` names, which were deprecated on 2026-09-26 as the release half of ADR-0017 (`publish-etherfold-and-deprecate-old-names`, split out of it so that task could close).

**It is a PORT, not a rename**, measured on 2026-09-26 against `wighawag/stratagems` at `3d5a0b3`. It resolves five old packages, and only two have a same-shaped successor:

- `ethereum-indexer-browser` (in `contracts/scripts/data/`, `web/`): renamed, now `@etherfold/browser`. Not everything it exported survived: `web/` imports `keepStateOnIndexedDB`, which `@etherfold/browser` no longer exports (state lives in the entity store; only the STREAM has an IndexedDB keeper, `keepStreamOnIndexedDB`).
- `ethereum-indexer-cli` (in `indexer/`, the `ei` command): renamed, now `etherfold` (below).
- `ethereum-indexer-js-processor` (`fromJSProcessor`, `JSProcessor`, `MergedAbis`): the free-form JS-object processor path is RETIRED (ADR-0037). The stratagems processor has to be rewritten against `@etherfold/processor-entities`: declared entities, `state.get` / `state.set` / `state.delete` in `on<Event>` handlers. `examples/event-processor-nfts` in this repository is the worked example, and its own comments show the same question written both ways.
- `ethereum-indexer-fs` (`keepStreamOnFile`, `keepStateOnFile`): filesystem storage is DELETED (ADR-0041). A Node process keeps state in SQLite (`@etherfold/state-store-sqlite`, or the `etherfold` CLI's `build` / `run`), and the stream is the CLI's too.
- `ethereum-indexer-server` (in `indexer/`): archived, NOT renamed and NOT deprecated (its npm fate is ADR-0010's). The read tier is now `@etherfold/server` / `etherfold serve`; check whether `indexer/` still uses it at all.

**The snapshots are the old CLI's output files.** `stratagems-snapshots` runs `pnpm indexer:index <name>` in `stratagems`, which builds `indexer/` and runs `ei -p ./dist/index.cjs ... -f ../web/static/indexed-states/<mode>`: the old one-shot writes a state file that `web/` then serves STATICALLY. The `ei` command no longer exists; the CLI is `etherfold` with the one-shot command `build` (ADR-0017, and `the-one-shot-is-build-and-serve-is-only-the-read-tier`). A `named-logs` filter matching `ethereum-indexer*` becomes `@etherfold/*`, and the CLI's own log namespaces are `etherfold` / `etherfold:keepState`.

## Acceptance criteria

- [ ] `stratagems` resolves no `ethereum-indexer*` package (its lockfile names none), and builds and passes its CI.
- [ ] The stratagems processor is an `EntityProcessor`, and folding the same history produces the same answers the JS-object processor gave for the questions `web/` asks (checked against a snapshot the old job published).
- [ ] `stratagems-snapshots` indexes `alpha1` only, runs `etherfold` (not `ei`), and publishes with the producer the spec above delivers, and its scheduled workflow succeeds with no deprecation warning in its install step.
- [ ] `web/` starts from the published state snapshot (and, if the spec delivers it, installs the stream seed) through `@etherfold/browser`'s existing options, and lands on the same state as a tab that indexed `alpha1` itself.

## Blocked by

- `a-build-published-app-starts-from-its-own-publication`: the last task of the spec `a-build-publishes-what-a-browser-app-starts-from`, which proves `build --publish`, the bundle arrival and the publication-index option end to end in the shape this port needs (history `none`, no seed). Everything else is ready: `publish-etherfold-and-deprecate-old-names` is done and every `@etherfold/*` package is on npm.
- `a-browser-app-queries-its-worker-with-graphql`: the last of the query work (ADR-0098, ADR-0099) the maintainer wants before the port, because `web/` iterates the whole state (`state.cells`, `state.owners`) and the store seam alone cannot enumerate an entity.
- `a-host-started-from-a-snapshot-answers-queries` (added 2026-09-28): the port starts from a publication AND queries with GraphQL, and until that task lands a host whose store is snapshot-aware answers every query `internal-error`.

## Prompt

> The work happens in `wighawag/stratagems` and `wighawag/stratagems-snapshots`, not in etherfold, which is why this task is `humanOnly`: an etherfold runner cannot build in those repositories. The maintainer's answers are recorded above: port, `alpha1` only, and publish with the CLI's producer rather than a static state file.
>
> FIRST, check this task against current reality: the imports and the workflow were read on 2026-09-26 and either repository may have moved since. Re-derive which `ethereum-indexer*` packages each one resolves (`grep` the `package.json` files and the lockfile) before planning anything.
>
> For the processor rewrite, read ADR-0037 (why the JS-object path is gone) and `examples/event-processor-nfts` in etherfold (an `EntityProcessor` and its CLI bundle). An entity processor declares its entities up front and its only set read is a PREFIX of a declared id with a required limit (ADR-0021), so a query `web/` makes by scanning a JS object may need a second entity keyed the way the question is asked, as that example's `ownership` entity is. Keep the old snapshot as the oracle: the port is right when the new fold answers `web/`'s questions the same way over the same history.
>
> `web/` reads its state through GraphQL on its worker host (`workerExecutor` from `@etherfold/graphql`, the worker entry passing the query handler, ADR-0099), for example all cells, or the cells in the viewport with a `where` on position fields the ported `cell` entity declares, rather than adding prefix-keyed entities only to make a set readable. Re-query on the state-moved signal.
>
> Record every non-obvious choice in a `## Decisions` block at the end of your final report.
