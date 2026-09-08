---
title: 'Find out whether deleting a stream-config field moves the digest'
slug: the-stream-digest-is-pinned-against-an-absent-flag
spec: etherfold-is-a-fold-over-logs
blockedBy: []
covers: [7]
---

## What to build

Establish, as a test rather than as an assumption, whether deleting a stream-config field moves the stream digest.

ADR-0073 records the property: for a deployment that never set `alwaysFetchTimestamps` or `alwaysFetchTransactions`, deleting those fields from `ProvidedStreamConfig` should leave the stream digest BYTE-IDENTICAL, so no stream forks and no history is re-fetched. The mechanism is that `resolveStreamConfig` omits keys whose value is `undefined`, and the digest is taken over the resolved config's canonical bytes.

**This is INFORMATIVE, not a gate, and that is a deliberate scoping decision.** Backward compatibility with what has already been released is not an obligation of this project at its current stage, so if the property turns out not to hold, the answer is to say so in the changeset and proceed with the deletions, NOT to redesign around it. The reason to know anyway is cheap and practical: a silent full re-index is a confusing thing to debug, and one test is a small price for not being surprised by it.

So this task does not block the deletions, and the deletions do not wait for it. It can run before, during or after.

**It is therefore a DELIBERATE ORPHAN against the spec's end state, and that is recorded rather than hidden.** A destination check over this spec will find that nothing in ADR-0073's target system requires this task, because knowing whether the digest moves changes no shipped behaviour. It is kept because one test is a small price for not being confused by a from-scratch re-index during development, and it should be dropped rather than defended if it ever costs more than that.

Two halves:

1. **A recorded-value digest test.** Assert the digest of a representative source with no stream flags equals a LITERAL recorded constant, not a re-computation. A test that computes both sides passes happily when both sides move together, which is exactly the regression this must catch.
2. **A stored-stream round trip.** Write a stream with a config that sets neither flag, then load it back through the ordinary load path and assert no fork and no clear: the real-world version of half 1, and the thing that actually protects existing users.

Do NOT delete anything in this task. The test must be able to run against the CURRENT code so that it says something about the changed code.

## Acceptance criteria

- [ ] A digest test asserts against a literal recorded value, and a comment says why it is literal rather than computed
- [ ] A stored stream written with no stream flags loads with no fork and no clear
- [ ] Both tests run green against the tree as it stands today
- [ ] The RESULT is reported: does the digest survive the field removal, yes or no? A clear answer is the deliverable, and "no" is an acceptable outcome to be recorded rather than fixed
- [ ] The existing assertions in `streamIdentity.test.ts` (an absent flag leaves the digest unchanged; key order does not matter) still pass and are not duplicated
- [ ] Tests mirror the repo's existing test style

## Blocked by

- None, can start immediately.

## Prompt

> Answer a factual question about the `etherfold-is-a-fold-over-logs` deletions. Read `docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md` first, in particular the section "The identity property that makes this cheap, and that decides the timing", including its note that this is worth knowing rather than a constraint on the change.
>
> Your deliverable is a TEST PLUS AN ANSWER. If the digest survives the deletion, say so. If it does not, say that instead and do not try to preserve it: nothing is owed to an already-published consumer here, and a change that re-indexes is acceptable so long as it is known rather than discovered.
>
> Domain vocabulary: a STREAM DIGEST addresses a stored stream and is a function of the fetch filter plus the RESOLVED stream config (`streamDigestOf`, `resolveStreamConfig`); a stream whose digest moves is a DIFFERENT stream, so the old one is orphaned and the new one re-fetches from the source's start block. Look in `@etherfold/core` around the stream identity and stream config modules, and at the existing `streamIdentity.test.ts` for the established assertion style.
>
> The point of the literal recorded constant is subtle and is the whole task: a test that recomputes the digest on both sides of the comparison passes when the digest function changes, which is precisely the failure being guarded against. Record the bytes.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code and the relevant ADRs? If `resolveStreamConfig` no longer omits undefined keys, or the digest no longer covers the resolved config, that is itself the answer this task exists to produce: report it rather than routing to needs-attention, since the premise being false is a legitimate result here rather than a blocker.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
