# Findings: existing TODO triage

> **Partly resolved by deletion.** `ethereum-indexer-db-processors` has since been removed (`docs/adr/0010`), so every TODO below located in `db-processors/*` is moot: all of theme 5, and the `RevertableDatabase` half of theme 4. The themes themselves still matter, because the same requirements (context matching, batch/upsert/transactional primitives) now land on the SQL-backed store instead.

A sweep of the existing `TODO` / `FIXME` markers (≈60 across the codebase) plus the root `TODO.md`.
Grouped by theme, with cross-references to the review findings. The goal is to make these tracked
rather than scattered, and to flag which feed the design plans vs. which are standalone cleanups.

## Root `TODO.md`

> **CLOSED BY DELETION, and the file with it.** Both entries below (this one and the `logValues`
> typing cleanup under "Standalone / minor") were answered by DECIDING NOT TO BUILD the feature:
> `work/specs/tasked/the-stream-stores-only-what-the-node-said.md` deletes the `logValues` knob
> outright, so the stream always keeps the whole raw log and no configuration can trim it. The root
> `TODO.md` held only this item and is gone. Left below as the dated record of what was triaged.

- `NumberifiedLog / LogEvent could have fields removed, configuration on config.stream` — i.e. allow
  trimming log fields via stream config (there is already a `logValues` flag stub for this; see the
  related `indexer.ts:63` TODO about typing `logValues`). Minor feature, not urgent.

## Recurring theme 1: "check if source matches old sync" (correctness)

The same TODO appears in **every** persistence/cache layer:
- `db-processors/EventProcessorOnDatabase.ts:60`
- `db-processors/EventProcessorWithBatchDBUpdate.ts:91`
- `db-utils` (implied, via EventCache `load`)
- `fs-cache/ProcessorFilesystemCache.ts:62`

These all load a persisted `lastSync` **without verifying it belongs to the current source/config**.
The core engine does context-matching on its own `keepStream`, but these processor-side stores do not.
→ Already noted in `findings/event-cache.md` (#8) and `findings/revertable-database.md`. The
historical-state DB plan should define a single canonical "does this persisted state match the current
context?" check. **Real correctness risk** (wrong state served after a source/config change).

## Recurring theme 2: reorg replay drops `unconfirmedBlocks` (correctness)

- `fs-cache/ProcessorFilesystemCache.ts:96,108` — `unconfirmedBlocks: [], // TODO ?`
- `fs-cache/ProcessorFilesystemCache.ts:90` — `TODO group per block and use the corresponding lastToBlock`
- mirrors `EventCache.replay()` passing `unconfirmedBlocks: []` (see `findings/event-cache.md` #2).

Same class of bug across both cache implementations: replaying cached events reconstructs `lastSync`
with empty `unconfirmedBlocks`, so reorg state is not reproduced faithfully. → Feeds the
historical-state plan's "deterministic reorg replay" requirement.

## Recurring theme 3: `extra` field not persisted

- `db-utils/StreamDBCache.ts:28`, `db-utils/EventCache.ts:176` — `// extra: event.extra, // TODO`
- `EventCache.ts:121,123` — replay can't refetch missing timestamps / `shouldFetchTransaction`.

Processors relying on prefetched `extra` data behave differently on replay/fetch than live. → Noted in
`findings/event-cache.md` #5.

## Recurring theme 4: Database API gaps / batching / PouchDB coupling

- `RevertableDatabase.ts:39,53,77` — "create block only if not exist", "batch, require update Database
  interface", "batch?" — the `Database` interface lacks upsert/conditional-put and batch primitives,
  forcing slow per-item loops (`batchPut`/`batchDelete` are explicitly "slow implementation").
- `RevertableDatabase.ts:107,155` — `delete _rev // TODO PouchDB specificity` — PouchDB leakage.
- `db-utils/SyncDB.ts:18,103` — reset-the-whole-db instead of tracking modified objects.
- `StreamDBCache.ts:11` — `// TODO make it transactional`.

→ All directly relevant to the historical-state DB plan's **backend/schema** and **atomicity**
sections (the plan targets `remote-sql`/D1/SQLite, which will replace the PouchDB-specific bits and
should define proper batch + transactional + upsert semantics).

## Recurring theme 5: error/result typing in RevertableDatabase

- `RevertableDatabase.ts:178,200` — `TODO Error type for Result, or throw?` (currently returns a faux
  `Result` with an `error` field cast through `unknown`).
- `RevertableDatabase.ts:181` — `query block number on provider, remove the need to store block_<hash>`.

→ Query-API design detail for the historical-state plan.

## Server / streams packages (feeds the trigger-system + watcher/processor plans)

- `server/simple.ts` + `streams/multiStreams.ts` (near-duplicates): `allow to pass processor
  configuration`, `pass api key in get request?`, `what about kind?`, `clean response / force fields
  to be specified and prevent some (like underscore)`.
- These are the existing HTTP server layer — directly relevant to the **watcher↔processor authenticated
  HTTP protocol** (auth, response shaping/field exposure) in `plan-historical-state-database.md`, and
  to the trigger system's API surface. The duplication between `server` and `streams` is worth noting.

## Standalone / minor (safe cleanups, low risk)

- `ethereum-indexer/src/internal/engine/utils.ts:75` — `break // TODO use a while loop instead` in the
  reorg-detection loop (cosmetic; logic is correct — has a test).
- `ethereum-indexer/src/internal/engine/ethereum.ts:158` — optimise/combine filter topics (perf).
- `ethereum-indexer/src/internal/decoding/LogEventFetcher.ts:105` — `as any // TODO types?`.
- `indexer.ts:63` — type `logValues` for better safety (ties to root TODO.md). **Closed by deletion:
  the knob, its type and this TODO are gone (see the note under "Root `TODO.md`" above).**
- `indexer.ts:122,219` — `handle history (in reverse order)` (the `ContractData.history` field is
  declared in types but not yet wired through — partial feature).
- `indexer.ts:231` — remove the chainId courtesy-check in `updateIndexer` (dev responsibility).
- `indexer.ts:517,544,659` — minor (`?`, `timeout?`, type-investigation) — low value.
- `cli/src/utils/bn.ts:1`, `js-processor/history.ts:59`, `cli/index.ts:32` — "share/reuse" code
  duplication (bn helpers, history utils) — DRY cleanups.
- `cli/index.ts:95` — `fix type in KeepState to allow undefined`.
- `js-processor/JSObjectEventProcessor.ts:137` — `configure 100` (magic number).
- `browser/OnIndexedDB.ts:131` — `more than 2` remote fallbacks (noted in browser findings #7).
- `fs-cache/src/test.ts:21`, `browser/index.ts:10`, various `// TODO` stubs — trivial.

## Summary / recommendation

- **No new standalone bug** beyond what the three review findings already captured — the inline TODOs
  largely *corroborate* those findings (source-match, reorg replay, atomicity, PouchDB coupling).
- The **most valuable TODOs cluster around the historical-state DB plan** (themes 1–5) and the
  **watcher/processor + trigger plans** (server/streams). They should be considered inputs to those
  designs rather than fixed piecemeal now.
- A handful of **safe standalone cleanups** exist (the `while`-loop comment, DRY bn/history helpers,
  `logValues` typing) that could be done anytime without design decisions.
- The **`history` (reverse-order) feature** is partially declared (`ContractData.history` type) but not
  implemented in `indexer.ts` — worth deciding whether to finish or remove the type.
