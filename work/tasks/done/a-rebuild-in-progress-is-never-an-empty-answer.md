---
title: 'A rebuild in progress is visible on /status and is never answered as an empty result'
slug: a-rebuild-in-progress-is-never-an-empty-answer
spec: the-server-and-cli-hold-generations-too
blockedBy: [the-rebuild-replays-the-local-stream-in-bounded-chunks, one-registry-entry-holds-several-live-wire-contexts, two-named-indexers-never-touch-each-others-data]
covers: [4]
---

## What to build

The absence-versus-contradiction distinction, applied to a rebuild. "Nothing here yet" and "this is
still being built" must never look the same, which is the same discipline the reorg model and
`SuspectedTruncationError` already keep.

It is TWO surfaces, and separating them is what makes it small:

- **An OPERATOR watching progress reads `/status`.** The cursor field is already a REPORTED ENVELOPE
  the server never parses, and ADR-0047 left room for exactly this: the envelope gains a PER-GENERATION
  dimension — the canonical generation, plus any rebuilding one with how far its checkpoint has got.
  It is ADDITIVE and it adds NO endpoint. A host that injects no reporter still reports no cursor field
  at all, which stays correct rather than missing.
- **A CONSUMER doing a read has no ambiguity by construction**, and nothing is built for it: a read is
  served from the CANONICAL generation, which already advertises the generation identity it answered
  from, and a rebuilding generation is never the one answering.

**The one real case is "no canonical generation YET"** — a first build, where the state is genuinely
empty AND a rebuild is running. That is ADR-0015's territory: REFUSE the read, naming the generation
that has not caught up. Never answer empty, and never answer from a generation that is still being
built.

**WHICH read, and whose file.** The read surfaces that resolve the canonical pointer on this runtime
are the two feed views (`packages/server/src/api/feed.ts`) and a `serve` process answering over a
database written elsewhere; `/status` is the operator surface and is not the read being refused. The
feed file and its once-per-request canonical resolution belong to
`one-registry-entry-holds-several-live-wire-contexts`, which is why this task is now blocked on it:
add the refusal to the resolution that task establishes rather than a second one beside it, so there
is ONE place a read decides which generation answers. If it turns out the refusal belongs BELOW the
routes (at the pointer resolution itself, so every surface inherits it), say so in the `## Decisions`
block.

Keep the envelope SMALL and JSON-serialisable. The reporter contract is explicit that the server
reports what it returns VERBATIM and therefore cannot bound it afterwards, so a per-generation entry
must not grow into a dump of an unconfirmed window.

## Acceptance criteria

- [ ] `/status` reports one entry per generation this host holds: which is canonical, and, for a
      generation being rebuilt, how far the rebuild has got.
- [ ] The entry is inside the existing cursor envelope: no new endpoint, no new top-level field beyond
      what ADR-0047 already reserves, and a host with no reporter still has no `cursor` field.
- [ ] The envelope stays small and JSON-serialisable, with no unconfirmed window and no raw serialized
      cursor in it.
- [ ] The rebuild's progress ADVANCES across chunks, visibly — assert two reads either side of a chunk.
- [ ] A read against an indexer with NO canonical generation yet is REFUSED on the feed views (and by
      a `serve` process over such a database), naming the generation that has not caught up, and never
      answered as empty — through the SAME canonical-generation resolution the feed already does, not
      a second one.
- [ ] A reporter that throws or returns nothing still yields absent-with-a-reason and never fails the
      request or changes `healthy`.
- [ ] Tests cover the new behaviour, in the repo's existing style.

## Blocked by

- `the-rebuild-replays-the-local-stream-in-bounded-chunks` — there is no rebuild progress to report and
  no checkpoint to read until the driver exists.
- `one-registry-entry-holds-several-live-wire-contexts` — that task owns `api/feed.ts` and the
  once-per-request canonical-generation resolution this task's refusal hangs off; building them in
  parallel means two tasks editing the same read path.
- `two-named-indexers-never-touch-each-others-data` — it reworks the SAME feed routes again, onto the
  handle each name owns. Nothing depends on this task, so it is the cheap one to serialise LAST: the
  refusal is then added to a resolution that already reads from the right database, instead of being
  rewritten by the next task that touches the file.

## Prompt

