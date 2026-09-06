---
title: 'A fixture reader is not a stream keeper'
slug: a-fixture-reader-is-not-a-stream-keeper
spec: the-stream-stores-only-what-the-node-said
blockedBy: []
covers: []
---

## What to build

Take the captured stream FIXTURE off the keeper seam: `replayStream` stops declaring itself an `ExistingStream` and gets its own reader type, whose events stay DECODED.

A fixture is a decoded test INPUT; a keeper is a store of what the node said. They have been sharing one interface because nothing made them differ, and the next task in this spec makes them differ: the keeper seam narrows to a stored-event type that REFUSES a decoded event, while a fixture's `eventStream` is decoded `LogEvent`s by design (they are decoded once at capture so a replay does not re-run the decoder). Nothing wires the fixture as the indexer's `keepStream`, so the two never meet at RUNTIME — but the fixture DECLARES the seam, so narrowing the seam would stop it compiling. Separate them now, before the narrowing, so that change does not have to.

The fixture FORMAT is untouched: same serialized shape, same format number, same provenance block. What changes is the TYPE the replay helper hands back. `captureStream` does not go through the seam either (it fetches and decodes directly), so what a capture WRITES is unaffected by this spec's later strip.

The docstring must be rewritten in the same change. It currently sells the fixture AS the keeper seam ("this is the seam the indexer already consults before fetching, so pointing it at a fixture is how a run gets its events from disk"). Leaving that would ship documentation telling a user to do what the types now refuse. The same claim appears in the core package README ("play them back as an `ExistingStream`") and in TWO of `CONTEXT.md`'s glossary entries — **seeding** (which names the replay helper as "already returns an `ExistingStream`") and **read-only stream view** (which names the fixture and the server's stored emission stream as "the same view over two different readers"). All of them must move in this change: after it, the server's reader is the wrapper's only caller. What is NOT rewritten is the package CHANGELOG, which records what shipped at the time and stays as it is.

**The fixture is currently BUILT OUT OF the shared read-only keeper wrapper, and three more places say so.** Grep for the replay helper before you start; at the time of writing they are: the wrapper's own docstring, whose "One view, two callers" section names the fixture as the second caller; the segment keeper's comment calling capture/replay "the shipped third implementation of this seam"; and — the one that will FAIL rather than merely read false — core's read-only-stream test, which carries a whole `replayStream is that same view` block asserting the fixture serves from a block, swallows a write and refuses another chain THROUGH the wrapper. That block is pinning ADR-0044's "one definition of read-only on this seam", so do not silently delete what it asserts: move those guarantees onto the fixture's own reader type (or into the fixture test beside the others) and leave the wrapper's own tests covering the follower case it still serves.

ADR-0044 constrains this: it deliberately built the fixture out of that wrapper so there would be ONE definition of "read-only on this seam" rather than two that drift. That rule is about the KEEPER seam and still holds for the follower case; what changes is that the fixture LEAVES that seam rather than gaining a second read-only implementation of it. Note that ADR-0044's own rejected-alternatives section names the fixture as the wrapper's second caller, so it becomes stale on this point: say so where a reader will find it, and if the divergence meets the ADR gate, record it.

## Acceptance criteria

