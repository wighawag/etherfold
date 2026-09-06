# A captured fixture is a READER of its own, not an implementation of the kept-stream keeper seam

`replayStream` (`@etherfold/core`, `stream/fixture.ts`) returns a `StreamFixtureReader` — one operation, `fetchFrom`, and no write half at all — instead of the `ExistingStream` it used to declare, and it is no longer built out of `readOnlyStream`. A captured fixture therefore leaves the keeper seam entirely rather than becoming a second read-only implementation of it.

Recorded because ADR-0044 deliberately built the fixture out of `readOnlyStream` so that there would be ONE definition of read-only on that seam, so a reader arriving at this code with that ADR in hand would find the opposite and be right to ask; and because it is a PUBLIC API change on a type third parties are meant to implement.

## Why they had to separate

A KEEPER stores what the node said. The decoded half of an event (`args`, `eventName`) is what SOME ABI made of those bytes: it is the only half that can go stale, and it is re-derived on read (ADR-0034's unconditional `reparse`). So the keeper seam is narrowing to a stored event that structurally REFUSES a decoded one (`work/specs/tasked/the-stream-stores-only-what-the-node-said.md`).

A FIXTURE is the opposite by design. Its events are decoded ONCE, at capture, precisely so a replay does not re-run the decoder, and that decoded half is what makes it a reusable test input rather than a second copy of the chain.

They shared one interface for as long as nothing made them differ. Nothing ever wired a fixture as an indexer's `keepStream`, so they never met at RUNTIME — but the fixture DECLARED the seam, so narrowing the seam would have stopped it compiling. Separating them is what lets each type say what it actually is, and it is the honest direction: the fixture was the thing that did not belong, not the constraint.

## Why this does not reopen ADR-0044

That ADR's rule is about the KEEPER seam: one definition of what read-only means for a stream somebody else writes, so that the **one-writer rule** is structural. That rule is untouched and `readOnlyStream` is unchanged in behaviour. What its rejected-alternatives section named as the second caller — the fixture — is simply no longer a caller of anything on this seam, which is a caller LEAVING rather than a second implementation ARRIVING. `readOnlyStream`'s callers are all keepers now (the container's follower, and `@etherfold/server`'s `storedEmissionStream`), which is a sharper statement of ADR-0044's rule than the fixture ever was.

## Why the reader has NO write half, rather than a no-op one

The alternative was a fixture reader that kept a swallowing `saveNewEvents`, so the fixture would look like the seam without being it. Rejected: it would be a second no-op write in the tree, differing from `readOnlyStream`'s for no reason a reader could see, and it would preserve exactly the shape-confusion this change exists to remove.

With no write half, "writing through a fixture does not change what it serves" stops being a behaviour a test has to watch and becomes UNEXPRESSIBLE — the strongest available form of the guarantee. It is asserted as such, with `@ts-expect-error` under `pnpm typecheck` (`packages/core/test/streamFixture.test.ts`), so the compile-time claim is pinned rather than assumed.

The trade accepted is that `readOnlyStream`'s runtime assertion "a write is swallowed" no longer covers the fixture at all. That is the point rather than a loss: the two now make different promises, and a test asserting the fixture through the keeper's read-only view would have been asserting the very conflation this ADR removes.

## Consequences

- **`StreamFixtureReader.fetchFrom` always ANSWERS**, where a keeper's may report ABSENT (`undefined`). A fixture is a stream that is present by construction; what it still refuses is a chain it was not captured on, which is a mistake and not an absence.
- **The fixture FORMAT and its format number are untouched.** This changes the type the replay helper hands back, not a byte on disk: an existing capture parses, replays and serializes exactly as before.
- **A SEEDING path cannot point an indexer at a fixture any more.** Seeding a stream from a published capture (`work/specs/proposed/a-generation-can-be-seeded-from-a-published-artifact.md`) has to WRITE the captured events into a keeper, which is also the only shape that leaves a later generation able to re-fold them. `CONTEXT.md`'s **seeding** entry says so.
- **`replayFixtureInto` is unaffected**, having never gone through the seam: it drives a processor directly, one block per `process` call.
