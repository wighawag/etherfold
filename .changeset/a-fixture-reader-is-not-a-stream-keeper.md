---
'@etherfold/core': minor
---

A captured stream FIXTURE is no longer an `ExistingStream`.

`replayStream` now returns a **`StreamFixtureReader`** — `fetchFrom` and nothing else — instead of declaring the kept-stream keeper seam, and it is no longer built out of `readOnlyStream`. The fixture FORMAT is untouched: same serialized shape, same format number (2), same provenance block, so an existing capture parses, replays and serializes exactly as before.

Why they had to separate: a KEEPER stores what the node said, and the seam is narrowing to a stored event that structurally refuses the decoded half (`args`/`eventName`), which is the half that can go stale and is re-derived on read. A FIXTURE holds decoded events on purpose — they are decoded ONCE at capture so a replay does not re-run the decoder. Nothing ever wired a fixture as an indexer's `keepStream`, so the two never met at runtime, but the fixture DECLARED the seam and would have stopped compiling under the narrowing. ADR-0059 records the divergence, and ADR-0044's rule (ONE definition of read-only on the keeper seam) is untouched: `readOnlyStream` is unchanged in behaviour and its callers are all keepers now (a follower, and `@etherfold/server`'s `storedEmissionStream`).

What a caller has to change:

- **A fixture cannot be passed as `keepStream`.** It could be before and nothing did; a seeding path must WRITE a capture's events into a keeper instead, which is also the only shape a later generation can re-fold.
- **There is no `saveNewEvents` and no `clear` on a fixture reader.** "Writing through a fixture does not change what it serves" moves from a swallowed write to a compile-time fact, asserted with `@ts-expect-error` under `pnpm typecheck`.
- **`fetchFrom` always ANSWERS** rather than possibly reporting ABSENT: its result is no longer `| undefined`, so a `?.` on it is now unnecessary. A fixture captured for another chain is still REFUSED, which is a mistake and not an absence.

`captureStream`, `parseStreamFixture`, `serializeStreamFixture`, `blocksOf` and `replayFixtureInto` are unchanged; the last of those never went through the seam, driving a processor directly.
