---
title: 'One registry entry holds SEVERAL live wire contexts, and expected-from-block answers per context'
slug: one-registry-entry-holds-several-live-wire-contexts
spec: the-server-and-cli-hold-generations-too
blockedBy: [a-changed-context-creates-a-successor-instead-of-clearing]
covers: [1, 2]
---

## What to build

A FILTER or CONFIG change makes a NEW STREAM, and a successor on a new stream cannot receive a single
log today: `ServerOptions.getIndexer` resolves ONE `LogIngestion` with ONE readonly `WireContext`, and
`assertContext` refuses a foreign `{source, config}` with a `400` that is deliberately not resumable.
So the successor starves while the incumbent is still being fed. This is the server's version of the
browser's "a successor follows the head itself", and it does not port, because in a browser the
indexer owns its own fetching and here it does not.

The widening the registry entry was DESIGNED for (read its docstring): **one entry holds SEVERAL LIVE
WIRE CONTEXTS.** The route selects the INDEXER; the batch's own `{source, config}` then selects WHICH
stream-builder within that entry receives it. A context in NEITHER is still the existing `400`, so the
refusal families are untouched: `409` stays the one resumable refusal, a foreign context and a
malformed range stay `400`, an unknown name stays `404`, and a host with no registry stays `501`.

`POST /{indexer}/ingest/expected-from-block` correspondingly answers with one
`{context, expectedFromBlock}` per LIVE context instead of a single pair. That is a WIDENING of what it
already does — it returns its `context` beside the block number precisely so a sender knows which
receiver it reached — and it is what lets one fetcher host later run one fetch loop per context.
Record it as a deliberate response-shape change with a changeset.

