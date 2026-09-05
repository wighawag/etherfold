---
title: 'A rebuild in progress is visible on /status and is never answered as an empty result'
slug: a-rebuild-in-progress-is-never-an-empty-answer
spec: the-server-and-cli-hold-generations-too
blockedBy: [the-rebuild-replays-the-local-stream-in-bounded-chunks, one-registry-entry-holds-several-live-wire-contexts, two-named-indexers-never-touch-each-others-data]
covers: [4]
needsAnswers: true
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

## Open questions

- the-canonical-pointer-moves-back-without-re-ingesting is not blockedBy the-rebuild-replays-the-local-stream-in-bounded-chunks, but it cannot be built without it: on this runtime the chain-free container created by a-changed-context-creates-a-successor-instead-of-clearing deliberately stops short of promotion (its own What-to-build says so), and the rebuild task is the one that owns the FORWARD pointer move and explicitly takes the lift of the promotion trigger and its arming into a shared place as IN SCOPE. Built as written and in parallel, the revert task has nothing to revert FROM and no arming rule to assert its criterion 3 against, so it either stalls on a scope-fence violation or writes a second promotion trigger, which is exactly the two-sources-of-truth the rebuild task warns against. The revert task's own open question 2 also says it CONSUMES question 2 of the rebuild task, an ordering that is prose-only today. Fix: add the rebuild slug to blockedBy plus the Blocked-by prose (edit supplied). (work/tasks/backlog/the-canonical-pointer-moves-back-without-re-ingesting.md frontmatter blockedBy: [a-changed-context..., one-registry-entry...]; criterion 'After the revert, the automatic promotion policy does not move the pointer forward again'; rebuild task: 'The chain-free container this task builds on deliberately stops short of promotion ... That lift is IN SCOPE for this task.')
