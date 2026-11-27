# Triggers run outside the indexer-server

> **Complemented 2026-11-26 by [ADR-0101](0101-a-trigger-service-hosts-several-apps-in-one-app-keyed-schema-each-behind-its-own-lease.md): a consumer's "own database" may be an app-keyed slice of a database one operator shares across several apps.** Everything below still holds: the consumer owns its state, its cursor, its gate, its outbox and its auth, and the indexer-server holds none of it.

Trigger evaluation and action delivery (webhooks, push notifications) do **not** run inside the indexer-server. They run in N independent consumer services, each owning its own database, its own cursor, its own gate, its own delivery outbox and its own auth. The indexer-server holds no trigger state whatsoever: no registrations, no subscriptions, no per-consumer cursors, no delivery table. We chose this to keep the indexer-server simple and to allow different trigger purposes, run by different entities, to exist without any change to it.

This **reverses** `work/specs/dropped/trigger-system.md`, which records that "triggers evaluate in the log-processor component (it has the events + historical state + DB)" and asks its open question 5 to confirm that. The answer is no.

## Considered Options

- **Triggers in the indexer-server (the original intent).** Gives a central, enforceable delivery guarantee, at the cost of per-consumer state and configuration inside the store, a schema change to add a consumer, and write access to our database for anyone running a trigger service. Rejected.
- **Independent consumers over a pull feed (chosen).** Adding a consumer changes nothing in the indexer-server.

## Consequences

- **The durable queue relocates rather than disappearing.** The transactional-outbox requirement is unchanged, but it applies in each consumer's own database, where the atomic pairing is that consumer's cursor advance with the delivery rows it implies. A managed queue (Cloudflare Queues or similar) is transport, never the source of truth, because enqueueing after a commit is a dual write and can lose or duplicate a trigger.
- **The reliability promise changes owner.** The trigger spec's "it must be possible to guarantee the action actually runs" is now a promise made by the reference trigger service, not enforced by the platform, and it cannot be enforced at all for a third-party consumer. What the platform guarantees is the feed: ordered, resumable, and free of silent loss.
- Trigger-system user stories 3, 4, 6 and 7 (webhook action type, delivery guarantees, delivery observability, webhook auth and payload signing) become requirements of the trigger service. The indexer-server's own security surface narrows to read auth on the feed.
- This decision is what forces the indexer-server to expose a feed at all. See ADR-0006.
- Unchanged by all of this: a state condition is still evaluated **as of the triggering log's block**, addressed by block hash, via the historical-state query API. That constraint is why the historical-state database must land first.
