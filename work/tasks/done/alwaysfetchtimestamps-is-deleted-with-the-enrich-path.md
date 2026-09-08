---
title: 'Delete alwaysFetchTimestamps and the whole enrich path'
slug: alwaysfetchtimestamps-is-deleted-with-the-enrich-path
spec: etherfold-is-a-fold-over-logs
blockedBy: [a-timestampless-log-is-refused-at-the-fetch-boundary, alwaysfetchtransactions-is-deleted-with-the-transaction-field]
covers: [1, 3, 5, 6]
---

## What to build

Delete `alwaysFetchTimestamps` and everything left of the enrichment path.

Named by SYMBOL rather than only by concept, so the sweep is checkable by search instead of by judgement (the template forbids brittle file paths, not stable identifiers): `enrichEvents`, `blockFetcherFor`, `transactionFetcherFor` and their single-hash and multi-hash helpers, `BlockTimestampCache` and its reorg-window pruning, and the `getBlocks` / `getTransactions` bound methods that both deployment shapes call them through. If a symbol here no longer exists, that is drift worth reporting rather than working around.

Unlike the transaction half, this is a SWAP and not a removal. The timestamp axis survives unconditionally and for free, because the node puts `blockTimestamp` on the log (`ethereum/execution-apis#639`, and `@nomicfoundation/edr >= 0.20.0` closed the last holdout). What goes is the machinery that compensated for its absence at a cost the operator did not choose.

After this, `ProvidedStreamConfig` is `{finality, parse}`.

Two things that must NOT be deleted with it:

- **`normalizeBlockTimestamp` and the hex/decimal quantity tolerance** in the log decoding. Reading the field off the log is the SURVIVING path, and it has to keep tolerating both encodings and an absent field without inventing a value.
- **`blockTimestamp?: number` on the event type**, which stays optional because the wire genuinely does not guarantee it.

One coupling to get right: `blockPointer`'s refusal message currently recommends setting `stream: {alwaysFetchTimestamps: true}`. That flag will not exist. The message must be updated in THIS task, or it advises an operator to set something that is gone.

Likewise the fetch-boundary refusal added by the blocking task is conditioned on the flag not being set; that condition becomes dead and goes here.

## Acceptance criteria

- [ ] `alwaysFetchTimestamps` is gone, and `ProvidedStreamConfig` is `{finality, parse}`
- [ ] A repo-wide search for `enrichEvents`, `blockFetcherFor`, `transactionFetcherFor` and `BlockTimestampCache` returns nothing outside changelogs and this task's own paperwork
- [ ] `normalizeBlockTimestamp` and the hex/decimal tolerance survive, with a test that an absent or unreadable value yields undefined and never a number
- [ ] `blockPointer`'s refusal no longer recommends a flag that does not exist, and still refuses rather than guessing
- [ ] The fetch-boundary refusal now fires unconditionally
- [ ] The conformance workload that sets `{finality: 12, alwaysFetchTimestamps: true}` is migrated so its fixture logs carry `blockTimestamp` instead
- [ ] A changeset records the removal and states the minimum node requirement
- [ ] Tests mirror the repo's existing test style

## Blocked by

- `a-timestampless-log-is-refused-at-the-fetch-boundary`: the replacement guard must exist BEFORE the fallback goes, or there is a window where a timestampless log is neither compensated for nor refused early. This is the one edge here that is about correctness rather than convenience.
- `alwaysfetchtransactions-is-deleted-with-the-transaction-field`: same files; serialized to avoid a merge conflict rather than for a logical dependency.

## Prompt

> Remove the last reason the engine calls anything but `eth_getLogs`. Read `docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md` first.
>
> Domain vocabulary: ENRICHMENT is the step that filled in what a log did not carry (block timestamp, transaction data) with extra per-hash requests; it is shared by the single-process indexer and the split log-fetcher because both must honour the stream config identically (ADR-0003), and the receiving half of the split makes no chain calls at all. The STREAM CONFIG is hashed into the stream identity, so removing a field is an addressing change; a sibling task establishes whether the digest actually moves, and either answer is acceptable, so do not hold back the deletion for it.
>
> The distinction that matters while deleting: the ENGINE no longer fetches a timestamp, but it still READS one off the log, tolerantly. Deleting the reading path along with the fetching path would look like a tidy sweep and would remove the feature this task exists to rely on. A test should hold the line: an absent or malformed timestamp yields undefined, never zero and never an interpolation, because a wrong timestamp breaks the time axis silently and an as-of read cannot tell a caller it was lied to.
>
> Watch for the message coupling: `blockPointer` in `@etherfold/processor-entities` currently tells operators to set the very flag you are deleting. Search for other prose recommending it too.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the two blocking tasks landed as assumed, in particular that the fetch-boundary refusal exists, or you will delete the fallback and leave no guard at all.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.

## Decisions

