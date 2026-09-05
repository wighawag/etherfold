---
title: 'The canonical pointer moves BACK, and the previous generation answers exactly as before'
slug: the-canonical-pointer-moves-back-without-re-ingesting
spec: the-server-and-cli-hold-generations-too
blockedBy: [a-changed-context-creates-a-successor-instead-of-clearing, one-registry-entry-holds-several-live-wire-contexts, the-rebuild-replays-the-local-stream-in-bounded-chunks]
covers: [3, 10]
---

<!-- open-questions -->

## Open questions
1. ~~**What is the OPERATOR's affordance for the revert?**~~ **ANSWERED: an AUTHENTICATED ADMIN HTTP
   ROUTE, guarded by a NEW `ADMIN_TOKEN` that fails closed when unset.**

   Decisive reason: it is the only affordance that exists on EVERY deployment shape. On Cloudflare
   there is no CLI at all — a Worker is reachable only over HTTP — so a flag on a command cannot
   serve a serverless deployment, and a library call with no operator surface does not deliver the
   story. The command set is pinned at five with no default command, so a sixth verb is unavailable,
   and hanging `--revert` on `run` conflates a long-running fold with a one-shot control action.

   `/admin/setup` already exists, so `/admin` is an ESTABLISHED namespace rather than a new class of
   surface — and that is what matters, because the milestone's "add no endpoint" fence protects the
   QUERY surface (`/status` is the whole of it), not the admin one.

   **NOT the ingest token.** That credential is handed to a log shipper and guards the WRITE path;
   letting it also change which generation answers reads would give a fetcher control-plane authority.
   A separate `ADMIN_TOKEN`, failing closed exactly as the ingest guard does ("refuses everyone when
   no token is configured, rather than letting everyone in").

   NOTE, flagged and deliberately NOT changed here: `/admin/setup` is currently UNAUTHENTICATED
   (idempotent DDL, plausibly a deliberate bootstrap choice). This task introduces the first admin
   credential rather than reusing one; it does not retrofit `setup`.
2. ~~**What does the generation reverted TO actually hold?**~~ **ANSWERED by question 2 of
   `the-rebuild-replays-the-local-stream-in-bounded-chunks`: it kept FOLDING, so it holds its OWN
   CURRENT state, not a pre-promotion snapshot.**

   So assert the HONEST property: reverting restores the OLD PROCESSOR's answers over the CURRENT
   chain — NOT "the exact answers from the promotion instant". That is assertable, and it is the more
   useful guarantee: a revert that handed back stale answers would be a poor revert.

## What to build

The way BACK: moving the canonical pointer to a previously-canonical generation, so a processor that
turned out worse is undone **without re-ingesting anything**.

Almost all of this is already true by construction and the task is mostly about PROVING it and
exposing it: a retired generation is RETAINED under the caps rather than dropped, and its state is its
own table namespace, so nothing the successor did OVERWROTE it. That non-overwriting is the property
that makes it revertible-to at all.

What is NOT true by construction on this runtime is that the retired generation is frozen. A pause here
is an explicit operator action, not something a promotion performs, and the container REFUSES to pause
a follower (`CannotPauseFollowerError`) because a follower advances exactly as far as the stream it
follows. So do not assume 'it stopped at the instant it was superseded' — see the open questions.

**You do NOT build a second promotion machine.** Promotion, the arming rule and the pointer move on
the chain-free container arrive with `the-rebuild-replays-the-local-stream-in-bounded-chunks`, which
lifts the trigger out of the chain-facing container into something both containers use, and which is
why this task is blocked on it: without that lift there is no forward promotion on this runtime to
revert FROM, and writing one here would be the second source of truth that task exists to prevent.
Reverting is the same one small write in the other direction — reuse it.

What has to be got right here:

- **Its own state, untouched.** After the move back, the previous generation answers from the state it
  folded, with nothing the successor wrote in it — assert on real reads, not on a row count. With
  nothing folded into it since the promotion, that is exactly its pre-promotion answer; if it kept
  folding (question 2), the honest assertion is that its answers are its own fold's and never the
  successor's.
- **No re-ingestion and no re-fetch.** Assert zero chain calls and no new emission rows across the
  revert.
- **A revert is not a promotion.** The container distinguishes them by whether the pointer has EVER
  named that generation, and the arming rule exists precisely so a reverted-from successor is not
  re-promoted on the next cycle. Assert that: after a revert, the successor does not silently take the
  pointer back.
- **Reads never straddle it.** A read unit of work resolves the pointer once and holds it, so a query
  in flight cannot answer half from each generation. Assert this THROUGH the once-per-request canonical
  resolution that `one-registry-entry-holds-several-live-wire-contexts` establishes in the feed views —
  that task owns those files. Do not add a second resolution beside it.
- **The retired-forward generation stays available**, so a second move forward is also free.

## Acceptance criteria

- [ ] Moving the pointer back makes the previous generation answer reads again, from its own state and
      with nothing the successor wrote in it — identical to its pre-promotion answers when nothing was
      folded into it since (see open question 2).
- [ ] The revert makes ZERO chain calls and appends NOTHING to the stored stream.
- [ ] After the revert, the automatic promotion policy does not move the pointer forward again on the
      next advance — asserted over the SHARED promotion trigger the rebuild task lifted, with no second
      trigger added here.
- [ ] A read resolving through the pointer holds one generation for its whole unit of work.
- [ ] The generation reverted FROM is still registered, still has its state, and can be promoted again.
- [ ] Whatever question 1 resolves to is implemented, and refuses clearly when asked to point at a
      generation this host does not hold.
- [ ] Tests cover the new behaviour, in the repo's existing style.

## Blocked by

- `a-changed-context-creates-a-successor-instead-of-clearing` — there must be a second generation to
  move back FROM.
- `one-registry-entry-holds-several-live-wire-contexts` — it owns `api/feed.ts` and the
  once-per-request canonical-generation resolution the 'a read never straddles a move' property hangs
  off; building both at once means two tasks editing the same read path and two resolutions where
  there must be one.
- `the-rebuild-replays-the-local-stream-in-bounded-chunks` — it owns the FORWARD move on this runtime
  (the pointer move at the end of a rebuild) and the lift of the promotion trigger and its arming into
  something the chain-free container uses; there is nothing to revert from, and no arming rule to
  assert against, until that lands. It also owns the answer to open question 2 here, which this task
  consumes rather than decides.

## Prompt

> Make the way back real on the server and the CLI: an operator moves the canonical pointer to the
> previous generation and gets the old answers, with no re-index and no re-fetch.
>
> Vocabulary (`CONTEXT.md`): the **canonical pointer** is the single record naming which generation
> answers reads — moving it IS promotion and moving it back IS revert; **pause / draining** is how a
> generation stops indexing without being deleted, capping and never truncating, which is what keeps it
> revertible-to; **drop-on-promotion** is off by default for exactly this reason; a **generation cap**
> refuses rather than evicts.
>
> Where to look: `packages/core/src/generation/registry.ts` (the pointer as a mechanism: move it, read
> it, move it back), `packages/core/src/container.ts` (`promote`, the `everCanonical` flag that tells a
> promotion from a revert, and the arming that stops a re-promotion), `packages/core/src/generation/promotion.ts`,
> and the SQL registry substrate, the generation container and the rebuild driver this task builds on —
> the rebuild task is where promotion reached the chain-free container, so START from what it left.
>
> Constraining decisions: ADR-0046 (a promotion candidate is armed by add, and drop-on-promotion never
> drops a writer), ADR-0045 (a generation pauses by capping and draining, never by truncating),
> ADR-0044 (only the indexing generation writes a stream), ADR-0053 (each generation's state is its own
> namespace, so nothing was overwritten), ADR-0008 (whose drop-the-old-namespace rule this replaces).
>
> Seams to test at: reads through the pointer before and after both moves, the chain seam (zero calls),
> and the stored stream (no new rows). Done means a bad upgrade is undone by one small write and the old
> answers come back byte for byte.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if a
> dependency landed differently or an ADR superseded an assumption here, route the task to
> needs-attention with the discrepancy rather than building on the stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do
> not write the done record, the commit message or the PR body yourself.
