---
title: 'What a published stream seed costs a browser to install, and what shape it should have'
slug: what-a-published-stream-seed-costs-to-install
source: 'measured by docs/spikes/measure-what-a-published-stream-costs-to-install-and-pick-its-shape/ (prepare.mjs, browser/cut.ts, browser/install-cost.spec.ts, android.mjs, snapshot-cadence.mjs) @ c683f83, installing the committed stratagems-alpha1 capture (31,332 real logs) through the ADR-0063 install path; against a REAL DEVICE, a Pixel 8a (Tensor G3, 7.4 GB RAM, Android 16 / sdk 36, Chrome 152.0.7977.76) over USB, and as a labelled desktop proxy against Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6 under Playwright on one Debian 13 laptop, unthrottled and at a 4x CDP CPU throttle, 3 repeats per case, 2026-09-06. The republication cadence is measured from the git history of the public wighawag/stratagems-snapshots repository (8,198 publishes, 2024-02-08 to 2025-01-30), retrieved 2026-09-06. Raw output in that spike folder under results/.'
---

> Load-bearing, so REQUIRED rather than optional (`WORK-CONTRACT.md`): the wire shape of a published
> seed is chosen because of these numbers, and a spike folder alone leaves that reason undiscoverable.

## The question, and the short answer

Can a published stream seed be ONE document, fetched, parsed and installed in one go, or must it be
chunked and resumable?

**It can be one document, and it should carry only the STORED half of each event.** On the real
device, the whole install of 31,332 events costs about **1.0 s and a 51 MB peak heap** in that shape.
Chunking is a real but much smaller improvement than a laptop suggests, and it costs wall-clock; take
it when you want resumability, not because a single document cannot be afforded.

**The bigger finding is that this choice is not on the critical path at all**, and it is recorded
below under "when a stream seed is worth publishing": a state snapshot republished hourly already
makes a browser start, so a stream seed is for what comes AFTER the first start.

## What was measured

The install pinned by ADR-0063 (batched `saveNewEvents` through the real `keepStreamOnIndexedDB`
keeper), on the committed `stratagems-alpha1` capture, across two crossed axes:

- **delivery**: one document, or a manifest plus contiguous chunks (4,000 and 1,000 events);
- **content**: the capture's DECODED events, or only the STORED (raw) half the keeper keeps.

The parser is part of the second axis: `parseStreamFixture` revives every tagged BigInt, and a
stored-only artifact has none to revive.

### The artifacts

| shape | raw | gzipped |
| --- | --- | --- |
| single, as committed (indented) | 33.8 MB | 1.05 MB |
| single, compact | 26.5 MB | 0.81 MB |
| **single, compact, STORED-only** | **20.1 MB** | **0.54 MB** |
| chunked 4,000, decoded (8 chunks) | 26.5 MB | 0.85 MB |
| chunked 4,000, STORED-only (8 chunks) | 20.1 MB | 0.57 MB |
| chunked 1,000, decoded (30 chunks) | 26.5 MB | 0.87 MB |

Chunking COSTS about 5% of the gzipped size, because compression cannot cross a chunk boundary. A
chunk carrying the fixture header rather than sharing one manifest would add 35.3 KB each.

## The numbers

Medians of 3 runs. Peak heap on the device is the CDP figure and only the CDP figure, for a reason
given under "the instruments" below.

### Pixel 8a, a REAL DEVICE

| case | total | peak heap | longest main-thread block |
| --- | --- | --- | --- |
| single, decoded, as committed | 1302 ms | 66.0 MB | 198 ms |
| single, decoded, compact, `parseStreamFixture` | 1123 ms | 55.7 MB | 216 ms |
| single, decoded, compact, plain `JSON.parse` | 974 ms | 55.6 MB | 193 ms |
| **single, STORED-only, compact** | **975 ms** | **51.4 MB** | 190 ms |
| chunked 4,000, decoded | 1168 ms | 42.2 MB | 139 ms |
| chunked 4,000, STORED-only | 1178 ms | 43.8 MB | 101 ms |
| chunked 1,000, decoded | 1996 ms | 31.3 MB | 196 ms |

