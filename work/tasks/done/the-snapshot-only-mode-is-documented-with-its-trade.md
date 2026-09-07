---
title: 'The snapshot-only mode is documented with its trade stated, not discovered at the reconfigure'
slug: the-snapshot-only-mode-is-documented-with-its-trade
spec: a-browser-app-starts-from-a-published-artifact
blockedBy: [a-generation-runs-with-no-stream-keeper-at-all]
covers: [2]
promptGuidance.testFirst: false
---

## What to build

The user-facing documentation for the mode the previous task asserted: a browser app that starts from a published state snapshot and keeps no stream, written so a developer CHOOSES it knowing what it costs instead of discovering the cost at the first processor-only change.

Three things have to be on the page, and the third is the one that is usually left out.

**What the mode is**, in the vocabulary the project already uses: state from a published snapshot, `keepStream` absent, nothing stored or read under the stream keyspace, and it is the path most browser apps should take rather than a fallback.

**What it trades away.** A snapshot-seeded generation is a LEAF (ADR-0028's retention floor, and no stream beneath it to re-fold), so a later processor-only change cannot re-fold locally and waits for a republished snapshot instead of being free. That is the sentence an author needs BEFORE they ship, because after they ship it is a reconfigure that does not behave the way the generation model promised.

**How long that wait actually is**, with its evidence and its two tiers kept apart. The PUBLISHER's cadence is MEASURED from the git history of the reference snapshot repository (8,198 publishes over 357 days, median gap 1.0 h, p99 1.9 h, worst observed 50.9 h, leaving a client 1,802 to 91,527 blocks to backfill, all of it inside what a public node serves). That the CLIENT ran on the snapshot alone is a separate and weaker claim: it is the maintainer's ACCOUNT of that deployment, not something the measurement shows, and the page must say which is which rather than blending them into one confident claim.

Note where that separation comes from, so you do not go looking for it in the wrong place: the finding measures the publisher's git history and then reasons from it ("on this evidence a state snapshot alone is what makes a browser app start"), and `CONTEXT.md`'s `seeding` entry states it flatly ("it is what the reference deployment actually ran"). NEITHER labels the client-side half as an account. The two-tier separation is this spec's own judgement about how confidently the claim may be stated to a reader, and the guide is where it gets written down. So cite the finding for the NUMBERS, which are measured, and state the client-side claim in your own words as an account.

One thing the page must NOT say: that a stream seed is what makes a browser app start. The operational record says the state snapshot on cadence already did that. A stream seed's justification is narrower, and it is the subject of the later slices, not of this page.

## Acceptance criteria

- [ ] Where the documentation names a snapshot or seed LOCATION, it states that the caller owns that choice and its risk: the library fetches where it is pointed and judges nothing, so an app that accepts a runtime override (a query parameter, as the reference deployment does) is accepting an untrusted state source, and omission is not detectable (ADR-0066, ADR-0065's residue).
- [ ] The mode is documented in the user-facing guide (under `docs/`), reachable from the browser-app guide rather than parked somewhere a reader would have to already know about.
- [ ] The page NAMES the mode and states its configuration in one place a reader can copy.
- [ ] The leaf trade is stated explicitly: what a later processor-only change costs when there is no stream underneath, and what the alternative buys.
- [ ] The measured cadence is quoted with its source cited (`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`), and the client-side claim (that the reference deployment ran on the snapshot alone) is labelled as an account rather than presented as measured. The finding itself does not draw that line, so the page draws it: do not cite the finding as though it already had.
- [ ] The page does not claim a stream seed is what makes a browser app start.
- [ ] The page points at the assertion that backs it (the mode's test), so the claim is evidenced rather than asserted in prose alone.
- [ ] No package under `packages/` changes behaviour: this task ships documentation.
- [ ] The repo acceptance gate is green (`pnpm format:check` covers the markdown).

## Blocked by

- `a-generation-runs-with-no-stream-keeper-at-all`, because the page points at the assertion that makes its central claim evidence rather than intention.

## Prompt

> Document the snapshot-seeded, NO-stream-keeper mode for browser app developers, with its trade stated up front.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): read what the blocking task actually landed and describe THAT, not what this task assumed it would land. If they diverge, describe reality; if reality contradicts this task's premise, route to needs-attention.
>
> Vocabulary and constraints (`CONTEXT.md`, `docs/adr/`): **seeding** is creating a generation from a published artifact instead of backfilling; a state **snapshot** (ADR-0028, `bootstrapFromSnapshot`) seeds the FOLD and reports a **retention** floor at its own block, so a snapshot-seeded **generation** is a LEAF; a **generation** is a stream plus a fold over it, and a processor-only change is free precisely because a successor re-folds the STORED STREAM. `CONTEXT.md`'s `seeding` entry already carries this in the project's register: keep the guide consistent with it and do not restate it differently.
>
> The evidence is `work/notes/findings/what-a-published-stream-seed-costs-to-install.md`. Take the cadence numbers from it and cite it. Then keep two tiers apart that the finding does NOT itself keep apart, which is why it is spelled out here: the publisher's republication cadence is MEASURED from a public git history and may be stated as fact; the claim that the CLIENT ran on the snapshot alone is the maintainer's account of a deployment and must be labelled as one. The finding reasons straight from the first to the second ("on this evidence a state snapshot alone is what makes a browser app start") and `CONTEXT.md` states it flatly; do not cite either as the source of the distinction, and do not contradict them either. The point of the page is to be honest about which half is measured.
>
> Where it goes: the existing browser-app guide under `docs/guide/`, which is where a developer wiring an app already reads (it is a page about the shape a template wires once). Match its voice: short, decision-carrying, with the hazard stated before the recipe. It is a VitePress site, so respect the existing link conventions between guide pages and ADRs.
>
> Done means: an author can find the mode, wire it, and know the exact thing it costs them later, with the numbers sourced and the account labelled. Change no production code.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The runner transcribes it into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note.

## Note on the build pin, superseded

The tasking loop raised one blocking issue against every task in this set: ADR-0065 pinned trust to a
build-named content HASH without saying a hash of what. That is settled, but not the way the first
amendment settled it. **ADR-0066 supersedes ADR-0065 on the trust anchor and the byte domain**, and a
builder should read it before either:

- **Trust is the HOST the build NAMES**, not a content hash. A build cannot pin the hash of a ROLLING
  artifact, and rolling is how this is deployed: the reference deployment held one web build against a
  snapshot republished every hour. `bootstrapFromSnapshot`, the path that already ships and works,
  verifies no hash at all.
- **A content hash is OPTIONAL**, for a release-tied immutable artifact, where it is the strongest
  thing available. When present it is SHA-256 over the DECOMPRESSED octets, taken after transfer
  decoding and before `JSON.parse`.
- **There is NO hosting constraint.** The earlier rule forbidding `Content-Encoding: gzip` is
  withdrawn: hashing the decompressed octets is transport-invariant, so it does not matter whether a
  host serves the file opaque or compresses it in transit.
- **Same-origin is not a condition anywhere**, and the refusal it once justified is gone. The app may
  be served from any IPFS gateway while the artifact lives on a known host, so the two origins never
  match by construction.

## Decisions

**The mode is a section INSIDE the browser-app guide, not a new guide page.** The prompt names "the existing browser-app guide under `docs/guide/`" as the destination, and the acceptance criterion asks for "reachable from the browser-app guide", which being in it satisfies maximally. Alternative considered: a new `docs/guide/starting-from-a-published-snapshot/` page linked from the browser-app page and registered in the sidebar. Rejected because it would fork the "wiring an app" reading surface into two pages and require touching `docs/.vitepress/config.mts`'s nav and sidebar (what it touches: nothing, as built). If the page later grows a stream-seed counterpart (slice C), splitting both out into their own page is the natural moment, and this section moves whole.

**No new vocabulary: the page uses "snapshot-only mode", the term `CONTEXT.md`'s `seeding` entry and the landed test already use.** Coherence check done against the glossary, ADR-0028/0063/0066 and the test: `snapshot-only`, `seeding`, `snapshot`, `leaf`, `retention`, `generation` and `stream seed` all keep their existing meanings, and I introduced no flag, key or status. What it touches: nothing new; it is deliberately a reuse.

**The page states that adding `keepStream` on top of a snapshot seed does NOT buy back the free re-fold, and links the `readOnlyStream` self-clear observation.** The criterion asks for "what the alternative buys", and the obvious reader's move ("then also keep a stream") is both ineffective (a stream kept by a snapshot-seeded tab starts at the snapshot's block, so a successor still has nothing to fold below it, and a snapshot is processor-version-keyed anyway) and the exact shape of a known latent defect (`work/notes/observations/a-follower-can-self-clear-the-writers-stream-through-the-read-only-view.md`, and the spec's Further Notes say so). So I named the real alternative as *a stream that reaches back to the source's start block*: self-indexed from that block, or installed from the unbuilt stream seed. Alternative considered: stating only the positive ("a stream underneath makes the change free") and staying silent on the neighbouring combination, which would have left the guide quietly recommending a defect path. What it touches: the future stream-seed slice C documentation (which will describe the mode this section defers to), and `readOnlyStream` / ADR-0044, whose defect the guide now references from a user-facing page. If that defect is fixed or the observation is renamed, this link needs updating.

**The recipe shows `finalityDepth` being passed and states the producer-side rule, rather than mirroring the landed test's fixture.** `work/notes/observations/the-snapshot-only-mode-test-never-exercises-the-inside-reorg-window-guard.md` records that the test publishes at its producer's observed tip and omits `finalityDepth`, so the consumer-side guard never runs there; it explicitly suggests the documentation state the producer rule instead of reproducing the fixture. I followed that. What it touches: the mode's test (a future task may align the fixture with what the guide now documents), and any publisher script, which now has a written rule to meet.
