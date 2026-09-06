---
title: 'The stream stores only what the node said'
slug: the-stream-stores-only-what-the-node-said
taskedAfter: [appending-to-the-stream-costs-the-batch, a-reconfigure-is-not-an-outage]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **SPLIT out of `the-stream-is-what-the-node-said-appended-once` after four review rounds.** That
> spec bundled the append-cost change with this one. Every new blocker across all four rounds landed
> in THIS half, because it is a breaking public API change entangled with a third seam
> implementation, while the append half was stable from its second draft. Separating them means the
> append win can land without waiting on a type migration.

## Problem Statement

A stored `LogEvent` is two things at once: the raw log (`topics`, `data`, `address`), which is what
the node said and is true forever, and `args`/`eventName`, which is what SOME ABI made of it.

**Only the second can be wrong.** It goes stale whenever decoding moves without the fetch moving,
which is exactly what a renamed non-indexed parameter does: `topic0` hashes types and not names, so
every cached log is still exactly the right log while every cached `args` is filed under a key the
handler no longer reads.

ADR-0034 already had to work around this with an unconditional `reparse`: the stream cannot say per
event which ABI decoded it, so every replay re-decodes regardless. That is a workaround for storing
a derivation next to its source.

**This is a correctness-shaped problem, not a size one.** The three inherited figures that used to
disagree here (32.5 against 8.6, and 32.5 against 20.5) are RETIRED: they were re-measured on the
same 31,330 real Base logs and are now **27.8 MB full (raw + decoded), 21.1 MB raw-only, 17.0 MB
decoded-only** (`work/notes/findings/replay-parse-cost.md`, consequence 3). So raw-only saves 24% of
today's stored bytes while being 24% LARGER than the decoded half alone — which is exactly why the
case is CORRECTNESS (the decoded half is the only half that can go stale) and not size. Quote these
figures rather than re-measuring, and do not resurrect the retired ones.

> **EVALUATED AND REJECTED, recorded so the next reader does not re-derive it: making story 3's reuse
> CONDITIONAL on a decode identity.** The idea is to keep the decoded half as a guarded cache, keyed
> on a decode-sensitive digest, so a processor-only change skips decoding and only an ABI change
> reparses. It was investigated with measurement (`docs/spikes/replay-decode-cache/`) and refused on
> four counts: the cost it removes is mostly not decoding at all but a per-call ABI re-search that
> can simply be DELETED (see the memoisation task below, 3.2x for zero stored bytes); what remains
> afterwards is 11.5 us/event, which is 4% of a server replay; the guard covers the ABI but NOT the
> decoder, so it is incomplete in a way this repo cannot close; and it would fork the storage shape
> away from the server's `_emissions`, which already stores raw only. Adopting it would also need a
> stored type that permits the decoded half, a per-segment identity field, a new 128-bit decode
> digest and a decoder-version input — a different spec, not an amendment to this one.
>
> **Ordering, decided:** `decoding-is-3x-faster-with-a-memoised-topic0-map` lands FIRST and
> SEPARATELY. It is a private-method optimisation; this spec is a breaking type migration. Merging
> them would entangle a behavioural change with an API change for no gain.

## Solution

**The stream stores only what the node said**: raw logs plus the reorg flag the indexer derived; no
`args`, no `eventName`. Decoding happens on read, which is what `reparse` already does transiently
and what the fetch path pays anyway.

**This needs a NEW stored-event type that EXCLUDES the decoded half.** A raw-only event is not a
`LogEvent`: that is a union of `ParsedLogEvent` (carrying `args` and `eventName`) and
`LogEventWithParsingFailure` (carrying `decodeError`), and an event with neither belongs to neither.

Do NOT reuse `BaseLogEvent`. It already exists, is already exported, and is the SUPERTYPE every
decoded event extends (`ParsedLogEvent = BaseLogEvent & LogParsedData`). Reusing it would re-mean a
published type AND enforce nothing, because a decoded `LogEvent[]` is assignable to
`BaseLogEvent[]` — that is what a supertype is — and excess-property checks fire only on fresh
object literals. A keeper could receive, hold and persist decoded events in silence.

