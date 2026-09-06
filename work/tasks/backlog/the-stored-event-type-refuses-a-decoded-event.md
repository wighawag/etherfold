---
title: 'The stored-event type refuses a decoded event'
slug: the-stored-event-type-refuses-a-decoded-event
spec: the-stream-stores-only-what-the-node-said
blockedBy: [no-configuration-can-strip-the-raw-log]
covers: [2]
---

## What to build

Mint the stored-event type — a raw log plus the reorg flag the indexer derived, and NOTHING derived from an ABI — and make the re-decode path able to read it. This task ADDS the type beside what exists; a later task moves the keeper seam onto it.

A raw-only event is not a `LogEvent`: that is a union of a parsed event (carrying `args`/`eventName`) and a parsing-failure event (carrying `decodeError`), and an event with neither belongs to neither. Do NOT reuse the existing base event type. It is already exported and is the SUPERTYPE every decoded event extends, so reusing it would re-mean a published type AND enforce nothing: a decoded array is assignable to a base array (that is what a supertype is) and excess-property checks fire only on fresh object literals, so a keeper could receive, hold and persist decoded events in silence.

So mint a DISTINCT name whose shape REFUSES the decoded half. This form was verified with `tsc` rather than reasoned about, and it is the decision-rich part, so it is inlined:

```ts
type StoredLogEvent<Extra = undefined> = BaseLogEvent<Extra> & {args?: never; eventName?: never; decodeError?: never};
```

The VERIFIED part is the intersection with the three `?: never` clauses: it rejects a parsed event both with and without inputs, and rejects the union via the parsing-failure member, while accepting a raw event. The repo does not set `exactOptionalPropertyTypes`, so the interaction that would otherwise make `?: never` unreliable does not arise. One known hole, worth stating in the type's docstring rather than hiding: an event whose STATIC type has already been widened to the base type still assigns, so the guard is at the seam, not through a widening.

**The PARAMETER LIST above is shorthand and will not compile as literally written.** In this repo the base event type declares `Extra extends JSONObject | undefined = undefined`, so an unconstrained `Extra` does not satisfy its constraint. Carry the constraint over verbatim so the new type takes the same parameter as its neighbours. That is a transcription fix and NOT the drift the check below is about: only a failure of the REFUSAL clauses is worth surfacing rather than fixing.