> Make a rebuild in progress DISTINGUISHABLE from an empty result: visible on `/status` for an
> operator, and a refusal rather than an empty answer in the one case where a read would otherwise lie.
>
> Vocabulary (`CONTEXT.md`): `/status` is the whole query surface for this milestone, and its **cursor**
> arrives through an injected REPORTER because only the process that owns the store can read one and the
> cursor is opaque behind the storage seam; **BlockUnavailableError** is the family of "this store cannot
> answer about that block", and an unresolvable address is an ERROR and never an empty result or a tip
> read; the **generation** identity is advertised opaquely and compared, never parsed.
>
> Where to look: `packages/server/src/api/status.ts`, `packages/server/src/cursor.ts` (what a reporter
> owes the server, and why the bound has to live on the seam), `packages/cli/src/cursorReport.ts` (the
> reporter the folding commands inject), and the rebuild driver's checkpoint.
>
> Constraining decisions: **ADR-0047** (the status cursor is a reported envelope the server never
> parses, and the generation dimension grows INSIDE it), **ADR-0015** (an unresolvable block address is
> an error, not an empty result), ADR-0008 (readers never see partial state), and
> `one-command-runs-the-whole-pipeline`, which is why this adds no endpoint.
>
> Seams to test at: the `/status` response, and the read path that must refuse. Done means an operator
> can watch a rebuild advance without a new endpoint, and a first build refuses rather than answering
> "there is nothing here".
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if a
> dependency landed differently or an ADR superseded an assumption here, route the task to
> needs-attention with the discrepancy rather than building on the stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do
> not write the done record, the commit message or the PR body yourself.


## Decisions

- **The reporter's return shape is two NAMED slots (`{value?, generations?}`), a breaking change to `getCursorReport`, rather than sniffing the reported value for a `generations` key.** ADR-0047 forbids the server parsing what it reports verbatim, and a host may legitimately put a key called `generations` *inside* its cursor summary — `packages/server/test/server.test.ts` has asserted exactly that shape since the seam landed. Sniffing would make a legal report change how the envelope is built. Alternatives considered: (a) sniffing (rejected, above); (b) a SECOND injected option `getGenerationReport` (rejected: ADR-0047 says the dimension grows *inside* the field a single reporter fills, and two reporters would be two degrade paths for one page). It touches every host that injects a reporter — `run`, `index`, `platforms/nodejs` tests — and is documented in the changeset with the one-line migration. Nothing is published (CONTEXT `## Conventions`), so it costs a changeset.
- **`reported` keeps its exact meaning and `generations` sits beside it on the `reported: false` branch too.** A first build is the load-bearing case: it has generations and no cursor. The alternative — `reported: true` with an absent `value` — would silently re-mean the flag every existing reader branches on.
- **The per-generation flag is `follows`, the established word (ADR-0044 / CONTEXT "follower"), not a new `rebuilding`.** Coherence check: "follower" already means "advanced by re-folding the stored stream", which is exactly the condition under which the entry's `value` is rebuild progress. A second near-synonym would fork the vocabulary.
- **The refusal lives BELOW the routes** (`resolveCanonicalGeneration` in `api/resolve.ts`), which the task invited me to record. Both feed views resolve through it, so there is one place a read decides which generation answers, and a surface added later inherits it. It touches `one-registry-entry-holds-several-live-wire-contexts`'s once-per-request resolution (I replaced it in place rather than adding a second) and will be inherited by `two-named-indexers-never-touch-each-others-data`'s handles unchanged.
- **`503 no-canonical-generation`, and the refusal is scoped to WHICH generation answers, never to how far it has got.** A canonical generation mid-backfill still serves a short page and a cursor: refusing on progress would mean a feed could not be followed until its backfill finished. Alternatives: `409` (rejected — ADR-0004 pins it as the one *resumable* refusal, and there is no position to resume from), `404`/`501`/`400` (rejected — the name resolved, the host can serve feeds, and nothing about the request is wrong). Recorded as **ADR-0058** because it is a published refusal on a public read surface with four plausible codes.
- **The new wire field is `building` (opaque digests).** New name on a new refusal; `generations` was rejected because that key already carries objects on the admin route and on `/status`, and a third shape under one name is the muddle worth avoiding.
- **`IndexerRegistryEntry.canonicalGeneration(): Promise<GenerationId | undefined>`**, and the ADMIN route *reports* the absent case (`canonical` absent, generations still listed) rather than refusing it — the opposite of what a READ does with the same answer. A read served from nothing is a wrong answer; "nothing answers reads yet, here is what is registered" is what an operator opened that route to see.
- **`serve` is NOT wired to a registry here, so the criterion's parenthetical "(and by a `serve` process over such a database)" is satisfied structurally rather than by a running `serve`.** `serve` registers no named indexer today (it refuses `--indexer` outright, so it has no name to register under) and its feed answers `501`; making it resolve the canonical pointer is `the-cli-and-the-server-hold-generations-the-same-way`'s own acceptance criterion. My test drives exactly the read-tier entry that task will build (`generationRegistryPortOnSQL(db, name).read()`), so the refusal is already the one it will inherit — nothing about it will need rewriting there.
