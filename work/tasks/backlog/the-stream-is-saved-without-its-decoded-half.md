---
title: 'The stream is saved without its decoded half'
slug: the-stream-is-saved-without-its-decoded-half
spec: the-stream-stores-only-what-the-node-said
blockedBy: [the-stored-event-type-refuses-a-decoded-event]
covers: [1, 3]
needsAnswers: true
---

## What to build

Strip the decoded half on the way INTO the stream, in core, so what a keeper is handed to persist is the raw log plus the reorg verdict and nothing an ABI made of it.

Core strips, not each keeper. The keeper seam is third-party-implementable and has three implementations already; putting the rule in each would let them drift. So the strip happens once, on the way into `saveNewEvents`.

The strip must produce NEW OBJECTS. A new array holding the same references strips nothing, and those references are the very objects just handed to the processor — mutating them would corrupt what the fold is reading.

The batch's `lastSync` is stripped too, and this is the part that is easy to get wrong. A `LastSync`'s unconfirmed blocks hold full DECODED events, and the STREAM keeper's stored copy of them is never read back as events: the load path takes only the cursor numbers and the context from a stored `lastSync`, the live reorg window is the indexer's in-memory one, and transaction-inclusion questions are answered from the STATE keeper's copy. So leaving them decoded would leave the one stale thing in the stream. The strip must build a NEW `LastSync` (and new blocks inside it), because the SAME object is handed to the state keeper on the same tick and a mutating strip would silently empty the live reorg window.

**This task must typecheck ON ITS OWN, and that takes one deliberate step.** The seam has not narrowed yet: the saver still declares a decoded event array, and the window's blocks still declare decoded events. A stripped object is NOT assignable to the decoded event type — that type is a union requiring `args`/`eventName` or `decodeError`, which is exactly the refusal the new stored type was minted for — so NEITHER the stripped batch NOR the stripped window fits today's seam by construction. Do NOT resolve that by widening the seam, by narrowing it early (that is the next task, which moves every implementation and fake in one change), or by DECLARING the strip's output (its variables, its return types) to be decoded events. Resolve it the expand-then-contract way: keep the single call site where the stripped batch meets `saveNewEvents` compiling with ONE assertion at that boundary — one over the whole argument the saver takes is cleaner than two — commented with why it is temporary and which task removes it. The next task narrows the seam and deletes the batch half of it (and, if it leaves the window typed decoded, re-documents what remains as permanent); leave it findable rather than tidy.

Nothing about the read path changes here: a stored stream is still re-decoded on load against the source running now, which is what makes reuse across a decode-only change work and is already pinned by the browser invalidation tests. Those tests passing unchanged is the evidence that raw-only loses nothing at RUN time.

## Acceptance criteria

- [ ] Events handed to a keeper's `saveNewEvents` carry no `args`, no `eventName` and no `decodeError`, for every deployment shape that reaches the indexer's save path.
- [ ] The stripped events are NEW objects: the events the processor was handed on the same tick still carry their decoded half after the save.
- [ ] The `lastSync` a keeper is handed carries stripped events in its unconfirmed window, and the strip does NOT mutate: the object handed to the state keeper still carries its unconfirmed window, decoded, after a stream save.
- [ ] The repo typechecks with the seam UNCHANGED: the assertion needed to hand a stripped batch and a stripped window to a seam that still declares decoded events is confined to the single save call site (one assertion over the saver's argument, not a scatter), is commented as temporary, and names the task that removes it. No seam type is widened, and the strip's own variables and return types declare the STORED type rather than the decoded one.
- [ ] `fetchFrom` answers the same MEMBERSHIP and ORDER for the same `fromBlock`, with the same raw halves, as before this change. Not event-for-event equality: it now returns raw-only where it returned decoded, which is the change itself.
- [ ] Reuse across a decode-only change still holds at runtime: the existing invalidation tests (a renamed non-indexed parameter reuses the cached stream rather than re-fetching a block) pass unchanged.
- [ ] A changeset records the behaviour change to what `@etherfold/core` persists.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.

## Blocked by

- `the-stored-event-type-refuses-a-decoded-event` — the strip's output is typed with the stored-event type that task mints, and both tasks touch core's indexer and types modules.

## Prompt

> Goal: make the indexer hand a keeper only what the node said. This is the RUNTIME half of "the stream stores only what the node said"; the follow-on task narrows the seam's TYPES so a keeper cannot be handed anything else.
>
> Vocabulary: the DECODED HALF is `args`/`eventName`/`decodeError` — what some ABI made of the raw log; a KEEPER is an `ExistingStream` implementation (segmented IndexedDB in the browser, the stored emission stream on the server, test fakes in core); `LastSync` is the cursor plus the unconfirmed reorg window; the STREAM keeper and the STATE keeper are handed the same `lastSync` object on the same tick.
>
> Where to look: core's indexer, at the save path that calls the keeper's `saveNewEvents` (and the point where the batch it writes is derived from what was just processed). The strip belongs there, in core, NOT in any keeper. Read the load path too, so you can see that a stored `lastSync` is read back only for its cursor numbers and its context, never for its events — that is what makes stripping the window safe.
>
> The two traps, both already paid for once in this codebase: (1) a new ARRAY over the same references strips nothing and the references are the processor's own event objects, so build new event objects; (2) a mutating `lastSync` strip empties the LIVE reorg window, because the state keeper is handed the same object on the same tick, so build a new `LastSync` with new blocks. Write a test for each rather than trusting the reading.
>
> The third trap is the compiler: the seam still declares decoded events on both the batch and the window's blocks, and a stripped object cannot satisfy that union. Keep this task green with ONE commented, temporary assertion at the save call site — over the saver's whole argument, covering batch and window together — rather than touching the seam. Narrowing it is the next task, which moves every implementation and fake at once, and doing half of it here would leave the repo red between the two. What the assertion must NOT become is a declared type: the strip's own locals and return types say STORED, and only the boundary lies, in one place, with a comment naming its remover.
>
> Constraints: ADR-0034 (the decoded half is a cache and is re-derived on read, unconditionally, so nothing downstream depends on a stored `args`). ADR-0035 (the stream cursor contract: what a keeper is required to store). Do not change the read path's decoding, do not change any keeper's storage format beyond the fields that are no longer present, and do not push the rule into the keepers.
>
> Done means: keepers receive raw-only events and a raw-only window, nothing the processor holds is mutated, `fetchFrom` answers the same membership and order as before, the browser invalidation tests pass unchanged, and `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check` and `pnpm changeset status` pass.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself. If a choice meets the ADR gate (hard to reverse, surprising without context, a real trade-off), also write the durable WHY as an ADR in `docs/adr/` and name it in the block.

## Open questions

- The decomposition mints StoredLogEvent without ever naming EmittedLog, which already exists in the SAME module and already claims almost the same meaning. Lens 4c fork risk, and a concrete hole in the-stream-seam-takes-only-the-stored-event: its criterion forbids re-typing an implementation to the base event type, but EmittedLog is a SECOND supertype with the identical hole (a decoded event satisfies it), and it sits right beside the server keeper this task narrows. A keeper annotated EmittedLog would compile and enforce nothing, which is exactly the failure the spec minted a new name to prevent. Fixed by the edits: task 3 must state the relation in the new type docstring and leave EmittedLog untouched; task 5 forbids both supertypes. (packages/core/src/types.ts:49 exports EmittedLog = NumberifiedLog, docstring: one entry of the emission stream as a host that STORES it sees it, deliberately does NOT promise the decoded half. Used by streamBuilder.ts, emissionStream.ts, server/src/emissions.ts.)
