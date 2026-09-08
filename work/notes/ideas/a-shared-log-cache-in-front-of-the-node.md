---
title: A shared log cache in front of the node, so the second client to index a contract pays nothing
slug: a-shared-log-cache-in-front-of-the-node
---

## The opportunity

Every etherfold deployment fetches its own logs, from block zero of its source, every time a fresh client starts. ADR-0002 makes that the DESIGN (each browser is its own indexer), and it is also what makes the design expensive: the cost of a backfill is multiplied by the number of users, against exactly the rate-limited public providers ADR-0002 expects them to be using. Nothing is shared between two clients indexing the same contract, and nothing is shared between two runs of the same client on different machines.

The README already names the shape of the answer, in the Caveats section, and then does not pursue it: "an hybrid approach is possible where a server index and the in-browser indexer exists only as a backup when every server instances are unavailable except for a cache (which could even be shared across user in p2p manner)". This note is that cache, taken seriously and scoped down to the part that is cheap.

## What it is, and what it deliberately is not

It is a **proxy**, keyed by the question asked: given (chain, address set, topic set, block range), return the logs, fetching from the upstream node on a miss and serving from storage on a hit.

It is NOT a per-chain archive of all logs. That is the HyperSync shape, it is the whole job rather than a piece of it (multi-TB backfill, per chain, plus tip-following, forever), and it contradicts the reason the project exists: a per-chain all-logs service everyone points at is the centralised thing ADR-0002 was written to avoid. A cache has the opposite property. It holds only what someone actually asked for, it is correct when empty, and it degrades to the status quo rather than to an outage.

## Why it is cheap HERE specifically

**Because etherfold only ever speaks EIP-1193.** The core makes exactly five kinds of chain call and nothing else, so a cache is a provider DECORATOR: an object with a `request` method that wraps another one. It needs no change to `@etherfold/core`, no new seam, no configuration inside the engine, and it composes with the split-fetcher shape and the single-process shape identically because both take a provider. That is a genuinely unusual position to be in and it is worth spending.

**Because immutability has a bright line already drawn.** Below `latestBlock - finality`, the answer to a fixed (address set, topic set, range) question never changes again. That range is exactly the one the engine already treats as settled. So a cache entry below the finality depth is immutable and can be content-addressed, served with a permanent `Cache-Control`, put in a CDN, or handed to a peer. Above the finality depth, nothing is cached, ever. The rule is one comparison and it is the same number the reorg logic already carries.

## The hard part, which is the cache KEY and not the storage

A naive key of `(addresses, topics, fromBlock, toBlock)` will almost never hit ACROSS clients, and this is the thing that would kill a careless implementation.

`RangeLogFetcher` adapts its range at runtime: it starts at `numBlocksToFetchAtStart` and grows or shrinks from what the node answered, so two clients on two providers ask for two DIFFERENT sequences of ranges over the same contract. Add ADR-0033's per-range topic narrowing (`topicsThatCanOccurIn` removes a topic from the request when no declared range reaches it) and even the topic set varies by range. Two clients asking the same question in different words share nothing.

So the cache has to **normalise the question before it is asked**: fixed-size, globally aligned block buckets (a bucket is `[k*N, k*N+N-1]` for a fixed N), with the requested range decomposed into whole buckets plus at most two partial ones at the ends, and the topic set canonicalised (sorted, and NOT narrowed per bucket, so every client asks for the same superset and filters locally). That inverts the relationship with the adaptive range: the fetcher stops choosing ranges and starts consuming buckets. Which is a real change in behaviour and is the reason this is an idea note rather than a task.

## The refusal it must inherit

ADR-0004 is the constraint that makes a sloppy cache dangerous rather than merely useless. An absence is read as a reorg, and a reorg deletes state. So a cache entry is **all-or-nothing over the exact range it claims**: a partial entry served as a complete one is indistinguishable from a truncated node, which is the failure `suspectResultCount` exists to catch and which ends in deleted state. A cache miss must be a miss, never a short answer.

That also means the entry has to record the filter it answers with enough precision to reject a near-match. An entry fetched with a narrowed topic set cannot serve a request for the full set.

## What it composes with, both already in the tree

- **Stream seeds (ADR-0063 to 0067).** A seed is the whole-fold version of this idea: a captured stream that installs and folds with `eth_chainId` as the only node call. A seed is strictly better where it applies, and it applies to a bounded, published workload. The cache is for the case a seed cannot cover: an arbitrary contract nobody has published a seed for.
- **`work/specs/proposed/node-log-api.md`.** An etherfold server serving `eth_getLogs` over its indexed subset IS a cache with an indexer behind it, and it is the version with a completeness guarantee attached. If that spec is built, the cache becomes the client-side half of the same story and can front it as one more upstream.

## Where the entries could live, in ascending ambition

1. **In-tab, per client.** IndexedDB or the Cache API. Helps a reload and a second processor in the same origin, helps nobody else. Nearly free and it is the honest first step.
2. **A shared HTTP cache.** A plain reverse proxy over an RPC endpoint, with the bucket normalisation above and permanent cache headers below the finality depth. One operator serves a whole community, and it is ordinary infrastructure with no consensus in it.
3. **Peer-to-peer.** Content-addressed bucket entries, so a peer can serve a bucket and the recipient can verify it addresses what it claims. This is the README's own suggestion and the only version that keeps the decentralisation story fully intact. It is also the one that has to answer what a peer's answer is TRUSTED on, which a hash does not settle: a hash proves the bytes are the bytes that were addressed, not that they are every log in that range. Omission is undetectable, which is the same problem ADR-0065 hit for seeds and ADR-0066 answered by trusting a named HOST rather than a hash. Expect to land in the same place.

## When to actually do it

**Not before the round-trip work is measured.** This cache does nothing at all for the FIRST client, and if it turns out that the fold's own round trips dominate a backfill rather than the log fetching (which `the-indexing-loop-is-round-trip-bound` exists to find out), then a log cache is an optimisation of the smaller half. Level 1 is cheap enough to do on a hunch; levels 2 and 3 should wait for a number.
