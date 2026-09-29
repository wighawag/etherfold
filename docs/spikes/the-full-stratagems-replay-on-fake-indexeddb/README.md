# The full stratagems replay on fake-indexeddb

**Why does `test:all-backends` fail on `indexeddb`, and is the fix a longer timeout or a faster replay?**

`pnpm --filter @etherfold/conformance-workload-stratagems test:all-backends` replays the launched stratagems game (31,332 logs over 1,042 event-bearing blocks) into every backend and then reverts 521 blocks. On `indexeddb`, which runs on `fake-indexeddb` under Node, the replay hit its 600,000 ms hook timeout every time; a full-length run with the timeout raised to 5,400,000 ms took **2,599 s** on another machine and passed both cases. This spike measures a bounded PREFIX instead of the whole thing (a full replay is about 43 minutes there) and extrapolates.

## Method

`measure.ts` (run with the workload package's `tsx`, from the repository root, one run at a time under `timeout 900`):

- `replay --blocks N`: the workload's own loop (the same pieces as `replayIntoStore`: one `runBlockHandlers`, then one `applyBlock` per block) on the exact `indexeddb` factory the test uses (`test/utils/backends.ts`), timing the handlers (the processor's reads through the store) and the `applyBlock` (the write) per block. It then reverts to the middle of the prefix and times that, because the test's second case is a revert of half the stream. `--profile` records a V8 CPU profile and splits self time by module.
- `writes --blocks N --pack K`: the prefix's mutations are computed on `MemoryStateStore` first (untimed) and then written into a fresh `indexeddb` store with no reads, one `applyBlock` per block (`K = 1`), or K blocks per IndexedDB transaction through a spike-only copy of `applyBlock`'s body looped over several blocks (`packedApply`). That is what an `applyBlocks` verb on this backend (packing, the way `@etherfold/state-store-sqlite`'s does) could buy at most. The packed store is checked against the memory store key by key afterwards.
- `model --from <replay result>`: fits the cost model below on the per-block samples, replays the whole stream on `MemoryStateStore` (seconds) to get every block's predictors, and extrapolates the full replay and the test's revert.

Machine: AMD Ryzen 9 9955HX (32 threads, one used), Node v24.19.0, Linux 6.18, `fake-indexeddb` 6.2.5. Raw results are in `results/`.

## Where the time goes

A 300-block prefix plus its revert, profiled (`results/replay-300-profiled.json`): of 60.2 s of self time, **59.3 s (98.6%) is in `fake-indexeddb`**, 23 ms in `@etherfold/state-store-indexeddb`, 31 ms in the processor and the seam. The hottest functions are all the shim's key comparison: `valueToKeyWithoutThrowing` (42.4 s), `binarySearchTree._findRecords` (6.8 s), `cmp`, `FDBKeyRange.includes`, `RecordStore.deleteByValue`.

The cause is in `fake-indexeddb`'s `ObjectStore.storeRecord`: when a `put` OVERWRITES an existing record in an object store that has indexes, it calls `RecordStore.deleteByValue` on every index, and that walks **every record of the index** comparing keys. `deleteRecord` does the same. The `versions` store has two indexes (`lower` and `upper`), and closing a version is exactly such an overwrite: `applyBlock` re-`put`s the previously live version with its `upper` set. So each block costs roughly its closes times the versions stored so far, and the whole replay is quadratic in the version count. A real engine keeps indexes in B-trees and pays a log factor; this is the shim, not the backend.

The reads are negligible: 1.1 s of the 400-block prefix's 62 s.

## The per-block curve

`replay --blocks 400` (`results/replay-400.json`), 50-block windows:

| blocks | mutations | versions stored after | write ms/block | write ms/mutation | read ms/block |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0-49 | 609 | 591 | 2.1 | 0.17 | 0.7 |
| 50-99 | 675 | 1,245 | 14.7 | 1.09 | 1.2 |
| 100-149 | 842 | 1,906 | 42.9 | 2.55 | 2.1 |
| 150-199 | 971 | 2,756 | 87.7 | 4.52 | 3.2 |
| 200-249 | 1,003 | 3,663 | 122.8 | 6.12 | 2.9 |
| 250-299 | 1,234 | 4,758 | 221.8 | 8.99 | 4.0 |
| 300-349 | 1,162 | 5,685 | 282.2 | 12.14 | 3.8 |
| 350-399 | 1,486 | 6,975 | 443.4 | 14.92 | 4.5 |

Total: 60.9 s writing and 1.1 s reading for 400 of 1,042 blocks, then **77.3 s** to revert the top 200 of them (4,219 versions deleted, 899 reopened, out of 6,975). The cost per mutation grows linearly with the versions stored, which is the scan.

## Batching

The same 400-block prefix, writes only (`results/writes-400-pack-*.json`):

| | write seconds |
| --- | ---: |
| one `applyBlock` per block | 59.4 |
| 50 blocks per transaction | 57.5 |

**3% faster, same curve.** Fewer transactions remove per-transaction overhead that was never the cost; every overwrite still scans both indexes. Packing cannot reach the "cuts the prefix's time by at least half" bar, so there is no case for an `applyBlocks` verb on `@etherfold/state-store-indexeddb` from this workload, and the replay itself has nothing else to shed (98.6% of its time is inside the shim's scan).

## Extrapolation

Model, per block: `writeMs = a * mutations + b * closes * versionsBefore`, where `closes` counts mutations of a key that already has a live version (the overwrite that scans) and `versionsBefore` is the versions stored when the block starts (a forward replay only adds them). Least squares over the 400 per-block samples (`results/model-from-replay-400.json`): `b = 3.2 µs` per close per stored version, `a` indistinguishable from zero. It reproduces the prefix it was fitted on (60.0 s modelled against 60.9 s measured). Fitted per window instead, `b` creeps from 2.8 to 3.3 µs as the stores outgrow the caches, so the full-stream figure below leans low by perhaps 10 to 20%.

The revert is the same scan: every deleted and every reopened version is a write to the indexed store. Calibrated on the prefix's own revert it comes out at **3.1 µs** per operation per stored version, the same constant as the forward writes, which is the evidence that the model has the right term.

Predictors for the whole stream come from replaying it on the memory store: 29,492 mutations, 20,713 closes, 24,759 versions at the tip; the test's revert to block 13,364,821 deletes 14,178 versions and reopens 2,159.

| on this machine | extrapolated |
| --- | ---: |
| full replay (`beforeAll`) | **~890 s** (about 15 minutes; ~1,050 s allowing for `b`'s creep) |
| the revert case | **~900 s** |

So the revert case alone exceeds its own 600,000 ms bound even on this machine, which the hook failure had been hiding: the replay never got that far. The other machine's measured 2,599 s replay is 2.9 times this extrapolation, which is the spread between a desktop Zen 5 and a laptop; a GitHub-hosted runner is not faster than either.

## Decision: raise the timeouts

The cost is the shim's and batching does not change its shape, so the timeouts go up rather than the replay changing. Both IndexedDB bounds in `test/alpha1.test.ts` (the `beforeAll` replay and the revert case) are **5,400,000 ms (90 minutes)**: twice the SLOWEST measured full replay (2 × 2,599 s = 5,198 s), rounded up. Twice this machine's extrapolation (about 1,800 s) would already fail on the machine that measured 2,599 s, so the anchor is the slowest real measurement rather than the fastest machine's model. The other three backends keep 600,000 ms; they replay in seconds.

The scheduled run is `.github/workflows/stratagems-all-backends.yml`, with `timeout-minutes: 200` (the two 90-minute bounds plus about 20 minutes for install, build and the other backends, so a named vitest timeout fails before the runner kills the job). Its run prints `stratagems replay on <backend>: N s` and the revert's time, which is the full-length figure on a CI runner that this spike could only extrapolate; if it comes in far under the bounds, they can be tightened from it.

## Reproduce

```sh
T=packages/conformance-workload-stratagems/node_modules/.bin/tsx
S=docs/spikes/the-full-stratagems-replay-on-fake-indexeddb/measure.ts
timeout 900 $T $S replay --blocks 400 --out /tmp/replay-400.json
timeout 900 $T $S writes --blocks 400 --pack 1
timeout 900 $T $S writes --blocks 400 --pack 50
timeout 900 $T $S replay --blocks 300 --profile
timeout 900 $T $S model --from /tmp/replay-400.json
```

The workspace has to be built first (`pnpm build`): the script imports `@etherfold/state-store-indexeddb`'s `dist/` internals for the packed copy.
