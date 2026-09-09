# replay-parse-cost

**What does DECODING cost on a replay from the stored stream, next to the read and the
re-processing a replay also pays? And what does the stored decoded half actually weigh?**

Asked by `work/specs/tasked/the-stream-stores-only-what-the-node-said.md`, which would store
the RAW half only, so a replay after a processor change pays decode-on-read (`reparse`) instead of
trusting stored `args`. Nothing in the repo had measured it: the committed conformance fixture omits
`data`/`topics` (nothing to decode), and the sqlite-in-the-browser spike timed `fetch+parse-fixture`
(JSON.parse), not ABI decoding. The spec also warns that no task should quote a SIZE figure without
re-measuring; this spike re-measures size on the same bytes as the timings.

## Method

- `capture-full.mjs` re-captures the SAME pinned range as
  `packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz`
  (stratagems on Base, deployments/alpha1, blocks 12,082,307–23,400,000) but keeps `data` and
  `topics`, into `results/`. It verifies the re-capture against the committed fixture: every
  re-captured identity must be present there, and the only committed events allowed to be absent
  are UNPARSED ones. Re-run offline with `--verify-only`.
- `measure.ts` measures offline, warmup 2 + 5 runs, medians, on production code only:
  - **read**: gunzip + JSON.parse + `taggedBnReviver` (the codec `parseStreamFixture` applies).
  - **decode**: `LogEventFetcher.reparse` — the exact method the indexer's load path calls on a
    cached stream (ADR-0034), measured over BOTH the raw-only events (the shape the proposed spec
    would store) and today's raw+decoded events, so the stored `args`' effect on the decode term is
    measured rather than assumed. Correctness is asserted, not presumed: both shapes must decode to
    identical events, and the decoded result must agree with the `args` the capture itself produced.
  - **process**: the vendored stratagems `JSProcessor` driven through `@etherfold/js-processor`
    exactly as the oracle in the sqlite-in-the-browser spike drives it — the re-processing a
    processor change exists to re-run.
  - **sizes**: the three shapes serialized with the repo codec, JSON and gzipped bytes.

  Run: `packages/core/node_modules/.bin/tsx measure.ts`. Raw output: `results/measure.json`.

### Why one capture PER CONTRACT

The original capture (2026-08-22, commit d635f39) fetched all three contracts through ONE
`LogEventFetcher`. Since #28 that construction is REFUSED: the merged ABI declares
`Approval(address,address,uint256)` twice with different decoding shapes (Stratagems'
ERC-721-style `tokenID` event and Gems' ERC-20-style `value` event), and the guard refuses the
whole merged source even though per-address decoding — what the fetcher actually does per event —
is unambiguous. The spike therefore constructs one fetcher per contract and routes events by
address, which makes the same decode decision per event (`decodeOnto` keys the ABI by the log's
address). Recorded as an observation: the repo's own promoted conformance workload cannot be
captured or replayed through the production fetch path today (the conformance tests replay through
processors and never construct a fetcher, so the green gate cannot see it).

### The two unparsed events

The committed fixture holds two logs of events NEITHER artifact declares (`OwnershipTransferred`,
an OpenZeppelin deployment event), captured by the pre-#26/#27 address-only fetch and stored
unparsed (`decodeError`, no `eventName`). Today's topic0-filtered fetch deliberately never asks for
events outside the ABI, so the re-capture holds 31,330 events against the committed fixture's
31,332, and the verification expects exactly those two as the difference. Every PARSED event matches
on every identity field AND on `args`/`eventName`: no decoder drift between the 2026-08-22 capture
and this one.

## Results (one laptop: Ryzen 7 PRO 6850U, node v24.13.1, Debian 13; medians of 5)

31,330 events over 1,040 blocks (the launched stratagems game on Base):

| term | median | per 1k events |
| --- | --- | --- |
| read (gunzip + JSON.parse + reviver) | 488 ms | 15.4 ms |
| decode `reparse(raw-only)` — the proposed stored shape | 1,962 ms | 63.1 ms |
| decode `reparse(full)` — today's stored shape | 1,924 ms | 61.5 ms |
| process (stratagems `JSProcessor` over every block) | 735 ms | 22.6 ms |

**A processor-change replay from the stored stream, post-spec shape: read 488 + decode 1,962 +
process 735 ≈ 3,185 ms — decode is ~62% of the total, the largest of the three terms.**

Sizes of the three shapes on the same 31,330 events (repo codec, JSON / gzipped):

| shape | JSON | gzipped |
| --- | --- | --- |
| full (raw + decoded) — today's stream | 27.8 MB | 0.98 MB |
| raw-only — the proposed stored shape | 21.1 MB | 0.63 MB |
| decoded-only — what the committed fixture keeps | 17.0 MB | 0.58 MB |

## What the numbers say

- **Raw-only storage does not ADD decode cost to the replay**: `reparse(full)` and
  `reparse(raw-only)` are the same cost (1,924 vs 1,962 ms — within run-to-run noise), because
  ADR-0034's reparse already discards the stored `args` and re-derives them either way. The
  spec's replay-path decode cost is the cost today's stream ALREADY pays on every replay.
- **But that cost is not small**: at ~63 µs/event, decoding is 2.7× the re-processing cost of this
  workload and ~62% of the replay pipeline. Decode-on-read is the dominant term of a
  processor-change reindex from the stored stream — a claim the spec's task should carry into its
  acceptance thinking (and one no future task should have to re-derive).
- **The stored decoded half is dead weight, measured**: today's stream carries 6.7 MB (24%) more
  JSON than raw-only for `args`/`eventName` that nothing reads. Meanwhile raw-only is 24% LARGER
  than the decoded half alone — SIZE is definitively not the case for the spec, exactly as its
  problem statement insists, and now there are fresh numbers instead of the three it inherited
  disagreeing.
- **Decoder stability, incidentally confirmed**: all 31,330 re-captured events decode to the same
  `args`/`eventName` the 2026-08-22 capture recorded.

## Caveats, stated rather than hidden

- One laptop, one node version, warm page cache, single-threaded decode; medians of 5 runs.
  Absolute numbers will move on other machines; the RATIOS are the finding.
- The process term is the js-processor (free-form path) on this workload; an entity path with SQL
  writes would raise it, shrinking decode's SHARE of the total. The decode term itself is
  path-independent.
- The decode measurement routes events to per-contract fetchers by address (see above); the
  per-event decode decision is the same as the merged fetcher's, but the merged construction path
  is currently unmeasurable because it throws.