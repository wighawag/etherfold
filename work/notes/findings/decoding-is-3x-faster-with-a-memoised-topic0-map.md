---
title: 'Decoding cost 57 µs/event because viem re-searched the whole ABI per call; preselecting the member by a topic0 map built once makes it 18 µs/event, a 3.2x cut for a 0.24 ms map — LANDED, and re-measured through the shipped path'
slug: decoding-is-3x-faster-with-a-memoised-topic0-map
source: 'first measured on a hand-rolled equivalent by docs/spikes/replay-decode-cache/ (decode-breakdown.ts) at etherfold 2efd858; RE-MEASURED THROUGH PRODUCTION CODE at 0a53b98 once the preselection shipped (work/tasks/done/decoding-preselects-the-event-by-topic0-instead-of-re-searching-the-abi.md). Both over the 31,330 real Base logs of the LAUNCHED stratagems game (deployments/alpha1) in docs/spikes/replay-parse-cost/results/stratagems-alpha1-full.stream.json.gz, against the SAME viem instance @etherfold/core resolves (2.52.0, its ESM entry from core node_modules); all four variants asserted to produce identical eventName/args on every one of the 31,330 events. AMD Ryzen 7 PRO 6850U, node 24.13.1 on Debian 13, medians of 5 warm runs. Raw output in docs/spikes/replay-decode-cache/results/decode-breakdown.json.'
---

`LogEventFetcher.decodeOnto` called `decodeEventLog({abi: <every event member of that address>, data,
topics})` **once per event**. viem then had to work out which member the log's `topic0` names, and it
did that by walking the ABI and computing an event selector (a keccak over the canonical signature)
for each candidate, **per call**, with nothing memoising it. That search, not the ABI decoding, is
where most of the replay's decode time went.

**This has LANDED.** `decodeOnto` now preselects the member from a `${address}:${topic0}` map built
once per fetcher, and falls back to the whole-ABI call where nothing can be preselected. The numbers
below are therefore in two tables: the ones that made the case, measured on a hand-rolled equivalent,
and the ones this repo publishes, measured through the shipped path.

## Measured through PRODUCTION CODE, after landing (0a53b98)

The pre-change algorithm is still reachable through production: the address-agnostic route
(`parseAllEventsIrrespectiveOfAddresses`) deliberately does NOT preselect, and each fetcher in the
harness holds exactly one contract, so that route decodes against the same member list and differs
only in the search. The delta below is therefore production-to-production rather than production
against a transcription of it.

| variant | median | per event |
| --- | --- | --- |
| production `reparse`, the pre-change whole-ABI search | 1,824 ms | 58.2 µs |
| production `reparse`, **as it ships: preselected by `${address}:${topic0}`** | **576 ms** | **18.4 µs** |
| bare `decodeEventLog`, whole address ABI per call | 1,787 ms | 57.0 µs |
| bare `decodeEventLog`, one-member ABI preselected from the same map | 581 ms | 18.6 µs |
| building that map | **0.24 ms**, once per fetcher | n/a |

**3.2x through the shipped path**, and the shipped path is within 1% of the bare viem call it wraps
in both directions (576 against 581 ms preselected; 1,824 against 1,787 ms unpreselected), so the
fetcher adds nothing measurable around the decode either way. The pre-change production number
re-measures the 1,791 ms recorded at `2efd858` within noise, on the same machine.

Correctness is asserted rather than presumed, on real data: all 31,330 events decode to identical
`eventName`/`args` through the shipped preselection and through the pre-change search. That is the
pure-optimisation claim, checked over a whole launched game's history rather than only over the
fixture in `packages/core/test/decodePreselection.test.ts`.

## The original measurement, on a hand-rolled equivalent (2efd858)

| variant | median | per event |
| --- | --- | --- |
| production `reparse` (whole address ABI per call) | 1,791 ms | 57.2 µs |
| bare `decodeEventLog`, whole address ABI per call | 1,769 ms | 56.5 µs |
| bare `decodeEventLog`, **one-member ABI preselected from a `${address}:${topic0}` map** | **564 ms** | **18.0 µs** |
| building that map | **0.24 ms**, once per fetcher | n/a |

**The ABIs here are SMALL** (14, 6 and 4 event members for the three contracts), so this is not an
artifact of a pathological ABI. The effect grows with ABI size, which means a real deployment with a
larger ABI pays more than 3.2x, not less.

## Why this is a refactor and not a cache

Nothing is stored. The map is rebuilt from the source every time a fetcher is constructed, so there
is no derivation on disk that can go stale and no identity to guard. It is the same class of change
as any other memoisation of a pure lookup. `decodeOnto` already exists so that the fetch path and the
cached-stream replay decode through ONE rule rather than two copies of it, so memoising inside it
speeds up **both** paths at once: the live fetch as well as the replay.

## What it costs the argument for caching decoded `args`

The decode term is 59% of a raw-only replay on the light store before this and 31% after it. Measured
against the alternative of storing decoded `args` beside the raw log under a decode-identity guard,
the guard's remaining advantage falls to **11.5 µs/event**: the residual 18.4 µs/event decode, less
the 6.5 µs/event of extra READ that storing `args` costs (456 ms against 251 ms over 31,330 events).
See `docs/spikes/replay-decode-cache/README.md` for that comparison and the recommendation it leads
to.

## Two things a builder must not skip

Both are now pinned by `packages/core/test/decodePreselection.test.ts`, which asserts the decoded
half byte-for-byte (argument key ORDER included) against a golden table AND against the whole-ABI
algorithm transcribed as an oracle, so the pin is on the rule and not on a snapshot of one run.

- **Anonymous events have no `topic0`** and therefore cannot be in the map. They must keep falling
  through to the whole-ABI path, or they stop decoding. What they decode TO is a separate matter:
  under viem 2.52.0 `decodeEventLog` selects a member by matching `topics[0]` against a computed
  selector even for a one-member ABI, and an anonymous event's `topics[0]` is an indexed ARGUMENT, so
  no member is found and such a log records a `decodeError` on either route. The fallback is what
  keeps the two routes agreeing, whichever answer viem gives.
- **The map is only unambiguous because a `topic0` collision within one ABI is REFUSED at
  construction** (ADR-0031). That is a load-bearing precondition borrowed from another decision, so
  it is asserted in the test rather than trusted.

`parseAllEventsIrrespectiveOfAddresses` routes through `allABIEvents` rather than `abiPerAddress` and
deliberately KEPT the whole-ABI route rather than growing a second map: ADR-0031 is that it decides
which ABI decodes a log and must never decide which events exist. Its cost is unchanged, and it is
what the production "before" row above is measured through.
