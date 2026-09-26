---
title: 'A successor on a NEW stream is fetched by a second writer, so an upload that adds an event catches up and is promoted'
slug: a-successor-on-a-new-stream-is-fetched-by-its-own-writer
blockedBy: []
covers: []
---

> **DRIFT CORRECTION, 2026-09-26 (conductor, Gate 3 on PR #204).** The first build is good and is KEPT; this re-drive continues from its branch. Everything else in it passed Gate 3. It was blocked for ONE reason: the new rule "a promotion onto ANOTHER stream stops folding the incumbent, however it arrived" was put in `ReceivingIndexer` for EVERY host, so it also changed hosts that do not fetch: the split `index` and the server package's receiving hosts, fed by an external fetcher's pushes. There the incumbent's stream now stops accepting pushes after such a promotion (`packages/server/test/theOperatorReclaimsWhatNoSlotNames.test.ts` had to change from all three `held` to `frozen`/`no-instantiator` for the first). This task said the split deployment is unchanged, and ADR-0087's amendment says it is "untouched"; both must be true. Fix exactly this:
>
> 1. Stop folding a cross-stream incumbent at promotion ONLY on a host that fetches its own streams (the CLI's `run`, and `build` if it applies), via an explicit option the host passes to the container. A push-fed receiver (`index`, the server's hosts) keeps today's retention: the incumbent goes on folding and its stream goes on accepting pushes.
> 2. Restore `theOperatorReclaimsWhatNoSlotNames.test.ts` to its original assertions (all three `held`). Add one assertion that a push-fed receiver keeps folding a cross-stream incumbent after a promotion and its stream still accepts a push.
> 3. Make ADR-0087's and ADR-0093's amendments, the CLI README and CONTEXT.md say exactly where the rule applies.

## What to build

The maintainer decided on 2026-09-26 that an upload carrying DIFFERENT contracts (a new event a new handler needs, an upgraded contract with new events) is a legitimate change and registers a `successor` on its new stream rather than being refused (ADR-0085's relocated decisions, ADR-0093). It registers. It then never advances: a `run` builds ONE fetcher over ONE source (the configured one, or with nothing configured `ReceivingIndexer.fetchedSource`, the first fold's source, set once), so nothing appends to the successor's stream, it cannot catch up and is never promoted. A restart does not help, because the fetched source is again the canonical generation's. This is the observation `an-upload-on-a-new-stream-is-never-fetched-by-a-running-node`, and it means The Graph-style "add an event" deploy does not complete.

**Decided by the maintainer on 2026-09-26: a SECOND WRITER.** While a successor sits on a stream other than the canonical generation's, `run` fetches THAT stream too, with its own fetcher over the successor's source, appending through the container's `StreamWriter` for that stream (the container already holds one writer per stream: ADR-0087). The incumbent keeps being fetched and keeps answering throughout, which is the whole reason for choosing this over moving the one fetcher. ADR-0087's rule is unchanged and must stay true: each stored stream has exactly ONE writer, whoever fetches it; this adds a second STREAM with its own writer, never a second writer of one stream.

Then:

- **At promotion** the fetch follows the pointer: the promoted generation's stream goes on being fetched, and the old stream's fetcher stops once no fold this process holds reads that stream (the incumbent's fold already stops being folded when the pointer leaves it). What the deployment "fetches" (`fetchedSource`, and whatever a restart reads to decide what to fetch) becomes the new canonical generation's source, so a restart with nothing configured fetches the stream the canonical generation is on.
- **A replaced successor** (a newer arrival takes the slot) stops its stream's fetcher once nothing reads it.
- **At a restart mid-catch-up**, the successor instantiated at open (`an-uploaded-processor-survives-a-restart`) gets its stream's fetcher too, so it goes on catching up and is promoted.
- A successor on a new stream is no longer reported `stream-not-fetched` on `run`; it is `held`. The admin listing and `/status` say what is true.
- **Out of scope, unchanged:** a revert ACROSS a filter change still moves the pointer and freezes (ADR-0057's 2026-09-25 amendment): this task is about a successor catching up, not about re-fetching a predecessor. The split deployment (`fetch` + `index`) is unchanged: its fetcher is another process. A node started with an EXPLICIT source still refuses an upload whose source differs (decision 2), so there this only concerns configured starts and re-reads, if any path can produce a new-stream successor there at all; measure it.
- Generation caps (two streams per named indexer) still bound this; hitting the cap refuses the arrival as today.

## Acceptance criteria

- [ ] End to end on the CLI, driven by `etherfold upload` over the committed fixtures: a node folding `nfts.bundle.js` receives `nfts-with-approval.bundle.js` (different contracts); the successor's stream is fetched while the incumbent keeps answering and advancing; under `on-catch-up` the successor catches up and is promoted; reads then answer from it, including the new event's effect.
- [ ] The same with a node started with NOTHING configured (ADR-0093).
- [ ] After that promotion, a restart with nothing configured fetches the NEW stream (the canonical generation's) and the cursor advances.
- [ ] Upload a new-stream successor, restart mid-catch-up: it goes on being fetched and is promoted.
- [ ] The old stream's fetcher stops after promotion (no more chain calls for it), and a replaced new-stream successor's fetcher stops, both asserted over a fake chain that counts requests per filter.
- [ ] Each stored stream still has exactly one writer (ADR-0087), asserted.
- [ ] A new-stream successor on `run` is reported `held`, not `stream-not-fetched`.
- [ ] ADR-0087 and ADR-0093 carry dated amendments; CONTEXT.md's entries on the one fetcher / follower and one-writer rule and the CLI README say what is now true. Grep `docs/adr/` and `CONTEXT.md` for "one fetcher", "set once", "never moves" and similar claims this makes false.
- [ ] The observation `an-upload-on-a-new-stream-is-never-fetched-by-a-running-node` is DELETED.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None -- can start immediately.

## Prompt

The goal is that the deploy the maintainer's decision was made for, adding an event, completes: upload, catch up beside the live version, switch.

Read ADR-0087 (one writer per stream, the deployment appends), ADR-0093 and its "Where it lives" paragraph (`fetchedSource`, the late fetcher in `prepareWaiting`), ADR-0085's relocated decisions, ADR-0092 and its 2026-09-26 amendment (the successor at open), and ADR-0084 (slots and what replacing a successor does).

The seams: `ReceivingIndexer` in `@etherfold/core` (its per-stream `writerFor`, `fetchedSource`, the frozen reason `stream-not-fetched`), and in the CLI `prepareIndexing` / `prepareWaiting` and the fetcher host they build (`createFetcherHost`). The CLI suites `aBundleIsUploadedToARunningNode`, `aRunNodeWithNothingConfiguredWaits` and `anUploadedProcessorSurvivesARestart` are the test shapes.

The decisions most likely to be got wrong: moving the ONE fetcher to the successor's stream (the incumbent then stops advancing while the successor catches up, which is exactly what was rejected); giving one stream two writers; and leaving the old stream's fetcher running after promotion for ever.

Done means: `etherfold upload` of a bundle that adds an event, to a running node, ends with that bundle canonical and advancing, and the node survives a restart doing the same.

FIRST, check this task against current reality. If a new-stream successor is in fact already fetched somewhere, route to needs-attention with the measurement.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular how the set of fetchers is kept in step with the slots. Do not write the done record, the commit message or the PR body yourself.
