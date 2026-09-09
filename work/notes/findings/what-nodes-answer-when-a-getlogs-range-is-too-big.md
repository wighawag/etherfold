---
title: 'What nodes actually answer when an eth_getLogs range is too big, and the logs a successful call can still leave out'
slug: what-nodes-answer-when-a-getlogs-range-is-too-big
source: 'SQD, "eth_getLogs: limits, pagination, and the logs it leaves out", https://sqd.dev/learn/eth-getlogs-limits/, retrieved 2026-09-08, self-dated "every figure is from a request you can run, captured on 2026-06-30" and carrying the reproducing curl commands; Infura eth_getLogs reference, https://docs.infura.io/networks/ethereum/json-rpc-methods/eth_getlogs, retrieved 2026-09-08; the Alchemy error text quoted verbatim in ethers-io/ethers.js#4703; QuickNode support article "Understanding the 10,000 Block Range Limit". CROSS-CHECKED against packages/core/src/internal/engine/RangeLogFetcher.ts at a966aa5d. NOT independently re-run by us: SQD sells a competing indexed product, so their framing is interested even though their commands are reproducible and their captures dated. Re-run the probes before treating any single number as current.'
---

Ground truth about the one method etherfold cannot do without. Two separate things live here: what a node says when it refuses a range (which the fetcher reacts to), and what a node omits when it does NOT refuse (which nothing currently detects).

> **RE-RUN 2026-09-08, and two rows below no longer reproduce.** This finding told its readers to re-run the probes before treating any number as current; that was done while building `a-provider-refusal-is-read-from-its-data-before-its-prose`, and the fresher, wider capture is `docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/refusal-shapes.md`, with `capture-refusals.sh` beside it for re-running. **Prefer the spike where the two disagree.** What changed:
>
> - `rpc.mevblocker.io` no longer enforces a RESULT cap. It now enforces a 10,000-BLOCK span and answers `-32602 "range 47440 exceeds limit of 10000"`, so it has changed which KIND of cap it has, which is the one axis section 1 is about.
> - `eth.merkle.io` no longer serves `eth_getLogs` at all (`-32601 "Method not found"`).
> - The structured `data: {from, to, limit}` shape is still REAL, but mevblocker is no longer an example of it. Infura is, verbatim in `ethers-io/ethers.js#4703`.
> - `ethereum-rpc.publicnode.com`'s archive refusal is byte-identical three months on, which is why the fetcher treats it as terminal.
> - NEW, and not in this finding: Nethermind puts the whole hint in `data` as PROSE while leaving `message` at a bare `"invalid params"` (Gnosis, Fraxtal). A reader that looked only at `message` discarded a complete machine-readable answer. This is why the parser now reads `data` before prose.
>
> The SHAPES this finding records are what the code is built on and they have held; it is the per-endpoint NUMBERS that decay, exactly as the `source:` warned. Section 3 (the bloom omission) has NOT been re-run by us and is still a third party's dated capture.

## 1. There is no portable page size, and the caps are not even the same KIND of cap

Providers bound the method in two incompatible ways, and the numbers differ by more than an order of magnitude. Measured against public Ethereum endpoints, 2026-06-30:

| endpoint | the cap it enforces |
| --- | --- |
| `1rpc.io` | 50 BLOCKS per query |
| `eth.merkle.io` | 1,000 BLOCKS per query — **STALE (2026-09-08): serves no `eth_getLogs` at all now, `-32601 "Method not found"`** |
| `rpc.mevblocker.io` | 10,000 RESULTS per query — **STALE (2026-09-08): now a 10,000-BLOCK span, `-32602 "range 47440 exceeds limit of 10000"`** |
| `ethereum-rpc.publicnode.com` | recent blocks only; archive needs a token (re-confirmed 2026-09-08, byte-identical) |

The two stale rows are marked rather than rewritten, because the 2026-06-30 capture is what it is and the table is a dated record. But note WHICH row went: `rpc.mevblocker.io` was this table's only RESULT-cap example, and it has since changed to a BLOCK cap. The point of the section survives it — the two kinds exist and a fixed page size cannot satisfy both — but the example that demonstrated it no longer does, so read the spike for a current RESULT-cap endpoint (Arbitrum's `arb1.arbitrum.io/rpc` counts logs) rather than citing this row for it.

A block-span cap and a result-count cap cannot be satisfied by one page size, because the number of logs per block is a property of the workload rather than of the request. This is the reason etherfold's adaptive sizing exists at all, and it is why a fixed `maxBlocksPerFetch` can never be right for two providers at once.

**A query past the cap is REJECTED, not truncated**, on every endpoint above. That is the good case and it is what the retry path is built on. Section 3 is the case where it is not true.

## 2. The refusal shapes, and the four our parser does not read

`getNewToBlockFromError` accepts `-32005`, or `-32602` when the message mentions `results` or `block range`, then regex-matches `/\[.*\]/gm` and splits the bracketed pair on `", "`, parsing each as `0x`-prefixed hex. Separately, `getLogs`'s catch handles `-32603` with `err.data.message` containing `block range is too wide` (Polygon) or `block range too large` (Base), using them only to lower a ceiling and not to extract a number.

