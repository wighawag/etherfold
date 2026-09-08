---
title: 'Document the EDR requirement, the override, and the scope of the claim'
slug: the-edr-requirement-and-the-scope-of-the-claim-are-documented
spec: etherfold-is-a-fold-over-logs
blockedBy: [alwaysfetchtimestamps-is-deleted-with-the-enrich-path]
covers: [10, 11]
---

## What to build

The documentation half, which carries two things that are easy to get wrong and each of which sends a reader to the wrong place if fudged.

**1. The requirement is on the EDR VERSION, never on the Hardhat version.** State `@nomicfoundation/edr >= 0.20.0`, and put the package-manager override snippet next to it (`pnpm.overrides`, npm `overrides`, yarn `resolutions`). A reader who sees only "no released Hardhat has it" concludes they must wait; the override means they do not. Carry the honest caveat too: an override forces a combination Hardhat did not ship or test, so say verify it in your project rather than that it just works, and note the published 0.19 to 0.20 delta is narrow.

**2. The scope of the claim, which is a limit and not a boast.** "A fold over logs" is a claim about the ENGINE's calls. It is NOT a guarantee that the fold sees every log on the chain: `eth_getLogs` is generally served from a `logsBloom`-derived index, so a log the bloom does not commit to is omitted with no error and nothing signalling it. The documented claim is "every log the node's log index contains". Do not overstate it, and do not bury it either.

Where: the README's Caveats section is the natural home for both.

**Explicitly NOT in scope: a migration guide.** Backward compatibility with what has already been released is not an obligation of this project at its current stage, so do not write upgrade instructions, do not enumerate who is affected, and do not document a compatibility path. If the stream digest moves for someone who set a flag, the changeset stating what was removed is sufficient. Effort spent on a migration here is effort spent on a promise nobody made.

## Acceptance criteria

- [ ] The minimum requirement is stated against `@nomicfoundation/edr`, with a working override snippet for all three package managers
- [ ] The override's caveat is stated (an untested combination; verify locally) rather than implied
- [ ] No migration guide or compatibility path is written (see above: deliberately out of scope)
- [ ] The completeness claim is scoped to what the node's log index contains, with the bloom-omission case named and the finding referenced
- [ ] No document still tells a reader to set a flag that no longer exists
- [ ] The README's stated provider surface matches what the engine actually calls

## Blocked by

- `alwaysfetchtimestamps-is-deleted-with-the-enrich-path`: this documents the post-deletion world, so it must not land describing a state that does not exist yet.

## Prompt

> Write the docs for a breaking simplification. Read `docs/adr/0073-the-engine-makes-one-data-call-and-eth-getlogs-is-it.md` and `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` (section 3 is the bloom-omission case with the captured numbers: Polygon block 74,614,768, 848 logs from `eth_getLogs` against 8 more from the same node's `eth_getTransactionReceipt`).
>
> Two separate audiences, and conflating them is the way this goes wrong. The Hardhat user needs the override and needs to know they are not waiting for anyone. The evaluator reading the Caveats needs an honest scope on the completeness claim, because a claim they later discover to be qualified costs more trust than a qualified claim stated up front.
>
> Resist the pull toward writing a migration section. It is the reflex this kind of change usually deserves and it is explicitly not wanted here: nothing is owed to an already-published consumer at this stage, and a migration guide would imply a compatibility promise that does not exist.
>
> The bloom-omission limit meets ADR-0004 at its weakest point: an absence there is an INFERENCE that reverts state, and a bloom-omitted log is a STABLE absence rather than a flapping one, so it is undetectable rather than noisy. Say enough that a Polygon user recognises their situation; the finding carries the detail.
>
> The repo does not hard-wrap prose in Markdown: write each paragraph as one line and let editors soft-wrap. Do not use em dashes.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): re-verify the EDR and Hardhat version facts before publishing them, since both move. If a Hardhat release now bundles edr >= 0.20.0, say so and keep the override as the fallback for older versions rather than deleting it.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
