---
title: 'Measure what a published stream costs to install, and pick its wire shape on that evidence'
slug: measure-what-a-published-stream-costs-to-install-and-pick-its-shape
spec: a-generation-can-be-seeded-from-a-published-artifact
blockedBy: [pin-the-seam-a-published-stream-arrives-through]
covers: [2]
promptGuidance.testFirst: false
---

## What to build

A MEASUREMENT, and a wire-shape recommendation that rests on it. The question is whether a published stream seed can literally be a `StreamFixture` (one document, fetched, parsed and installed in one go) or whether it has to be chunked and resumable, and the answer must come from numbers rather than from the intuition that 30-odd MB "feels like a lot".

The narrowest real case is already committed: the `stratagems-alpha1` capture, 31,332 real logs, **33.8 MB of JSON and 1.05 MB gzipped**. (The 20.5 MB / 0.6 MB this task was written with described the capture BEFORE 2026-09-06, when it omitted each log's `data` and `topics`. That form cannot be installed at all: an event with no raw log cannot be re-decoded, so the load path clears the stream. It was re-captured with `--full` under `pin-the-seam-a-published-stream-arrives-through`; see ADR-0063 and the fixtures README.) Measure, in a real browser, what the install pinned by `pin-the-seam-a-published-stream-arrives-through` costs on it: wall-clock from fetch to a keeper a generation can fold, peak memory, whether the main thread is blocked and for how long, and where the cost actually sits (transfer, `JSON.parse`, the bigint-tagged revive, reducing decoded events to stored ones, the keeper writes). Do the same for at least one chunked variant, so "chunked is better" is a comparison and not an assertion.

**Name the proxy honestly, because the spec insists on it.** The repo's spike harness is desktop Playwright (`playwright-browser-harness`, precedent in `docs/spikes/generation-storage-headroom-in-the-browser/`), so what is genuinely measurable here is install time and peak memory under a THROTTLED desktop profile, not a real mid-range phone. Either accept that proxy and label every number as one, saying what it is likely to under-report, or name the real device the numbers came off. Do not present a throttled laptop as a phone.

The output is a recommendation stated as a CONDITION ("a single gzipped document until X, chunked beyond it") plus what would overturn it. It must also leave the envelope OPEN in one specific way: two later tasks in this spec decide whether the artifact carries its own digest and what a client verifies before installing, so do not freeze a field list or a chunk boundary that cannot carry an identity or a verification claim.

## Acceptance criteria

- [ ] Install cost for the committed `stratagems-alpha1` capture is measured in real browsers (at least Chromium; Firefox and WebKit where the harness reaches them), reporting wall-clock to a foldable keeper, peak memory, main-thread block time, and the breakdown across transfer, parse, event reduction and keeper writes.
- [ ] At least one CHUNKED variant is measured on the same fixture and the same harness, so the single-document and chunked shapes are compared on like-for-like numbers.
- [ ] Both the raw (33.8 MB) and gzipped (1.05 MB) forms are accounted for, and the report distinguishes transfer bytes from parsed-in-memory cost rather than quoting one as the other.
- [ ] The device/throttling profile is stated explicitly, and every number is labelled as a desktop-proxy measurement or as coming from a named real device. What the proxy is likely to under-report is stated.
- [ ] A finding at `work/notes/findings/<slug>.md` carries the conclusion with a `source:` naming the script, the commit, the browsers and versions, the throttling profile and the date; the harness and raw output live at `docs/spikes/<slug>/` with a README saying how to re-run it.
- [ ] The recommendation is a CONDITION, not a preference, and names what would overturn it.
- [ ] The report says where a published STREAM stops being viable at all, so the source spec's rule (publish a stream where you can, a snapshot only where the stream is too large) becomes actionable: either name the size or cost at which the crossover bites, or state plainly that these numbers do not settle it and hand the open boundary to `emit-the-sliced-build-plan-for-seeding`.
- [ ] The recommendation explicitly leaves room for an identity field and a verification claim, so the two decision tasks that follow cannot be boxed out by a frozen envelope.
- [ ] No package under `packages/` changes behaviour; the harness is spike code and is not wired into any shipped path.
- [ ] The repo acceptance gate is green. `CONTEXT.md` is NOT edited by this task.

## Blocked by

- `pin-the-seam-a-published-stream-arrives-through`. The install being measured is the one that task pinned; measuring an install nobody chose measures nothing.

## Prompt

> Measure what it costs a browser to install a published stream seed, and recommend the artifact's wire shape on that evidence. Source spec: `work/specs/tasked/a-generation-can-be-seeded-from-a-published-artifact.md`, an EXPLORATION spec whose done is confidence plus a de-risked plan. Your deliverables are a finding, a re-runnable harness, and a conditional recommendation. Not a feature.
>
> FIRST, check this task against current reality (it is a launch snapshot). Read the ADR emitted by `pin-the-seam-a-published-stream-arrives-through` in `docs/adr/` and its spike, if any: the install path you measure is the one it pinned. If that ADR landed differently from what this task assumes, measure what it actually says and note the difference; if it is missing or contradicts the task premise, route to needs-attention rather than measuring a path nobody chose.
>
> If the seam task left no runnable install to measure (its spike is optional), building a throwaway install for the pinned seam is IN SCOPE here: measure the path that ADR describes, do not stop because no code exists yet. What you must not do is measure a path nobody pinned.
>
> The case is the committed stratagems capture in the private conformance workload package (`stratagems-alpha1`, 31,332 logs, 33.8 MB of JSON, 1.05 MB gzipped, gzip chosen by the `.gz` extension). Nothing here may query a node: the whole point of a seed is that the node will not serve those logs.
>
> The comparison is one document versus chunked-and-resumable. For the single document, measure fetch, `JSON.parse` with the tagged-bigint revive (`parseStreamFixture` in `@etherfold/core`; note that format 2 tags bigints, so the revive is not free), the reduction from decoded fixture events to the raw stored events the keeper seam takes (ADR-0060), and the keeper writes themselves. For the chunked variant, measure the same, plus what resumability costs and whether a partially installed seed is coherent or has to be discarded. Peak memory matters as much as wall-clock: a 33.8 MB document parsed into JS objects is several times its own size in the heap, and that is the number that decides whether a low-memory device survives it.
>
> Use the repo's existing harness pattern rather than building plumbing: `docs/spikes/generation-storage-headroom-in-the-browser/` runs `playwright-browser-harness` across Chromium, Firefox and WebKit and forces conditions over CDP where only Chromium supports it. Be explicit that desktop Playwright with throttling is a PROXY for a phone, say what it under-reports (real mobile memory pressure and eviction, slower storage, background tab suspension), and either accept it as a labelled proxy or name a real device you ran on. Do not silently present one as the other.
>
> The install path is already pinned AND already written as prototype code: `docs/spikes/pin-the-seam-a-published-stream-arrives-through/install.mjs`, kept separate for exactly this reason. Measure THAT, rather than re-deriving an install of your own, and read ADR-0063 for the three block rules it turns on.
>
> Two things you must NOT do. Do not freeze the envelope's field list: later tasks in this spec decide whether the seed carries its own digest and what a client verifies before installing, and a shape that cannot carry those is a shape that will be re-opened. Do not let the harness become the implementation: the source spec puts building the seeding capability out of scope, and a spike that quietly ships is the named failure mode.
>
> Knowledge goes to `work/notes/findings/<slug>.md` with a `source:` naming script, commit, browsers and versions, throttle profile and date; the contract REQUIRES the finding because this measurement is load-bearing (a capability is shaped by it). Evidence goes to `docs/spikes/<slug>/`. State the recommendation as a condition and name what would overturn it. Do not edit `CONTEXT.md` (a later task in this spec owns that edit). Do no git operations.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The runner transcribes it into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note.