> **DECIDED 2026-09-06 (human), so this is settled rather than open: `StoredLogEvent` and `EmittedLog` BOTH survive, with a stated relation.** The tasking review raised whether minting a second raw-log name forks a concept, since `EmittedLog` landed on 2026-09-05 (#62) — after this spec was written, which is why the spec never mentions it. The answer is that they differ in KIND and in AUDIENCE, not merely in name: `EmittedLog` is PERMISSIVE (a plain `NumberifiedLog` alias that does not *promise* the decoded half) and is the server's emission-row shape, deliberately free of an ABI type parameter; the type minted here REFUSES the decoded half and carries `extra` and `removedStreamID`, neither of which `EmittedLog` can express. So `EmittedLog` is not a candidate for this seam rather than a duplicate of it. Do exactly what the paragraph below says; do not unify them.

**Reconcile the new name against `EmittedLog` before you mint it — it is the one concept this type could fork.** `EmittedLog` is already exported from the same module, is defined as the raw log alias, and its docstring already claims almost this type's job: one entry of the emission stream as a host that STORES it sees it, deliberately not promising the decoded half. It is the type of the SERVER's emission-append path, a different seam from the keeper seam this spec narrows, and it differs in substance: no ABI parameter, no `extra`, no `removedStreamID`, and — decisively — it is a plain supertype, so it ENFORCES nothing, which is the very reason this spec refuses to reuse the base event type. So the expected answer is that both survive with a STATED relation rather than one silently shadowing the other. What this task owes is that statement: say in the new type's docstring how it relates to `EmittedLog` (which seam each speaks, and that only one of them refuses a decoded event), and do NOT re-mean, re-point or delete `EmittedLog` here. If you conclude they should actually be ONE type, STOP and surface it rather than merging them inside this task: that is a second published-type migration and belongs to its own decision.

The re-decode entry point (`reparse`) must WIDEN to accept the stored type as well as the decoded one. It is the sole DECODING consumer of what a keeper's `fetchFrom` returns, so "decoding happens on read" rests on widening its parameter. It already strips any decoded half off each event before decoding, so its RUNTIME behaviour does not change; what changes is what it will accept. It keeps returning decoded events — reads produce `LogEvent`s, only WRITES narrow.

It is not, however, the only thing that TOUCHES what `fetchFrom` returned: the follower path also derives an emission mark per stored event and compares the stored slice against what it already folded. Those read raw fields only, and they are the LATER task's to widen, when the seam actually narrows — leave them alone here, and do not treat their existence as drift.

## Acceptance criteria

- [ ] A stored-event type is exported from `@etherfold/core` whose shape refuses a decoded event, with a docstring saying what it governs (writes), naming the widening hole, and stating its relation to `EmittedLog` (which seam each speaks, and which of them actually refuses a decoded event). `EmittedLog` itself is unchanged: not re-pointed, not re-meant, not deleted.
- [ ] A TYPE test asserts the refusal under `pnpm typecheck` using `@ts-expect-error`: a parsed event (with and without ABI inputs), a parsing-failure event, and the `LogEvent` union are each REJECTED where the stored type is expected; a raw event is ACCEPTED. Follow the existing type-test style in this repo (a test file whose assertions are `@ts-expect-error` comments that the typecheck evaluates, with the bodies deliberately never called — see the browser package's call-shape test).
- [ ] The re-decode path accepts both a stored-shaped array and a decoded `LogEvent` array, and still returns decoded events, with no change to what it does at runtime (the existing kept-stream and invalidation tests pass unchanged).
- [ ] Nothing else moves onto the new type yet: the keeper seam still declares what it declares today, and the repo still builds, typechecks and tests green.
- [ ] A changeset records the added `@etherfold/core` type.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.

## Blocked by

- `no-configuration-can-strip-the-raw-log` — it edits the same public types module and the same decoding module, so these are serialized to avoid a rebase for no gain.

## Prompt

> Goal: introduce the type that says "this is what the node said, and nothing an ABI made of it", and make the read path able to consume it. Additive only: after this task nothing has narrowed, so the whole repo stays green.
>
> Vocabulary: a stored event is the raw log (`address`, `topics`, `data`, block coordinates) plus the reorg flag the indexer derived; the DECODED HALF is `args`/`eventName` (what SOME ABI made of those bytes) or `decodeError` (what happened when it could not). `LogEvent` is the union of the two decoded outcomes; the base event type is their shared supertype. `reparse` is the re-decode of a cached stream against the source running now, which ADR-0034 made UNCONDITIONAL precisely because a stream cannot say per event which ABI decoded it.
>
> Why the exclusion form and not the supertype: the supertype ENFORCES nothing (a decoded array is assignable to it, and excess-property checks only fire on fresh literals), and reusing it would silently re-mean an already-published type. The `{args?: never; eventName?: never; decodeError?: never}` intersection in this task's body was verified with `tsc`, not reasoned about — use it as given, and if you find it does not hold in this repo, that is a finding worth surfacing rather than papering over.
>
> Where to look: core's public types module (where the base/parsed/failure/union event types live, where `EmittedLog` sits a few lines below them, and where the keeper seam's fetcher and saver types sit — you are NOT changing those yet), and the decoding module's `reparse`. For the type-test style, read the browser package's call-shape test: `pnpm typecheck` is what runs half of such a file, and each `@ts-expect-error` FAILS the typecheck if the line it guards starts compiling.
>
> Scope discipline: `reparse` is the only DECODER of a fetched stream, and it is the only consumer you widen here. The indexer's follower path also reads the fetched events (for their emission marks and its already-folded check) using raw fields only; widening those belongs to the task that narrows the seam, and finding them is expected rather than a sign this task is stale.
>
> A trap this repo has already hit: the browser tests pass their keeper through as `never` at several call sites, so a stored-event break is INVISIBLE there. Those tests passing unchanged proves NOTHING about the compile-time half — that is why the explicit type test is an acceptance criterion.
>
> Constraints: ADR-0034 (the decoded half is a cache, re-derived on read; a stream that cannot be re-read is cleared). Reads keep producing decoded events; only writes will narrow, in the follow-on task.
>
> Done means: the type exists and is exported, the type test proves the refusal, the re-decode path accepts both shapes with unchanged runtime behaviour, and `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check` and `pnpm changeset status` pass.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself. If a choice meets the ADR gate (hard to reverse, surprising without context, a real trade-off), also write the durable WHY as an ADR in `docs/adr/` and name it in the block.