So mint a distinct name whose shape REFUSES the decoded half:

```ts
type StoredLogEvent<Extra = undefined> = BaseLogEvent<Extra> & {args?: never; eventName?: never; decodeError?: never};
```

**This form was verified with `tsc`, not reasoned about.** It rejects `ParsedLogEvent` both with and
without inputs, and rejects the union via `LogEventWithParsingFailure`, while accepting a raw event.
The repo does not set `exactOptionalPropertyTypes`, so the interaction that would otherwise make
`?: never` unreliable does not arise. One known hole, worth stating rather than hiding: an event
whose STATIC type has already been widened to `BaseLogEvent` still assigns, so the guard is at the
seam, not through a widening.

**`StreamFetcher` and `StreamSaver` move onto it.** That is a breaking `@etherfold/core` change and
it needs a changeset.

## User Stories

1. As a developer, I want the stream to hold what the node said and nothing derived from it, so
   nothing in it can disagree with my current ABI.
2. As an implementor of `ExistingStream`, I want the stored-event type to REFUSE a decoded event, so
   a keeper cannot accidentally persist one and I find out at compile time.
3. As a developer whose ABI changed only in how it decodes, I want the cached stream reused without
   re-fetching a block. (Already true today via ADR-0034's `reparse`; this makes it structural
   rather than a workaround, and that is the honest framing.)
4. As a developer upgrading, I want segments written before this change to keep working untouched,
   so adopting a stricter stored type costs me no rebuild.
5. As a developer, I want NO configuration capable of stripping the raw log out of what is stored or
   sent, so that raw-only storage cannot be defeated by a setting and an event can never arrive with
   nothing left to decode from. Delivered by DELETING `logValues`, not by relocating it.

## Implementation Decisions

**Core strips the decoded half, not each keeper.** `ExistingStream` is third-party-implementable with
three implementations already; putting the rule in each would let them drift. Strip on the way into
`saveNewEvents`, producing NEW OBJECTS: a new array holding the same references strips nothing, and
those references are the very objects just handed to `processor.process`.

**`reparse` widens to accept the stored type.** It is typed `readonly LogEvent<ABI>[]` and is the
SOLE consumer of what `fetchFrom` returns, so "decoding happens on read" rests on widening its
parameter. Small, but it is the seam that makes the change work.

**`lastSync`'s events are stripped too.** `LastSync.unconfirmedBlocks` holds full DECODED events, and
the STREAM keeper's stored copy is never read back as events: `promiseToLoad` takes only
`lastFromBlock`, `lastToBlock`, `latestBlock` and `context`, the live reorg window is `this.lastSync`
in memory, and `checkTxInclusion` answers from the STATE keeper's copy. So keeping them decoded would
leave the one stale thing in the stream. **The strip must build a NEW `LastSync`**, because the same
object is handed to the state keeper on the same tick and a mutating strip would silently empty the
live reorg window.