- [ ] The fixture replay helper returns its own reader type (decoded events), not `ExistingStream`, and does not go through the keeper-seam read-only wrapper.
- [ ] The shared read-only keeper wrapper is unchanged in BEHAVIOUR and still serves the follower/one-writer case it was built for (ADR-0044). Its docstring and any other prose naming the fixture as its second caller are corrected, and the tests that asserted the fixture THROUGH it keep asserting the same guarantees about the fixture, now against the fixture's own type.
- [ ] The fixture serialization format is byte-for-byte unchanged: an existing captured fixture file still parses and still replays the same events in the same order from the same block, and a fixture captured for another chain is still refused.
- [ ] The docstring on the replay helper, the core package README line, BOTH `CONTEXT.md` entries that name it (**seeding** and **read-only stream view**), and the segment keeper's comment calling the fixture an implementation of this seam no longer describe the fixture as the keeper seam or as a caller of the read-only wrapper.
- [ ] The core stream-fixture test still pins what a fixture guarantees (serves from a block, refuses another chain, is immutable), adjusted to the new type rather than deleted.
- [ ] A changeset records the `@etherfold/core` API change.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: make the captured stream fixture stop declaring the kept-stream keeper interface, so a later task can narrow that interface to a stored-event type that refuses decoded events without breaking the fixture.
>
> Vocabulary: `ExistingStream` is the keeper seam the indexer consults before fetching (`fetchFrom` / `saveNewEvents` / `clear` / optional `setStreamConfig`); a STREAM FIXTURE is a captured `{source, lastSync, eventStream}` recorded from a real chain, whose events are DECODED at capture time on purpose; the read-only wrapper is the shared no-op-write keeper that makes the one-writer rule structural (ADR-0044).
>
> Where to look: the core package's stream module — the fixture (capture, parse/serialize, the replay helper, the block grouping, the "replay into a processor" helper that drives a processor directly and does NOT go through the seam), and the read-only keeper wrapper beside it, which the replay helper is currently built out of. Then the prose: the replay helper's docstring, the wrapper's own docstring (its "one view, two callers" claim), the segment keeper's comment about the shipped implementations of this seam, the core package README's stream-fixture bullet, and `CONTEXT.md`'s **seeding** and **read-only stream view** glossary entries. In tests: core's stream-fixture test (which calls `fetchFrom`/`saveNewEvents` structurally) AND core's read-only-stream test, which asserts the fixture IS that wrapper's view and will fail on this change — grep for the helper rather than trusting this list, and leave the package CHANGELOG alone, since it records what shipped rather than what is true now.
>
> Judgement you own: the shape of the fixture's own reader type (whether it keeps a no-op write side at all, or is read-only by construction) and where it lives; and where the guarantees the read-only-stream test asserted ABOUT the fixture end up. Keep it honest — a fixture is immutable by definition, so whatever you choose must keep "writing through a fixture does not change what it serves" true, either by behaviour or by the type making the write unexpressible; if the type makes the write unexpressible, the assertion that a write is swallowed becomes a compile-time fact and should be recorded as such rather than dropped in silence.
>
> Constraints: ADR-0044 (one definition of read-only on the KEEPER seam; do not add a second parallel read-only implementation of that seam — the fixture is leaving the seam, not re-implementing it). ADR-0035 (the stream cursor contract; the fixture reports an empty unconfirmed window). The fixture FORMAT and its format number must not change.
>
> Done means: the replay helper no longer names `ExistingStream`, every piece of prose that called it the keeper seam or the wrapper's second caller is corrected, no test still asserts the fixture through the read-only wrapper while the fixture's own guarantees survive, the fixture round-trips and replays exactly as before, and `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check` and `pnpm changeset status` pass.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself. If a choice meets the ADR gate (hard to reverse, surprising without context, a real trade-off) — the fixture/keeper divergence against ADR-0044 is a candidate — also write the durable WHY as an ADR in `docs/adr/` and name it in the block.


## Decisions

- **The fixture reader has NO write half at all, rather than a no-op `saveNewEvents`/`clear` of its own.** Chosen because it makes "writing through a fixture does not change what it serves" unexpressible instead of merely swallowed, and because a second no-op write beside `readOnlyStream`'s is exactly the parallel read-only shape ADR-0044 refuses. Alternative considered: keep a no-op write half so the fixture still *looks* like the seam (rejected: preserves the conflation the change removes). Touches: the read-only-stream test's "swallows a write" assertion about the fixture is now a compile-time claim, pinned with `@ts-expect-error` under `pnpm typecheck` in `streamFixture.test.ts` rather than dropped. Recorded durably as **ADR-0059**.
- **`StreamFixtureReader.fetchFrom` returns a value, not `| undefined`.** A fixture is a stream that is present by construction; ABSENT is a keeper's answer, and a wrong chain is still a THROW, not an absence. Alternative: mirror `StreamFetcher`'s optional result for familiarity (rejected: it would invite `?.` on a thing that never answers nothing, and copying the seam's shape is what got the fixture onto the seam in the first place). Touches: any caller written against the old `?.` (only core's own tests today) and the changeset says so.
- **Named `StreamFixtureReader`, and it lives in `stream/fixture.ts`.** Coherence check: `StreamReader` already means "the READ half of the KEEPER seam" in `stream/readOnly.ts`, so I did not reuse or re-mean it; the new name is qualified by its subject and sits with the fixture it reads, so the seam narrowing (`the-stream-seam-takes-only-the-stored-event`) can move `StreamReader` onto the stored-event type without touching the fixture. Touches that sibling task, which already expects the fixture to be off the seam.
- **ADR-0044 is amended in place with a stale-on-its-example note pointing at ADR-0059, not rewritten**, and ADR-0035's "third implementation of this seam" clause got the same one-clause correction (its evidence about the empty window is unaffected). Alternative: leave both ADRs alone as historical records (rejected: ADR-0044's rejected-alternatives bullet is cited as current rule, and a reader arriving with it in hand would find the code contradicting it).
