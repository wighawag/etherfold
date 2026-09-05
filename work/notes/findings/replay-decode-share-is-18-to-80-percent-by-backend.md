---
title: "Decode is 18% to 80% of a processor-change replay depending on the state backend, not the single 62% the earlier finding names, whose process term was measured through a deleted package"
slug: replay-decode-share-is-18-to-80-percent-by-backend
source: 'measured by docs/spikes/replay-decode-cache/ (measure.ts) at etherfold 2efd858, replaying the LAUNCHED stratagems game on Base (deployments/alpha1, 31,330 logs over 1,040 blocks) from the full re-capture docs/spikes/replay-parse-cost/results/stratagems-alpha1-full.stream.json.gz, through the ENTITY path (replayIntoStore + stratagemsProcessor) into MemoryStateStore / PatchStateStore / VersionedStateStore-on-libSQL; the replay is asserted to land on the committed golden state. AMD Ryzen 7 PRO 6850U, node 24.13.1 on Debian 13, viem 2.52.0, medians of 5 warm runs, 2026-09-05. Raw output in docs/spikes/replay-decode-cache/results/measure.json.'
---

`work/notes/findings/replay-parse-cost.md` says decode is **~62%** of a processor-change replay from
the stored stream. That figure is **not reproducible at HEAD**, and the reason is not that it was
wrong when measured. Its `process` term was measured by driving the vendored stratagems processor
through `fromJSProcessor` in `@etherfold/js-processor`, the package **ADR-0037 deleted**.
`packages/js-processor` now has ZERO tracked files and `fromJSProcessor` has no definition anywhere
in `packages/*/src`.

> **The trap, and it is worth naming loudly: that spike still APPEARS to run.**
> `packages/js-processor/dist/` survives on disk as untracked, gitignored build output, so
> `docs/spikes/replay-parse-cost/measure.ts` imports it and produces a number from code that is no
> longer in the repository. A spike that imports `dist/` by path cannot tell a live package from a
> deleted one.

**Two of the three seams DID hold.** `git diff 5e0f455..HEAD -- packages/core/src/internal/decoding/`
is empty, and the codec behind the read term did not move. Both terms reproduce within noise: read
461 ms against 488, decode 1,794 ms against 1,962 (the same 57–63 µs/event band). So the earlier
finding's decode and read numbers stand; only its denominator does not.

## The process term, re-measured on the model that survives

| term | median | per 1k events |
| --- | --- | --- |
| read, raw-only shape | 251 ms | 8.0 ms |
| read, raw + decoded shape | 456 ms | 14.6 ms |
| decode (`reparse`, per-address routed) | 1,794 ms | 57.3 ms |
| process, entity path on **memory** | 202 ms | 6.4 ms |
| process, entity path on **patch** (the light store) | 991 ms | 31.6 ms |
| process, entity path on **sqlite** (in-memory libSQL) | 7,737 ms | 246.9 ms |

**The process term spans 38x across backends**, so decode's share of a raw-only replay
(`read(raw-only) + decode + process`) is a range and not a number:

| backend | replay total | decode share |
| --- | --- | --- |
| memory | 2,247 ms | **80%** |
| patch | 3,035 ms | **59%** |
| sqlite | 9,782 ms | **18%** |

**Any claim of the form "decode is most of a replay" is a claim about the browser's light store and
is false on the server.** The earlier finding's own caveat predicted the direction ("an entity path
with SQL writes would raise it, shrinking decode's SHARE"); this is the size of it. The sqlite figure
is an in-memory libSQL, so a disk or D1 store pushes decode's share lower still.

## Two corrections that come with it

- **The READ term is not shape-independent, and no prior number in the repo exposed it.** The stored
  decoded half nearly DOUBLES the read: 456 ms against 251 ms on the same events. Any comparison
  between storing `args` and not storing them has to carry this, because it runs opposite to the
  decode saving.
- **Sizes reproduce exactly** on the same bytes: full (raw + decoded) 27.8 MB JSON / 0.98 MB gz;
  raw-only 21.1 MB / 0.63 MB; decoded-only 17.0 MB / 0.58 MB. Read the other way round from the
  earlier finding's framing: keeping the decoded half costs **+32% JSON and +54% gzipped** over
  raw-only.

**Incidentally confirmed:** the entity replay of these 31,330 events lands on the COMMITTED golden
state that the original stratagems `JSProcessor` computed (1,040 blocks, 29,492 mutations), so the
process term above is the real fold and not a loop that happens to take time.