> **ORDERED AFTER `a-reconfigure-is-not-an-outage`, and the REASON HAS CHANGED — read this rather
> than re-deriving the old one.** The edge originally rested on that spec's SEEDING path, which used
> `replayStream` returning an `ExistingStream` (`stream/fixture.ts`) — a seam this spec narrows so it
> no longer can. **Seeding has since been SPLIT OUT** into
> `a-generation-can-be-seeded-from-a-published-artifact`, so that reason has evaporated: nothing left
> in `a-reconfigure` depends on `replayStream`.
>
> The edge SURVIVES on a different and still-live ground: **file overlap**, though it is NARROWER
> than it was. An earlier draft of `a-reconfigure`'s landable 1 rewrote the whole stream keyspace,
> which touched everything this spec touches. Hierarchical addressing removed that: the prerequisite
> now leaves a PLACEHOLDER digest level and landable 1 only fills it, so there is no key rewrite and
> no migration. What still overlaps is real but smaller — both changes land in `@etherfold/core`
> (the digest computation and the shared segmentation helper there, against `saveNewEvents`'s strip
> of the decoded half) and in both keepers (address construction, against persisting the narrowed
> shape). Landed the other way round they rebase onto each other in the same files for no gain. This is
> `TASKING-PROTOCOL` section 3's serialise-on-shared-files rule applied across specs, not a logical
> dependency: nothing here NEEDS the generation model, it just must not collide with it.
>
> **`taskedAfter` orders TASKING, not LANDING, so the tasker must carry this through.** The collision
> this edge names is a merge conflict between two sets of tasks, and ordering the tasking alone does
> not prevent it. The tasks emitted from THIS spec must carry `blockedBy` onto `a-reconfigure`'s
> landable-1 tasks (`TASKING-PROTOCOL` §3, serialise tasks known to touch the same module).
>
> The `replayStream` disposition below is unchanged and is still this spec's to do — it is now owed
> to the SEEDING spec rather than to `a-reconfigure`. Whichever lands first, the seeding path must be
> written against the seam as it stands THEN, and `CONTEXT.md`'s `seeding` glossary entry — which
> names `replayStream` as returning an `ExistingStream` — must be updated in the SAME change.

**`replayStream` stops being an `ExistingStream`.** The exclusion form forces this and it is the
right answer rather than a casualty. Nothing wires `replayStream` as `keepStream`, so they never meet
at RUNTIME, but `replayStream` DECLARES `ExistingStream` and `StreamFixture.eventStream` is
`LogEvent[]`, so narrowing the seam stops it compiling. A fixture is a decoded test INPUT; a keeper
is a store of what the node said. They have been sharing one interface because nothing made them
differ.

So the fixture gets its own reader type and its format is untouched. **And `fixture.ts`'s docstring
must be rewritten in the same change**: it currently sells `replayStream` AS the `keepStream` seam
("this is the seam the indexer already consults before fetching, so pointing it at a fixture is how a
run gets its events from disk"). Leaving that would ship documentation telling a user to do what the
types now refuse. Its one real consumer is `packages/core/test/streamFixture.test.ts`, which calls
`fetchFrom`/`saveNewEvents` structurally; the conformance workload does not use it at all.

**What this does NOT do is keep two shapes behind one interface** with an already-decoded
discriminator. That was considered and rejected: it preserves the ambiguity the type exists to
remove.

**Decided: `logValues` is DELETED, not relocated.** An earlier draft made it a PROCESSOR-facing
projection so that storage (and later the wire) would always keep the raw log. That was the right
constraint and the wrong mechanism, because it preserved a knob whose entire purpose it had just
removed.

**What `logValues` is, since the name suggests something else.** It is not a decoding option. Its type
is `OptionsFlags<NumberifiedLog>` — an allowlist over the RAW log's own fields (`address`, `topics`,
`data`, `blockNumber`…) — and the implementation keeps `args` UNCONDITIONALLY while dropping every raw
field not explicitly named. So it preserves the DERIVATION and discards the SOURCE, which is exactly
backwards under raw-only storage: after this spec strips `args` on the way in, an event whose raw half
was projected away has NOTHING left. That is the `reparse`-returns-`undefined` case and the reason
ADR-0034 mandates clearing such a stream.

**The evidence for deleting rather than keeping it, checked rather than assumed:**

- **It has ZERO callers.** Outside core's own type definition and implementation, nothing in the repo
  sets it: no example app, no test, no processor. What exists is the definition, the implementation,
  generated API docs, a TODO asking for it to be TYPED, and defensive machinery guarding its
  consequences.
- **`docs/reviews/todo-triage.md` calls it a "flag STUB"**, which is what it is: unfinished.
- **Its sole purpose is removed by this spec.** The root `TODO.md` item it stubs
  ("NumberifiedLog / LogEvent could have fields removed, configuration on config.stream") is about
  reducing what is STORED, and this spec decides storage always keeps the raw log.
