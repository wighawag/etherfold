---
title: 'A reader learns when the state moved'
slug: a-reader-learns-when-the-state-moved
taskedAfter: [the-indexer-runs-in-a-worker-and-the-tab-talks-to-it]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> Tasked 2026-09-13, in NINE tasks. The implementation and testing detail moved into them; the durable rationale — the `{block, coherence, entities}` shape, why the coherence token is what makes best-effort delivery safe rather than merely cheap, entity names rather than ids in v1, the token rotating on a promotion by the same mechanism, and the signal being the primitive with a GraphQL subscription as an anticipated adapter over it — moved to **ADR-0083**.

> **What review changed, after the first cut of the tasks.** The payload gained a fourth field, `generation`, because story 10 asks the notification to NAME the lineage that answered and an opaque token names nothing. The touched-entity set is produced in `@etherfold/processor-entities`, where the mutations already are, and RELAYED by core, because core has no mutation vocabulary at all and `EventProcessor.process` returns an opaque result — the first cut assumed a seam that does not exist. The signal is NOT SUPPORTED on Cloudflare Workers and the host refuses rather than appearing to work, since an ingest invocation cannot write into a stream opened by another; a Durable Object is the remedy and it belongs to whoever adds the subscription adapter. And because the server has no state query surface yet, a remote reader converges by being told the current position on connect rather than by re-querying.

> **A second review pass added the ninth task.** The relay above was verified buildable on the CHAIN-FACING container and nowhere else: every server and CLI deployment folds through the RECEIVING container, which publishes nothing by explicit design, and `@etherfold/server` applies no blocks at all (its ingest route delegates to a receiver the host built). So the set reached the browser half of the goal while claiming both. `the-receiving-container-publishes-what-it-applied` now owns that half, and the remote transport task is blocked on it. The same pass also pinned three cases the first cut left implicit: only the CANONICAL fold publishes (a follower re-folding a stored stream would otherwise emit thousands of notifications about past blocks), the SQL processor's wrapper must forward the relay or every SQL deployment silently reports no entities, and a reconfigure swaps a generation's processor in place so a channel attached once must not go quiet.

> **Two things the tasking settled that this spec left implicit.** The retraction is produced in CORE and the `StateStore` seam is not widened: `revertTo` returns `void` at the interface, and although the IndexedDB and SQLite implementations do walk their version indexes, the fold already knows the fork point above the seam and a rotated token means invalidate everything, so the entity-level detail is unnecessary. And "sync progress rides the same stream" covers BOTH the cross-tab and the cross-network case, split across two tasks — a host pushing status to its own tab over its port (ADR-0082) already shipped and is untouched, because a reader tab and a remote app are the ones with no host to ask.

## Problem Statement

A client can read the state and has no way to know when to read it again.

Today an app subscribes to a reactive store in the same thread as the indexer: `createIndexerState` exposes `syncing`, `state` and `status` with `subscribe`, and the indexer pushes into them via `onStateUpdated`. That works precisely because everything is in one heap.

Every direction this project is going breaks it. Put the indexer in a worker and the subscription is on the wrong side of a `postMessage` boundary. Put the query surface in front of it and the app no longer reads through that handle at all, it sends documents. Point the app at a remote indexer and there is no shared heap in principle. Elect one tab to index and the other tabs have no indexer to subscribe to.

Two specs already reached this and parked it. The query spec lists subscriptions as out of scope and keeps only the question of whether the transport type admits `AsyncIterable`. The election spec asks how a reader learns the leader advanced, and notes it must be answered jointly or the two will answer it differently. That is the gap: not a missing feature inside one spec, but a decision two specs each need and neither owns.

