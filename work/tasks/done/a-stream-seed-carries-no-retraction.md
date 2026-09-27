---
title: 'A stream seed carries no retraction, from any producer'
slug: a-stream-seed-carries-no-retraction
blockedBy: []
covers: []
---

## What to build

Resolve the contradiction recorded in `work/notes/observations/a-stored-stream-seed-with-a-reorg-is-refused-as-incoherent.md` by removing the retraction allowance: a stream seed carries NO retraction, whatever producer it declares.

ADR-0065 ("Retractions: COHERENCE, not absence") admits retractions in a seed declaring the producer kind `stored-stream`, so that a server's append-only stream could be seeded verbatim. But the same coherence pass (`incoherenceOf`, `packages/core/src/stream/seedInstall.ts`) refuses a block number carrying two block hashes, and the ordinary reorg in a stored stream is exactly that (the losing branch's application, its retraction, the winning branch's replacement at the same height). So the allowance is unreachable for the one case it was written for. And since `publish-writes-the-stream-seed-when-asked` (ADR-0095, "The stream seed is opt-in, at both ends"), the only producer of a `stored-stream` seed COMPACTS matched apply/retract pairs, so that a seed is a function of the chain and two producers publish the same bytes under the same pinnable content hash (ADR-0065). No producer emits a retraction, and a verbatim stored stream would break that pin property anyway.

So:

- `incoherenceOf` refuses any `removed: true` event, for every producer kind, as `incoherent` (the logged rule names it: a seed is the compacted final chain and carries no retraction). The ordering and duplicate rules are then stated over every event, and the `standing` bookkeeping that existed only for retractions goes. The two-hashes-at-one-height rule is unchanged.
- The producer kind (`capture` / `stored-stream`) stays in the envelope as provenance; it no longer changes what the check admits.
- Amend ADR-0065's section "Retractions: COHERENCE, not absence" IN PLACE to say the decision changed and why (this contradiction, and the compaction ADR-0095 records), and keep the `producer` declaration bullet truthful. Update the comments in `seed.ts` and `seedInstall.ts` that restate the old rule.
- Retire the observation `a-stored-stream-seed-with-a-reorg-is-refused-as-incoherent` (delete it; re-point any non-exempt citation), since this resolves it.

## Acceptance criteria

- [ ] A seed carrying a retraction is refused as `incoherent` whether it declares `capture` or `stored-stream`, including a matched apply/retract pair that the old rule admitted.
- [ ] A compacted seed of a stored stream that saw a reorg below the cut (what `publish --seed` writes) still installs, asserted through the existing publish seed suites.
- [ ] Every existing seed-admission test that asserted a `stored-stream` retraction was admitted is rewritten to assert the refusal; no test still asserts the allowance.
- [ ] ADR-0065 states the new rule and why; the observation is retired; `pnpm check:adr` and `pnpm check:refs` pass.
- [ ] A changeset for `@etherfold/core` (minor: a seed that installed before is now refused).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: make the seed coherence rule one rule, with no retraction allowance (see What to build). Look at `incoherenceOf` in `packages/core/src/stream/seedInstall.ts`, `StreamSeedProducerKind` in `packages/core/src/stream/seed.ts`, `packages/core/test/streamSeedAdmission.test.ts`, the compaction in `packages/server/src/publication.ts`, and ADR-0065 and ADR-0095.
>
> FIRST, check this task against current reality: if a producer that emits retractions into a seed exists after all, do not remove the allowance; route to needs-attention naming it.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **I also fixed two stale comments outside `seed.ts` and `seedInstall.ts`.**
  - **What I chose:** I reworded two phrases in the `CONTEXT.md` **seeding** entry that described the producer declaration as "what the retraction rule is stated against" and listed "retraction coherence against the declared producer". I also reworded one field comment in `packages/conformance-workload-stratagems/src/stream-seed.ts`.
  - **Why:** all three restated the rule this task removes.
  - **Alternative considered:** leave them for a separate sweep. That would have left the glossary contradicting ADR-0065.
  - **What it touches:** comments and glossary text only. The conformance package is private, so it needs no changeset.
- **I dropped the special message for an unmatched retraction.**
  - **What I chose:** there is now one log message for every retraction, and it names the declared producer kind.
  - **Why:** "no standing application before it" no longer means anything once all retractions are refused.
  - **Alternative considered:** keep separate messages. There is nothing left to tell them apart.
  - **What it touches:** the wording of the log line only. The outcome is still `incoherent`.
- **No new ADR.**
  - **What I chose:** I amended ADR-0065 in place, as the task asked.
  - **Why:** ADR-0095 already records the compaction this change rests on.
