---
title: 'The result cap is discovered from the provider, not guessed by an operator'
slug: the-result-cap-is-discovered-not-guessed-by-an-operator
spec: the-fetcher-reads-the-hints-providers-already-send
blockedBy: [a-provider-refusal-is-read-from-its-data-before-its-prose]
covers: [4, 5]
---

## What to build

`suspectResultCount` is the sharpest correctness knob in the fetcher. It is the count at which a result set is treated as SUSPECT rather than complete, and it works by exact-count matching because a capped answer and a complete one differ in nothing else. Set it wrong and a short range is delivered as a complete one, the receiver reads the missing logs as an absence, concludes a reorg, and deletes state.

Today it defaults to 10000 and is otherwise an operator's guess about their node, surfaced as `SUSPECT_RESULT_COUNT` in the fetcher host. Some providers report their real cap in every refusal, as `limit` in the structured error data the blocking task now reads.

Use it. When a provider has reported a result limit, that becomes the effective `suspectResultCount`. An explicitly configured value still WINS, because a deployment that knows something the provider does not report must be able to say so, and because silently overriding an operator's stated number with a parsed one would be the worse failure.

Precedence, most to least specific: explicit configuration, then a limit reported by the provider, then the existing default.

**Scope boundary, verified:** `suspectResultCount` exists only on the split fetcher path (`@etherfold/core`'s `LogFetcher`, configured through `@etherfold/fetcher-host`). The single-process indexer has no equivalent truncation guard. Do NOT add one here; that asymmetry is real but it is a separate question, and this task is about sourcing a number that already exists.

## Acceptance criteria

- [ ] A provider-reported limit becomes the effective suspect count when nothing is configured
- [ ] An explicitly configured value wins over a reported one, asserted directly
- [ ] With neither, the existing default is unchanged
- [ ] The effective value and its SOURCE (configured, reported, default) are visible to an operator rather than silent
- [ ] A discovered value cannot be zero, negative or otherwise nonsensical; such a report is ignored and logged
- [ ] The refusal message that names this knob still names it correctly
- [ ] A CHANGESET accompanies the change. The repo's acceptance gate runs `changeset status --since=main`, so a touched package with no changeset is a RED GATE rather than a style nit. Describe the change in prose, as the repo's existing changesets do, not in one line

## Blocked by

- `a-provider-refusal-is-read-from-its-data-before-its-prose`: the reported `limit` only becomes available once structured error data is read.

## Prompt

> Stop asking an operator to guess a number their provider already tells us. Read `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` section 2, and the `suspectResultCount` docstring in `@etherfold/core`'s log fetcher, which explains at length why this knob is dangerous and why exact-count matching is the only detection available.
>
> Domain vocabulary: ADR-0004 makes the receiver treat a MISSING log as evidence of a reorg, and a reorg reverts state. So a truncated range delivered as a complete one does not fail loudly, it deletes data. Truncation is expressed by LOWERING toBlock, never by delivering part of a range, and this knob is what decides whether truncation was noticed at all.
>
> Why configuration must still win, stated so you do not simplify it away: an operator who has set this has asserted something about their node. A parsed value from an error message is weaker evidence than that assertion, so it may fill a gap but must never override one. Making the SOURCE visible is what lets an operator tell the two apart when diagnosing.
>
> FORWARD-POINTER on the FINDING you are told to read. It has PARTLY GONE STALE and a fresher, wider capture now sits beside it: `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/refusal-shapes.md` (a full re-run dated 2026-09-08, with `capture-refusals.sh` next to it). Read BOTH, and prefer the spike where they disagree. Specifically, `work/notes/observations/the-getlogs-refusal-finding-has-partly-gone-stale.md` records that `rpc.mevblocker.io` no longer answers with the structured `{from, to, limit}` shape (it enforces a 10,000-BLOCK span cap now and answers `-32602`) and that `eth.merkle.io` no longer serves `eth_getLogs` at all, so two rows of the finding's cap table no longer reproduce. The archive-refusal capture, by contrast, is byte-identical three months on. Do NOT amend the finding as part of your task: that is its own item and is already recorded.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the blocking task landed and that a reported limit actually reaches this code. If no provider in the captures reports one, say so rather than building a path nothing exercises.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.

## Decisions

- **A reported cap is read from PROSE as well as from the structured `{from, to, limit}` descriptor the task names.** The task points at `limit` in structured error data, but the fresh capture shows that shape is no longer reproducible on any keyless public endpoint, while seven endpoints count their result cap out in words. Reading only the structured form would have shipped a feature exercised by no provider in the current sweep. The prose patterns are tight and each anchors on what is being COUNTED (`more than N results|logs`, `logs matched by query exceeds limit of N`, `cap of N logs`), which is the same unit-safety rule `statedBlockCapFromError` uses in the opposite direction. Alternative considered: structured only, plus a note that nothing exercises it. Touches: nothing else — `statedBlockCapFromError` (task `a-stated-numeric-cap-becomes-a-ceiling`) deliberately refuses result caps, so this reader takes exactly the shapes that one leaves, and neither was widened.

- **A reported cap only ever LOWERS what was learned (lowest-wins, within a refusal and across refusals).** Mirrors `lowerBlockCeilingTo`, with a sharper asymmetry: a suspect count *below* the node's real cap costs a re-fetched half-range, one *above* it misses the truncation entirely and the receiver deletes state (ADR-0004). One URL can also front several backends with different caps, and the smallest is the only number safe against all of them. Alternative considered: latest-report-wins, which keeps up with a provider that revises its cap upward but can carry a stale-high number into a missed truncation. Touches nothing outside `RangeLogFetcher`; documented at the writer.

- **A new core option, `defaultSuspectResultCount`, exists so a HOST can state the third tier without asserting it.** `@etherfold/fetcher-host` resolved its default (10000) into the same field an operator's value goes in, so *every* deployment looked `configured` to core and no reported cap could ever have filled the gap — the feature would have been dead on the only production path. Core's own fallback (`fetch.maxEventsPerFetch ?? 10000`) is unchanged, per the acceptance criterion, and the host still refuses to let the suspect count follow `maxEventsPerFetch`. Alternatives considered: dropping core's `maxEventsPerFetch` fallback (violates "the existing default is unchanged"), or a boolean flag on core's config (says less and reads worse). Touches: `FetcherHostConfig` gains `suspectResultCountSource`, which is a new required field on that type, and `FetcherHost` now passes `suspectResultCount` conditionally.

- **`LogFetcher.suspectResultCount` changed from a private number to a PUBLIC getter returning `{count, source}`.** It is the acceptance criterion's visibility surface, and the only existing reader was a fetcher-host test reaching in through a cast, which now asserts the public shape. Alternative considered: keeping a number getter plus a second `suspectResultCountSource` getter — two accessors for one answer that must never be read apart. Touches: `packages/fetcher-host/test/classification.test.ts`.

- **`SuspectedTruncationError`'s constructor takes the source as a required third argument.** Criterion 6: the refusal that names this knob must still name it correctly, and "the count this fetcher was **configured** to treat as suspect" is false for a discovered one — worse, the fix differs (a reported count is overridden by configuring one). Alternative considered: an optional parameter defaulting to `'configured'`, rejected because a silently wrong provenance in this particular message is exactly the confusion it exists to prevent. Touches: two test call sites (core, fetcher-host).

- **The runtime `source` is NOT yet in the fetcher host's status/report surface.** It is visible through the getter, the startup line, a log on every change, and the truncation error. Putting the learned values into a status surface is user story 7 of the spec (`the range the fetcher has learned is readable in the status surface`) and belongs to that task, not this one.
