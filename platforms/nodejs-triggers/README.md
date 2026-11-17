# etherfold-triggers

A generic trigger service for [etherfold](https://github.com/wighawag/etherfold): it follows an indexer's canonical feed (`etherfold run`'s `/canonical`) and fires authenticated, idempotent actions when a trigger matches, such as a Web Push through push-notification-server or a call to an operator's reward service.

Triggers run outside the indexer by design (etherfold ADR-0005). Two kinds: subscription triggers, registered by a user and notifying that user, and global rule triggers, defined by the operator, whose recipient is computed from the event.

Status: not built yet. It is step S2 of the plan `docs/plans/template-tree-features.md` on the `work` branch of [jolly-roger](https://github.com/wighawag/jolly-roger).

## License

[AGPL-3.0-only](LICENSE).
