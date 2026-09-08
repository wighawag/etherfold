---
title: 'A cap a provider states in prose becomes a ceiling, instead of being halved towards'
slug: a-stated-numeric-cap-becomes-a-ceiling
spec: the-fetcher-reads-the-hints-providers-already-send
blockedBy: [a-provider-refusal-is-read-from-its-data-before-its-prose]
covers: [3]
---

## What to build

Some providers refuse with their cap written out in the message, in words rather than as a suggested range: `up to a 2K block range`, `Exceed maximum block range: 5000`. Today that number is dropped and the fetcher halves blindly towards a limit it has just been told.

Extract a stated numeric cap and use it as a CEILING, feeding the same mechanism the fetcher already has for a discovered upper bound (the field it sets today when it recognises a too-wide-range message from specific chains).

Two properties to hold on to:

- **A ceiling is not a target.** It bounds what the fetcher will ask for; it does not become the requested size directly, because a block-span cap says nothing about how many logs those blocks hold.
- **Never widen on a guess.** A parsed number may be wrong or may be a different quantity than it appears (a result cap read as a block cap). It may only ever LOWER the ceiling, never raise it, so a misparse costs throughput and can never cause a request the provider refuses.

## Acceptance criteria

- [ ] `up to a 2K block range` and `Exceed maximum block range: 5000` both yield a ceiling, with the `2K` style unit suffix handled
- [ ] A parsed cap only ever lowers the ceiling; a test asserts a larger parsed value does not raise it
- [ ] A message with no stated cap leaves behaviour exactly as it is today
- [ ] A number that is clearly not a block count (zero, negative, absurdly large) is ignored rather than trusted
- [ ] Tests use captured real-world messages, provider named in a comment
- [ ] A CHANGESET accompanies the change. The repo's acceptance gate runs `changeset status --since=main`, so a touched package with no changeset is a RED GATE rather than a style nit. Describe the change in prose, as the repo's existing changesets do, not in one line

## Blocked by

- `a-provider-refusal-is-read-from-its-data-before-its-prose`: same function, serialised to avoid a merge conflict, and this builds on the parse paths that task establishes.

## Prompt

> Teach the fetcher to believe a provider that states its own limit. Read `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` for the captured message shapes and their sources.
>
> Domain vocabulary: the fetcher keeps a discovered upper bound on how many blocks a provider will accept, learned by being refused, and separately tracks the largest span it has SUCCEEDED with. A ceiling constrains the first; it is not the same as the range it asks for next, which is computed from the log density it has observed.
>
> The only-ever-lower rule is the important one and it is what makes prose parsing safe at all. Parsing English is guessing, and the design question is what a wrong guess costs. Lowering costs a few extra round trips; raising would produce a request the provider refuses, and the fetcher would then discover the same limit again the slow way. Make it structurally impossible to raise, not merely unlikely.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the blocking task landed and that the ceiling field still exists with the meaning described here.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
