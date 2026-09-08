# One rule has one home: the WRITER, and the unreadable snapshot

Two independent corrections found by auditing the published surface before it is published, sharing one shape: **a rule with two homes, or a word meaning two things.**

1. `Indexer` (`container.ts`) now derives which generation FOLLOWS a stream from the shared `writerOf`, instead of from the order of its own in-memory array.
2. `NotBootstrappedReason` gains `unreadable-format`, so a snapshot document that was fetched and cannot be read is no longer reported as `unreachable`.

## 1. The one-writer rule had two definitions

`writerOf` (`generation/registry.ts`) defines the writer of a stream as **the oldest SURVIVING record by `createdAt`**, and its docstring is explicit that this is what makes succession atomic with a delete and durable across a restart. `ReceivingIndexer` consumes it, and its own documentation says so: *"the value it is derived from is the shared `writerOf`, not a second copy of the rule."*

That sentence was true of the receiving container and false of the chain-facing one it compares itself to. `Indexer.add` never imported `writerOf`. It decided `follows` from `this.held.some((entry) => entry.record.stream === record.stream)` -- **this process's array order**, which is whatever order the caller passed its specs in.

The two agree on the ordinary path, which is why nothing caught it: the first generation held on a stream is normally also the oldest registered on it. They are still not the same rule. A host that lists its specs differently after a reload would hand the append duty to a different engine than the registry names, and nothing reconciles the two -- the container has no writer succession at all, where the receiving one needed sixty lines of it.

This is one line of code and it is not a tidy-up: it is the difference between one rule and two, on the rule that decides who may write a stream. A test now asserts the container's non-follower is the generation `writerOf` names.

## 2. `unreachable` meant two things, on the path an app renders to a user

`bootstrapFromSnapshot` recorded `'unreachable'` both for a fetch that failed and for a document that **was** fetched successfully and is not an envelope this build reads. The name is untrue in the second case, and `pickReason` hands one of the two to the application.

The remedies are opposite. A host that did not answer may answer on the next try, or another mirror may, so retrying is right. A document this build cannot read means the app or the publisher is out of date, and retrying never helps -- so telling a user "the mirror is down" sends them to do the one thing that cannot work. `BootstrapOutcome` documents itself as "data, so a host can decide rather than parse a log", and this is the decision.

The stream-seed path is the deliberate analogue of this one -- same ADR family, same location/failover/refusal-as-data vocabulary, and its own code calls its capture-depth check "the stream analogue of the snapshot path's `inside-reorg-window`". It has carried `unreachable` and `unreadable-format` as separate reasons since it was written. This union simply drifted, and the newer sibling is the one that got it right.

`pickReason`'s precedence puts `unreadable-format` above `unreachable` and below the two content checks: most specific first, since a reason about a document we actually read tells a user more than one about a host that never answered.

## Why both now

Adding a member to a published union breaks every consumer with an exhaustive `switch`, and changing which of two rules governs the write duty is not something to do to an installed base. `publish-etherfold-and-deprecate-old-names` is what ends the window. Neither of these is expensive today and both are expensive the moment it lands.

## What was deliberately NOT done

The same audit found the two containers share `generation/registry.ts` and `generation/promotion.ts` genuinely, with `PromotionView<T>` as a working seam, and that their raw line counts (1331/1220) are mostly prose over 565/450 code lines. **Merging them would be a net loss** -- what is left duplicated is ~10% of application shell whose rules are already shared, and a common base parameterised over five callbacks would make both hosts harder to read to save sixty lines. Only the `writerOf` divergence above was a rule with two answers; the rest is two hosts over one model, exactly as `CONTEXT.md` claims.