### Desktop, a labelled PROXY (Chromium, unthrottled / 4x CPU throttle)

| case | total | peak heap (cdp) | longest block |
| --- | --- | --- | --- |
| single, decoded, as committed | 655 / 1746 ms | 139.2 MB | 179 / 663 ms |
| single, decoded, compact, `parseStreamFixture` | 470 / 1560 ms | 133.0 MB | 179 / 632 ms |
| single, decoded, compact, plain `JSON.parse` | 310 / 1136 ms | 109.8 MB | 0 / 174 ms |
| single, STORED-only, compact | 273 / 901 ms | 92.7 MB | 0 / 148 ms |
| chunked 4,000, decoded | 353 / 1156 ms | 31.3 MB | 0 / 0 ms |
| chunked 4,000, STORED-only | 296 / 999 ms | 28.8 MB | 0 / 0 ms |

Firefox and WebKit were measured too and agree on every direction; neither reports a heap figure or
implements the `longtask` entry type, so both are recorded as `n/a` rather than as zero.

## What the numbers say

**1. Publish the STORED half only. This is the one unambiguous win.** Installing strips `args`,
`eventName` and `decodeError` before anything reaches the keeper (ADR-0060), so a seed carrying them
ships bytes the client parses and then deletes. Dropping them costs nothing and buys **33% off the
gzipped artifact** (0.54 MB against 0.81 MB), a smaller parse, and a lower peak. It also removes the
tagged-BigInt revive entirely, which on desktop alone accounts for 160 ms of a 470 ms install and is
bought purely to be discarded.

**2. A single document is affordable on a real mid-range phone.** 975 ms and a 51 MB peak for 31,332
events. The peak is about 2.5x the artifact's raw size, rather than the 3 to 5x a rule of thumb predicts.

**3. Chunking helps much less on a device than on a laptop, and the laptop would have misled us.**
On desktop, chunking cut the peak by 3 to 4x and eliminated long tasks completely. On the phone it
cuts the peak by about 20% (42 to 44 MB against 51 to 56 MB), halves but does NOT eliminate
main-thread blocking (101 to 139 ms against 190 to 216 ms), and costs about 20% more wall-clock.
The phone collects garbage far more aggressively than the laptop, so the memory headroom chunking
buys is partly bought already by the runtime, and paid for in time instead. **This is exactly the
error the source spec warned about**, and it would have been made in the flattering direction: a
desktop-only measurement would have recommended chunking on a benefit 3 to 4 times larger than the
one a real device delivers.

**4. Smaller chunks are worse, not better.** 1,000-event chunks take twice as long on the device
(1996 ms) for no reliable memory gain. Per-chunk overhead dominates below a few thousand events.

**5. Resumability is free, and is chunking's real product.** An install interrupted after 3 of 8
chunks and resumed ACROSS A PAGE RELOAD picks up from the keeper's own cursor, with no record of
which chunks were installed, and lands on a stream identical to an uninterrupted one (asserted in the
spike). That falls out of ADR-0063's decision to install through the keeper seam: a partial install
is a contiguous prefix with an honest cursor, so resuming is asking the cursor where it got to.

## The recommendation, as a CONDITION

**Publish a single compact STORED-only gzipped document while the capture is at or below roughly
50,000 events (about 0.9 MB gzipped, 32 MB raw, extrapolating linearly from 31,332 events at 0.54 MB
and 20 MB). Above that, or whenever the publisher wants an interrupted download to resume rather than
restart, publish the chunked form with a manifest and chunks of 4,000 to 8,000 events.**

What would overturn it:

- **A low-memory device behaving differently.** The Pixel 8a has 7.4 GB of RAM. It is a real phone
  and it is NOT a constrained one, and the case this recommendation is weakest on is a 2 to 3 GB
  Android Go device where the browser evicts rather than collects. If one shows eviction at a 50 MB
  peak, the crossover moves down sharply and chunking becomes the default.
- **A larger capture behaving non-linearly.** The extrapolation above is linear and untested past
  31,332 events. If peak heap grows faster than the artifact past some size, the threshold is lower.
