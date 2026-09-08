---
title: 'Delete alwaysFetchTransactions and the transaction field: a capability removal'
slug: alwaysfetchtransactions-is-deleted-with-the-transaction-field
spec: etherfold-is-a-fold-over-logs
blockedBy: [a-timestampless-log-is-refused-at-the-fetch-boundary]
covers: [3, 5]
---

## What to build

Delete `alwaysFetchTransactions` from the stream config, `transaction?: LogTransactionData` from the processor-facing event type, and the transaction-fetching machinery under them.

**This REMOVES A CAPABILITY and there is no replacement.** `from`, `gasUsed` and `effectiveGasPrice` are not on a log, no standard proposes putting them there, and this task does not invent a substitute. That is the decision in ADR-0073, taken because a per-transaction request is exactly what ADR-0002's consequences and the README's Caveats forbid a processor from needing.

Deleted outright: no deprecation window, no migration path, no compatibility shim. **Backward compatibility with what has already been released is explicitly not an obligation of this project at its current stage**, so do not spend effort preserving a consumer, and do not soften the removal into an alias or a runtime warning. The changeset still describes the removal plainly, because a changeset records what changed.

Scope note: the transaction FETCHERS and the enrichment path are shared with the timestamp fallback, which a later task deletes. Take out what is transaction-specific and leave the shared machinery standing; the next task removes the rest. This ordering exists so each task can land green on its own, and because the two touch the same files.

## Acceptance criteria

- [ ] `alwaysFetchTransactions` is gone from `ProvidedStreamConfig` and from every resolved-config path
- [ ] `transaction?: LogTransactionData` is gone from the event type a processor sees
- [ ] The transaction-fetching calls are gone from BOTH deployment shapes (the single-process indexer and the split log-fetcher)
- [ ] A changeset names what was removed and states plainly that there is no replacement
- [ ] No test double answers a transaction-fetching method any more
- [ ] Tests mirror the repo's existing test style

## Blocked by

- `a-timestampless-log-is-refused-at-the-fetch-boundary`: serialised on merge-conflict grounds only, not logic. Both tasks plausibly touch the core stream-config and event types, and the runner rebases or surfaces conflicts rather than resolving them, so ordering them here is cheaper than colliding later. Same reasoning as the edge between this task and the timestamps deletion.

## Prompt

> Delete a capability, deliberately. Read `docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md`, especially "Why the two flags were not one decision": the transaction half is a REMOVAL with no replacement, and the ADR is explicit that this is stated rather than dressed up as a migration. Do not add a substitute, do not stub the field, do not leave a deprecated alias.
>
> Domain vocabulary: the STREAM CONFIG is hashed into the STREAM IDENTITY, so removing a field from it is an addressing change and not merely an API change. That is worth understanding but is NOT a constraint on you here: a sibling task measures whether the digest moves, and if it does the answer is to record it, not to preserve the old value. The two DEPLOYMENT SHAPES of ADR-0003 (the single-process indexer, and the split log-fetcher that pushes to a receiver) must both honour the stream config identically, so both make these calls and both stop.
>
> Look in `@etherfold/core` at the stream config types, the enrichment path shared by both shapes, and the per-hash transaction fetcher under it. Leave the timestamp half of the enrichment alone: a later task in this spec removes it, and the ordering is deliberate so each lands green.
>
> On the changeset: the repo uses changesets with descriptive bodies, not one-liners. State what was removed, that there is no replacement, and what a processor that needed `from` should do instead (the honest answer is outside this engine). Do not write a migration guide: there is nothing to migrate to, and backward compatibility is not owed here.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if something now reads `event.transaction`, that is a real consumer this task's premise says does not exist. Do NOT delete around it. Route to needs-attention with what you found.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.

## Decisions

**1. `STREAM_ALWAYS_FETCH_TRANSACTIONS` is removed outright, not refused.** The criterion says the flag goes from "every resolved-config path", and the env read in `@etherfold/fetcher-host` is one. I deleted the read and the README row rather than keeping the variable alive as an error ("this variable no longer exists"). Alternative considered: refuse on sight, on the strength of the repo's "nothing is accepted and ignored" rule quoted in `cli/src/folding.ts`. Rejected because that rule is about a variable the code *reads and discards*, not about one it no longer knows; `resolveFetcherHostConfig` has no unknown-variable validation at all, so an operator's stale `STREAM_ALWAYS_FETCH_TRANSACTIONS` is now ignored exactly as any typo'd variable is. Adding a refusal would be a new user-visible error surface the task explicitly rules out ("no substitute, no stub, no deprecated alias"). What it touches: `platforms/nodejs-fetcher` docs, `streamConfigFor` in the CLI, and the sibling timestamps task, which will do the same to `STREAM_ALWAYS_FETCH_TIMESTAMPS` and can now follow this precedent.

**2. `transactionFetcherFor` is deleted here, although the sibling timestamps task names it in its own sweep list.** That task's criterion is "a repo-wide search for `enrichEvents`, `blockFetcherFor`, `transactionFetcherFor` and `BlockTimestampCache` returns nothing", which this satisfies early rather than contradicts. The alternative — leaving a transaction fetcher standing with no caller — would leave an `eth_getTransactionReceipt` call site in the package, which is exactly what my structural test forbids and what ADR-0073's "the engine makes one data call" claims. The genuinely shared machinery (`enrichEvents`, `blockFetcherFor`, `BlockTimestampCache`, `providerSupportsETHBatch`) is left standing for that task, as instructed.

**3. Two `streamIdentity.test.ts` cases that used the flag as a second config axis were re-pointed at `finality` rather than dropped.** "Two DIFFERENT config changes are two different streams" and the collision corpus were both testing the digest, not the flag, so deleting them would have quietly narrowed digest coverage while the diff looked like a tidy removal. The corpus keeps four config variants (`undefined`, `alwaysFetchTimestamps`, `finality: 5`, `finality: 64`) so the collision count is unchanged.