- **It is net negative to keep**: an extra object allocation per event, and a live footgun — the loop
  iterates `Object.keys(logValues)` and never reads the boolean, so `{topics: false}` KEEPS `topics`,
  the opposite of what the type invites you to write.

**Deleting is LESS work than relocating**, which is the decisive practical point. Relocating meant
moving the projection off the object that gets stored, a real change to the fetch path; deleting is
removing the branch. It also makes the guarantee STRUCTURAL rather than merely stated: no
configuration CAN strip the raw log, so the sibling specs that depend on it (`indexer-server-feed`'s
indexed `address`/`topic0..3` columns, `node-log-api`'s `eth_getLogs`, the server-side rebuild) need no
constraint at all.

**Scope of the deletion**: the `logValues` field on `LogParseConfig`, the `LogValuesFlags` type, the
projection branch in `LogEventFetcher.parse`, the `indexer.ts` TODO asking for it to be typed, and the
root `TODO.md` line it stubs (closed by deciding NOT to build it). Breaking, and cheap: nothing is
published (`CONTEXT.md`), so it costs a changeset and no migration.

**What the deletion does NOT remove is the detect-and-clear guard.** A stream written by an older
version under a projecting parse can still exist on disk, and ADR-0034 mandates clearing one that
cannot be re-read. That branch stays as pure defence and simply becomes unreachable for new writes.
`appending-to-the-stream-costs-the-batch` tests it, so a builder must not delete a guard its sibling
just landed.

**Existing segments keep their decoded halves, and that is tolerated on READ.** After this lands,
segments already written by `appending-to-the-stream-costs-the-batch` still hold `args` and
`eventName` forever. Runtime is unaffected, since `reparse` discards and re-derives them anyway. But
the type would then describe something untrue of the bytes on disk, so say which it governs: the
stored type governs WRITES from here on, reads tolerate a decoded half and ignore it, and no
rewriting migration is performed. Pin that with a test rather than leaving it to be discovered.

## Testing Decisions

- **The refusal is a TYPE claim and needs a type test.** Assert it under `pnpm typecheck` with
  `@ts-expect-error`, in the style of `packages/browser/test/processorKinds.test.ts`. Note the trap:
  both `keepStream` call sites in the browser tests pass the keeper through as `never`, so a
  stored-event break is INVISIBLE there — those tests passing unchanged proves nothing about the
  compile-time half.
- **Reuse across a decode change** is already pinned by `packages/browser/test/invalidation.test.ts`;
  those tests passing unchanged is the evidence that raw-only loses nothing at RUN time.
- **`fetchFrom` answers the same membership and order** for the same `fromBlock`, with the same raw
  halves. Not event-for-event equality, since it now returns raw-only where it returned decoded,
  which is the change itself.
- **The `lastSync` strip does not mutate**: the object handed to the state keeper still carries its
  unconfirmed window after a stream save.
- **A segment written before this change still replays**, carrying a decoded half that is ignored
  rather than refused, which is the upgrade guard for story 4.
- **`logValues` is GONE**, asserted as a type-level absence (`LogParseConfig` has no such field) and
  by the projection branch being absent from `parse`. The `reparse`-returns-`undefined` branch is
  then unreachable for anything newly written, while remaining reachable for a stream already on
  disk — assert BOTH, since the guard must survive.

## Out of Scope

- **Everything in `appending-to-the-stream-costs-the-batch`**: segments, `clear`, enumeration, the
  `lastSync` key, the structural migration. This spec assumes that landed.
- **The wire format's DECODED shape.** `WireBatch` keeps shipping decoded events, since the receiving
  primitive takes them and the sender holds the ABI. Storage and wire may differ on that axis. The
  PROJECTION question does not arise once `logValues` is deleted: there is nothing left that could
  strip the raw log from either.
- **Per-segment filter or lineage provenance.**

## Further Notes

Story 3 is already delivered today by ADR-0034's unconditional `reparse`, so this spec is smaller
than it reads: its real content is the stored type, the strip, and the `replayStream` disposition.
