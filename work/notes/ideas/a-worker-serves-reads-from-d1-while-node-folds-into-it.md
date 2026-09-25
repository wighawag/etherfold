---
title: 'A Worker serves reads from D1 while a Node process folds into it, over one missing `RemoteSQL` adapter'
slug: a-worker-serves-reads-from-d1-while-node-folds-into-it
---

## The opportunity

The reason to want a Worker is cheap hosting and a D1 database per deployment. The reason a Worker is a poor place to FOLD is recorded in ADR-0091: a rebuild has no invocation long enough to hold it, and a Worker cannot instantiate a processor from bytes at all. Those two facts point at a split rather than a rejection: **the Worker only ever READS, from D1 directly, and the folding happens in a Node process that writes into that same D1.** The Worker keeps the part it is good at (short per-request work, a cheap public read surface) and the Node process keeps the part that needs a process (long rebuilds, retained code, ADR-0091's way back).

Raised by the maintainer on 2026-09-22 while deciding ADR-0091, as the likely final shape for Workers: readers always, folders never.

## Why it is cheaper than it sounds

The seam already exists. The Node side talks SQL only through `RemoteSQL` (`prepare` plus `batch`), from the `remote-sql` library, and it already has two adapters: `remote-sql-libsql` on Node and `remote-sql-d1` inside the Worker. **The missing piece is one adapter: a `RemoteSQL` whose `batch` travels over HTTP to a thin Worker that replays it on the D1 binding.** Everything above the seam is written to survive exactly that: ADR-0054 designed the registry's atomicity for a substrate that offers only pre-built batches and no affected-row count, precisely so a commit stays correct over remote SQL, and every store already respects D1's parameter cap (`work/notes/findings/d1-caps-bound-parameters-per-query-at-100.md`).

## Two routes to D1 from outside a Worker, not yet weighed

1. **A thin proxy Worker** that accepts a batch and runs it on its binding. Cloudflare's own D1 documentation describes this as THE way to reach D1 from outside a Worker project ("Build an API to access D1 using a proxy Worker"). It needs a credential of its own, and it is SQL-execution authority over the database, so it wants the same care as the admin token (ADR-0057).
2. **Cloudflare's account-level D1 REST API**, which accepts SQL over HTTPS with an API token and needs no Worker at all. Unverified here: its rate limits, its latency per batch, and whether it preserves a batch's all-or-nothing semantics, which ADR-0054's guard depends on. That last one decides whether route 2 is usable at all.

## What would have to be true, and what is unknown

- **Batch atomicity end to end.** ADR-0054's guarantee holds only if the batch applies all-or-nothing on D1. Through the binding it does; through either remote route that has to be checked, not assumed.
- **Latency per fold.** A fold writes state per batch of logs, so every batch becomes a round trip to Cloudflare. Whether that is tolerable during a REBUILD, the one phase that writes a lot quickly, is the number to measure first.
- **Who owns the schema.** Today the Worker host deliberately does not apply the schema on boot and treats migration as an operator action (`POST /admin/setup`); with a Node writer the writer is the natural owner, and the two must not race.
- **Reads while a rebuild runs.** A successor rebuilding in its own table namespace (ADR-0053) does not disturb reads of the canonical one, so a Worker reading D1 mid-rebuild should see exactly what a Node reader would. Worth one test rather than an argument.

## Not now

Recorded so the shape is not lost, not scheduled. It becomes worth building when a deployment actually wants the Worker's hosting economics; the first step then is the latency measurement above, since it is the one that could make the idea not worth the adapter.
