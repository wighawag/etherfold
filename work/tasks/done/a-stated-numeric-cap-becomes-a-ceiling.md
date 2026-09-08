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
> FORWARD-POINTER on the FINDING you are told to read. It has PARTLY GONE STALE and a fresher, wider capture now sits beside it: `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/refusal-shapes.md` (a full re-run dated 2026-09-08, with `capture-refusals.sh` next to it). Read BOTH, and prefer the spike where they disagree. Specifically, `work/notes/observations/the-getlogs-refusal-finding-has-partly-gone-stale.md` records that `rpc.mevblocker.io` no longer answers with the structured `{from, to, limit}` shape (it enforces a 10,000-BLOCK span cap now and answers `-32602`) and that `eth.merkle.io` no longer serves `eth_getLogs` at all, so two rows of the finding's cap table no longer reproduce. The archive-refusal capture, by contrast, is byte-identical three months on. Do NOT amend the finding as part of your task: that is its own item and is already recorded.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the blocking task landed and that the ceiling field still exists with the meaning described here.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.

## Decisions

- **No error CODE gates the cap reader.** It reads any error's text, unlike `getNewToBlockFromError`, which accepts only `-32005/-32602/-32000`. Chosen because the 2026-09-08 sweep found stated caps under `-32000`, `-32602`, `-32614`, `-32600` and `-32047`, and the identifying evidence is the text, exactly as `archiveRefusalFromError` (which also takes no code) argues. Alternative considered: gate on the same three codes as the range parser, which would drop Base, Alchemy's public endpoint and Cloudflare for no safety gain, since a wrong read here can only lower a ceiling. Touches: a cap is now read under codes no other path in this file accepts; it does NOT widen the codes `getNewToBlockFromError` accepts.

- **A stated cap becomes the ceiling DIRECTLY, so the fetcher asks for cap − 1 blocks.** `foundNumBlockToHigh` means "this many blocks was too high", and a stated cap means "this many is allowed", so the faithful encoding would be `cap + 1`. I chose the conservative one: no message says whether "up to a 2K block range" is inclusive, and one block of throughput buys never having to know. Alternative (`cap + 1`, asking exactly the stated cap) rejected as a guess that can over-ask. Touches nothing outside this file; documented at the choice site.

- **Plausibility bounds `1..10_000_000`, whole numbers only.** The widest cap in the whole captured corpus is 10,000 and the fetcher's own default `maxBlocksPerFetch` is 100,000, so a seven-figure "cap" is a block number, a byte count or a result total a pattern sat next to. This is the acceptance criterion's "clearly not a block count" made concrete; the upper bound is a judgement call and the number is a named constant. Note the bound is load-bearing beyond hygiene: setting the ceiling at all switches the post-success sizing from log-density to ceiling bisection, so a bogus huge ceiling is not a no-op.

- **Deliberate MISSES where a provider does not name the unit.** `range 16777216 exceeds limit of 10000` (Linea, mevblocker) and `GetLogs query must be smaller than size 1024` (Harmony) are real block-span caps that this reader does not extract, because nothing in the sentence says the unit and the neighbouring shape (`logs matched by query exceeds limit of 10000`, Arbitrum) is a RESULT cap. A miss costs the halving path we would have taken anyway; a false positive pins the fetcher to a small range for the process lifetime, slowly and invisibly. Recorded because a later task may reasonably want to widen these.

- **The `-32603` ceiling path was re-routed through the new single writer** (behaviour-preserving: same `Math.min`, same fallback to `maxBlocksPerFetch`). This is what makes "structurally impossible to raise" true rather than merely intended, per the task's headline property. It is a small refactor of code this task did not otherwise have to touch.

- **The range asked for is now floored at ONE block at both ceiling-clamp sites.** A ceiling of 1 previously computed a zero-width, backwards range (`toBlock = fromBlock - 1`). It was already reachable via the `-32603` path when a two-block span was refused; my change makes it reachable from a parsed cap of 1 (QuickNode's discover plan really does state `limited to a 5 range`, so tiny caps are real). Two `Math.max(1, ...)` wrappers, behaviour-identical for every ceiling ≥ 2, asserted by a test. I fixed it rather than filing an observation because my feature widens the door to it; flagging it here since it is a change to pre-existing sizing arithmetic.
