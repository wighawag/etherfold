---
title: 'Retire providerSupportsETHBatch, its operator env var, and the ADR that asserts it'
slug: providersupportsethbatch-is-deleted-and-adr-0002-is-corrected
spec: etherfold-is-a-fold-over-logs
blockedBy: [alwaysfetchtimestamps-is-deleted-with-the-enrich-path]
covers: [5]
---

## What to build

`providerSupportsETHBatch` exists to let the per-hash block and transaction fetchers issue one batched request instead of N. Those fetchers are gone by the time this task runs, so the flag has no live readers and the engine stops having an opinion about batch support at all.

**This is NOT an internal tidy, and an earlier draft of this task wrongly said it was.** The flag's reach was checked repo-wide during review and it is operator-facing:

- `@etherfold/core` declares it on the indexer config and the log-fetcher config, and reads it in the enrichment fetchers.
- **`@etherfold/fetcher-host` carries it in its own resolved config and passes it through to the fetcher.**
- **`platforms/nodejs-fetcher` documents `PROVIDER_SUPPORTS_ETH_BATCH` in its README as a deployment environment variable.**

So deleting it REMOVES A DOCUMENTED DEPLOYMENT KNOB from published packages, and the work spans three packages rather than one. Scope all three, and remove the env var from the platform's documented surface rather than leaving a documented variable that silently does nothing, which is the worse of the two failure modes: a variable that is read and ignored is indistinguishable from one that works.

Backward compatibility is not owed here, so no alias and no deprecation period. An operator who still sets the variable should simply find it gone from the docs; do not add a warning path for it.

**The half that is easy to miss:** ADR-0002 carries a consequence bullet asserting "**Batch RPC IS allowed** (`providerSupportsETHBatch`), an earlier framing that batch was off-limits is inaccurate; batch is used where the provider supports it." That becomes false in this change. Correct it in the same commit, or the repo gains a fourth document asserting a stale fact about its own engine, which is precisely the drift this spec's neighbouring work just finished cleaning up.

The correction is not "batch is now off-limits". It is that the engine no longer makes any request it could batch, so the question does not arise: one `eth_getLogs` per range, one `eth_blockNumber`, one `eth_chainId`. A caller's provider may still batch whatever it likes; the engine simply no longer asks.

## Acceptance criteria

- [ ] `providerSupportsETHBatch` is gone from every config type and every reader, across `@etherfold/core`, `@etherfold/fetcher-host` AND `platforms/nodejs-fetcher`
- [ ] `PROVIDER_SUPPORTS_ETH_BATCH` is gone from the nodejs-fetcher README's environment table, not merely unread
- [ ] ADR-0002's consequence bullet is corrected to reflect that the engine makes no batchable request, rather than deleted or left asserting a removed flag
- [ ] A repo-wide search confirms nothing still names either the flag or the env var, generated API docs included (regenerated, or noted as regenerating on build)
- [ ] A changeset records the removal and names it as removing a documented deployment variable, so it is not read as an internal change

## Blocked by

- `alwaysfetchtimestamps-is-deleted-with-the-enrich-path`: the flag's only readers are the fetchers that task deletes, so this cannot run before it.

## Prompt

> Delete a config flag whose readers have gone, and repair the ADR that advertises it. Read `docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md` (see its Consequences) and `docs/adr/0002-in-browser-eip1193-indexing-primary.md`.
>
> Verify the premise before deleting, REPO-WIDE and not just in `@etherfold/core`. This task's first draft claimed the flag's only readers were the fetchers being deleted, and that was wrong precisely because the check was scoped to one package: `fetcher-host` reads it and `platforms/nodejs-fetcher` documents it as an env var. Search every package, and search for the SCREAMING_SNAKE env-var spelling separately, since a config key and its environment variable do not grep alike. If a reader survives that this task does not name, route to needs-attention rather than deleting it out from under that reader.
>
> On the ADR edit: ADR-0002 is a live architectural decision, not a changelog, and its bullet was itself a correction of an earlier wrong framing. Do not simply strike it. Rewrite it so a reader learns the current truth (the engine makes no batchable request, so the allowance is moot) and does not conclude that batch RPC was re-prohibited. Keep the bullet's role in the ADR intact.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if ADR-0002's bullet has already been rewritten by another change, reconcile rather than overwrite.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
