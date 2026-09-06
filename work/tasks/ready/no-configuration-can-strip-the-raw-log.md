---
title: 'No configuration can strip the raw log'
slug: no-configuration-can-strip-the-raw-log
spec: the-stream-stores-only-what-the-node-said
blockedBy: []
covers: [5]
---

## What to build

DELETE the `logValues` knob from `@etherfold/core`, so no setting exists that can project the raw log out of a stored or sent event.

`logValues` is not a decoding option. It is an allowlist over the RAW log's own fields (`address`, `topics`, `data`, `blockNumber`, ...), and the implementation keeps `args` UNCONDITIONALLY while dropping every raw field not explicitly named. That is exactly backwards for a stream that is about to store only what the node said: an event whose raw half was projected away has NOTHING left to decode from, which is the case that makes `LogEventFetcher.reparse` answer `undefined` and forces the caller to clear the stream.

It has ZERO callers outside core's own type definition and implementation (no example app, no test, no processor sets it), `docs/reviews/todo-triage.md` calls it a "flag STUB", and it is net negative to keep: an extra object allocation per event plus a live footgun, since the projection loop iterates the object's KEYS and never reads the boolean, so `{topics: false}` KEEPS `topics`. Deleting it is less work than relocating it and makes the raw-log guarantee STRUCTURAL rather than merely stated.

Scope of the deletion: the `logValues` field on `LogParseConfig`, the `LogValuesFlags` type it is typed with (and the private `OptionsFlags` helper it is built from, if nothing else uses it once the field is gone), the projection branch in the log fetcher's `parse`, the indexer TODO asking for `logValues` to be typed, and the root `TODO.md` line that stubs it (closed by deciding NOT to build it). The `CONTEXT.md` stream-identity entry currently says `parse.logValues` "is DELETED with the knob by" this spec: update it to state the deletion as done, and do NOT narrow the stream-config hash as a result (`parse` still belongs to the digest on the strength of `parseConfig.filters`).

What the deletion does NOT remove is the detect-and-clear GUARD. A stream written by an older version under a projecting parse can still exist on disk, and ADR-0034 mandates clearing a stream that cannot be re-read rather than replaying it on trust. That branch stays as pure defence and simply becomes unreachable for anything newly written.

**The guard is EXPLAINED in two places by naming the knob, and both go stale the moment it is gone.** `LogEventFetcher.reparse`'s docstring says it answers `undefined` "which only a `logValues` projection that dropped `topics` or `data` can cause", and the load path's clear branch in the indexer carries the comment "a `logValues` projection dropped the raw log". After this task neither sentence names anything that exists, and a reader hunting the deleted symbol finds only prose. Re-word both to name the real remaining cause — a stream written by an OLDER version, before the knob was deleted — in the same change. Historical records are the exception and stay untouched: ADR-0034's own text, any `.changeset/` entry, and the package CHANGELOG record what was true when they were written.

`docs/reviews/todo-triage.md` is the one judgement call in the sweep. It is cited above as EVIDENCE (it calls the field a "flag STUB"), and it also triages the field as a minor future feature worth doing. It is a dated triage RECORD rather than live documentation, so leaving it is defensible — but leaving it silently is not: either annotate the two entries as closed-by-deletion with a pointer to this spec, or say in your report why you left the record as it stands.

**Check what actually pins that guard before you touch it, because the obvious assumption is wrong.** The sibling stream work landed tests for an UNPARSEABLE SEGMENT (a stored segment the keeper cannot read back, which is cleared) — a different guard on a different layer. Nothing found in the tests today drives `reparse` to answer "cannot re-read" over a stream whose events lost their raw half, so this task WRITES that test rather than merely preserving one. Grep first and correct this paragraph's premise in your report if you find otherwise; what must not happen is deleting or weakening either guard.

## Acceptance criteria

