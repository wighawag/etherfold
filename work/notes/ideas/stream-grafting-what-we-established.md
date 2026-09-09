---
title: 'Stream grafting: the invariants we established, the options we weighed, and what is still open'
slug: stream-grafting-what-we-established
---

> **SUPERSEDED IN ITS CONCLUSION, KEPT FOR ITS EVIDENCE. Read this box before anything below it.**
>
> The INVARIANTS section is still true and still the reason this note exists: every claim in it was
> established by reading the code and is expensive to re-derive. The NAMING section is still true.
>
> **The chosen design is NOT the one recorded below.** Option D (two labels in one stream) was chosen,
> specced, reviewed four times, and then REPLACED. What is built is
> `work/specs/tasked/a-reconfigure-is-not-an-outage.md`: N generations, each with its own stream
> keyed by its FETCH FILTER, and a canonical pointer. Two reasons it replaced D, both recorded here so
> the argument is not had again:
>
> - a two-valued label caps the design at two generations BY CONSTRUCTION, so rollback and N were not
>   reachable without a redesign (the option-D spec claimed they were, and was wrong);
> - the shared-keyspace promotion machinery accounted for six of the ten blocking defects four review
>   rounds found, and regenerated a new one each time it was fixed.
>
> So read the options below as the OPTIONS WEIGHED, not as a verdict. Where a section says "chosen",
> it means chosen at the time.

> **This is a DESIGN RECORD, not a spec.** It exists so the specs in
> `work/specs/proposed/` can state ONE design without carrying the argument that produced it.
> Written at the end of a long design conversation that ran through seven review rounds; the specs had
> accumulated so much "an earlier draft said X, which was wrong because Y" that reviewers were
> repeatedly finding paragraphs contradicting each other rather than finding real defects.
>
> Extends the discharged idea note `a-stream-branches-instead-of-being-discarded`, which framed the
> original question ("should a stream BRANCH rather than be discarded?") and is answered by the
> current design: it does not branch, each generation gets its own stream. Deleted per the
> capture-bucket rule; in git history if wanted.

## Why this matters

A reconfigure (a source change, or a processor change) currently DISCARDS the state and re-indexes.
On a browser that blanks the app; on a server it is an outage. The idea is to build the replacement
alongside the live one and switch when it is ready, which needs the replacement to reuse as much of
the existing event stream as possible rather than re-fetching it.

## Invariants established BY READING THE CODE

These took the most work to establish and are the most easily lost. Each was checked, not reasoned
about.

**Reorgs are bounded by the finality depth.** The indexer re-fetches from `latestBlock - finality`
every round (`packages/core/src/indexer.ts`, and `getFromBlock`), and the reorg search window is
`lastSync.unconfirmedBlocks`. Default `finality` is **17** (`internal/engine/utils.ts`,
`resolveStreamConfig`). So no reorg reaches below `latest - finality`, and since `latest` only grows,
a block once below that horizon stays below it.

**A reorg APPENDS, it never rewrites.** On a reorg the indexer re-appends the superseded events
carrying their ORIGINAL `blockNumber`, flagged `removed: true`
(`internal/engine/utils.ts`, ~line 188), then continues indexing at LOWER block numbers. Two
consequences that shaped everything:

- stored segments are immutable regardless of any policy we adopt, because nothing ever rewrites
  them;
- block ranges across segments OVERLAP and are not monotonic, so `(blockNumber, logIndex)` cannot key
  or order an emission stream. This is ADR-0006's argument and it applies to the client cache too.

**`unconfirmedBlocks` self-prunes in the live path** (`internal/engine/utils.ts`: a block is kept only
if `newLastToBlock - unconfirmedBlock.number <= finality`), but a copy frozen inside a stored record
does NOT self-prune, because nothing rewrites it.

**`EventBlock` keeps events on purpose.** `packages/core/src/types.ts` carries the comment: _"this
could be replaced by start: number; end: number but we would need access to the old corresponding
events"_. Retraction needs them. Relevant every time someone proposes stripping them.

**Events carry `blockHash`** (`NumberifiedLog`), so an unconfirmed window is plausibly
RECONSTRUCTIBLE from the events themselves. Not verified: whether blocks with NO events matter, since
`unconfirmedBlocks` appears to be built from event-bearing blocks.

**The stream is one blob rewritten in full on every append.** Both keepers
(`packages/fs/src/storage/stream/OnFile.ts`, `packages/browser/src/storage/stream/OnIndexedDB.ts`)
read the whole stream, concat, and write it all back, and `save` runs once per index cycle. So a
backfill is QUADRATIC today. Recorded separately in
an observation since discharged and deleted.

**Stream keys are `stream_<name>_<chainId>`.** So a bare prefix filter COLLIDES ACROSS CHAINS:
`stream_tag_1` is a prefix of `stream_tag_10_0`. Any enumeration must be anchored with a numeric
suffix.

**Both fs keepers share one folder.** `keepStateOnFile` writes `<name>_<chainId>` into the same
directory the stream keeper uses.

