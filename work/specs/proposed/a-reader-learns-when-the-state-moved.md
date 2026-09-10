---
title: 'A reader learns when the state moved'
slug: a-reader-learns-when-the-state-moved
taskedAfter: [the-indexer-runs-in-a-worker-and-the-tab-talks-to-it]
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

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
- **No `needsAnswers`.** All five are answered in Implementation Decisions below, and they had to be: a notification model is very hard to widen later, because a "something changed" signal shipped first is consumed by every app and adding retraction or detail afterwards changes every consumer.
- **`taskedAfter: [the-indexer-runs-in-a-worker-and-the-tab-talks-to-it]`.** That spec provides the port this is delivered over in the browser. Note the direction with the QUERY spec is the other way round: it consumes this spec's answer as its own open question 1, so this must be tasked before it, not after.

## Implementation Decisions

**This is a decision that belongs to neither of its callers**, which is why it is its own spec. The query surface needs it and treats it as out of scope; the election spec needs it and cannot answer it alone. Deciding it in either would give the other a second, incompatible answer, which is the specific failure both specs already flag.

**The producer is whoever applied the block.** In the browser that is the worker or the elected tab, both of which already know exactly what changed, because they just wrote it. On a server it is the ingesting side. Nothing derives change by watching storage, since a store that must be watched implies either polling or a change feed nothing has asked for.

**A retraction is carried explicitly**, however question 2 is answered. The system already has the vocabulary: an emission stream that records what was applied and what was taken back, `removed: true` markers, and a fold that honours those verdicts on replay. Whatever crosses the boundary should be recognisable as the same idea rather than a new one.

**The block number is the coherence anchor.** It is what the query surface pins per operation and reports in `extensions`, so the same number appearing in a notification lets a client relate the two without parsing anything.

### The five answers

**The notification is `{block, coherence, entities}`, and the coherence token is the load-bearing part.**

```ts
type StateMoved = {
  block: number;
  /** Opaque. COMPARE it, never parse it. Changes when cached data may be stale. */
  coherence: string;
  /** Entity NAMES this block touched. Bounded by the declaration, not by block size. */
  entities: readonly string[];
};
```

A client's whole rule is two lines: **token unchanged, invalidate narrowly using `entities`; token changed, invalidate everything.**

**A retraction is explicit, and it is why narrow invalidation is not enough on its own.** After a revert the stale entities are the ones the ABANDONED branch touched, and those are generally NOT in the changed-set of whatever block arrives next, so a client invalidating narrowly under-invalidates and keeps dead-branch rows on screen indefinitely. It is cheap to produce: `revertTo` already walks `LOWER_INDEX` and `UPPER_INDEX` above the fork, so it sees exactly which rows it restored or removed. And it names a FORK POINT rather than a set of blocks, which is the vocabulary the emission stream, the `removed` marker and `revertTo` already share.

**Delivery is best-effort, at-most-once and unordered, and the coherence token is what makes that SAFE rather than merely cheap.** The producer holds no per-client state, which is what stops a SharedWorker's memory growing with the number of open tabs. But "a missed notification is repaired by the next one" is FALSE for a retraction on its own: miss it, receive the next append, invalidate narrowly, and the dead-branch rows survive. Best-effort delivery and an explicit retraction event do not compose without something more. The token is that something: the next notification already carries a different one, so a missed retraction is self-correcting, for the cost of one field.

**The token changes on a PROMOTION too, and that is deliberately the same mechanism.** A promotion means a different fold now answers, which from a cache's point of view is indistinguishable from "everything you hold may be wrong". One comparison and one code path rather than two. It also follows the existing convention that a generation is rendered so a consumer "compares the value and never parses it"; this is that idea widened to cover both reasons a cache can go stale.

**The payload names ENTITIES, not ids, in v1.** Entity names are bounded by the declaration, so the payload is O(schema) rather than O(mutations), which matters because the real measured stream's worst block carried **457 mutations** against a median of 7. Type-level invalidation is what a normalised GraphQL cache does well and what most apps use anyway. And ids can be ADDED later as an optional field without breaking a consumer, while they could not be removed, so starting narrow is the reversible direction. There is also a trap in shipping ids early: they invite a client to apply the delta by hand instead of refetching, which is precisely what goes wrong under reorg.

**It is a SIGNAL on its own channel, and a GraphQL subscription is an optional adapter over it rather than the primitive.** The signal has to exist anyway for the worker path, because a `MessagePort` has no GraphQL on it. A subscription is derivable from a signal by wrapping it in an `AsyncIterable`; a signal is NOT derivable from a subscription without a GraphQL runtime, which is exactly what a read-surface-only app has deliberately not loaded. Every client library's invalidation API is a plain callback (`invalidateQueries`, `refetchQueries`, `reexecuteOperation`), so a signal composes with all of them in a few lines, where a subscription needs a second link or exchange configured in each. And a subscription whose payload is "block N changed" is a heavyweight way to deliver a number: subscriptions earn their weight by pushing DATA, and pushing data means per-client state, which the delivery decision above rules out.

**Cross-spec consequence, and it is a simplification.** This answers `the-same-query-runs-against-a-worker-and-a-server`'s open question 1 as NO: `QueryExecutor` stays `Promise`-returning on day one, with no `AsyncIterable`. If subscriptions are ever wanted they arrive as a separate `subscribe` on the same port rather than by widening the executor, which is a cleaner shape regardless: two functions rather than one polymorphic one.

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

The reason to spec this rather than let each caller improvise is that a notification model is very hard to widen later. A "something changed" signal shipped first would be consumed by every app, and adding retraction or per-entity detail afterwards means changing every consumer, which is precisely the migration a small early decision avoids.

**One limit is accepted rather than solved.** If a notification is lost and the chain then goes quiet, a client stays stale until the next block moves. That is inherent to push, and the honest mitigations belong to the client: re-query on visibility change, or a slow poll as a backstop. Building delivery guarantees for it would mean buffering per client, which is exactly the per-client state the delivery decision rejects, so this is recorded as a known edge rather than engineered around.
