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
