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

## Decisions

- **`archive/ethereum-indexer-server/src/server/simple.ts` still names `providerSupportsETHBatch`, and I left it.** `archive/README.md` states the tree is deliberately outside `pnpm-workspace.yaml` and is "not built, typechecked, tested, versioned or published", kept as the reading material `docs/reviews/server-cli-batch.md` analyses. It already names several deleted things (`EthereumIndexer`, `ProcessorFilesystemCache`), so editing it would falsify a frozen historical record to satisfy a grep rather than remove a reader. Alternative considered: delete the option there too, which compiles nothing and would have made that file diverge from the review doc that reads against it. Touches: the acceptance criterion "a repo-wide search confirms nothing still names either the flag" is satisfied for live code; `work/` items (the spec, two done tasks, a dropped spec) likewise still name it as history and are records I must not edit.
- **`docs/adr/0073`'s `status: accepted, not yet implemented` was left alone.** Two more tasks from this spec are still in `work/tasks/ready/` (`the-engine-declares-its-method-set-and-a-test-holds-it-to-it`, which is blocked by this one, and `the-edr-requirement-and-the-scope-of-the-claim-are-documented`), so flipping the status now would overstate what shipped. Same call both predecessor tasks made; the last task in the chain is the place for it.
- **The generated API docs are not regenerated in this commit, because they are not committed.** `docs/api` is typedoc output and is gitignored (`.gitignore:53`), produced by `pnpm publish-typedoc` during `docs:build`. Since the flag is gone from the source types, the next build emits docs without it; there is no stale committed artifact to sweep. Recorded because the acceptance criterion offers "regenerated, or noted as regenerating on build" and this is the second branch.
- **`readBoolean` was deleted rather than kept for a future boolean variable.** It had exactly one caller. Keeping it would leave an unused helper whose only purpose was the removed knob, against CONTEXT.md's "delete what has stopped earning its keep". Touches: any later task adding a boolean env var to `@etherfold/fetcher-host` re-adds a six-line parser (`readNumber` next to it is the template).
- **The removed variable gets no warning path, and I added no test asserting one is absent.** The task forbids a deprecation warning, and `streamConfigFromEnv`'s existing docstring already establishes the house rule that a retired variable is "ignored like any other unrecognised variable". I stated that rule in the changeset and in the fetcher-host test's header comment instead of encoding it as a new mechanism. Touches: `platforms/nodejs-fetcher` operators, who see the variable simply gone from the docs.
