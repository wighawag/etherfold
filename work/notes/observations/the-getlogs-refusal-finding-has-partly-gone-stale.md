---
title: 'The getLogs-refusal finding has partly gone stale: mevblocker no longer sends the structured shape'
---

2026-09-08: re-running the probes behind `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` (the finding itself says to) found that `rpc.mevblocker.io` no longer answers `-32005` with `data: {from, limit, to}` — it enforces a 10,000-BLOCK span cap now and answers `-32602 "range 47440 exceeds limit of 10000"` — and `eth.merkle.io` no longer serves `eth_getLogs` at all (`-32601 "Method not found"`), so two rows of the finding's cap table no longer reproduce. The shape itself is still real (Infura, verbatim in ethers-io/ethers.js#4703) and the archive-refusal capture is byte-identical three months on. Full re-run, including a live structured-data shape the finding does not have (Nethermind puts the whole hint in `data` behind a `"invalid params"` message), is in `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/refusal-shapes.md`. Someone should decide whether the finding's `source:` and cap table want amending.

## Resolved 2026-09-08

The finding now carries a dated RE-RUN block at the top naming exactly what no longer reproduces (mevblocker's cap changed KIND, merkle.io stopped serving the method), pointing at `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/refusal-shapes.md` as the fresher source, and saying to prefer the spike where the two disagree. It also records the shape the finding never had (Nethermind's prose-in-`data`) and re-states that section 3's bloom omission is still an un-re-run third-party capture. The finding's own `source:` warning was left as it stands, because it was right and is what prompted the re-run.
