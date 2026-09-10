---
title: 'A reader learns when the state moved'
slug: a-reader-learns-when-the-state-moved
needsAnswers: true
taskedAfter: [the-indexer-runs-in-a-worker-and-the-tab-talks-to-it]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK — stripped by the apply rung on full resolution.
-->

## Open questions

1. **Is this a GraphQL subscription, or a signal beside the query surface?** A subscription is what a GraphQL client already knows how to consume, and it costs the `AsyncIterable` shape in the transport plus a server-side implementation the research has built but not shipped (SSE on a plain Worker, WebSocket hibernation on a Durable Object). A signal beside it ("something changed, at block N") is trivially portable, works identically over a `MessagePort`, a `BroadcastChannel` and SSE, and leaves refetching to the client's own cache. The second is smaller and the first is what a client library expects.
2. **What does the notification CARRY?** A bare "something changed" forces a refetch of everything on screen. A block number lets a client decide. A list of changed entities lets it decide well, and is the most expensive to produce and the easiest to get wrong under reorg. The store knows exactly which rows a block touched, since it just wrote them, so the information exists; whether it should cross the boundary is the question.
3. **How is a RETRACTION signalled?** A reorg is not "more data", it is data that stopped being true, and a client that treats the two the same will render the abandoned branch until something else moves. This is the case that makes a bare "changed" signal least adequate.
4. **Does a notification carry a generation, and what happens on promotion?** Reads resolve the canonical pointer once per operation, so a notification that crosses a promotion could invite a refetch that answers from a different generation than the one the client was rendering.
5. **Is delivery best-effort or ordered?** Best-effort with a monotonic block number is enough for a UI to converge, since a missed notification is corrected by the next one. Anything stronger implies buffering per client, which on the browser path is a worker holding state per tab.

<!-- /open-questions -->

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

### Autonomy notes

- **No `humanOnly`.** The shape is constrained on both sides: it must fit the query spec's transport and the election spec's reader, and its failure mode is a stale screen rather than a wrong answer.
- **`needsAnswers: true`.** Questions 1 and 2 decide the surface an app writes against and how much the producer must compute per block, so both change what the tasks are. Question 3 is the one that must not be answered late, because a model that cannot express a retraction cannot be extended into one without changing every consumer.
- **`taskedAfter: [the-indexer-runs-in-a-worker-and-the-tab-talks-to-it]`.** That spec provides the port this is delivered over in the browser. Note the direction with the QUERY spec is the other way round: it consumes this spec's answer as its own open question 1, so this must be tasked before it, not after.

## Implementation Decisions

**This is a decision that belongs to neither of its callers**, which is why it is its own spec. The query surface needs it and treats it as out of scope; the election spec needs it and cannot answer it alone. Deciding it in either would give the other a second, incompatible answer, which is the specific failure both specs already flag.

**The producer is whoever applied the block.** In the browser that is the worker or the elected tab, both of which already know exactly what changed, because they just wrote it. On a server it is the ingesting side. Nothing derives change by watching storage, since a store that must be watched implies either polling or a change feed nothing has asked for.

**A retraction is carried explicitly**, however question 2 is answered. The system already has the vocabulary: an emission stream that records what was applied and what was taken back, `removed: true` markers, and a fold that honours those verdicts on replay. Whatever crosses the boundary should be recognisable as the same idea rather than a new one.

**The block number is the coherence anchor.** It is what the query surface pins per operation and reports in `extensions`, so the same number appearing in a notification lets a client relate the two without parsing anything.

**Sync progress rides the same stream.** A reader cannot compute it (the cursor is behind the storage seam as an opaque string, ADR-0027, and deserialising it in a reader would breach that), so it must be published by the producer. Putting it in a second channel would mean two mechanisms with two failure modes for one question.

## Testing Decisions

- **Cause a reorg and assert the client converges**, rather than asserting a message shape. This is the case the whole model exists for and the one a shape test would pass while being wrong.
- **A missed notification converges**, by dropping one deliberately and asserting the next one repairs the client's view. That is the property that lets delivery be best-effort.
- **One model, three transports**: the same case over a `MessagePort`, over `BroadcastChannel` between tabs, and over the server transport, asserting the app-visible outcome is identical.
- **Coherence with a pinned query**: a notification naming block N, followed by a query, must not answer from below N, which ties this to the query spec's pinning rather than leaving the two independently plausible.
- **No per-client growth**, asserted by attaching many readers and observing the producer's bookkeeping does not scale with them.

## Out of Scope

- **GraphQL subscription server implementations.** The research has built and verified them (SSE on a plain Worker, `graphql-ws` in a hibernating Durable Object, and it explicitly rejects the pinned `graphql-workers-subscriptions` library). Whether we adopt one is question 1; building it is not this spec.
- **A general pub/sub or client-side cache.** This says what happened; what a client does with it is the client's, and a GraphQL library's cache is exactly the thing that should be doing it.
- **Delivering to a client that was not connected.** Best-effort means what it says: a client that reconnects re-queries and is coherent again by the block number.
- **Cross-device delivery.** Same boundary as the election spec: tabs of one profile, or a client connected to one server.

## Further Notes

The reason to spec this rather than let each caller improvise is that a notification model is very hard to widen later. A "something changed" signal shipped first would be consumed by every app, and adding retraction or per-entity detail afterwards means changing every consumer, which is precisely the migration a small early decision avoids. Question 3 is the one to get right on day one; questions 2 and 5 can start conservative and grow.
