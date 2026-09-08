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
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the blocking task landed and that a reported limit actually reaches this code. If no provider in the captures reports one, say so rather than building a path nothing exercises.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
