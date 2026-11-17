---
title: What the first build (S2a) left out of the etherfold ADRs it implements
slug: what-the-first-build-left-out
---

The core built in step S2a implements the safe lane of etherfold ADR-0007, ADR-0009's per-type delivery policy, ADR-0012's TTL with renewal and ADR-0013's two archetypes. These parts of the same ADRs are not built, each waiting for a feature that needs it:

- **The fast lane** (ADR-0007): read the retraction-aware `/feed`, hold a match pending for its depth, cancel on retraction. The consumer refuses `lane: 'fast'` today. A push tolerates it; nothing needs its latency yet.
- **Digests** (ADR-0011): the two-stage outbox (matches, then a digest materialised when a window closes, frozen, keyed per `(subscriber, window)`), the coalescing policy beside the TTL and retry budget, and the rate bound per subscriber. Today every match is its own delivery (coalescing `none`).
- **Dormancy from delivery feedback** (ADR-0012's fast path): a push subscription whose deliveries reach zero devices N times marked dormant, or checked through push-notification-server's `GET /registered/:address/:domain` (its ENHANCEMENT-1, S1-4). Today only the TTL collects an abandoned subscription.
- **A state read for predicates** (ADR-0011's point read as of the log's block): a predicate gets the log and its block hash and must do its own read. A helper over etherfold's `/graphql` with `block: {hash}` comes with step S2b's "every account's third greeting", which needs it.
- **Breadth checks at registration** (ADR-0011's guardrail): only the per-recipient count quota exists.
