---
status: accepted; built by the trigger service packages, outside the indexer-server (ADR-0100)
---

# Triggers expire unless renewed, with delivery feedback as a fast path

A registered trigger has a **TTL and dies unless renewed** (a client refreshes on app open; renewal is per subscriber, cascading to all of that subscriber's triggers). In addition, a push trigger whose deliveries report **zero subscribers** N consecutive times is marked dormant and later deleted. We chose both because an abandoned trigger is invisible: every step of processing it continues to "succeed" forever.

## The failure it prevents

A player registers "notify me of arrivals at systems A, B, C", then stops playing and clears their browser data. The push subscription cleans itself up, since the endpoint starts returning `410 Gone` and `push-notification` deletes it. The **trigger does not**. Every subsequent arrival at A, B or C still matches the inverted index, writes a match row, materialises a digest at window close, and fires an HTTP call that finds nobody. Multiplied across everyone who ever churned, most of the service's matching, storage and outbound calls end up being spent on people who left, and nothing ever reports a problem.

## Considered Options

- **Never expire.** The status quo of most trigger systems, and the reason they accumulate dead weight that only shows up as an unexplained cost curve years later.
- **Delivery feedback alone.** Fast (catches an uninstall within one notification cycle) but **channel-specific**: it works because Web Push reports zero subscriptions. A webhook target that keeps returning `200` to a service nobody reads gives no signal at all.
- **TTL alone.** Robust and channel-agnostic, but wastes up to a full TTL of work and requires client cooperation.
- **Both (chosen).** TTL is the floor because it holds for every action type; delivery feedback is an optimisation for the push case.

## Consequences

- **Resurrection needs no mechanism.** A returning player's client re-registers its triggers on open, so a deleted trigger costs nothing to recreate. This is what makes an aggressive TTL safe.
- **Dormant is a distinct state from deleted**, kept for diagnostics, so "why did I stop getting notifications?" is answerable rather than a shrug.
- **The TTL length is a real trade-off and not a sacred number.** 90 days is the suggested start: too short punishes seasonal players and adds renewal load, too long defeats the purpose. It should be tunable and its expiry observable, ideally surfaced to the client as "this trigger expires on X".
- **The failure mode of this design is a client that forgets to renew**, which silently loses a user's notifications. Expiry must therefore be a visible, logged event, not a quiet `DELETE`. It is the same asymmetry as everywhere else in this system: dropping work silently is the thing to prevent.
- **Non-push actions rely on the TTL alone.** A webhook trigger has no liveness signal, so its only garbage collection is renewal. Worth stating rather than assuming the push path generalises.
- Interacts with ADR-0011: a dormant trigger stops consuming match and digest work, so garbage collection is part of the same cost-bounding story as rate limiting, not a separate concern.
- Makes one small ask of `wighawag/push-notification`: a "does `(address, domain)` have **any** live subscription" endpoint would let the fast path check liveness directly instead of inferring it from delivery results. Recorded in that repo's `docs/findings/trigger-service-integration.md`.
