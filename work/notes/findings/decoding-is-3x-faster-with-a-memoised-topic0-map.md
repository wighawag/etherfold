---
title: 'Decoding costs 57 µs/event because viem re-searches the whole ABI per call; preselecting the member by a topic0 map built once makes it 18 µs/event, a 3.2x cut for a 0.24 ms map'
slug: decoding-is-3x-faster-with-a-memoised-topic0-map
source: 'measured by docs/spikes/replay-decode-cache/ (decode-breakdown.ts) at etherfold 2efd858, over the 31,330 real Base logs of the LAUNCHED stratagems game (deployments/alpha1) in docs/spikes/replay-parse-cost/results/stratagems-alpha1-full.stream.json.gz, against the SAME viem instance @etherfold/core resolves (2.52.0, its ESM entry from core node_modules); all three variants asserted to produce identical eventName/args on every one of the 31,330 events. AMD Ryzen 7 PRO 6850U, node 24.13.1 on Debian 13, medians of 5 warm runs, 2026-09-05. Raw output in docs/spikes/replay-decode-cache/results/decode-breakdown.json.'
---

`LogEventFetcher.decodeOnto` calls `decodeEventLog({abi: <every event member of that address>, data,
topics})` **once per event**. viem then has to work out which member the log's `topic0` names, and it
does that by walking the ABI and computing an event selector (a keccak over the canonical signature)
for each candidate, **per call**, with nothing memoising it. That search, not the ABI decoding, is
where most of the replay's decode time goes.

| variant | median | per event |
| --- | --- | --- |
| production `reparse` (whole address ABI per call) | 1,791 ms | 57.2 µs |
| bare `decodeEventLog`, whole address ABI per call | 1,769 ms | 56.5 µs |
| bare `decodeEventLog`, **one-member ABI preselected from a `${address}:${topic0}` map** | **564 ms** | **18.0 µs** |
| building that map | **0.24 ms**, once per fetcher | n/a |

**3.2x, for a map built in a quarter of a millisecond.** Production's overhead above the bare viem
call is ~1% (1,791 against 1,769 ms), so this is entirely viem's per-call ABI search and not
anything the fetcher does around it.

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
the guard's remaining advantage falls to **11.5 µs/event**: the residual 18 µs/event decode, less
the 6.5 µs/event of extra READ that storing `args` costs (456 ms against 251 ms over 31,330 events).
See `docs/spikes/replay-decode-cache/README.md` for that comparison and the recommendation it leads
to.

## Two things a builder must not skip

- **Anonymous events have no `topic0`** and therefore cannot be in the map. They must keep falling
  through to the whole-ABI path, or they stop decoding.
- **The map is only unambiguous because a `topic0` collision within one ABI is REFUSED at
  construction** (ADR-0031). That is a load-bearing precondition borrowed from another decision, so
  it should be asserted in the test rather than trusted.

`parseAllEventsIrrespectiveOfAddresses` routes through `allABIEvents` rather than `abiPerAddress` and
would need either its own map or to keep the existing route; not measured here.