**`idb-keyval` ships `keys`, `getMany`, `setMany`, `delMany`, `clear`**; the keepers import only
`get`/`set`/`del`. `packages/fs/src/utils/fs.ts` is OUR file, a `readdir` away from enumeration. So
"neither keeper can enumerate" was false. Note `idb-keyval`'s `clear()` wipes the WHOLE store, not one
stream.

**`EthereumIndexer` calls `keepStream.saveNewEvents` UNCONDITIONALLY** on every save
(`indexer.ts` ~687). So "a successor that is a pure reader" is NOT expressible by simply not writing;
it needs a read-only stream view whose `saveNewEvents` is a no-op.

**`keepStream` is a single injected instance** keyed without any generation, so a successor that needs
its OWN stream has nowhere to put it today.

**`ProcessorContext` is `{source, config?, version}` and its `config` is the PROCESSOR config**, while
`ContextIdentifier.config` is the `streamConfigHash`. They are different things with the same field
name. A keeper cannot derive a generation identity from `ProcessorContext`.

**`sourceInvalidationOf` already folds the config hash into its verdict** (it compares
`context.config` first and returns both halves invalid on mismatch), so identity is the VERDICT plus
the PROCESSOR hash. Adding config again would be a redundant comparison.

**The ingest server DOES host a processor.** `createServer` takes an injected `getIngestion`;
`StreamBuilder` calls `processor.clear()` on a changed source, config or processor version; the 501
body reads _"this server hosts no processor: pass getIngestion"_. It never constructs an
`EthereumIndexer`, which misled two drafts into excluding it.

**The CLI never reconfigures.** Zero `updateProcessor`/`updateIndexer` call sites; it is a one-shot
`indexToTip` batch that exits, and its `serve` verb imports the platform server.

## Naming: three collisions, for the next author

`version` is taken (an entity row with a half-open block-validity range, plus a processor's `version`
field). `deployment` is worse (53 uses: "split deployment", "browser deployment"). `candidate` is
taken (a snapshot that may be adopted, in the entity snapshot path). The unit is now a
**generation**, with **live** and **successor**, both of which had zero prior uses.

## The design options weighed

The question is how a successor reuses the live stream.

**A. Read and filter.** Read the whole live stream, keep events below the graft point, write them into
the successor's own stream, fetch from the graft point up. Needs nothing added. Self-contained
streams, trivial deletion. Costs a full local read and write of the prefix, which is real at
gigabyte scale and worst on IndexedDB.

**B. Share by reference.** The successor references the live stream's segments below the graft point.
No copy. Earlier objections to it were each wrong: it does NOT need a finality clamp (a successor
inheriting the cursor can derive reorgs itself), and it does NOT need per-segment block-range metadata
(each segment already embeds the `lastSync` current when it was written, so grafting at a SEGMENT
BOUNDARY rounded DOWN needs no new data). What it did need was a lifetime rule, because a stream
referencing another stream chains across successive grafts.

**C. Graft at the latest point.** Not a separate option: the graft point is `invalidFromBlock` from
the verdict, not a free choice, so "graft at latest" is the degenerate case where nothing below the
cursor was invalidated, which is whole-stream sharing.

**D. TWO LABELS — chosen at the time, SINCE SUPERSEDED (see the box at the top).** Do not make a
stream a keyspace at all. Give each stream
entry a label, `live` or `staging`:

```
staging read:  WHERE gen = 'staging' OR (gen = 'live' AND seq <= N)
promotion:     DELETE WHERE gen = 'live' AND seq > N
               UPDATE SET gen = 'live' WHERE gen = 'staging'
```

**Relabelling on promotion is what kills the chain**, which is why this beats B. After promotion
everything is simply `live` with no record of which generation wrote it, so there is never a second
level to accumulate. Exactly two labels, forever. On the server this is an indexed bulk update and is
the literal implementation.

## The three sharing cases

Which case applies is decided by the invalidation verdict, not chosen:

- **whole-stream** (a processor-only change, a decode-only change: the topic set is unchanged, so
  every log the successor needs is already stored). It re-fetches NO HISTORY and re-folds from the
  live stream. The most common case by far, since an ABI is regenerated more often than it is
  meaningfully changed.

  > **Superseded in one detail by the spec.** This bullet originally read "it fetches NOTHING and
  > writes nothing until promotion", which was true of option B, where the successor was a pure
  > reader over the live stream. The spec chose ONE successor mechanism instead of two, so the
  > successor is an ordinary indexer that follows the head itself: it re-fetches no HISTORY, but it
  > does fetch the head-following TAIL (the doubling this note already records as acceptable) and it
  > does write its own staging segments. See `a-reconfigure-is-not-an-outage`, which states the price
  > and why it was worth one mechanism.
- **partial graft** (an event added or edited below the cursor). Reuses below the graft point,
  re-fetches above it.