- **`getBlockData`, `getBlockDataFromMultipleHashes` and `ExtendedEIP1193Provider` were deleted from `internal/engine/ethereum.ts`, although the task names only the enrich-path symbols.** Their sole caller was `blockFetcherFor`. Leaving them would leave a live `eth_getBlockByHash` (and `eth_batch`) call site in a published package with no caller, which is exactly what ADR-0073's "the engine makes ONE data call" claims is gone, and what my structural sweep test forbids. This follows the precedent the sibling transaction task set when it took the same helpers for receipts. Alternative considered: leave them for the `providerSupportsETHBatch` task. Rejected because that task's premise is that the flag has *no live readers* by the time it runs, which is true of the flag but would not have been true of the `eth_batch` request builder. Touches: `providersupportsethbatch-is-deleted-and-adr-0002-is-corrected`, which now has strictly less to delete.

- **`providerSupportsETHBatch` itself is left standing (dead) rather than deleted here.** It is declared on `ProvidedIndexerConfig`, `ProvidedLogFetcherConfig`, `FetcherHostConfig` and documented as `PROVIDER_SUPPORTS_ETH_BATCH` in `platforms/nodejs-fetcher`, and a dedicated ready task owns removing all three at once *plus* correcting ADR-0002's batch bullet. Deleting it here would have silently absorbed that task and taken a documented operator knob out of a published package under a changeset that does not mention it. I did update its now-false docstring in `fetcher-host/src/config.ts` (it said "which the enrichment fetches use") so no comment asserts a mechanism that no longer exists, and pointed it at the task that removes it. Touches: `providersupportsethbatch-is-deleted-and-adr-0002-is-corrected`.

- **ADR-0002's BLOCK-TIMESTAMP bullet is rewritten here; its BATCH bullet is deliberately untouched.** The timestamp bullet asserted "the fallback stays for now", which this change makes false, and the repo's own spec calls three documents asserting a stale external fact the drift worth cleaning. The batch bullet becomes false only when `providerSupportsETHBatch` goes, and that task explicitly claims it. Alternative considered: leave both to that task. Rejected because it would leave ADR-0002 describing a fallback that does not exist for however long that task waits. Touches: that task, which should now find only the batch bullet to reconcile.

- **`docs/adr/0073`'s `status: accepted, not yet implemented` was left alone.** The deletion has landed but the `providerSupportsETHBatch` consequence has not, so flipping the status now would overstate what shipped. Same call the previous task in this spec made. The last task in the chain is the natural place to flip it.

- **The stream-config test axes that used `alwaysFetchTimestamps` as "a second config that is not `finality`" were re-pointed at `parse`, not dropped.** `streamIdentity.test.ts` ("two DIFFERENT config changes are two different streams", key-order independence, the 1,800-case collision corpus), `updateIndexer.test.ts` (the genuinely-moved-config table, the idempotence loop) and `utils.test.ts` (the resolver's explicit-undefined rules) were all testing the *digest and the resolver*, not the flag, so deleting them would have quietly narrowed coverage while the diff looked like a tidy removal. The collision corpus keeps four config variants (`undefined`, `finality: 12`, `finality: 5`, `finality: 64`) so the count is unchanged. Same reasoning the sibling task recorded. One pinned literal had to move with it: `simple_hash({finality: 17, alwaysFetchTimestamps: true}) === 'ht6tzx8'` became `simple_hash({finality: 17, parse: {}}) === 'hg7dav3'`, computed from the built package. That assertion pins `canonical_form` over a TWO-key object, and it is the object that changed, not the hash function — the one-key and empty-object pins beside it (`h10lkzm2`, `h28y`) are untouched, which is what shows the bytes did not move.

- **The CLI's "agree on the boolean setting" test became "agree on a variable that names a DELETED flag".** Rather than deleting it, it now pins that BOTH halves ignore a stale `STREAM_ALWAYS_FETCH_TIMESTAMPS` and reach the same digest as an environment that never mentioned it. A half-migration where one side still read the variable would put a key in one digest and not the other, and `WireContextMismatchError` is not retryable, so the process would exit. Following the sibling task's precedent, the variable is removed outright rather than refused: `resolveFetcherHostConfig` has no unknown-variable validation at all, so it is now ignored exactly as a typo'd variable is, and adding a refusal would be a new user-visible error surface this task does not ask for.

- **`docs/design/historical-state-database.md` got a one-sentence "superseded on the fallback half" correction rather than a rewrite or nothing.** It told an implementer to fall back to `eth_getBlockByHash` for the blocks whose logs carried none, which is now false. It is a dated design snapshot, so I did not touch its empirical client table (kept as the record it is) and did not restate the whole argument. Alternative considered: leave it entirely, on the grounds that a `Status:` header marks it as historical. Rejected because the header says "design complete, not built", not "not maintained", and an unbuilt component's design doc is precisely the thing someone reads before building it.