**A live context has a LIFETIME, and this task owns the MECHANISM of it.** A successor's context
becomes live when the successor is created, and stops being live when its generation is DELETED (and,
if that was the stream's last generation, when the stream is reaped with it). Get this wrong and
either a retired stream keeps being fed or a live one stops being.

What this task must NOT bake in is what happens to a RETIRED-BUT-RETAINED generation's context after
the canonical pointer moves. Under this spec a superseded generation is retained rather than dropped
(that is the part of ADR-0008 the spec supersedes), so 'the successor became canonical' is NOT by
itself a reason to stop feeding the old context, and whether it should be is an open question on
`the-rebuild-replays-the-local-stream-in-bounded-chunks` (question 2). DERIVE the live set from the
registry — which generations are registered and indexing — so that answer becomes a small policy
input here rather than a rewrite of this task's routing.

**The feed follows the canonical generation.** `GET /{indexer}/feed` and `/{indexer}/canonical`
currently key their read (and validate the cursor's stream component) off the single entry's
`streamDigest`, and advertise that entry's `generation`. With several contexts in an entry the answer
must be the CANONICAL generation's stream and fold, read ONCE per request so a response never pairs
one with the other's neighbour. The existing refusals stay what they are: a cursor for a stream no
longer served is answered with the current stream identity and a cursor at its start, and is
explicitly not a rewind.

Scope fence: the RECEIVER, plus keeping the existing SENDER green (a fetcher pushing one context finds
its own entry in the list and behaves as before). A fetcher host running one loop per context is
enabled by this and is NOT built here.

## Acceptance criteria

- [ ] A registry entry can hold several live wire contexts; the ingest route selects the indexer by
      route segment and the stream-builder by the batch's own `{source, config}`.
- [ ] A successor on a NEW stream receives its own batches while the incumbent keeps receiving its own,
      and neither advances the other's cursor.
- [ ] `expected-from-block` answers one `{context, expectedFromBlock}` per live context; a sender
      pushing one context still resumes correctly, including through a `409` correction.
- [ ] The refusal families are unchanged: unknown name `404`, no registry `501`, context in no entry
      `400` (not resumable), wrong `fromBlock` `409` carrying the expected value.
- [ ] A context stops being live when its generation is deleted or its stream is reaped, and a batch
      for it then gets the ordinary `400`.
- [ ] The live set is DERIVED from the registry rather than from a hard-coded 'a promotion retires the
      previous context' assumption, so the retained-generation rule can be set without reworking the
      routing.
- [ ] Both feed views answer from the CANONICAL generation's stream and advertise its generation, with
      the stream and the generation read once per request.
- [ ] A changeset records the response-shape change.
- [ ] Tests cover the new behaviour, in the repo's existing style.

## Blocked by

- `a-changed-context-creates-a-successor-instead-of-clearing` — there is nothing to hold several
  contexts FOR until a successor can be created, and both tasks touch the registry entry.

## Prompt

> Let ONE named indexer receive logs for SEVERAL live streams at once, so a filter change can build a
> successor while the incumbent keeps being fed and keeps answering.
>
> Vocabulary (`CONTEXT.md`): the **named indexer** is a ROUTE SEGMENT and a name-keyed REGISTRY entry,
> and is deliberately NOT a field in the ADR-0004 envelope; a **wire batch** is that envelope
> `{context, fromBlock, toBlock, latestBlock, logs}`; **the cursor is the idempotency key**, so `409` is
> the ONE resumable refusal and every other refusal is a `400`; the **two views** over the stored
> emission stream each keep their own cursor, and every feed response advertises the **generation** it
> answered from.
>
> Where to look: `packages/server/src/registry.ts` (its docstring already describes exactly this
> widening and why the entry is an object), `packages/server/src/api/ingest.ts`, `api/resolve.ts`,
> `api/feed.ts`, `packages/server/src/feed/cursor.ts` (what a cursor carries and which refusal answers
> with what), `packages/core/src/streamBuilder.ts` (`assertContext`, `WireContextMismatchError`,
> `streamDigest`, `generation`), and the sending side in `packages/core/src/ingestClient.ts` plus
> `@etherfold/fetcher-host`.
>
> Constraining decisions: ADR-0004 (the wire contract, the two refusal families, a partial range is
> never pushed), ADR-0036 (the name is structural and never defaulted on the wire; a name a host was not
> built with is a `404`), ADR-0006 (the two views), ADR-0044 (only the indexing generation writes a
> stream).
>
> Seams to test at: the HTTP routes (status codes and bodies) and the stream-builder selection beneath
> them. Done means two streams under one name are fed independently, `expected-from-block` reports both,
> and the feed still answers from the canonical generation alone.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if a
> dependency landed differently or an ADR superseded an assumption here, route the task to
> needs-attention with the discrepancy rather than building on the stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do
> not write the done record, the commit message or the PR body yourself.


## Decisions

**The entry became TWO ASYNC QUESTIONS (`liveIngestions()` / `canonicalGeneration()`), not a list field.** Liveness and the canonical pointer are facts only the durable generation registry holds, and both move without this host being told (a generation deleted by an operator making room at a cap; a pointer moved by another process), so a record captured at boot could express neither. Alternatives considered: a plain `ingestions: LogIngestion[]` field (cheap, but then "live" could only mean "what this process last thought", which is exactly the hard-coded retirement rule the task forbids), and keeping `ingestion` beside a new plural (two ways to say one thing, and every route would have to choose). Touches every host's resolver — `packages/cli/src/indexCommand.ts`, `platforms/nodejs` (type only), and the `getIndexer` docs — and it is what lets `ReceivingIndexer` be registered as the entry with no adapter. The resolver itself stays SYNCHRONOUS: resolving a NAME is a lookup in what the host was built with (so `404`/`501` still cost no database read), while resolving what the name currently HOLDS is the async part.

**ONE RECEIVER PER STREAM, and `add` REFUSES a second fold on a stream already held.** A batch carries `{source, config}` and nothing that could tell two folds over one stream apart, so a second receiver at that address would be reachable only by iteration order. Such a fold is a PROCESSOR-change successor, and ADR-0044 already says how it advances (re-fold the stream its writer stores), so the refusal points there. It is a new REFUSAL, deliberately a plain `Error` at host-assembly time rather than a typed one (precedent: `createHttpIngestion`'s "needs the NAME") because no sender or fetcher host classifies it. Consequence I did NOT build, and which ADR-0044's amendment already reserved: deleting a stream's writer removes the only receiver that stream had, so its context stops being live rather than the wire moving to the next-oldest generation — the records succeed instantly, the engine half does not. Recorded as a dated addendum to ADR-0044 rather than a new ADR, since it is that ADR's own rule applied rather than a new decision. Touches `the-rebuild-replays-the-local-stream-in-bounded-chunks` and `the-cli-and-the-server-hold-generations-the-same-way`, which build the hosts that would hold such a fold.

**`expected-from-block` answers a `contexts` LIST with no top-level pair, and the ASK NAMES THE ASKER.** The task requires the list; what it does not settle is how a sender picks its entry, and `createHttpIngestion` cannot know its own `{source, config}` (only `LogFetcher` does). So `IngestionTarget.expectedFromBlock(context)` takes a REQUIRED argument. Alternatives: keep a top-level pair beside the list (a single pair can only ever name one of several — silently wrong, and this repo does not do accept-and-ignore), or have the client take the FIRST entry when it cannot match (the plausible-wrong-answer this design refuses). Consequence, and the one user-visible behaviour change on the sending side: over HTTP a fetcher pointed at a receiver that does not fold its context now fails at the ASK with `IngestionRefusedError` code `context-mismatch` instead of `WireContextMismatchError`. Both are fatal, non-retryable and raised before a single log is fetched, and `@etherfold/fetcher-host` classifies both as `fatal`; the direct (in-process) transport still raises `WireContextMismatchError` from `LogFetcher`'s own check, unchanged. Touches `@etherfold/core`'s public `IngestionTarget` and every hand-written target (one test wrapper in `fetcherRoundTrip.test.ts` updated).

**`400 context-mismatch` now carries `expected` as an ARRAY, always — even for one live context.** Naming every live context is information; picking one to call "expected" is a policy with no basis, which is the same call `GenerationCapReachedError` makes when it lists every deletable generation. A conditional shape (scalar for one, array for several) was rejected: a sender would have to branch on it. The receiver's own `WireContextMismatchError` (should the route and the receiver ever disagree) is mapped into the same array shape rather than kept as a second body.

**Liveness compares the fold's REGISTRATION RECORD, not its current version hash.** A processor whose `getVersionHash()` moves after open (via `configure()`) must still be able to receive — `StreamBuilder` resolves-or-creates the new generation on the next cursor read — so filtering on the live hash would drop the receiver just before the moment it is supposed to create its successor.

**`ReceivedGenerationSpec` gained `source` and a per-fold `stream` config.** `source` is the only way to say "a different stream", which is what a second live wire context IS. The stream CONFIG is per fold here although the chain-facing container refuses it per generation (one keeper serves one indexer there, ADR-0044's last consequence); on the receiving side each fold has its own `StreamBuilder`, which holds its own config, so the reason for that limit does not exist. Both default to the container's, so a single-fold host states neither twice.