- **no sharing** (a changed address, a new contract: these land in the block-0 skeleton entry, so
  nothing below is valid). A full backfill.

## ANSWERED: the promotion cost — for a question the design no longer asks

> **This section answered option D's open question.** The chosen design has no label to place, so the
> conclusion below decides nothing today. It is kept because the MEASUREMENTS are reusable (renames
> are free on the filesystem; IndexedDB is indifferent between a rename and a rewrite; a value read
> costs the whole payload) and because it is part of why D was abandoned.

The promotion cost was the open question here and it is now MEASURED, not argued:
`work/notes/findings/promotion-cost-of-a-two-label-stream.md`, evidence in
`docs/spikes/promotion-cost-of-a-two-label-stream`.

**Put the label in the KEY** — the verdict, for the design that no longer exists. The short version,
with the reasoning in the finding:

- **IndexedDB does not decide the question; the filesystem does.** IndexedDB has no rename, so a
  key-label relabel there is the same read-plus-write a value-label rewrite costs, and the two
  measure the same on all three engines. On the filesystem a key-label promotion writes NO segment
  bytes at all (250 renames, 18 ms over a 136 MB stream) against 135.6 MB and 1.8 s for a value label.
- **A value label cannot be found without reading the values it is in**, so even the whole-stream
  case — which relabels nothing and should be free — costs a full deserialise of the history (820 ms
  on the filesystem) unless a separate boundary pointer is added, which is a second source of truth
  of exactly the kind `appending-to-the-stream-costs-the-batch` already rejected.
- **A value label also forces a HOLE in the ordinal space**, because with one key space staging must
  append after the live TAIL rather than from the graft point, so promotion leaves a gap that the
  contiguity refusal reads as a lost fragment.
- **Promotion cost does not constrain the design on either keeper.** It is bounded by what STAGING
  WROTE, which is nothing in the most common case, and in the worst case it is under one percent of
  the backfill that produced it.

## What is still OPEN

**Whether the unconfirmed window must be stored per boundary or can be reconstructed.** Storing it in
every segment is wasteful and cannot be pruned (segments are immutable). Reconstructing it from the
events is plausible since they carry `blockHash`, and a successor re-fetches from
`lastToBlock - finality` on its first round anyway. This point flipped three times in conversation,
which is the signal that it should be settled by a build rather than by more prose.

## State of the specs — SUPERSEDED SNAPSHOT, kept only to date the note

> This section and the next described the spec tree as it stood when this note was written, and BOTH
> are now out of date in ways that would mislead. The note's VALUE is the invariants and the options
> weighed, above; do not take routing advice from here. The current tree is whatever is in
> `work/specs/*/`, and the entry points are `a-reconfigure-is-not-an-outage` (the model) and
> `work/specs/tasked/appending-to-the-stream-costs-the-batch` (the foundation, now tasked).

As of this note, four sat in `work/specs/proposed/`: `appending-to-the-stream-costs-the-batch`,
`the-stream-stores-only-what-the-node-said`, `a-reconfigure-is-not-an-outage`, and
`an-ingest-server-reconfigure-is-not-a-blackout` (an honest stub).

What has happened to each since, so a reader is not sent somewhere that has moved:

- **`appending-to-the-stream-costs-the-batch`** is TASKED (`work/specs/tasked/`), with two tasks in
  `work/tasks/backlog/`. Its durable rationale — the four-property cursor contract, and why cursor
  PLACEMENT is left to each keeper — is ADR-0035. The per-segment block-range requirement this note
  flagged was duly reverted.
- **`a-reconfigure-is-not-an-outage`** was rewritten, but NOT against option D. Option D was
  abandoned entirely — see the supersession box at the top of this note. It is now N generations,
  each with its OWN stream keyed by its fetch filter, plus a canonical pointer; and it is
  BROWSER-SCOPED, with the server and CLI runtime split out.
- **`an-ingest-server-reconfigure-is-not-a-blackout`** is DROPPED (`work/specs/dropped/`). It is
  replaced by `the-server-and-cli-hold-generations-too`, which is the real server tier and which also
  absorbed `indexer-server-feed`'s rebuild stories.
- **Two specs exist that this note never mentions**, both split out under `TASKING-PROTOCOL` §2a:
  `the-server-and-cli-hold-generations-too` (the server/CLI runtime, gated) and
  `a-generation-can-be-seeded-from-a-published-artifact` (an EXPLORATION spec for the seeding path).

**No forward guidance in this note is still live.** The "What is still OPEN" question above — whether
the unconfirmed window must be stored per boundary or can be reconstructed — was SETTLED, and by a
build rather than by more prose, which is what this note asked for. The answer is ADR-0035: a sealed
segment keeps its scanned extent and NOT its window, and the truncation recovery composes a cursor
with an EMPTY window, which is safe because the surviving prefix is REPLAYED first and
`generateStreamToAppend` rebuilds `unconfirmedBlocks` from the replayed events. Read this note now
only for its INVARIANTS and its OPTIONS WEIGHED.
