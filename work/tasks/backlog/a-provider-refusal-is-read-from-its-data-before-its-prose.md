---
title: 'Read a provider refusal from its structured data before parsing its prose'
slug: a-provider-refusal-is-read-from-its-data-before-its-prose
spec: the-fetcher-reads-the-hints-providers-already-send
blockedBy: []
covers: [1, 2, 9, 10]
---

## What to build

`getNewToBlockFromError` decides how far a refused `eth_getLogs` range should shrink. It reads the error's MESSAGE with a regex and never looks at the error's structured `data`, even where a provider supplies it.

Three changes to how a refusal is read, all additive to the existing halving fallback, which stays for a provider that says nothing useful:

1. **Prefer `error.data` over prose.** At least one public endpoint returns `data` carrying `from`, `to` and `limit` alongside the same information in English. Read the structured form first and fall back to the regex, rather than parsing prose when a machine-readable answer is present.
2. **Accept `-32000` under the same hint gate as `-32602`.** It is a widely used generic server-error code and several providers put range complaints behind it; today nothing matches it, so those hints are discarded.
3. **Keep the `looksLikeRangeHint` gate and pin it with a test.** It EARNS its keep on a real case: an archive refusal arrives as a `-32602` mentioning neither `results` nor `block range`, and without the gate a generic invalid-params could be mis-parsed into a bogus `toBlock`. It looks like a redundant guard and is not.

Tests are built from REAL captured provider responses, not invented ones. `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` carries the captured shapes and their sources.

## Acceptance criteria

- [ ] A refusal carrying structured `from`/`to`/`limit` is read from `data`, not from its message
- [ ] A refusal with prose only still parses exactly as it does today
- [ ] `-32000` with a range hint is honoured; `-32000` without one is not mis-parsed
- [ ] A `-32602` archive refusal (mentioning neither `results` nor `block range`) still yields no range hint, asserted directly
- [ ] Every parse path has a test whose input is a captured real-world response, with its provider named in a comment
- [ ] A provider that says nothing useful still falls back to halving, unchanged

## Blocked by

- None, can start immediately.

## Prompt

> Make the range-refusal parser read what providers actually send. Read `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` FIRST: it carries the captured error shapes, the providers they came from, and the dated sources. Re-run or re-verify the captures if you can, since the note itself says these figures are per-provider and per-plan and providers revise them.
>
> Domain vocabulary: a node REFUSES an oversized `eth_getLogs` rather than truncating it, and the fetcher responds by shrinking its range and retrying. Caps come in two incompatible kinds, a BLOCK SPAN and a RESULT COUNT, which is why no fixed page size works and why the adaptive loop exists. Look in the range-fetching module of `@etherfold/core` for the error-to-range function and the retry that calls it.
>
> The subtle one is change 3, and it is a NEGATIVE result worth protecting: the existing gate exists so that a `-32602` that is not about ranges at all cannot be regex-parsed into a range. An archive-access refusal is exactly that shape. Do not simplify the gate away while touching the function around it; add the test that would fail if someone did.
>
> Every improvement here is ADDITIVE. The halving fallback is what makes the fetcher work against an unknown endpoint, and nothing in this task may make the unknown-endpoint case worse.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the error-handling shape still matches what the finding describes. If the parser has moved or been rewritten, route to needs-attention rather than building on a stale premise.
>
> RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT. Do no git, do not edit the task body, and do not open an observation note for decisions.
