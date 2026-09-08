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

## Decisions

- **The declared set is FOUR methods, not the task's three.** `eth_getBlockByNumber` is added because `IndexerGeneration.promiseToLoad` reads the chain's first block to check a source's `genesisHash` (real, user-supplied configuration read by `@etherfold/utils` and hashed into the stream identity). It is IDENTITY like `eth_chainId`, asked once per load and never per block, so it belongs in the set rather than being routed around the wrapper. Alternatives considered: declaring three and calling the genesis check on an unguarded raw provider (a documented hole at exactly the method that reads blocks), or deleting the check (out of scope, and it is a real feature). Touches: the README claim and `CONTEXT.md`, which now say four.

- **The guard REFUSES in production rather than only recording in tests.** This is what makes the subset assertion run "across the engine's existing test suite" without editing 20 test files or inventing a global test-side registry: there is no seam a vitest setup file could reach into, because providers are plain objects constructed inside each test. It introduces a new error type (`UnexpectedProviderMethodError`), but no configuration and no node can provoke it: the only code that reaches a guarded provider is this engine, so it is an internal invariant, not an operator-facing refusal. Alternatives considered: a module-level recording registry read by a global `afterEach` (production code carrying a test-only global, and it retains objects), and a per-test opt-in wrapper (drifts the moment someone writes a new test). Cost is one `Set` lookup per request. No ADR written: ADR-0073 already decides the claim and this is its enforcement, hard to be surprised by given that ADR, and one deletion to reverse.

- **`eth_getBlockByNumber` is narrowed to the genesis probe by its PARAMS, not just its name.** A set of method names alone leaves a per-block-shaped hole at the one declared method that can read a block: a reintroduced enrichment loop written against `eth_getBlockByNumber` would pass a name-only guard. The narrowing states "identity, not data" in the only place it can be stated. Trade-off: the guard now enforces slightly more than the "set" the tests read, which I documented at the site and in the README claim.

- **The probe predicate accepts BOTH `earliest` and `0x0`, and this touches another ready task.** `work/tasks/ready/the-genesis-check-asks-for-block-zero-not-the-earliest-tag.md` replaces the tag with the explicit block number (because `earliest` means lowest-available, not genesis). Keying my predicate on `earliest` alone would have made that one-line fix fail here with a confusing refusal, so both spellings pass; both are the bottom of the chain, which is the property the predicate actually defends. Note for that task: it also asks that no `earliest` remain in the repo, and `packages/core/src/providerSurface.ts` is now a second site holding the string, deliberately, with a comment pointing at the task.

- **The claim lives in TWO READMEs, anchored and checked both ways.** The root README is where "relies only on EIP-1193" is claimed to a user; `packages/core/README.md` is the engine's own doc. Rather than pick one and leave the other vaguer, both carry the claim behind an HTML-comment anchor and the test asserts set equality against `ENGINE_PROVIDER_METHODS` in each. Duplication cannot drift silently, and declaring a fifth method now requires writing it where a user reads it. Side effect worth knowing: `eth_*` names may not appear inside those anchored paragraphs unless declared, so the history of a deleted call belongs in the ADR, which is where it already is.

- **`captureStream` is guarded too.** It is a third place the engine talks to a node (one `LogEventFetcher`, `eth_getLogs` only). Including it costs one line and keeps "every provider the engine holds is behind the declared surface" true without exceptions; excluding it would have made the rule "every intake except the capture one".

- **New vocabulary: "the declared provider surface"** (`ENGINE_PROVIDER_METHODS`, `declaredMethodsOnly`, `MethodDeclaringProvider`, `UnexpectedProviderMethodError`, `isGenesisProbe`). Checked against `CONTEXT.md` and the ADRs: no existing term meant this ("chain-facing surface" was prose in ADR-0073 and ADR-0002 with no code behind it, and this names exactly that, at the engine layer where the calls are). The error name follows the existing `UnexpectedChainError` / `UnexpectedFromBlockError` family and carries `retryable: false` per the errors-file convention. I added a glossary entry to `CONTEXT.md` so the term has one home.
