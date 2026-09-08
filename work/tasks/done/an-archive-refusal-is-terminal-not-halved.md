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

## Decisions

**1. The classifier is `archive` AND an entitlement word, not either alone.** This is the width judgement the prompt flags, and both halves are load-bearing. `archive` alone swallows "archive node is syncing" and "archive backend temporarily unavailable", which are transient, and a false terminal is the worse failure (grinding is slow and visible; a false terminal is fast, wrong and permanent). An entitlement word alone swallows the captured `rpc.ankr.com` "You must authenticate your request with an API key", which is about the endpoint rather than about serving history, so every deployment that briefly loses a key would stop. Alternatives considered: (a) substring `archive` only, rejected as too eager; (b) an exact match on the one captured `publicnode` sentence, rejected as matching nothing but one provider's current wording (they revise these: two rows of the finding's own table stopped reproducing in three months); (c) a negative list of transient words, rejected because a deny-list drifts and fails open, while the positive conjunction fails closed onto today's halving. The entitlement words beyond `token` (`api key`, `plan`, `upgrade`, `unsupported`, `not supported`, `not enabled`) are a deliberate, documented widening beyond the single capture. **What it touches**: it introduces a new user-visible terminal failure on the fetch path, so it is reversible only in the sense that widening/narrowing a regex is; the two negative tests (`archive node is syncing`, the ankr message) are what pin the shape.

**2. No error CODE gate.** The captured refusal is `-32602`, but the 2026-09-08 sweep found range refusals under seven different codes, so a code set here would be a list that goes stale the way the finding's cap table did. The identifying evidence is the text; the code adds nothing. Alternative considered: restricting to `-32602`/`-32000`, which would silently miss the same refusal from any provider that codes it differently, and would look like a safety rail while being an arbitrary one.

**3. Read from `error.data` before `error.message`, though no captured archive refusal puts it there.** Parity with `getNewToBlockFromError`, which had to learn this because Nethermind puts its whole complaint in `data` behind a bare `"invalid params"` (Gnosis, Chiado, Fraxtal, captured). Rather than have two functions read one error in two different orders, both read the same three places. The test for it is labelled CONSTRUCTED with that reasoning. Alternative considered: message-only, which is what the evidence strictly supports but re-opens exactly the hole the blocking task closed for the range path.

**4. Thrown BEFORE the retry-budget check, so the last attempt reports it too.** If an endpoint starts gating history mid-backfill on the final retry, the operator still gets the real cause instead of a range error. Costs nothing; noted because it is a deliberate ordering inside the catch.

**5. `ArchiveRefusedError` is a new PUBLIC type in `@etherfold/core`, and it is named for the refusal, not for the remedy.** It sits in `errors.ts` with the other fetch-path refusals (`SuspectedTruncationError`, `NoFetchProgressError`, `TimestamplessLogError`) and is exported through `index.ts`, which is what makes it readable structurally across a package boundary. Alternatives considered: `ArchiveRequiredError` (states a remedy the fetcher cannot be sure of: the endpoint may have an archive and simply not sell it to this connection) and `HistoryUnavailableError` (too close to the `BlockUnavailableError` family, which is about a STORE's retention, not a node's entitlement, and reusing that shape of name would blur two unrelated concepts). Coherence check: `archive refusal` is the task's and the finding's own vocabulary, collides with no `CONTEXT.md` term, and duplicates no existing concept. **What it touches**: `@etherfold/fetcher-host`'s classification list (a test-only change, hence its patch entry in the changeset) and one doc line in `logFetcher.ts`.

**6. No ADR.** The trade-off is real but the decision is cheap to reverse (one regex and one class, both covered by tests that state the hazard in each direction) and it is recorded in the changeset and at the choice site. It does not meet the "hard to reverse" half of the ADR gate.
