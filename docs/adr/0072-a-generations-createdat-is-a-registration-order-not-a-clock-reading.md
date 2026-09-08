# A generation's `createdAt` is a REGISTRATION ORDER, not a clock reading

`GenerationRegistry.create` sets `createdAt` to `max(Date.now(), newest + 1)` rather than to a bare `Date.now()`, so the value is strictly increasing within one registry and two generations can never tie. And the CLI now reads the `RebuildStop` ADR-0070 gave it, saying once when a follower cannot advance instead of polling it silently for ever.

## The tie was giving one stream TWO writers

`writerOf` names the writer of a stream as the oldest surviving generation registered on it (ADR-0044), reading `createdAt` through `byAge`. `createdAt` was `Date.now()`: MILLISECONDS. Two generations registered in the same millisecond tied, and `byAge` then broke the tie on the processor HASH — an order with no relation to which was registered first.

So `writerOf` could name a SUCCESSOR as the writer of a stream its incumbent already wrote. Measured on `ReceivingIndexer`, with a frozen clock and fixtures named so the successor's hash sorts first: **two folds with `writesStream: true`**, against one for the same fixtures named the other way round. That is the invariant ADR-0044 exists to hold, broken by a clock resolution.

It is not exotic. Consecutive `add` calls land in one millisecond routinely — the audit that found this measured `proc-C`/`proc-D` both at the same reading — and nothing about the failure is visible: both folds simply append.

## Why the fix is one `Math.max` and not a new field

The obvious alternative is a monotonic sequence field on the record. That is a durable-format change touching every registry port. It buys nothing here: the only thing `createdAt` is FOR is ordering, and its own docstring already said so ("ORDERING only, never identity"). A value nudged a millisecond forward to stay ordered is more faithful to that contract than a raw clock reading, not less.

`create` already holds `current.generations` inside the same `commit`, so the maximum is free and the increment is atomic with the write. The identity tie-break in `byAge` stays, for totality across records that did not come from one registry; it can no longer be reached by two records that did.

## What it does NOT do: repair a registry an earlier build wrote

The guarantee is about records this code CREATES. A registry written before this change can still hold two records that tie, and opening it repairs nothing: `writerOf` resolves such a pair by hash, deterministically and stably, exactly as it always did. So on an upgraded deployment holding a legacy tied pair, the named writer may be the later-registered generation.

That set is empty today -- nothing is published (`CONTEXT.md`), and the reference deployment holds no state this project must preserve -- which is why this ships as a forward guarantee rather than a migration. A repair on open is the mechanism if that ever stops being true, and it is not built.

## What this does NOT change

`writerOf` still means "the oldest SURVIVING generation registered on this stream", and it is still the shared model both containers consult. What changed is that "oldest" is now a fact rather than an approximation. ADR-0071 left this open explicitly, having found that deriving the chain-facing container's `follows` from `writerOf` per generation produced two writers there too; that container asks the registry a set question instead, and that is unchanged and still correct.

## The other half: a report nobody read

ADR-0070 gave `RebuildReport` a `stopped` reason and `retryCanAdvance`, so a host could tell "call again" from "calling again will do exactly this for ever". Nothing in this repository read it: the CLI called `rebuildMore()` and discarded the result, which is the loop ADR-0070's cost story is about.

It now reports a follower that cannot advance ONCE, naming the reason, and stays quiet while it can. Saying it every cycle would be its own kind of silence. A capability with no consumer is a claim, not a feature, and this was the one host we ship.

Two details that are the difference between a message and a message that arrives. It goes to `console.error` and NOT to the package's `named-logs` logger: `packages/cli/src/index.ts` captures `logs('etherfold')` at module scope, and only the `fetch` and `index` commands ever import `named-logs-console`, so on the commands that reach this loop a `logger.error` is a silent no-op -- a defect `processorSetup.ts` already documents and works around the same way. And the decision is a separate pure function (`newlyStalledFollowers`), because driving a whole CLI to a stalled rebuild is expensive and the version that was not separated could be inverted wholesale with the CLI suite still green.
