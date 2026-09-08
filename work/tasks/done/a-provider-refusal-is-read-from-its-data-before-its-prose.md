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
- [ ] A CHANGESET accompanies the change. The repo's acceptance gate runs `changeset status --since=main`, so a touched package with no changeset is a RED GATE rather than a style nit. Describe the change in prose, as the repo's existing changesets do, not in one line

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

## Decisions

**1. `error.data` is read when it is PROSE, not only when it is a `{from, to, limit}` object.** The task's change 1 says "prefer `error.data` over prose"; I read `data` as prose too. Why: the object shape's named source (mevblocker) no longer reproduces, while four live endpoints (Gnosis, Chiado, Fraxtal, plus Ronin) return `{"code":-32602,"message":"invalid params","data":"Query returned more than 50000 results. Try with this block range [...]"}` — a complete machine-readable answer discarded today because the *message* fails the gate. This was the single highest-value real-world win the re-verification found. Alternative considered: object-only, which would have left those four unread and made change 1 nearly unobservable today. What it touches: nothing outside this function, but it is a fourth behaviour beyond the task's three. The gate is applied **per text source** (data and message each gated on their own content), specifically so a hint in `data` cannot license lifting a bracketed pair out of an unrelated message — the composite gate was the tempting simplification and it re-opens exactly the hole change 3 protects.

**2. The structured path requires `limit`, and takes no prose gate.** `data.to` alone is not enough: some providers put the request body in `data`, and reading `to` out of an echo would hand the retry the range that was just refused. `limit` is the node's own cap, so its presence is what makes the object a refusal descriptor. Given that, no `looksLikeRangeHint` check is applied to the structured path, because that gate exists to disambiguate prose. Alternative considered: gating the structured read on the message too, which would have made a machine-readable answer depend on the prose beside it — the thing the task is removing.

**3. `-32000` is widened, but no test can show it producing a value from a captured body, and one test is therefore synthetic.** Across every endpoint probed, not one `-32000` carried a bracketed pair or a structured descriptor: every real `-32000` range refusal states its cap in prose only ("max range: 10000", "maximum is set to 2048"). Extracting a stated number is user story 3 and a different task, so under this task's two mechanisms the widened code changes no answer *today* — it stops the hint being discarded on its code, and it is what story 3 will build on. Consequence: acceptance criterion "`-32000` with a range hint is honoured" and criterion "every parse path has a test whose input is a captured real-world response" are in tension given the evidence. I resolved it by asserting every real `-32000` shape verbatim (four gate-passing, five gate-failing including Cronos's `"maximum [from, to] blocks distance: 2000"`, which is a real bracketed pair that must not be parsed) plus **one clearly-labelled synthetic test** — the Infura body re-coded to `-32000` — whose only job is to fail if someone drops `-32000` from the accepted codes again. Without it, change 2 would have zero coverage. It is labelled synthetic in the test, with the reason, pointing at the spike. Alternative considered: no test at all for change 2 (leaves it silently revertible), or inventing a plausible provider message (worse: it would read as captured). A reviewer may prefer to drop that one test; the rest stand on captures.

**4. The gate's mutation test stays constructed.** Criterion 4's archive assertion (`publicnode`'s `-32602`, verbatim) is present and asserted directly, but it would *not* fail if the gate were deleted, because that message contains no brackets. The test that actually bites is the repo's pre-existing `'invalid argument 0: expected one of [0x1, 0x2]'`, which I kept and re-commented. No provider in the sweep put a bracketed hex pair in an unrelated invalid-params message, so the input that proves the gate bites has to be written; the real refusals the gate rejects are asserted verbatim beside it.

**5. Codes carrying suggestions that this task does not accept are asserted as `undefined` rather than widened.** Alchemy's public endpoint and blastapi return a bracketed suggestion under `-32600`, and Base/Optimism/Blast use `-32614`, Cloudflare `-32047`, Taiko `-32012` with a nested `data.details.maxAllowedRange`. Widening to those is not in this task's scope and would be a new user-visible behaviour; they are recorded in the spike for the cap-extraction task and pinned as currently-unread, so the omission is deliberate rather than an oversight.
