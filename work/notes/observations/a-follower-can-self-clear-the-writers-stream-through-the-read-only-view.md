# A follower can CLEAR the writer's stream through the read-only view, because the self-clear is inside `fetchFrom`

**2026-09-06**, noticed while answering a design question during
`measure-what-a-published-stream-costs-to-install-and-pick-its-shape` (whether a snapshot-seeded
generation should keep a stream at all). Not reachable today; recorded because the thing that would
reach it is exactly what this exploration is designing.

`readOnlyStream` (`packages/core/src/stream/readOnly.ts`, ADR-0044) exists so that a **follower**
cannot damage the stream the indexing generation owns, and its own docstring states the case
precisely:

> `clear` is a no-op for a sharper reason than symmetry: the load path clears the cached stream on
> every shape it cannot use ... and a follower takes those branches over a stream ANOTHER generation
> is still indexing into. A view that passed `clear` through would delete the live generation's
> history from underneath it.

That guarantee is incomplete. It no-ops the OUTER `clear`, but `fetchFrom` is passed straight through
to the wrapped keeper, and `createSegmentedStream.fetchFrom`
(`packages/core/src/stream/segments.ts`) performs `port.clearSubtree` ITSELF on every shape it cannot
serve, beneath the wrapper:

- a gap in the ordinals,
- a segment that does not parse,
- a cursor claiming a different number of segments than are stored,
- **`cursor.startBlock > fromBlock`**, a stream that does not reach back to what was asked for,
- and segments present with no cursor record.

So a READER can delete the WRITER's history, which is the exact outcome the read-only view is
documented to prevent. The `clear` no-op only stops the load path's own explicit call, which happens
AFTER `fetchFrom` has already destroyed the subtree.

## Why it is latent, and what makes it live

Every branch above needs either damage or a stream that does not reach back to the source's
`defaultFromBlock`. A stream written by an ordinary indexing generation starts at that block, so the
`startBlock` branch cannot fire for it, and the damage branches need a corrupted store.

A stream whose `startBlock` is ABOVE the source's start block is produced by exactly one thing:
seeding. A generation bootstrapped from a state snapshot at block N and then keeping a stream from N
onward has `startBlock = N`. Give it a follower (a processor-only change, the case the generation
model exists to make free) and the follower's first `load()` takes the fresh-state branch, asks from
`defaultFromBlock`, and clears the writer's stream.

## Why it is not fixed here

This task ships a measurement, and the fix is a design decision rather than a typo: either the
self-clear moves OUT of `fetchFrom` and becomes something the caller does (which the load path
already does, so the keeper's copy may be redundant), or the read-only view has to interpose on the
read path as well as the write path, or the keeper needs to know whether its caller owns it. Which of
those is right is `readOnlyStream`'s and ADR-0044's business, not this spike's.

Note for whoever takes it: ADR-0063 pins that a seed's first batch carries the CAPTURE's `fromBlock`
so the seeded stream reaches back to the client's own start block, which keeps the `startBlock`
branch from firing for a STREAM-seeded generation. The hazard is specific to a SNAPSHOT-seeded one
that also keeps a stream, which `work/notes/findings/what-a-published-stream-seed-costs-to-install.md`
recommends against on independent grounds.
