---
status: accepted; built by the trigger service packages, outside the indexer-server (ADR-0100)
---

# Trigger cost is bounded by delivery rate, and notifications are digests

Trigger cost is bounded by **actual deliveries per subscriber per window** (a feedback loop), not by how many triggers exist (a limit). Breadth checks at registration are a fast-failing guardrail, and a per-address count quota is a backstop against registration spam. Matched events are **coalesced into digests** ("100 arrivals near your star systems", not 100 notifications), and the consumer's outbox is **two-stage**: a matches table, and a digests table materialised when the window closes.

## Why rate, not inventory

With the inverted-index matcher, cost is proportional to **matches**, not to registrations. A million triggers that each match weekly are cheap; one trigger matching every arrival on the map is not. Quotas on "how many triggers may I have" therefore protect the wrong resource. Breadth limits at registration (bounded value-set size, no unbounded filter on a high-frequency event) reject the pathological case up front and legibly, but they are a static guess about a dynamic quantity: fifty star systems are cheap in a quiet region and expensive in a war zone. Only measured delivery rate tracks the thing actually paid for.

The decisive point is that this is **also the product requirement**: nobody wants four hundred pushes during a siege. Building the rate control as the abuse control means it is exercised constantly by ordinary users instead of being an untested emergency path.

## Why a two-stage outbox

- **One row per matched event, coalesced at send time** makes retries ambiguous: after a failure you must know exactly which rows were in that attempt, or the retry silently changes the message and the idempotency key identifies nothing stable.
- **One row per (subscriber, window)** is a clean delivery unit but destroys the evidence, so "why did I get this?" and delivery-status observability lose their basis.
- **Two stages (chosen)** keep two atomic steps clean and separate: advancing the cursor and writing the matches (the ADR-0005 outbox invariant, unchanged), then closing the window and materialising the digest. The digest's content is **frozen** at materialisation, so a retry re-sends identical bytes under the same key rather than re-rendering a message that has grown since.

## Consequences

- **Coalescing is a per-action-type policy** (`none`, or `digest(window, leadingEdge)`) sitting beside the per-type TTL and retry budget of ADR-0009. A badge award never coalesces; an arrival notification always does. The fast lane uses **leading edge plus trailing digest**: send the first immediately, digest the rest, since "you are under attack" losing a whole window defeats the purpose of the lane existing.
- **The idempotency key is per digest, not per event**, which refines ADR-0009 for coalescing action types: the key identifies `(subscriber, digest window)` and the frozen content it was materialised from.
- **Web Push `topic` is not summarisation.** It collapses undelivered messages so the last wins, which would show "arrival at system X" rather than "100 arrivals". It is still worth setting on the digest stream as a safety net, so a device returning from offline receives the newest digest instead of a backlog, but the summarising is ours.
- **Digesting lives in the trigger service, not in `push-notification`.** Building "100 arrivals near your star systems" requires knowing what an arrival is and what counts as near. `push-notification` takes a prepared declarative message and has no domain vocabulary, which is exactly why it stays reusable across apps.
- **Window closing reuses existing machinery**: the same self-enqueueing or cron watchdog pattern ADR-0008 needs for chunked replay, so no new infrastructure.
- **Threshold predicates constrain how processors are written.** A condition like "owns at least X systems" must be a **point read as of the log's block**, so the processor should maintain the aggregate as a state field (for example `player.planetCount`) rather than leaving the trigger service to run `COUNT(*)` over versioned rows on every relevant event, which is a range scan that grows with history. This is a processor-design requirement discovered from a trigger requirement, and it is recorded here because it has no other home yet.