- [ ] `LogParseConfig` has no `logValues` field and the `LogValuesFlags` type no longer exists, asserted at the TYPE level (a `@ts-expect-error` on a config literal that sets `logValues`, evaluated by `pnpm typecheck`). No dead private helper is left behind by the deletion.
- [ ] The log fetcher's `parse` has no projection branch: every parsed event carries the full raw log the node reported, with no configuration able to change that.
- [ ] The detect-and-clear guard SURVIVES and is PINNED BY A TEST OF ITS OWN: a stream already on disk whose events lack `topics`/`data` still makes the re-decode answer "cannot re-read", and the load path still clears that stream instead of replaying it. Assert BOTH halves — the branch is unreachable for anything newly written, and still reachable for a stream constructed as an older version would have written it. The sibling's unparseable-SEGMENT tests are a different guard and do not count as this one.
- [ ] The indexer TODO about typing `logValues` and the root `TODO.md` line it stubs are gone, and `CONTEXT.md`'s stream-identity entry no longer speaks of the deletion as future work. The stream-config digest is NOT narrowed.
- [ ] No comment or docstring in `packages/*/src` still explains the detect-and-clear guard by naming the deleted knob: the re-decode's docstring and the indexer's clear-branch comment name a stream written by an older version instead. ADRs, changesets and CHANGELOGs are historical and are left alone, and `docs/reviews/todo-triage.md` is either annotated as closed-by-deletion or deliberately left with the reason given in the report.
- [ ] A changeset records this as a breaking `@etherfold/core` change (nothing is published, so it costs a changeset and no migration).
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: remove the `logValues` knob from `@etherfold/core` entirely, so that NO configuration can strip the raw log out of what is stored or sent. This is the structural half of "the stream stores only what the node said": later tasks strip the DERIVED half (`args`/`eventName`) on the way into the stream, and that is only safe if the RAW half can never be missing.
>
> Vocabulary: an `ExistingStream` is the kept-stream keeper the indexer consults before fetching; a stored event is the raw log (`address`, `topics`, `data`, block coordinates) plus, today, a decoded half (`args`/`eventName`) that some ABI made of it; `reparse` re-decodes a cached stream against the source running now (ADR-0034) and answers `undefined` when an event carries no raw log to decode.
>
> Where to look: the core package's decoding module (the log fetcher's `parse`, which is where the projection is applied, and `reparse`, which is where its consequence is detected AND whose docstring EXPLAINS that consequence by naming the knob), core's public types (`LogParseConfig` and the `OptionsFlags`-derived `LogValuesFlags`), the indexer's load path (the branch that clears a stream that cannot be re-read — there are TWO such branches, and the comment on one of them also names the knob), `docs/reviews/todo-triage.md`, the root `TODO.md`, and `CONTEXT.md`'s stream-identity glossary entry. Grep the whole workspace for the identifier before you finish: what must be left with the name in it is the historical record (ADRs, changesets, CHANGELOGs), and what must not is a live comment explaining today's code by a symbol that no longer exists.
>
> The guard is the subtle half of this task. Deleting the knob makes the "cannot re-read" branch unreachable for anything NEWLY written, and it must stay reachable for a stream ALREADY on disk — so it needs a test that constructs such a stream directly (events with the raw fields absent) rather than through the deleted configuration. Do not assume one exists: the tests that read as neighbours cover an unparseable stored SEGMENT, which is a different guard on a different layer.
>
> Constraints: ADR-0034 (the stream's decoded half is a cache and is re-derived on replay; a stream that cannot be re-read is CLEARED). Do not narrow the stream-config digest: `parse` stays in it because `parseConfig.filters` narrows which events are parsed and kept at all. Do not add an interlock or a replacement knob — `work/specs/proposed/node-log-api.md` records that the projection conflict is CLOSED BY DELETION and must not be re-opened.
>
> Done means: the field, its type, the projection branch and the two TODOs are gone; a type test proves the field is not accepted; the detect-and-clear guard is proven still reachable for a stream already on disk and unreachable for anything newly written; `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check` and `pnpm changeset status` all pass.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself. If a choice meets the ADR gate (hard to reverse, surprising without context, a real trade-off), also write the durable WHY as an ADR in `docs/adr/` and name it in the block.

