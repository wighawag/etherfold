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

## Decisions

- **The pnpm override snippet is given in TWO files, not one.** ADR-0073 and the task both say "`pnpm.overrides`", which is the pnpm 10 form; pnpm 11 and later ignore the `pnpm` field in `package.json` entirely and read `overrides:` from `pnpm-workspace.yaml`. This repo's own `pnpm-workspace.yaml` documents that exact trap for its `abitype` override, so a package.json-only snippet would have been a snippet that silently does nothing for a reader on current pnpm, failing the "working override snippet" criterion. Alternatives considered: the pnpm 11 form alone (leaves anyone still on pnpm 10, which is what this repo pins, with nothing) or the ADR's wording verbatim (wrong for the current major). Touches: nothing in code; it does mean the README is more precise than ADR-0073's sentence on this point.
- **The override value is `>=0.20.0` rather than a pin at `0.20.0`.** The requirement is a floor, and pinning would freeze a reader on today's release; a reader who wants the conservative form can pin. Touches: the same string appears in the `TimestamplessLogError` message (`override @nomicfoundation/edr to >=0.20.0`), so the two agree.
- **The stale-cache clause was restated rather than repeated.** ADR-0073, ADR-0002 and the `TimestamplessLogError` docstring say EDR's version-segmented cache means "entries written before the change keep answering without the field"; the 0.20.0 release note says the opposite about those entries (cache moved to `rpc_cache/v2`, everything else ignored). The surviving, accurate hazard is an absence RECORDED from a forked pre-spec remote and replayed until `rpc_cache` is dropped, so the README says that. The conclusion (the refusal is permanent machinery) is unaffected. I did not edit the ADRs, the changesets or the error docstring: they are records and out of this task's fence, so the discrepancy is captured as an observation instead.
- **The two additions live in the ROOT README only.** The task names the README's Caveats as the home; `packages/core/README.md` and `packages/processor-sqlite/README.md` already carry the shorter engine-side statements, and duplicating the override snippets into a published package README would create a second place to keep in step with pnpm's file moves. Touches: a reviewer who expects the completeness-scope sentence in `@etherfold/core`'s README will not find it there.
- **No new doc-scanning test was added.** The repo does pin some prose with tests (the provider-surface anchor, the retired-knob scanners), but those exist where prose asserts something the CODE can contradict. A version floor and an external node limitation have no in-repo referent to diff against, so a test would only assert that a string is present, which pins wording rather than truth and goes stale exactly when the version does. The provider-surface criterion is already covered by the existing test, which I ran.
