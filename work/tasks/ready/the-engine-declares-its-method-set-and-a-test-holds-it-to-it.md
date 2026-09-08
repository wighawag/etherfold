---
title: 'The engine declares its method set, and a test holds it to it'
slug: the-engine-declares-its-method-set-and-a-test-holds-it-to-it
spec: etherfold-is-a-fold-over-logs
blockedBy:
  [
    alwaysfetchtimestamps-is-deleted-with-the-enrich-path,
    providersupportsethbatch-is-deleted-and-adr-0002-is-corrected,
  ]
covers: [4]
---

## What to build

The durable guard for this whole spec, and the reason it is worth more than any individual deletion test.

Deleting the enrichment path makes the claim TRUE today. Nothing stops a future change from adding one `eth_getBlockByHash` back, and nothing would notice: a test double that answers the method would let it pass, and the cost is per-block, so it would show up as a vague slowdown rather than a failure.

So: assert the engine never asks its provider for anything outside its declared set. After this spec, that set is `eth_chainId`, `eth_blockNumber`, `eth_getLogs`.

Build it as a provider wrapper the tests can drive: it records every method requested, and the assertion is that the recorded set is a subset of the declared one. Apply it across the engine's own test suite rather than in one bespoke test, so a reintroduced call fails wherever it is added rather than only where someone thought to look.

The declared set should be stated ONCE, in the engine, and the test should read it from there rather than restating the list. A test carrying its own copy of the list is a second source of truth that will drift from the first.

## Acceptance criteria

- [ ] The allowed method set is declared once, in the engine, and is readable by tests
- [ ] A recording provider wrapper exists and asserts the requested methods are a subset of the declared set
- [ ] The assertion runs across the engine's existing test suite, not in a single dedicated test
- [ ] A deliberately reintroduced `eth_getBlockByHash` call fails the suite (demonstrate this, then revert the demonstration)
- [ ] The README's provider-surface claim matches the declared set exactly
- [ ] Tests mirror the repo's existing test style
- [ ] A CHANGESET accompanies the change. The repo's acceptance gate runs `changeset status --since=main`, so a touched package with no changeset is a RED GATE rather than a style nit. Describe the change in prose, as the repo's existing changesets do, not in one line

## Blocked by

- `alwaysfetchtimestamps-is-deleted-with-the-enrich-path`: the claim is not true until the enrichment path is gone.
- `providersupportsethbatch-is-deleted-and-adr-0002-is-corrected`: the batch path is one of the things that would otherwise widen the set.

## Prompt

> Make an architectural claim enforceable instead of aspirational. Read `docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md` and `docs/adr/0002-in-browser-eip1193-indexing-primary.md` (the EIP-1193-first constraint this makes checkable).
>
> Domain vocabulary: the engine talks to an EIP-1193 provider through a single `request({method, params})` seam, which is what makes this guard cheap: one wrapper sees every call. There are two DEPLOYMENT SHAPES (the single-process indexer, and the split log-fetcher that pushes to a receiver); the fetching half makes every chain call and the receiving half makes none, so the guard belongs where the calls are and the receiving half should be asserted to make zero.
>
> The failure mode this exists to prevent is specific and worth understanding before you design it: a reintroduced per-block call does not break anything. It returns the right answer. It just costs a round trip per block, against a provider a browser user is rate-limited on, and it would be found by a profiler months later rather than by CI in seconds. That is why the guard is a subset assertion over the whole suite rather than a unit test of one function.
>
> Demonstrating the guard actually bites (add a call, watch it fail, remove it) is part of the task and should be reported, not skipped as obvious. A guard nobody has seen fail is a guard nobody knows is wired up.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the blocking deletions landed, and confirm the actual method set the engine now uses rather than trusting this task's list. If the engine legitimately needs a fourth method, declare four and say so in your Decisions block; do not quietly widen the set to make a test pass.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
