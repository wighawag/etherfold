---
status: accepted; built by the trigger service packages, outside the indexer-server (ADR-0100)
---

# Consumers gate themselves: safe and fast lanes

A consumer never acts at the chain tip. It applies a **gate** and acts only at or below it, in one of two lanes: `safe` (the `finalized` tag, or a fixed depth on chains without one) or `fast` (`latestBlock - N`, with `N` configured per chain). The indexer-server publishes the facts (latest indexed block, finalized head, the chain's configured depth) and applies a gate when asked, but the choice of lane belongs to the consumer. We chose two lanes rather than one because the archetypes have opposite needs: a push notification is unretractable but tolerates being rarely wrong, while an achievement must never be wrong and can wait.

## Considered Options

- **Strict `finalized` only.** Zero false positives, but roughly 13 minutes of latency on L1 (and on the L2s that inherit it), which for a "you are under attack" notification is arguably worse than not sending.
- **Depth only.** Good latency, but forces value-bearing actions to accept reorg risk they should not take.
- **Two lanes (chosen).** Closed set of two, deliberately not an arbitrary per-trigger depth, which would mean an unbounded number of eligibility cursors for no product gain.

## Consequences

- **`N` defaults to that chain's `stream.finality`**, and going below it requires an explicit override. This makes the risk legible: at `N >= finality` the consumer only acts on blocks the indexer already treats as immutable, so no new risk class is introduced, since the system is already betting reorgs never exceed `finality`. Below it, the consumer is deliberately firing inside the indexer's own revert window. That should be a recorded decision, not a config value nobody remembers choosing.
- **Lane maps to view.** `safe` reads the canonical gated view: below finality nothing moves, so there is no rewind, no `removed`, no pending buffer, and the consumer's entire sync state is one monotonically increasing integer. `fast` should read the **full** emission stream, hold an action pending for its depth, and **cancel on retraction**, so that any reorg shallower than its depth becomes a non-event instead of an unretractable wrong notification. Being able to cancel before sending is the useful primitive, and it exists only because retractions are retained (ADR-0006).
- A fast consumer **may** use the canonical view instead, for simplicity, but the configuration is discouraged: it cannot cancel, so every reorg shallower than its depth becomes a false positive, and it must implement hash-validated cursors and rewind handling to avoid silently skipping events.
- **The feed is at-least-once; actions must be idempotent.** Duplicates arrive from three distinct sources: rewind re-delivery, a transaction re-mined in the new branch (semantically the same event at different coordinates), and the consumer's own outbox retries. Only the first two are the feed's doing and neither can be eliminated at the feed level.
- **Idempotency keys must be semantic, not positional.** `(blockHash, logIndex)` is precisely the wrong key, because re-mining changes both. Use `(transactionHash, index-within-transaction)` or, better, a key derived from the action's meaning.
