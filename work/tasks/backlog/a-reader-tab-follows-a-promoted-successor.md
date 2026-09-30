---
title: 'A reader tab follows the generation its leader promoted'
slug: a-reader-tab-follows-a-promoted-successor
blockedBy: []
covers: []
---

## What to build

In a tab election (ADR-0097), a READER tab opens its store ONCE, through `openState(context)` with the context of the stream it was configured with (`readerContextOf`), and answers every read from that store for as long as it stays a reader. The leader, meanwhile, may PROMOTE a successor generation whose state lives in ANOTHER database: a hot update (`reconfigureFromHotUpdate`), a processor-only change, or a redeploy folded beside the live generation, each of which folds into a store of its own (the reference's hot-update recipe names each save `reference-${context.stream}-save-N`). When the leader's canonical pointer moves, the reader hears the `repointed` state-moved value and invalidates everything, and then re-reads the INCUMBENT's database, which nobody writes any more. It looks healthy and answers stale rows; its GraphQL answers name the leader's new generation (`readerGenerationOf` takes the generation the leader last named) while reading the old one's rows.

A reader should read the store of the generation that answers: when its leader repoints, the reader reopens (through the app's `openState`, handed the context and bundle of the promoted generation) and answers from the successor's store, or, where it cannot know how to open it, refuses honestly rather than answering from a retired store.

Found while building `one-store-constructor-serves-the-tab-election`, which derived both factories from one constructor but deliberately left this unchanged (its acceptance required this follow-up to be written, not built).

## Acceptance criteria

- [ ] After the leader promotes a successor generation stored in another database, a reader tab's reads (read surface and GraphQL) answer the successor's rows, in the real-browser suite on all three engines.
- [ ] A reader never answers rows from a generation that is no longer canonical under that generation's successor's name (the `generation` a query reports and the store it read agree).
- [ ] What `openState` is handed for the successor is decided and documented (its `GenerationContext`, and its bundle where the successor runs one), and an ADR-0097 amendment records it.
- [ ] The guide's tab-election section says what a reader does when its leader promotes.
- [ ] Changesets for every package changed (0.x: patch or minor).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a reader tab in a tab election (ADR-0097) follows the generation its leader promoted, instead of reading the incumbent's store for ever. Look at the reader path in `@etherfold/browser` (`tabElection.ts`: `openReader`, `readerContextOf`, `readerGenerationOf`; `host/serve.ts` and `IndexerState.ts`: `servedState` / the reader's `reading` store), the `repointed` state-moved case (ADR-0083) the leader relays, and the hot-update recipe in `examples/browser-reference/browser/indexer.worker.ts`, whose saves fold into databases of their own. `stateFactoriesFrom` (`@etherfold/processor-entities`) is the helper that derives `createState` and `openState` from one constructor.
>
> FIRST, check this task against current reality (written 2026-09-30 against `@etherfold/browser@0.12.0`). If a reader already reopens on a repoint, route to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious choice in a `## Decisions` block at the end of your final report. Add a changeset for every published package you change (0.x: patch or minor, never major). Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist`, `.git` or minified bundles. The real-browser suites run in CI's browser jobs; they must be green.
