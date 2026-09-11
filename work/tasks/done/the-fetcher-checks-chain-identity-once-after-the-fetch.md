---
title: 'The split deployment fetcher checks chain identity once, after the fetch'
slug: the-fetcher-checks-chain-identity-once-after-the-fetch
spec: one-chain-identity-check-per-cycle-not-two
blockedBy: []
covers: [1]
---

<!-- Story 1 names TWO call sites, in two deployment shapes. This task owns the fetcher's;
     `the-cycle-checks-chain-identity-once-after-the-fetch` owns the in-process engine's. The
     story is closed only when both are done, which is why both carry `covers: [1]`. -->

## What to build

The same deletion as the in-process engine's, in the other deployment shape. The split deployment's log fetcher opens every cycle with a chain-identity assertion and makes a second one after the range is fetched and before the batch is pushed. Delete the opening one. Keep the one after the fetch, in its current position, which its own comment already identifies as "the last moment at which logs from another chain can still be stopped from being indexed".

The argument is identical to the engine's and is recorded once, in ADR-0081: the after call catches a provider that swapped DURING the fetch, the before call only fails fast, and only one of the two is a guard. What makes this its own task is that it is a different file in a different deployment shape, so it can be built in parallel with the engine's without the two colliding.

Two smaller shapes fall out of the deletion and neither is decided for you. The private assertion helper takes a `'before' | 'after'` argument that now has one reachable value, and the retry policy currently wraps both calls (worth preserving on the survivor: a flaky `eth_chainId` is a provider problem, not a chain swap). Collapsing the argument is reasonable and so is leaving it to mirror the error's own parameter; pick one and say which in your `## Decisions` block.

**Keep the refusal type exactly as it is.** `UnexpectedChainError` takes the expected chain, the actual one, and which side of the fetch caught it. With the before call gone, the `'before'` value becomes unreachable from production code — but the error is exported from a published package and the `'before'` case is constructed directly by the fetcher host's classification tests, so narrowing the constructor is a breaking change that buys nothing. If you disagree after looking, do not silently decide: record it in the `## Decisions` block with what you found.

## Acceptance criteria

- [ ] A fetch-and-push cycle makes exactly ONE `eth_chainId` call, after the range is fetched and before the batch is pushed.
- [ ] A test asserts that call count, so restoring an opening call fails loudly.
- [ ] A provider serving the wrong chain is still refused with `UnexpectedChainError` and still pushes nothing; the existing case that asserts this stays green with its assertions unchanged.
- [ ] A provider that swaps chain during the fetch is refused and nothing is pushed. Add this case if the suite does not already have one: it is the case the surviving call exists for, and it is the one that would silently stop being covered if someone later deleted the wrong call.
- [ ] `UnexpectedChainError`'s exported signature is unchanged.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches a PUBLISHED package and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

None — can start immediately. It is deliberately parallel to `the-cycle-checks-chain-identity-once-after-the-fetch`, which makes the same change in the in-process engine and touches a different file.

## Prompt

The goal is one chain-identity round trip per fetch cycle instead of two, in the split deployment's log fetcher, with no loss in what is detected.

Read `work/specs/tasked/one-chain-identity-check-per-cycle-not-two.md` and **ADR-0081** for the durable argument. Do not add a flag or an option to make the survivor conditional; that was proposed, argued and withdrawn.

Where to look: the log fetcher in `@etherfold/core` — the class that reads a range from a provider and pushes a batch to a receiver over the wire. Its identity assertion is a small private method taking `'before' | 'after'`; one call site opens `fetchAndPush`, the other sits between the fetched range and the push. Both go through the retry policy, which is worth preserving on the survivor: a flaky `eth_chainId` is a provider problem, not a chain swap.

Domain vocabulary: the RECEIVER makes no chain calls at all, by design (ADR-0003). That is why this check exists on this side and why its refusal message says so: a fetcher pointed at the wrong endpoint would hand the receiver another chain's logs under a perfectly valid identity, and nothing downstream could catch it.

The seam to test at is the fetcher driven by a fake chain and a fake receiver, which the core test suite already has (look for the group about what only this side can check). A provider whose `eth_chainId` answer moves mid-fetch is the case that matters most; the engine's follower suite has a movable-chain harness you can borrow the shape of if the fetcher suite has no equivalent.

Sibling work you must not collide with: a separate task makes the same deletion in the in-process engine, and another moves that engine's bare `Error` refusals onto this package's `UnexpectedChainError`. Stay inside the fetcher.

Done means: one identity call per fetch cycle, positioned after the fetch and before the push, demonstrated by a count assertion, with the wrong-chain and swapped-mid-fetch refusals both covered and nothing pushed in either.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

- **Collapsed the private helper's `'before' | 'after'` parameter**, so it is now `private async assertChain(): Promise<void>` and passes the literal `'after'` to `UnexpectedChainError` at the single construction site. The alternative was leaving the parameter to mirror the error's own. Chosen because a private one-call-site helper whose parameter has one reachable value is dead flexibility, and a reader seeing `assertChain('after')` would reasonably go looking for the `'before'` call that no longer exists. Touches nothing outside the class: the *exported* error keeps both values (the fetcher host's classification tests construct `'before'` directly, and narrowing a published constructor buys nothing), and the retry label is now the constant string `'checking the chain id (after fetch)'`.
- **Corrected the `UnexpectedChainError` docstring in `errors.ts`** ("checked before it fetches and again before it pushes" was made false by this deletion) and added a JSDoc on the `when` parameter recording that `'before'` is now unreachable from a cycle but deliberately kept. This is the one file I touched outside the fetcher, and a sibling task (moving the engine's bare `Error` refusals onto this type) also edits this class, so a textual merge conflict is possible; the edit is confined to comments, no behaviour or signature.
- **Updated two order assertions outside the fetcher suite** (`test/noBlockTimestampIsFetched.test.ts`, `test/noTransactionDataIsFetched.test.ts`), which pinned the deduped method list as `['eth_chainId', 'eth_getLogs']`. They are about *which* chain calls a cycle makes, not their order, and the order flipped as a direct consequence of the deletion; they are now `['eth_getLogs', 'eth_chainId']` with a one-line comment naming ADR-0081. No assertion about the fetched/pushed data changed.
- **No ADR written**: the rationale is entirely ADR-0081's, already accepted, and the code now cites it at the surviving call site.
