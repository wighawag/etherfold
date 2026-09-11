---
title: 'The in-process cycle checks chain identity once, after the fetch'
slug: the-cycle-checks-chain-identity-once-after-the-fetch
spec: one-chain-identity-check-per-cycle-not-two
blockedBy: []
covers: [1, 2, 3, 5]
---

<!-- Story 1 names TWO call sites, in two deployment shapes. This task owns the in-process
     engine's; `the-fetcher-checks-chain-identity-once-after-the-fetch` owns the fetcher's. The
     story is closed only when both are done, which is why both carry `covers: [1]`. -->

## What to build

The in-process engine brackets every cycle's log fetch with two `eth_chainId` calls. Delete the one BEFORE the fetch. Keep the one after, unconditional, in the position it already holds: after the logs are in hand and before anything is written or folded.

Only the after call is a guard. It catches a provider that swapped chains DURING the fetch, which is the window in which chain B's logs would be folded into chain A's stream. The before call only fails fast, saving a wasted range fetch when the provider had already swapped before the cycle began, and catching nothing the after call does not. ADR-0081 records the whole argument; the code should carry enough of it beside the surviving call that a future reader does not restore the deleted one for symmetry or delete the wrong one of the pair.

The comment beside these calls promises that the indexer will be warned "as soon as possible via chainChanged event". Nobody built that. It is the repository's only mention of `chainChanged`, no listener exists, and the provider type used throughout (including in `@etherfold/browser`) structurally cannot carry a subscription. Correct the comment so it stops describing a design that does not exist and stops implying a second line of defence.

**One existing test changes meaning and must be rewritten rather than deleted.** The engine's follower suite has a `a provider that changes chain mid-cycle` group with two cases. The first (the provider moves DURING the fetch) is exactly the guard being kept and must stay green untouched — story 5 is already satisfied by it. The second asserts the behaviour this task removes: that a provider which moved BETWEEN cycles is refused before a single range is requested. After this change that provider is still refused and still reaches no fold, but the range IS fetched first. Rewrite the case around the outcome that survives (a moved provider never reaches the fold) rather than the cost that changed, so the suite keeps testing the guarantee and stops pinning the round trip.

## Acceptance criteria

- [ ] A normal cycle makes exactly ONE `eth_chainId` call, and it happens after the log fetch and before the stream write or the fold.
- [ ] A test asserts that call COUNT for a cycle, so restoring a before-fetch call fails loudly rather than passing quietly.
- [ ] A provider that swaps chain during the fetch is still refused, and nothing from the wrong chain reaches the fold or the stream. The existing mid-fetch case demonstrates this and stays green.
- [ ] A provider that swapped between cycles is still refused and still folds nothing; the case asserting it is refused *before any range is requested* is rewritten around what remains true rather than left to fail or deleted.
- [ ] The cursor does not move on a refusal, so the next cycle re-derives the same range.
- [ ] The `chainChanged` comment no longer promises a mechanism that does not exist, and the surviving call carries the reason it is the survivor.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches a PUBLISHED package and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

None — can start immediately.

## Prompt

The goal is one chain-identity round trip per cycle instead of two, in the in-process engine, with no loss in what is detected.

Read `work/specs/tasked/one-chain-identity-check-per-cycle-not-two.md` and **ADR-0081**, which holds the durable argument: why the after-fetch call is the survivor, why a `chainChanged` subscription could not replace it even if someone built it, and why the survivor is deliberately unconfigurable. Do not add a flag, a config field or an option; that was proposed, argued and withdrawn.

Where to look: the in-process engine's per-cycle path in `@etherfold/core` (the method that loads if needed, checks identity, fetches the range, checks identity again, then writes the stream and folds). The two calls are a few lines apart and both hand-roll the hex parse; an internal `getChainId` helper already exists in the engine's ethereum internals and is what the fetcher path uses.

The seam to test at is the engine driven by a fake provider whose `eth_chainId` answer can be moved, including from inside the fetch. That harness already exists in the core test suite's follower tests — reuse it rather than building a second one, and read both of its existing chain-swap cases before changing anything, because one of them is the guard you are keeping and the other pins the round trip you are removing.

Sibling work you must not collide with: a separate task replaces the engine's bare `Error` refusals with the typed `UnexpectedChainError` the fetcher path already throws, and another deletes the equivalent before-fetch call on the fetcher path. Leave the refusal's TYPE and message alone here; this task is about which calls happen, not how the refusal reads. Changing both at once puts two edits on the same lines for no coverage either task asks for.

Done means: one identity call per cycle, positioned after the fetch, demonstrated by a count assertion; both chain-swap outcomes still refused with nothing folded; the `chainChanged` comment corrected; and the reason the survivor survives readable where the code is.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

- **The surviving call uses the internal `getChainId` helper rather than keeping the inline hex parse.** Why: the prompt points at it, it is what the fetcher path already uses, and leaving a hand-rolled `parseInt(...slice(2), 16)` beside a helper that does exactly that is the duplication ADR-0081's "the two shapes converge" consequence argues against. Alternative considered: pure deletion, leaving the after call byte-for-byte as it was, to keep the diff minimal for the sibling refusal-type task. Touches: `the-fetcher-checks-chain-identity-once-after-the-fetch` not at all, and `a-chain-identity-refusal-names-the-chain-it-expected` only adjacently (it rewrites the `throw` line below; the `chainId` variable name and its value, a decimal string, are unchanged, so its edit still applies cleanly).
- **The rewritten between-cycles test asserts the after-fetch refusal message (`/chainId changed after fetch/`).** Why: with the before call gone, that provider now trips the surviving guard, and the message is the one the code has today; matching the sibling mid-fetch case keeps one spelling in the suite. Touches: `a-chain-identity-refusal-names-the-chain-it-expected` will have to update this regex along with the mid-fetch one it was always going to update. I deliberately did not soften it to a bare `rejects.toThrow()` to hide that, because an untyped catch-all would stop the test saying which guard fired.
- **The chain-swap harness gained a stream keeper, so both refusal cases now assert nothing was written to the stream.** Why: acceptance criterion 3 is about the fold AND the stream, and the group previously ran with no keeper at all, making the stream half unassertable. Touches: only this `describe`'s own `indexerOn`; the existing mid-fetch case is otherwise unchanged and green.
- **ADR-0081's `status: accepted, not yet implemented` is left as-is.** Why: it covers three tasks and two are still in `ready/`; flipping it now would overstate what landed and would also collide with whichever sibling lands last. Alternative considered: amend it to say the engine half is done, which is a running commentary an ADR should not carry.