Without it, "a client can query state" means "a client can poll". Polling is not absurd here (the chain is block-paced, and the research's own recommendation for a v1 server was pull SSE for exactly that reason), but an interval invented by every app separately is worse than one answer, and it is markedly worse in the browser, where the data is local and a change is knowable the instant it happens.

## Solution

**The side that applied the block tells the sides that are reading, and it says enough for them to decide what to do.**

One notion, delivered over whichever transport the deployment has: a `MessagePort` from a worker to its tab, a `BroadcastChannel` from the indexing tab to the others, SSE or a hibernating socket from a server. The content is the same in every case, so an app writes one handler.

**A retraction is a first-class case, not an increment.** A reorg does not add data, it withdraws it, and the whole reason this project exists is to get that right. A notification model that can only say "there is more" leaves a client rendering the abandoned branch, which would be an odd way to lose the property the indexer was built for.

**It carries the block, so a client can be coherent with the query surface.** The query spec pins every operation to one block and reports it in `extensions`. A notification naming a block lets a client tell "I already have that" from "I am behind", and lets a refetch be compared against what it was told rather than hoped about.

**Delivery is best-effort and self-correcting.** A missed notification is repaired by the next one, because the block number is monotonic within a branch and a retraction names what it withdrew. That keeps the producer stateless per client, which matters most in the worker case, where per-tab buffering would make a shared worker's memory grow with the number of open tabs.

## User Stories

1. As an app developer, I want my UI to update when new data lands, so that I do not invent a polling interval.
2. As an app developer, I want one handler for local and remote, so that offline and hosted builds are the same code.
3. As an app developer, I want to know WHICH block the notification is about, so that I can ignore one I have already rendered.
4. As an app developer, I want to be told when data was RETRACTED, so that a reorg does not leave the abandoned branch on screen.
5. As an app developer, I want enough detail to refetch narrowly, so that a busy contract does not make every block a full-screen refetch.
6. As an app developer, I want to survive a missed notification, so that a backgrounded tab converges when it comes back rather than staying stale for ever.
7. As an app developer using a GraphQL client's cache, I want the notification to fit how that cache invalidates, so that I am not fighting the library I chose.
8. As an app developer, I want sync progress in the same stream, so that "syncing, 400 blocks behind" does not need a second mechanism.
9. As an app developer in a reader tab, I want notifications from the indexing tab, so that a non-indexing tab is not a stale tab.
10. As an app developer, I want the notification to name the generation, so that a refetch after a promotion is not silently answered by a different lineage than the one I was rendering.
11. As a user, I want the screen to reflect the chain shortly after a block, so that the app feels live.
12. As a user with two tabs open, I want both to update, so that the one I am not indexing in is not behind.
13. As a maintainer, I want the producer to hold no per-client state, so that a shared worker's memory does not grow with open tabs.
14. As a maintainer, I want one notification model across every transport, so that SSE, `MessagePort` and `BroadcastChannel` are adapters rather than three semantics.
15. As a maintainer, I want the reorg case tested by causing a reorg rather than by asserting a message shape, so that the hardest case is covered by behaviour.

## Out of Scope

- **GraphQL subscription server implementations.** The research has built and verified them (SSE on a plain Worker, `graphql-ws` in a hibernating Durable Object, and it explicitly rejects the pinned `graphql-workers-subscriptions` library). One IS wanted on the server eventually, over WebSocket or SSE, and ADR-0083 records it as an anticipated ADAPTER over the signal rather than a rejection — which is why the server producer is required to be transport-agnostic. Building it is not this spec.
- **A general pub/sub or client-side cache.** This says what happened; what a client does with it is the client's, and a GraphQL library's cache is exactly the thing that should be doing it.
- **Delivering to a client that was not connected.** Best-effort means what it says: a client that reconnects re-queries and is coherent again by the block number.
- **Cross-device delivery.** Same boundary as the election spec: tabs of one profile, or a client connected to one server.

## Further Notes

The reason to spec this rather than let each caller improvise is that a notification model is very hard to widen later. A "something changed" signal shipped first would be consumed by every app, and adding retraction or per-entity detail afterwards means changing every consumer, which is precisely the migration a small early decision avoids.

The limit this model accepts rather than solves (a lost notification followed by a quiet chain leaves a reader stale until the next block moves) is recorded in ADR-0083 with the reason it is not engineered around.
