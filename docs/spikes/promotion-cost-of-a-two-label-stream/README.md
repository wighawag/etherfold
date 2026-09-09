# Spike: what does promoting a staging generation cost in a key/value store?

> **The design this measured was SUPERSEDED.** It compared two layouts for a two-label stream. The chosen design (`work/specs/tasked/a-reconfigure-is-not-an-outage.md`) gives each generation its own stream keyed by its fetch filter, so there is no label and promotion is a pointer flip. The harness and the numbers are still valid and re-runnable; what they decide is no longer a live question. Kept as evidence, and because the measurement is part of why that design was abandoned.

Evidence for [`work/notes/findings/promotion-cost-of-a-two-label-stream.md`](https://github.com/wighawag/etherfold/blob/main/work/notes/findings/promotion-cost-of-a-two-label-stream.md), which is where the conclusions live. This folder holds the harness and the raw output, so every number in that finding can be re-run rather than believed.

Design record whose open question this answers: [`work/notes/ideas/stream-grafting-what-we-established.md`](https://github.com/wighawag/etherfold/blob/main/work/notes/ideas/stream-grafting-what-we-established.md). Spec the answer feeds: `work/specs/tasked/a-reconfigure-is-not-an-outage.md`.

## The question (as it stood)

The design under test gave every stream entry a label, `live` or `staging`. A staging reader takes `gen = staging OR (gen = live AND seq <= N)`; promotion deletes the live entries above `N` and relabels staging to live. On a relational store that is one indexed `UPDATE`. In a key/value store there is no bulk update, so promotion touches one entry per staging segment, and the open question was where the label should live:

- **key-label** — the label is part of the key, so a relabel is a **rename**
- **value-label** — the label is a field of the value, so a relabel is a **rewrite**

The filesystem has a native rename; IndexedDB has none. So the prediction was: cheap on fs, read-plus-write on IndexedDB, rewrite either way for value-label. The measurement is what decides whether that difference is worth designing around.

## What is here

```
src/layouts.ts      the two layouts, ONCE, over one get/set/del/keys/rename port
src/port-fs.ts      the filesystem port, mirroring packages/fs/src/utils/fs.ts
src/workload.ts     the stream, cut into segments, and the three sharing cases
run/measure-fs.ts   the filesystem half, in node
browser/cut.ts      the IndexedDB half, in-page, over idb-keyval
browser/promotion.spec.ts   the playwright cuts
results/            raw JSON per substrate and per engine
```

Both keepers run the SAME `layouts.ts`, so the two arms differ only in the port they supply and not in what is being measured.

### The arms

| arm | relabel | why it is here |
| --- | --- | --- |
| `key-label` | rename where the substrate has one, otherwise get+set+del | the candidate |
| `key-label-unbatched` | as above, without `getMany`/`setMany`/`delMany` | separates structured-clone cost from the per-transaction floor (IndexedDB only) |
| `value-label` | read every value to find the labels, rewrite the staging ones | the naive form |
| `value-label+pointer` | a boundary pointer says which entries are staging; rewrite those | value-label's BEST form, so this is not a strawman |

`value-label+pointer` exists deliberately. Without a pointer the labels are only discoverable by reading every value, since that is where they live, so even the whole-stream case (which relabels nothing) has to deserialise the entire history to find that out. Giving value-label the pointer removes that penalty — and the finding records what the pointer then costs, which is a second source of truth that can disagree with the entries, exactly the objection `appending-to-the-stream-costs-the-batch` already raised against a head pointer.

### The workload

The base stream is the captured launched game (`stratagems-alpha1`, 31,332 real logs, 23.2 MB of JSON), the same fixture [`docs/spikes/sqlite-in-the-browser`](https://github.com/wighawag/etherfold/tree/main/docs/spikes/sqlite-in-the-browser) uses, so the shape of an event is real. `4x`/`8x` are that stream repeated with its block numbers advanced.

The seal threshold is **swept**, because it is the axis that separates the two layouts: a rename costs per SEGMENT and a rewrite costs per BYTE, so at a fixed history a coarser seal should make key-label cheaper and leave value-label where it was. If the numbers had not shown that, the model would have been wrong.

The three **sharing cases** decide how much staging wrote, and which one applies is decided by the invalidation verdict rather than chosen: `whole-stream` (a processor-only or decode-only change) writes nothing, `partial-graft` writes above the boundary, `no-sharing` (a changed address, a new contract) writes everything.

## Re-running it

```sh
npm install

npx tsx run/measure-fs.ts                          # the filesystem sweep
SPIKE_SIZES=1x,4x SPIKE_SEAL=1000 npx tsx run/measure-fs.ts    # a quicker pass

npx playwright install chromium firefox webkit
npx playwright test --project=chromium             # the IndexedDB sweep, 1x and 4x
SPIKE_SIZES=8x SPIKE_SEAL=1000 npx playwright test --project=chromium   # the 136 MB rows
```

The browser spec defaults to `SPIKE_SIZES=1x,4x`, so the 136 MB rows the finding quotes need `8x`
asked for explicitly. Results are MERGED by `(arm, size, seal, case)` rather than overwritten, so
running one size at a time accumulates rather than discarding the others.

`SPIKE_DIR` chooses where the filesystem arm writes, and it is **not** a detail: `os.tmpdir()` is `tmpfs` on most Linux boxes, where a rename and a rewrite are both memory operations, so measuring there flatters the rewrite arm. The default is a real disk directory (`~/.cache/etherfold-promotion-spike`) and the chosen root is recorded in `results/fs.json`.

## Reading the numbers honestly

`ms` is wall-clock and is the WEAKER number: it moves with machine load, which is why `appending-to-the-stream-costs-the-batch` insists its own append-cost claim be asserted as work rather than wall-clock (ADR-0032). The metrics the finding rests on are the WORK ones — `metadataRenames`, `payloadsRewritten`, `payloadBytesMoved`, `storeOps` — which are substrate-independent and reproduce exactly.

How much weaker, measured rather than asserted: a first `8x` chromium sweep run on a busy machine produced key-label timings up to FIVE TIMES those of a quiet re-run, with byte-identical work counters. Treat any single timing as an order of magnitude, and treat a difference under about 2x between two arms as no difference at all.

`payloadBytesMoved` is measured as the JSON length of every value passed through `set`. That is an accounting of the work, NOT a claim about what either store wrote to disk: IndexedDB does not expose structured-clone size, which is the same reason the seal threshold is counted in events rather than bytes, and a metric both keepers can report is the only one comparable across them.
