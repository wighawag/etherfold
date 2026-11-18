---
status: accepted; built by the trigger service packages, outside the indexer-server (ADR-0100)
---

# Trigger actions are authenticated HTTP calls with a per-type delivery policy

A trigger action is exactly one primitive: an **authenticated outbound HTTP call carrying a semantic idempotency key**. Push notifications, reward APIs and NFT mints are all adapters over it. Delivery policy is **per action type** (a TTL and a retry budget), with **bounded retries then dead-letter as the floor**, so nothing is ever silently dropped: expiry and dead-lettering are both recorded, inspectable states.

## Considered Options

- **Retry forever with backoff.** Never loses an action, but one poison delivery retries eternally and the outbox never drains.
- **Bounded retries then dead-letter.** Durable and inspectable, but treats a worthless-after-an-hour notification the same as a must-eventually-happen award.
- **Per-type policy (chosen), with bounded-then-dead-letter as the floor.** A push notification expires (Web Push already has `urgency` and `topic` semantics for this); a badge or mint retries for days and then dead-letters rather than vanishing.

## Consequences

- **"Guaranteed" is now a precise claim**: guaranteed to be attempted according to its policy, and guaranteed to end in a recorded terminal state (delivered, expired, or dead-lettered). This is what makes the trigger spec's "observe delivery status" story implementable.
- **On-chain actions must never be submitted by the trigger service.** Submitting a transaction is a stateful, ordered, gas-managed operation with nonce management, confirmation waiting and its own reorg exposure. An NFT mint is therefore a call to a minting service that owns the transaction manager, and that service is itself consumer-shaped. This is a rule, not a convenience.
- **The idempotency key must be honoured by the target**, and we cannot enforce that from our side. At-least-once delivery against a non-idempotent mint endpoint is a double-mint, which is real value lost. Every action target we integrate carries this as an explicit requirement.
- **The first target already violates it.** `wighawag/push-notification`'s `POST /push` fans out to every device for `(address, domain)` and is neither idempotent nor atomic across them, so a retry after partial failure re-notifies devices that already received the message. Recorded, with the two authentication gaps, in that repo's `docs/findings/trigger-service-integration.md`.
- **Identity for notifications is `(address, domain)`**, decided by that service and not re-litigated here: the trigger service stores triggers keyed by address and holds no push endpoints, keys or Web Push encryption. Multi-device fan-out, revocation (`410`/`404`) and rotation all come for free from it.
