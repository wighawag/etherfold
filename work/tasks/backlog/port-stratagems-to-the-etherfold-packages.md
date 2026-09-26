---
title: 'Port stratagems and its snapshot job off the deprecated ethereum-indexer packages'
slug: port-stratagems-to-the-etherfold-packages
humanOnly: true
needsAnswers: true
blockedBy: []
covers: []
---

<!-- open-questions -->
<!--
  TRANSIENT BLOCK: stripped by the apply rung on full resolution.
-->

## Open questions

1. **Port, or retire?** `wighawag/stratagems` has had no commit since 2024-12-18. Is it still worth porting, or should its hourly snapshot job (`stratagems-snapshots`, `index-and-serve.yml`, cron `55 * * * *`) be stopped and both repositories left pinned to the last `ethereum-indexer*` releases, which still install (a deprecation only warns)? If retired, this task becomes "turn off the cron and say so in both READMEs".
2. **Which `alpha1` deployments still matter?** The snapshot job indexes `alpha1` live and has `alpha1test` and `composablelabs` commented out. A port only has to reproduce the snapshots someone still reads.
3. **What replaces the static state file?** `web/` bootstraps from `web/static/indexed-states/`, the `<chain>-<hash>-state.json` / `-lastSync.json` files the old `ei -f` wrote from the retired JS-object path. `etherfold build` folds into SQLite rather than writing that file, so the port needs a decision: a published snapshot of versioned state (see the idea `publishing-snapshots-of-versioned-state` and the stream-seed path), a served read tier, or folding in the tab from the chain. And does an already-deployed `web/` build have to keep reading the old files? `@etherfold/processor-entities` state is entity rows, so an old client cannot read a new snapshot; if a deployed client must keep working, the port has to ship `web/` and the snapshot job together.

<!-- /open-questions -->

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

- [ ] The open questions above are answered, and the answer to 1 decides which of the criteria below apply.
- [ ] `stratagems` resolves no `ethereum-indexer*` package (its lockfile names none), and builds and passes its CI.
- [ ] The stratagems processor is an `EntityProcessor`, and folding the same history produces the same answers the JS-object processor gave for the questions `web/` asks (checked against a snapshot the old job published).
- [ ] `stratagems-snapshots` runs `etherfold`, not `ei`, and its scheduled workflow succeeds with no deprecation warning in its install step.
- [ ] Whatever reads the snapshots (question 3) reads the new format, or the old format is kept and the reason is written down.

## Blocked by

- None: `publish-etherfold-and-deprecate-old-names` is done and every `@etherfold/*` package is on npm.

## Prompt

> The work happens in `wighawag/stratagems` and `wighawag/stratagems-snapshots`, not in etherfold, which is why this task is `humanOnly`: an etherfold runner cannot build in those repositories. Resolve the open questions with the maintainer first; if the answer to question 1 is "retire", do only that.
>
> FIRST, check this task against current reality: the imports and the workflow were read on 2026-09-26 and either repository may have moved since. Re-derive which `ethereum-indexer*` packages each one resolves (`grep` the `package.json` files and the lockfile) before planning anything.
>
> For the processor rewrite, read ADR-0037 (why the JS-object path is gone) and `examples/event-processor-nfts` in etherfold (an `EntityProcessor` and its CLI bundle). An entity processor declares its entities up front and its only set read is a PREFIX of a declared id with a required limit (ADR-0021), so a query `web/` makes by scanning a JS object may need a second entity keyed the way the question is asked, as that example's `ownership` entity is. Keep the old snapshot as the oracle: the port is right when the new fold answers `web/`'s questions the same way over the same history.
>
> Record every non-obvious choice in a `## Decisions` block at the end of your final report.
