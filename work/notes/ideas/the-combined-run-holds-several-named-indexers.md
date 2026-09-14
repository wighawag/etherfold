---
title: 'The combined `run` holds several named indexers, and the hard part is the config grammar'
slug: the-combined-run-holds-several-named-indexers
---

2026-09-13 — Scoped after the author asked how hard it would be to make `run` multi-tenant. Recording it because the answer is lopsided in a way that is not obvious: almost everything is built, and the one thing that is not is a design decision rather than code.

## Already built, and shipped

Multi-tenancy is a first-class capability of `@etherfold/server`, not a future feature:

- `indexerRegistry(indexers: Record<string, IndexerRegistryEntry>)` is the shipped multi-name resolver. Hand it a map and the host serves every name in it.
- `indexerEntryOn(container)` builds an entry from a container, so the per-tenant wiring is one call.
- ADR-0053 decided a named indexer is a DATABASE of its own, and the task `two-named-indexers-never-touch-each-others-data` made that structural: "no query, prefix scan or cap in one can ever reach another's data, even when the two index the same chain, the same contracts and the same processor."

That task also records the intended deployment shape, which matters here: "the indexer set is known at DEPLOY time, so N static bindings express it exactly (including on D1, whose bindings are static)". So multi-tenancy was designed for a host wiring N bindings, and the storage and serving layers need nothing at all.

## The one hard part: the config grammar

The CLI is single-tenant because ADR-0048 made every command "read the same inputs, under the same flag and the same variable, through the same resolver", with **"ONE name per input"** listed as non-negotiable. There is one `--indexer`, one `--db`, one `--processor`, one `--node-url`, and no config file anywhere in the CLI.

N tenants cannot be expressed in that grammar. So this is not "add a flag": it is revisiting a deliberate, documented uniformity that all five commands share, and whatever replaces it (a config file, repeated flags, a directory convention) is a new decision that wants an ADR. **That argument is the whole cost and all of the risk of this idea**, and it should be had on its own rather than smuggled in beside the plumbing.

## The two easy parts, and their existing answers

Recorded so nobody re-derives them or, worse, invents machinery that already exists:

- **Driving N folds.** `driveCycles(command, host, container, deps)` is 1:1 with a container, so a scheduler over N pairs is needed. The pattern already exists one level in: `Indexer.indexMore` steps N generations in a fixed order doing bounded work per tick (ADR-0022). A multi-tenant driver is that shape over containers instead of generations. The questions it forces are what `/status` reports for N (`getCursorReport` is a single reporter today) and making sure one stalled tenant cannot starve the others.
- **The node budget, which has a real footgun and an existing hook.** The requests-per-second limit lives on the PROVIDER (`createJSONRPCProvider(nodeUrl, {requestsPerSecond})`), and `FetcherHostDependencies.provider` already accepts an injected one ("Supply a provider instead of building one from `nodeUrl`"). The provider is pure transport, since the source lives on `LogFetcher`. So build ONE rate-limited provider and share it across N hosts and the budget is shared by construction. Letting each tenant construct its own means the process hits the node at N times the configured rate. Each host still keeps its own learned range, which is correct because ranges are per source (ADR-0074).

## Two things to do first, and one of them is more valuable than this

- **`run-registers-a-read-only-named-indexer` is a prerequisite.** A multi-tenant `run` still fetches for itself, so every tenant it hosts must refuse ingestion for exactly the same second-writer reason. That task makes "readable, not ingestible" expressible, which this idea needs before it can host anything.
- **`a-filter-change-freezes-the-incumbent-in-run` is the same mechanism for a better reason.** It needs N fetchers driven from `liveIngestions()` because ONE indexer has N live wire contexts mid-reconfigure, and it does NOT need the config-grammar decision, because those contexts come from the registry at runtime rather than from flags. So it delivers two thirds of this idea's plumbing, sooner, to fix a defect rather than to add a feature. Do it first and this idea gets cheaper.

## Worth asking before building any of it

Who is the tenant set for? A developer running two projects locally can run two processes today, and the deploy-time-static-bindings shape suggests a hosted operator is the intended user. If the motivation is the local case, the cheaper answer may be process supervision rather than a new config grammar, and that is worth settling before ADR-0048's uniformity is reopened.