Real shapes, and how that fares:

- **`rpc.mevblocker.io`, `-32005`** (READ, and the best case):
  `"query returned more than 10000 results. Try with this block range [0x184036C, 0x184037B]."`
  and, alongside it, a STRUCTURED `data: {"from": "0x184036C", "limit": 10000, "to": "0x184037B"}`.
  We parse the prose and **ignore the structured field entirely** (`error.data` is only ever consulted for `.message`, on the `-32603` path). The structured field is the same information without a regex, and it also carries `limit`, which is the node's real result cap and is exactly what `suspectResultCount` needs a value for and currently has to be told by hand.
- **Infura, `-32005`**: `"query returned more than 10000 results"`, with NO suggested range. Falls through to the halving path, correctly.
- **Alchemy, `-32602`**: `"Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap ..."`. Passes the `looksLikeRangeHint` gate on `block range`, then the regex finds no bracketed pair, so the hint is dropped and it halves. **The message states the cap in prose (`2K block range`) and that number is never extracted.**
- **`"Exceed maximum block range: 5000"`** (a fifth shape, seen via ethers-io/ethers.js#1816): same story, a stated numeric cap nobody reads.
- **QuickNode**: plan-dependent and it says so in the message (`"eth_getLogs is limited to a 5 range, upgrade from discover plan..."`), so the cap can differ between two keys on the same provider.
- **`ethereum-rpc.publicnode.com`, `-32602`**: `"Archive requests require a personal token. Get one at: ..."`. This is a `-32602` that is NOT a range hint, and our `looksLikeRangeHint` gate correctly rejects it because it mentions neither `results` nor `block range`. Worth recording as a case the gate EARNS its keep on: without it, a generic invalid-params could be mis-parsed into a bogus `toBlock`.
- **`-32000` is not handled at all.** It is a widely used generic server-error code and several providers put range complaints behind it. Nothing in the parser matches it, so those refusals reach the halving path with their hint discarded.

**Summary of the gaps, all cheap to close and all strictly additive:** read `error.data.{from,to,limit}` before parsing prose; accept `-32000` under the same hint gate as `-32602`; extract a stated numeric cap (`2K block range`, `maximum block range: 5000`) as a ceiling; and treat a reported `limit` as a discovered `suspectResultCount` rather than requiring an operator to configure it.

## 3. A SUCCESSFUL call can be silently incomplete, and this one threatens the architecture

`eth_getLogs` is generally served from an index the node derives from each block's `logsBloom`. A log the bloom does not commit to therefore enters that index only if the node adds it deliberately, and not every node does.

The captured case is Polygon state-sync logs, on `polygon.drpc.org`, block 74,614,768:

| method | logs |
| --- | --- |
| `eth_getLogs` (whole block) | 848 |
| `eth_getLogs` (address = state-receiver `0x...1001`) | 0 |
| `eth_getTransactionReceipt` (the state-sync tx) | 8 |
| an indexed source (whole block) | 856 |

Eight logs exist in the block, are returned by the receipt call on the SAME node, and are absent from `eth_getLogs` with no error and nothing in the response signalling the omission. Polygon's own docs reportedly say a standard node returns them; this archive endpoint did not, so it also varies by node.

**Why this matters here more than it would to most consumers.** Two of etherfold's load-bearing positions meet exactly at this point:

- ADR-0004 treats an ABSENCE as an inference that reverts state. A bloom-omitted log is a permanent, stable absence rather than an intermittent one, so it does not present as a flapping reorg; it presents as a log that never existed. That is worse, not better: it is undetectable rather than noisy.
- The direction of travel is to make the engine a FOLD OVER LOGS, with `eth_getLogs` as the only data call. That is a clean thesis and this is its boundary condition: on a chain and node where the bloom index is incomplete, no amount of correct folding recovers a log the source never returns.

Neither of those is a reason to abandon the thesis. It IS a reason to state the thesis with its scope attached ("complete with respect to what the node's log index contains") rather than as an unqualified guarantee, and to note that the only known remedy is a receipt-based path, which is precisely the per-transaction cost the browser deployment cannot pay.

## 4. History sits behind an archive node

A second, independent gate: serving logs for old blocks needs an archive node, and public endpoints commonly refuse or token-gate it (the `publicnode` `-32602` above). So a deep backfill against a free public endpoint can fail for a reason that has nothing to do with range size and that no amount of halving fixes. A fetcher that halves forever on an archive refusal is doing useless work; the refusal is terminal for that endpoint and should be reported as such rather than retried.

## Why this is a finding rather than an observation

It is verified external ground truth about third-party systems (node and provider behaviour), it is LOAD-BEARING (it decides how the retry path should be shaped, it supplies the value `suspectResultCount` currently asks an operator to guess, and section 3 bounds a claim the project is about to make about itself), and it is exactly the kind of number that MOVES: every figure is per-provider and per-plan, and providers revise them. The dated `source:` above is what keeps it correctable.
