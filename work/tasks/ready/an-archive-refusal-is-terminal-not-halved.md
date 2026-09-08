---
title: 'An archive refusal is terminal for that endpoint, not something to halve at'
slug: an-archive-refusal-is-terminal-not-halved
spec: the-fetcher-reads-the-hints-providers-already-send
blockedBy: [a-provider-refusal-is-read-from-its-data-before-its-prose]
covers: [6]
---

## What to build

Serving logs for old blocks needs an archive node, and public endpoints commonly refuse or token-gate it. A captured example: `Archive requests require a personal token. Get one at: ...`, arriving as `-32602`.

The fetcher treats every refusal as a range problem, so it halves and retries. No range size will ever satisfy an archive refusal, so a deep backfill against a non-archive endpoint grinds: it burns the retry budget, then fails with whatever the last error happened to be, and the operator learns nothing about the actual cause.

Recognise this class and report it as TERMINAL for that endpoint: stop retrying, and fail with a message naming the real reason, so an operator reads "this endpoint will not serve history" rather than a range error.

This is deliberately narrow. Only refusals that clearly identify themselves as archive or history access problems qualify. A refusal we cannot classify keeps today's behaviour, because halving is the safe default for an unknown error and misclassifying a transient failure as terminal would turn a retryable blip into a stopped indexer.

## Acceptance criteria

- [ ] A captured archive refusal stops the retry loop instead of halving through the budget
- [ ] The resulting error names archive access as the cause, not a range problem
- [ ] The error is structurally marked non-retryable, consistent with how the codebase already distinguishes retryable errors, rather than by a caller matching on message text
- [ ] An unclassifiable refusal still halves and retries exactly as today
- [ ] A transient network failure is NOT classified as terminal, asserted directly
- [ ] A CHANGESET accompanies the change. The repo's acceptance gate runs `changeset status --since=main`, so a touched package with no changeset is a RED GATE rather than a style nit. Describe the change in prose, as the repo's existing changesets do, not in one line

## Blocked by

- `a-provider-refusal-is-read-from-its-data-before-its-prose`: same catch path, serialised to avoid a merge conflict, and its `looksLikeRangeHint` test already pins the archive case as producing no range hint, which is the classification this task builds on.

## Prompt

> Stop the fetcher grinding against an endpoint that will never answer. Read `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` section 4 for the captured refusal.
>
> Domain vocabulary: the fetcher has a retry budget and a halving strategy for refused ranges, and separately the codebase already distinguishes RETRYABLE from non-retryable errors structurally (a property on the error rather than an `instanceof`, so an error crossing a package boundary from a second copy of core still classifies correctly). Use that existing mechanism; do not invent a second way to say non-retryable.
>
> The judgement to get right is the width of the classifier. Being too eager turns a transient outage into a stopped indexer, which is worse than the grinding this fixes, because grinding is visible and slow while a false terminal is fast and wrong. Match narrowly on refusals that identify themselves, and let anything ambiguous fall through to today's behaviour.
>
> FORWARD-POINTER on the FINDING you are told to read. It has PARTLY GONE STALE and a fresher, wider capture now sits beside it: `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/refusal-shapes.md` (a full re-run dated 2026-09-08, with `capture-refusals.sh` next to it). Read BOTH, and prefer the spike where they disagree. Specifically, `work/notes/observations/the-getlogs-refusal-finding-has-partly-gone-stale.md` records that `rpc.mevblocker.io` no longer answers with the structured `{from, to, limit}` shape (it enforces a 10,000-BLOCK span cap now and answers `-32602`) and that `eth.merkle.io` no longer serves `eth_getLogs` at all, so two rows of the finding's cap table no longer reproduce. The archive-refusal capture, by contrast, is byte-identical three months on. Do NOT amend the finding as part of your task: that is its own item and is already recorded.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the blocking task landed and that the retryable-error mechanism still works as described.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
