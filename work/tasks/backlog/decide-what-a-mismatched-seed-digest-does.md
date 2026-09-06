---
title: 'Decide what happens when a seed and the client disagree about which stream it is'
slug: decide-what-a-mismatched-seed-digest-does
spec: a-generation-can-be-seeded-from-a-published-artifact
blockedBy: [measure-what-a-published-stream-costs-to-install-and-pick-its-shape]
covers: [4]
promptGuidance.testFirst: false
---

## What to build

A DECISION: what a client does when the stream the publisher captured is not the stream the client is asking for.

A seed installs under a stream digest, and a stream digest is computed from the FETCH FILTER (the deduplicated `streamHash` values, sorted by themselves) plus the stream config hash. The publisher computes one from its source and config; the client computes one from its own. If they differ (the app shipped a new contract address, a config knob moved, the publisher captured under a wider filter), the seed installs under a key nothing will ever read. That is silent waste in the best case, and in the worse case a temptation to force it under the client's key, which is one generation adopting another's stream under a filter that does not match it: logs missing, nothing reported. This task decides the rule before anyone can be tempted.

What to settle, concretely:

- Does the artifact CARRY its own stream digest (and the inputs the client would need to recompute it), or is it identified purely by where it was published and checked by the client recomputing from its own source?
- What happens on a mismatch: refuse outright, or is any partial match adoptable (same fetch filter, different config; the publisher's filter a strict superset of the client's, which the invalidation model already treats as reusable-by-decoding-less)? If a superset is adoptable, say what makes that safe and what it costs.
- What SHAPE the outcome has: a refusal reason as data, mirroring the snapshot path's `NotBootstrappedReason`, or a throw. The snapshot side has a settled stance worth matching or consciously departing from (ADR-0040: an artifact a client cannot read is refused, not installed).
- What the client does next. On a public node the backfill this would fall back to is frequently impossible, so "refuse and fall back to backfilling" may be "refuse and never start". Say plainly which failure the user gets, rather than leaving it implied.
- The neighbouring mismatches, which are the same question in different clothes: a fixture FORMAT version the client does not read (`STREAM_FIXTURE_FORMAT`), and a chain mismatch (the fixture reader already throws on `chainId` today). Decide whether they share one rule or are deliberately different.

The deliverable is the rule, recorded where the next author will find it: an ADR if it meets the ADR gate, which a refusal rule that is hard to reverse and surprising without context very likely does.

## Acceptance criteria

- [ ] The decision states whether a published seed carries its own stream digest, and if so what else it must carry for a client to check that digest rather than trust it.
- [ ] The mismatch rule is stated as a rule, covering exact match, no match, and the superset/partial cases explicitly (each either admitted with its reason or refused with its reason), with no case left implied.
- [ ] The outcome shape is decided (refusal-as-data versus throw) and reconciled with the snapshot path's existing stance, naming ADR-0040 either as the precedent followed or as the precedent departed from and why.
- [ ] What the client does AFTER a refusal is stated, including the honest consequence when a backfill is impossible on the target node.
- [ ] Format-version mismatch and chain mismatch are covered by the decision, either under the same rule or with the difference stated.
- [ ] The decision names which of its choices depend on the wire shape chosen by `measure-what-a-published-stream-costs-to-install-and-pick-its-shape` (for example, whether a digest covers a whole artifact or each chunk).
- [ ] Recorded as an ADR in `docs/adr/` if it meets the ADR gate. If an ADR is written, its number is the next free one at the time of writing and is re-checked after any rebase, since `check:adr` fails the gate on a duplicate. If it does NOT meet the gate, the rule is stated in full in the `## Decisions` block of the final report, with the reason it did not, so the runner transcribes it into the done record that `emit-the-sliced-build-plan-for-seeding` reads. The build plan does not exist yet, so it is not a destination; and a decision we made is not a `work/notes/findings/` entry, which is verified EXTERNAL ground truth.
- [ ] No package under `packages/` changes behaviour; this task ships a decision, not an implementation. `CONTEXT.md` is NOT edited by this task.
- [ ] The repo acceptance gate is green.

## Blocked by

- `measure-what-a-published-stream-costs-to-install-and-pick-its-shape`. Whether a digest covers one document or each chunk of a resumable one depends on the shape that task recommends, and both tasks may write an ADR into the same numbered directory.

## Prompt

> Decide what a client does when a published stream seed and the client disagree about which stream it is. Source spec: `work/specs/tasked/a-generation-can-be-seeded-from-a-published-artifact.md`, an EXPLORATION spec whose done is confidence plus a de-risked build plan. Your deliverable is a RULE, recorded durably. Not an implementation.
>
> FIRST, check this task against current reality (it is a launch snapshot). Read the ADR from `pin-the-seam-a-published-stream-arrives-through` (which pinned how a seed arrives and what installing writes) and the finding from `measure-what-a-published-stream-costs-to-install-and-pick-its-shape` (which recommended the artifact's shape). Your rule attaches to those. If either landed differently from what this task assumes, decide against what actually landed; if one contradicts this task's premise outright, route to needs-attention with the discrepancy.
>
> The vocabulary, from `CONTEXT.md`: a **stream** is identified by its **stream digest**, a wide synchronous digest over the deduplicated `streamHash` values SORTED BY THEMSELVES plus the stream config hash. That is the fetch half of the source only, per ADR-0034, so a decode-only change does not fork a stream. A stream is addressed as `['stream', <indexer-name>, <streamDigest>, <ordinal>]`. Note the distinction the contract already draws and your rule must not blur: the invalidation VERDICT decides whether anything is invalid, while the stream digest decides WHICH stream a result belongs to. Read `packages/core` for `streamDigestOf` and the source-hash entries it digests, and the done task `a-stream-is-identified-by-the-digest-of-its-filter` for why it is computed the way it is.
>
> The precedent to weigh rather than ignore is the state-snapshot side: `bootstrapFromSnapshot` in `@etherfold/processor-entities` returns its refusals as DATA (`NotBootstrappedReason`: no locations, unreachable, processor mismatch, inside the reorg window) rather than throwing, and ADR-0040 settles that a published snapshot a reader cannot read is REFUSED, not installed. Decide whether a stream seed follows that stance or departs from it, and say why.
>
> Cover the awkward cases rather than the easy one. Exact match is trivial. What matters is: a publisher whose filter is a strict SUPERSET of the client's (which the invalidation model treats as reusable by decoding less: is a seed the same, and what does the client then store under its own digest?); a config-only difference; a format version the client does not read; a chain mismatch, which the fixture reader already throws on. And state what the user actually gets after a refusal: on a public node the backfill fallback is frequently impossible, which is the reason this whole spec exists, so "fall back to backfilling" may mean "never start" and should be written down as such.
>
> Do not re-open the digest's own definition (it is decided and built), do not decide the verification rule (that is the next task in this spec), and do not build the check, because the source spec puts building the seeding capability out of scope. If your rule meets the ADR gate (hard to reverse, surprising without context, a real trade-off; see `work/protocol/ADR-FORMAT.md`), write it as an ADR in `docs/adr/`, taking the next free number and re-checking it after any rebase, because `check:adr` is in the acceptance gate and a duplicate number fails it. Otherwise state the rule IN FULL, with the reason it missed the gate, in the `## Decisions` block of your final report: the runner transcribes that into your done record, which is where the build-plan task is told to look. Do not park it in `work/notes/findings/` (that bucket is verified external ground truth, not a decision we made) and do not write into a build plan that does not exist yet. Do not edit `CONTEXT.md` (a later task in this spec owns that edit). Do no git operations.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The runner transcribes it into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note.
