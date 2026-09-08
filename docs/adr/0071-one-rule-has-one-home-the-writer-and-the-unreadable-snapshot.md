# One rule has one home: the WRITER, and the unreadable snapshot

Two independent corrections found by auditing the published surface before it is published, sharing one shape: **a rule with two homes, or a word meaning two things.**

1. `Indexer` (`container.ts`) now derives which generation FOLLOWS a stream from the durable REGISTRY, instead of from the order of its own in-memory array -- and deliberately not from `writerOf`, which produces two writers here.
2. `NotBootstrappedReason` gains `unreadable-format`, so a snapshot document that was fetched and cannot be read is no longer reported as `unreachable`.

## 1. The container asked the wrong SOURCE, and `writerOf` is not the answer either

`Indexer.add` decided whether a new generation FOLLOWS its stream from `this.held.some((entry) => entry.record.stream === record.stream)` -- **this process's array order**, which is whatever order the caller passed its specs in and does not survive a restart. The durable registry is the honest source, so the question is now asked of it: *is any OTHER generation already registered on this stream?*

**The obvious fix is wrong, and it was measured wrong before it was written down.** The tempting change is `writerOf(await registry.list(), stream)` and `follows = !sameGeneration(writer, record)`, which reads as the unification this ADR is about: one rule, shared with `ReceivingIndexer`. It creates TWO WRITERS.

`writerOf` is a function of the whole record SET at a moment. `follows` is frozen per generation at ADD time, because `readOnlyStream` is baked into the engine's config and cannot be recomputed later the way `reconcileWriters` recomputes it on the receiving side. Evaluating a set-function per element at different moments is not the same as evaluating it once -- and `createdAt` has MILLISECOND resolution while `byAge` breaks a tie on the processor HASH, so:

- `add(A)`: registry `{A}`, `writerOf` names A, `follows = false`
- `add(B)` in the same millisecond, B's hash sorting lower: registry `{A, B}`, `writerOf` names **B**, `follows = false`

Both keep the real keeper and both call `indexMore()`. Measured at 20/20 runs in a warm process, with the fold writing 8 stored events where 4 are correct. It also disables the "never drop the writer of a stream another generation follows" guard, which reads `entry.follows`.

So the container asks the set question directly -- "is anyone else already registered here" -- which is tie-free, registry-backed, and exactly the container's form of the one-writer rule: it never REASSIGNS the duty, so the first generation registered on a stream keeps it.

**What this does NOT claim.** It is not the same expression as `writerOf`, and pretending otherwise is what produced the bug. `writerOf` decides WHICH of several records writes and is re-evaluated live; the container decides ONCE, at construction, and never revisits it. Under a same-millisecond tie the two can name different records, and that is tolerable precisely because the container never reassigns: what matters is that exactly one of its generations is not a follower, which is now true by construction rather than by ordering luck. Making them literally one expression needs `writerOf` to be stable in REGISTRATION order (a monotonic sequence on the record, not a millisecond clock with a hash tie-break) plus reconciliation in the chain-facing container. Both are real, neither is a one-liner, and this ADR does not do them.

The test that matters names its fixtures so the second sorts FIRST. Named the other way round -- which is how they were -- it passes against every candidate rule, including the broken one.

## 2. `unreachable` meant two things, on the path an app renders to a user

`bootstrapFromSnapshot` recorded `'unreachable'` both for a fetch that failed and for a document that **was** fetched successfully and is not an envelope this build reads. The name is untrue in the second case, and `pickReason` hands one of the two to the application.

The remedies are opposite. A host that did not answer may answer on the next try, or another mirror may, so retrying is right. A document this build cannot read means the app or the publisher is out of date, and retrying never helps -- so telling a user "the mirror is down" sends them to do the one thing that cannot work. `BootstrapOutcome` documents itself as "data, so a host can decide rather than parse a log", and this is the decision.

The stream-seed path is the deliberate analogue of this one -- same ADR family, same location/failover/refusal-as-data vocabulary, and its own code calls its capture-depth check "the stream analogue of the snapshot path's `inside-reorg-window`". It has carried `unreachable` and `unreadable-format` as separate reasons since it was written. This union simply drifted, and the newer sibling is the one that got it right.

`pickReason`'s precedence puts `unreadable-format` above `unreachable` and below the two content checks: most specific first, since a reason about a document we actually read tells a user more than one about a host that never answered.

## Why both now

Adding a member to a published union breaks every consumer with an exhaustive `switch`, and changing which of two rules governs the write duty is not something to do to an installed base. `publish-etherfold-and-deprecate-old-names` is what ends the window. Neither of these is expensive today and both are expensive the moment it lands.

## What was deliberately NOT done

The same audit found the two containers share `generation/registry.ts` and `generation/promotion.ts` genuinely, with `PromotionView<T>` as a working seam, and that their raw line counts (1331/1220) are mostly prose over 565/450 code lines. **Merging them would be a net loss** -- what is left duplicated is ~10% of application shell whose rules are already shared, and a common base parameterised over five callbacks would make both hosts harder to read to save sixty lines. Only the SOURCE the container asked was wrong; the rest is two hosts over one model, exactly as `CONTEXT.md` claims. Whether `writerOf` should be stable in registration order is a real question this ADR names and leaves open.
