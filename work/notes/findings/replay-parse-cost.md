---
title: 'The cost of decoding on replay: ~63 µs/event, ~62% of a processor-change reindex from the stored stream'
slug: replay-parse-cost
source: 'measured by docs/spikes/replay-parse-cost/ (capture-full.mjs, measure.ts) on top of etherfold 5e0f455 (the decode/stream/process seams unchanged at HEAD dd304a7 — verified by diff), replaying the LAUNCHED stratagems game on Base (deployments/alpha1, 31,330 logs over 1,040 blocks) re-captured 2026-09-01 from base-mainnet.g.alchemy.com at the same pinned range (blocks 12,082,307–23,400,000) the committed conformance fixture holds, both halves present, verified event-for-event against it (every identity matches; only its two UNPARSED pre-#26/#27 events are absent, by design); AMD Ryzen 7 PRO 6850U, node 24.13.1 on Debian 13, one laptop, medians of 5 warm runs, 2026-09-01. Raw output in docs/spikes/replay-parse-cost/results/.'
---

> **SUPERSEDED IN ITS HEADLINE, 2026-09-05. The "~62%" is NOT reproducible at HEAD, and its
> `measure.ts` MUST NOT be re-run for a number.** The read and decode terms still reproduce within
> noise (461 vs 488 ms; 1,794 vs 1,962 ms, the same 57-63 us/event band). The PROCESS term does not:
> it was measured through `fromJSProcessor` / `@etherfold/js-processor`, which ADR-0037 retired and
> which now has ZERO tracked files. **The trap is that the spike still appears to run**, because
> `packages/js-processor/dist/` survives on disk as stale untracked build output, so a re-run silently
> produces a number from code that is not in the repository.
>
> Re-measured on the surviving ENTITY path across three backends, decode's share is a RANGE and not
> one number: **80% on memory, 59% on the light patch store, 18% on sqlite** — the process term spans
> 38x. So "decode is most of a replay" is a claim about the BROWSER's light store and is false on the
> server. The read term is also shape-dependent, which no number here exposed: the decoded half nearly
> doubles it (456 vs 251 ms).
>
> Current truth: `work/notes/findings/replay-decode-share-is-18-to-80-percent-by-backend.md` and
> `work/notes/findings/decoding-is-3x-faster-with-a-memoised-topic0-map.md`, both measured by
> `docs/spikes/replay-decode-cache/` and asserted against the committed golden state. What survives
> here unchanged and still load-bearing: consequence 1 (raw-only storage does not ADD replay decode
> cost, because `reparse` re-derives either way) and consequence 3's size figures.

> This finding is REQUIRED rather than optional: `work/specs/proposed/the-stream-stores-only-what-the-node-said.md` proposes storing the RAW half only so a replay pays decode-on-read, warns that "no task should quote a figure without re-measuring", and — until this spike — had NO measurement of the cost it was proposing to pay on every replay. Nothing else in the repo held one: the committed conformance fixture omits `data`/`topics` (nothing to decode), and the sqlite-in-the-browser spike timed `fetch+parse-fixture` (JSON.parse), not ABI decoding. This is the number its tasking and its acceptance thinking should read.

**Decode is the DOMINANT term of a processor-change reindex from the stored stream — not a rounding
error next to the re-processing.** For the launched stratagems game on Base (31,330 events, 1,040
blocks), the three terms a replay pays, measured through production code only (`LogEventFetcher.reparse`
is the exact method the indexer's load path calls, ADR-0034; the process term is the vendored
stratagems `JSProcessor` driven as the sqlite spike's oracle drives it):

| term | median | per 1k events |
| --- | --- | --- |
| read (gunzip + JSON.parse + reviver) | 488 ms | 15.4 ms |
| decode (`reparse`, per-address routed) | 1,962 ms | 63.1 ms |
| process (`JSProcessor` over every block) | 735 ms | 22.6 ms |

Total ≈ 3.2 s, of which decode is **~62%** — more than read and process combined, and 2.7× the
re-processing itself. The ratios, not the absolute laptop numbers, are the finding.

**Three consequences for the spec:**

1. **Raw-only storage does not ADD replay decode cost.** `reparse` over today's raw+decoded events
   and over raw-only events costs the same (1,924 vs 1,962 ms — within noise), because ADR-0034's
   reparse already discards stored `args` and re-derives them either way. The replay decode cost the
   spec implies is the cost every replay from a cached stream ALREADY pays today; the spec only
   stops paying to WRITE and STORE the copy that is never read.
2. **But that cost is real and now named.** At ~63 µs/event (single-threaded viem decode), a replay
   of the full history spends most of its time decoding. On the entity path the process term would
   be higher (SQL writes), shrinking decode's SHARE; the decode term itself is path-independent.
3. **Size is definitively NOT the case, and the three disagreeing inherited numbers can be
   retired.** On the same 31,330 events: full (raw + decoded) 27.8 MB JSON / 0.98 MB gz; raw-only
   21.1 MB / 0.63 MB; decoded-only 17.0 MB / 0.58 MB. Raw-only saves 24% of today's stored bytes —
   the dead-weight `args` — while being 24% LARGER than the decoded half alone, which is why the
   spec's problem statement is a CORRECTNESS argument (the decoded half is what can go stale), not a
   size argument.

**Incidentally confirmed:** all 31,330 re-captured events decode to the same `args`/`eventName` the
2026-08-22 capture recorded — no decoder drift between d635f39 and HEAD.

**A finding the capture itself surfaced, recorded separately:** the merged three-contract
conformance source can no longer construct a production `LogEventFetcher` at all (see
`work/notes/observations/the-conformance-workloads-merged-source-cannot-construct-a-fetcher.md`),
which is why the spike captures per contract and routes decode by address — the same per-event
decision the merged fetcher would make.