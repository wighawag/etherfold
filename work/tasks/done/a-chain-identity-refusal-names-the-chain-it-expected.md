---
title: 'A chain-identity refusal names the chain it expected and the one it got'
slug: a-chain-identity-refusal-names-the-chain-it-expected
spec: one-chain-identity-check-per-cycle-not-two
blockedBy: [the-cycle-checks-chain-identity-once-after-the-fetch, the-fetcher-checks-chain-identity-once-after-the-fetch]
covers: [4]
---

## What to build

The split deployment's fetcher already refuses a wrong chain well: a typed `UnexpectedChainError` carrying the expected chain, the actual one, and which side of the fetch caught it. The in-process engine refuses the same condition in three places with three hand-written bare `Error`s, and one of them says only "chainId changed after fetch", which tells an operator nothing about which chain they are on.

Bring the engine's three sites onto the same footing:

- the surviving **per-cycle** check, after the fetch;
- the **load** path, which already names both chains in prose but throws a bare `Error` nobody can catch by type;
- the **reconfigure** path, which compares a newly supplied provider against the previous context's chain and throws a bare `Error` built from a multi-line template literal, indentation and all.

All three hand-roll the same hex parse; an internal `getChainId` helper already exists and is what the fetcher path uses.

**One wrinkle to get right rather than around.** `UnexpectedChainError`'s message ends with a clause about the receiver making no chain calls and therefore being unable to catch this. That is true on the fetcher path and meaningless on the other three, where there is no receiver and nothing is pushed. So do not simply throw the existing message from the engine. The behaviour this task owes is that a refusal names what was expected, what was received, and where it was detected, without asserting consequences that do not apply on the path that threw it.

Two shapes do that, and the RECOMMENDED one is to make the path-specific clause a constructor input on the existing type, keeping one name, one `retryable` answer and one thing for the fetcher host to classify. The alternative is a shared base with a second name, which is better only if the two paths turn out to need different retryability. Take the recommendation unless you find a reason not to, and record what you did and why in your `## Decisions` block.

The reconfigure site is deliberately included even though the spec does not scope it. It is the same defect, three lines long, and leaving it means the codebase holds both the corrected and the uncorrected shape of one decision.

## Acceptance criteria

- [ ] A chain-identity refusal on the per-cycle path names the expected chain id, the received one, and that it was detected after the fetch.
- [ ] The load path and the reconfigure path refuse with the same typed error family, each naming both chain ids.
- [ ] No refusal claims a consequence that does not hold on the path it was thrown from (in particular, the engine's refusals do not talk about a receiver or about nothing being pushed).
- [ ] Every one of these refusals is catchable BY TYPE, not by matching a message.
- [ ] The engine reads the chain id through the existing shared helper rather than through a fourth copy of the hex parse.
- [ ] `UnexpectedChainError` remains exported and constructible as it is today, so the fetcher path and the fetcher host's error classification keep working unchanged.
- [ ] Tests assert the refusal type and that both chain ids appear, for each of the three engine sites.
- [ ] ADR-0081's `status: accepted, not yet implemented` line is REMOVED, since this is the last task in its chain and the decision is fully in the code once it lands.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`). This touches a PUBLISHED package and `pnpm changeset status --since=main` is in the acceptance gate.

## Blocked by

`the-cycle-checks-chain-identity-once-after-the-fetch`, because one of the three sites is the before-fetch call it deletes and the other is the survivor whose message this rewrites — doing both at once puts two edits on the same lines. And `the-fetcher-checks-chain-identity-once-after-the-fetch`, so that this task is unambiguously the LAST of the three: ADR-0081's pending-status line is removed here, and a chain where every member can see it is not the last one is how such a line survives (see `ADR-FORMAT.md`).

## Prompt

The goal is that a chain-identity refusal is diagnosable in one read, on every path that can produce one.

Read `work/specs/tasked/one-chain-identity-check-per-cycle-not-two.md` (story 4) and **ADR-0081**, whose consequences section states the intended end state: the two deployment shapes converge on one refusal type so an operator reads one refusal rather than four spellings of it.

Where to look: `@etherfold/core`'s error module for `UnexpectedChainError` and how its siblings are shaped (several carry both sides of a mismatch, and the `retryable` flag on each is read by the fetcher host to decide whether to retry or stop — check what that classification does with whatever you throw). Then the in-process engine's three sites: the per-cycle check after the fetch, the load path's opening identity check, and the reconfigure path's comparison of a new provider against the previous context.

The seams to test at: the engine driven by a fake provider whose chain id can be moved (the follower tests have the harness), the load path with a provider on the wrong chain from the start, and the reconfigure path handed a provider on a different chain. Assert the TYPE and the presence of both ids, not an exact sentence, so the wording can improve later without a test rewrite.

Two constraints worth stating because they are easy to breach: a published error type's constructor is public API, and the fetcher host classifies errors by identity to decide retryability, so anything you add must land on the right side of that classification.

Done means: three refusals that a reader can act on without a debugger, catchable by type, sharing one family with the fetcher's, and ADR-0081 no longer claiming to be unimplemented.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The error-shape choice above is exactly such a decision and must appear there. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

- **The path-specific clause is derived from a WIDENED `when` parameter, not from a new free-text constructor argument and not from a second error class.** `UnexpectedChainError`'s third parameter is now `ChainIdentityCheckPoint` = `'before' | 'after' | 'cycle' | 'load' | 'reconfigure'`, and a module-private table maps each point to both its "where" fragment and its consequence sentence. The task recommended making the path-specific clause a constructor input; a closed enum of check points IS that input, and it is better than passing the clause as a string, because the wording then stays in one table in `errors.ts` (the five refusals cannot drift into five spellings, which is the state ADR-0081 exists to end) and callers cannot inject prose into a published error. Alternatives considered: (a) a `consequence: string` fourth parameter with the fetcher's clause as the default (rejected: prose as public API, and the wording spreads back out to the throw sites); (b) a shared base class with a second name for the engine (rejected: the task pins it as better only if the two paths need different retryability, and they do not, so it would give a host two identities to classify for one condition). Touches: `@etherfold/core`'s public error surface and `@etherfold/fetcher-host`'s classification, which reads `retryable` structurally (`retryable !== false`) and is therefore unaffected: all five points stay `retryable: false`.
- **`when` is re-documented as "the point at which the check was made" rather than "which side of the fetch caught it", and the engine's per-cycle point is `'cycle'`, not `'after'`.** Coherence check: this generalises an existing parameter rather than forking a concept, and the fetcher's `'after'` could not be reused for the engine's post-fetch check, because `'after'` carries the receiver clause that only the split deployment has. Reusing `'before'` for the load path was also rejected: ADR-0081 deleted the before-fetch call, so re-meaning `'before'` as "at load" would resurrect a value the ADR retired with a different meaning. `'before'` stays reachable-by-construction and unreachable-from-production, exactly as `the-fetcher-checks-chain-identity-once-after-the-fetch` decided. Touches: the fetcher-host classification test that constructs `new UnexpectedChainError('1', '137', 'before')`, which keeps working unchanged.
- **The reconfigure refusal keeps the old prose's remedy ("did you forget to pass a new source?") and the load refusal keeps "point at a node for the chain this source names, or correct the source's chainId".** These are the only actionable parts of the messages being replaced, and dropping them while typing the error would have made the refusal catchable and less useful at once. The engine's messages state no consequence about a receiver or about pushing, which the tests assert as a negative on all three sites.
- **No ADR written.** The rationale is ADR-0081's, already accepted, and its consequences section already states this end state; this change is what makes that section true, so the pending-status line went rather than a new decision arriving.