- **A publisher that cannot serve range requests**, which would make a resumable download impossible
  in the single-document shape and force chunking earlier.
- **The install path changing.** These numbers measure ADR-0063's install; if the batching or the
  keeper writes change, re-run the spike rather than trusting this table.

The envelope is deliberately left OPEN: the manifest carries `format`, provenance, source, coverage
and the chunk list, and nothing here freezes a field list. Two later decisions
(`decide-what-a-mismatched-seed-digest-does`, `decide-who-verifies-a-stream-seed-and-against-what`)
add an identity and a verification claim, and both fit as manifest fields.

## When a stream seed is worth publishing AT ALL

This is the crossover question the task asked for, and the answer is not a byte count.

The exploration's premise is that a browser on a public node "frequently cannot backfill at all", so
a seed is what makes the browser case possible. The operational record of the reference deployment
says otherwise. `wighawag/stratagems-snapshots` published a STATE snapshot from a GitHub Actions cron
**8,198 times over 357 days**:

| gap between publishes | |
| --- | --- |
| median | 1.0 h |
| p90 | 1.2 h |
| p99 | 1.9 h |
| worst observed | 50.9 h |
| within 2 h / 4 h | 99.74% / 99.90% |

At Base's measured 2.000 s/block (derived from the chain heads recorded in two of our own captures'
provenance, 14 days apart), that leaves a client **1,802 blocks to backfill at the median and 91,527
at the worst observed outage**. Both are served by any public node: 50 hours is nowhere near a
pruning horizon, and the fetcher chunks ranges anyway.

So on this evidence a **state snapshot alone** is what makes a browser app start, and it does so
without a stream at all. A snapshot-seeded generation is a LEAF (ADR-0028's retention floor; nothing
under it to re-fold), and on an hourly cadence that is usually fine. **A stream seed earns its keep
where a snapshot cannot: making a processor-only change free without waiting for a republished
snapshot, and giving revert and as-of depth below the snapshot's floor.** That is a narrower and more
honest justification than the spec's, and the follow-on build spec should open from it.

## The instruments, and what they cannot see

Recorded because two of them lie by default and the calibration is what caught it.

- **`performance.measureUserAgentSpecificMemory()` is the right instrument and is unavailable**: it
  exists and throws `SecurityError: not available` in this Chromium even cross-origin-isolated.
- **In-page `performance.memory` is quantised** unless Chromium is launched with
  `--enable-precise-memory-info`; without it every sample read exactly 10,000,000 bytes and never
  moved. The flag cannot be passed to Chrome on a phone.
- **The linearity calibration decides which instrument to believe, per device.** Allocating N and
  then 2N objects should double the delta. Desktop scores **2.00** and its in-page numbers are used;
  the **Pixel 8a scores 0.956**, so its in-page numbers are discarded and only the driver-side CDP
  figures are quoted. Without that check this finding would have quoted a fabricated 49 MB device
  peak.
- **Peak heap is a FLOOR.** `JSON.parse` blocks the main thread, so no in-page sample can land inside
  it and the CDP sampler answers only when the inspector can. The true peak can only be higher.
- **Long-task support is checked, not assumed** (`PerformanceObserver.supportedEntryTypes`): Firefox
  and WebKit accept the observer and never emit, so a naive harness reports "0 long tasks" about
  engines that do not measure them.

## What is NOT measured here

- **The FOLD.** Every number above is the cost of getting the seed INTO the keeper. Folding those
  31,332 events through a processor is a separate and much larger cost:
  `work/notes/findings/sqlite-in-the-browser.md` records 45.6 ms/block on Chromium for the IndexedDB
  entity backend over 1,042 event-bearing blocks, which is roughly **47 seconds**. Anyone reading
  "installing a seed costs a second" without this line will reach the wrong conclusion about what
  seeding costs a user.
- **A low-memory device**, per the recommendation's first overturning condition.
- **A mobile network.** The device fetches over `adb reverse`, so its transfer time is a USB
  measurement. Transfer sizes are real; transfer times on the device run are not.
- **Eviction and background-tab suspension**, which is what the desktop proxy most under-reports and
  what the device run did not provoke.
