# A generation's `createdAt` is a REGISTRATION ORDER, not a clock reading

`GenerationRegistry.create` sets `createdAt` to `max(Date.now(), newest + 1)` rather than to a bare `Date.now()`, so the value is strictly increasing within one registry and two generations can never tie. And the CLI now reads the `RebuildStop` ADR-0070 gave it, saying once when a follower cannot advance instead of polling it silently for ever.

## The tie was giving one stream TWO writers

`writerOf` names the writer of a stream as the oldest surviving generation registered on it (ADR-0044), reading `createdAt` through `byAge`. `createdAt` was `Date.now()`: MILLISECONDS. Two generations registered in the same millisecond tied, and `byAge` then broke the tie on the processor HASH — an order with no relation to which was registered first.

So `writerOf` could name a SUCCESSOR as the writer of a stream its incumbent already wrote. Measured on `ReceivingIndexer`, with a frozen clock and fixtures named so the successor's hash sorts first: **two folds with `writesStream: true`**, against one for the same fixtures named the other way round. That is the invariant ADR-0044 exists to hold, broken by a clock resolution.

It is not exotic. Consecutive `add` calls land in one millisecond routinely — the audit that found this measured `proc-C`/`proc-D` both at the same reading — and nothing about the failure is visible: both folds simply append.

## Why the fix is one `Math.max` and not a new field

The obvious alternative is a monotonic sequence field on the record. That is a durable-format change touching every registry port. It buys nothing here: the only thing `createdAt` is FOR is ordering, and its own docstring already said so ("ORDERING only, never identity"). A value nudged a millisecond forward to stay ordered is more faithful to that contract than a raw clock reading, not less.

`create` already holds `current.generations` inside the same `commit`, so the maximum is free and the increment is atomic with the write. The identity tie-break in `byAge` stays, for totality across records that did not come from one registry; it can no longer be reached by two records that did.

## What this does NOT change

`writerOf` still means "the oldest SURVIVING generation registered on this stream", and it is still the shared model both containers consult. What changed is that "oldest" is now a fact rather than an approximation. ADR-0071 left this open explicitly, having found that deriving the chain-facing container's `follows` from `writerOf` per generation produced two writers there too; that container asks the registry a set question instead, and that is unchanged and still correct.

## The other half: a report nobody read

ADR-0070 gave `RebuildReport` a `stopped` reason and `retryCanAdvance`, so a host could tell "call again" from "calling again will do exactly this for ever". Nothing in this repository read it: the CLI called `rebuildMore()` and discarded the result, which is the loop ADR-0070's cost story is about.

It now reports a follower that cannot advance ONCE, naming the reason, and stays quiet while it can. Saying it every cycle would be its own kind of silence. A capability with no consumer is a claim, not a feature, and this was the one host we ship.
