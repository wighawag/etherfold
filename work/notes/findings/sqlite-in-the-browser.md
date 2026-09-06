---
title: 'Browser storage for a versioned entity store: where wasm SQLite beats IndexedDB, and where it does not'
slug: sqlite-in-the-browser
source: 'measured by docs/spikes/sqlite-in-the-browser/ (run/verify-port.ts, run/build-traces.ts, run/verify-store.ts, run/measure-patch-replay.ts, run/sharing-probe.ts, browser/storage.spec.ts) on top of etherfold d635f39, replaying the LAUNCHED stratagems game on Base (contracts/deployments/alpha1, 31,332 logs over 1,042 blocks) captured 2026-08-22 from base-mainnet.g.alchemy.com at chain head 50,318,553; against Chromium 151.0.7922.34, Firefox 153.0 and WebKit 26.5 under Playwright 1.62.1, @sqlite.org/sqlite-wasm 3.53.0-build1, node 24.13.1 on Debian 13, one laptop, 2026-08-22. Raw output in docs/spikes/sqlite-in-the-browser/results/. The subgraph comparison in contortions 1 and 2 is NOT measured: it is read from The Graph docs (thegraph.com/docs/en/subgraphs/developing/creating/ql-schema/ and /querying/graphql-api/) plus their Avoiding Large Arrays post, retrieved 2026-08-22.'
---

> This finding is REQUIRED rather than optional (`WORK-CONTRACT.md`, the findings box): a capability is withheld because of it. Without it, `docs/spikes/` holds numbers nobody greps for when asking "why is wasm SQLite not the browser default?", and the next agent either re-litigates the measurement or quietly reverses the decision it justifies.

## Correction to the task's premise, first, because everything else rests on it

`spike-sqlite-in-the-browser` names Stratagems `0xb99d938a722df8984722ab38732533130b4f3ec4` from block 11,681,933, which is `contracts/deployments/base/`. **That is not the launched game.** It saw 45 logs across 10 blocks and was abandoned.

The launched game is `contracts/deployments/alpha1/`, which is **also Base** (its `.chain` file says `chainId: 8453`, same genesis hash as `base/`), deployed later:

| | `deployments/base` | `deployments/alpha1` |
| --- | --- | --- |
| Stratagems | `0xb99d938a722df8984722ab38732533130b4f3ec4` @ 11,681,933 | `0x5ab6d5bb8012fc60ab3653e025be4a59b4406ff2` @ 13,499,257 |
| Gems | `0xd1b76de5372bc47fc4b7ad918f11937fc17b7b46` | `0xb2d822732347e3dc60258dcf6cf0d4c7a432b678` |
| GemsGenerator | `0xbe2f7c303b53f16f447fd82bf549e65185bf3477` | `0xb0855eaf94bf7f122af4f444141e83b7408cc7a7` |
| logs | 45 | 26,308 |
| reward events (`GlobalRewardUpdated` and friends) | absent from the ABI, an earlier contract version | present, and 16,046 of them fired |

The folder name is the trap: `base/` is not "the Base deployment", it is one of two, and the abandoned one. Both fixtures are captured and kept (`fixtures/stratagems-base.stream.json`, `fixtures/stratagems-alpha1.stream.json`); **everything below uses `alpha1` and calls it the real workload.**

## The real workload, now that it is the real one

31,332 events in 1,042 event-bearing blocks, blocks 12,082,307 to 23,303,136. Through the processor: **38,192 mutations, 4,072 live rows, 29,393 versions.** Ten of thirteen handlers fire (everything except `onReserveWithdrawn` and `onForceSimpleCells`, which the chain never emitted, and the placement window churned enough to write 100 times, so the eviction cascade really ran).

Two shape facts that matter more than the totals:

- **Blocks are small and bursty**: mutations per block are min 0, **median 7**, mean 36.7, p90 118, **max 457**. Per-block fixed costs therefore dominate the real workload far more than a constant-batch benchmark suggests.
- **Event-bearing blocks are FAR APART**: the gap between them is median **429 blocks**, max 1,226,194. That single fact changes the answer to the spec's second open question, below.

## The recommendation, as a condition

**IndexedDB stays the browser default. On the real workload it is not close, and no candidate crossover is reached.**

| engine | IndexedDB rows | wasm SQLite (best VFS available) | whole-blob incumbent |
| --- | --: | --: | --: |
| Chromium | **45.6 ms/block**, 305 us/read | 74.2 ms/block, 1,246 us/read | 2.0 ms/block, 2 us/read |
| Firefox | **10.0 ms/block**, 155 us/read | 30.1 ms/block, 490 us/read | 5.4 ms/block, 5 us/read |
| WebKit | **11.7 ms/block**, 205 us/read | unavailable (`Missing required OPFS APIs`), or `:memory:` with no persistence | 4.5 ms/block, 5 us/read |

IndexedDB wins on writes by 1.6x to 6.9x and on reads by 4x to 14x, on every engine that can run both, at the size the real game actually reached.

**IndexedDB unless Z**, where Z is all four of these at once:

1. the deployment targets **Chromium** specifically (on Firefox and WebKit, IndexedDB's write cost does not degrade with dataset size at all, so there is no crossover to reach);
2. the live set exceeds roughly **5,000 to 13,000 entity rows** and keeps growing (range is real run-to-run variance). **The real game peaked at 4,072**, so this deployment never got there;
3. the app is **single-tab by construction**, or is willing to build leader election, because three of four tabs FAIL OUTRIGHT on both SQLite VFSs;
4. the app can afford **501.9 KB gzipped** of extra payload (392.5 KB `sqlite3.wasm` + 99.2 KB worker glue + 10.2 KB OPFS async proxy, measured on our own esbuild output, against 16.0 KB gzip for the page bundle carrying the ported processor, the generator AND all non-SQLite backends) and a **130 to 190 ms cold start** on every load, and does not need Safari, where the OPFS route is unavailable and SQLite silently becomes an in-memory database that loses everything on reload.

The prior recommendation in `~/dev/github/wighawag/research/browser-embedded-indexer/README.md` is **CONFIRMED, and now for a measured reason rather than an assumed one**. Its premise ("small live set, current-state reads, block-paced writes") is exactly what the real workload turned out to be. What it did not anticipate is that Chromium's IndexedDB write path degrades roughly **10x as the store grows**, while SQLite's stays flat, which puts a real crossover just above where this game landed.

### What would overturn it

- **A tuned IndexedDB backend.** The one measured is a prototype. The obvious suspect, read-before-write, was tested and EXONERATED: caching the whole live set in memory left Chromium's degradation curve unchanged (161 to 2174 us/mutation cached, versus 212 to 2209 uncached). The cost is in Chromium's write path as the stores grow. Remove it, and the condition collapses to "IndexedDB, always".
- **Chromium changing its IndexedDB implementation**, since the degradation is engine-specific and absent on the other two.
- **A live set an order of magnitude past this game's.** 4,072 rows is comfortably inside IndexedDB's good range; 50,000 would not be.
- **Multi-tab getting a real answer on the SQLite side.** Today it is a hard failure at open, not a tuning problem.
- **Query shapes IndexedDB cannot serve.** Everything here is point and as-of reads BY ID. The moment the browser needs filtered, sorted, paginated or joined queries over a large local set, the prior research's 20-to-100x SQLite advantage for that shape becomes the deciding number. Nothing in this workload needs it.

## The three open questions in `one-processor-everywhere`

### 1. Which backend is the recommended browser default?

**IndexedDB, under the condition above.** Beyond the real-workload table, the crossover was located deliberately, with a workload that holds the batch roughly constant (100 to 128 mutations per block) and lets only the dataset grow, so a cost that moves is attributable:

| microseconds per mutation, by live rows | ~0 | ~4,700 | ~6,800 | ~10,900 | ~14,900 | ~19,000 |
| --- | --: | --: | --: | --: | --: | --: |
| Chromium IndexedDB | 180 to 212 | 206 to 633 | 321 to 893 | 866 to 1462 | 1304 to 1710 | 1822 to 2209 |
| Chromium SQLite `opfs-sahpool` | 559 to 593 | 699 to 726 | 792 to 840 | 901 to 943 | 965 to 1000 | 1031 to 1059 |
| Firefox IndexedDB | 217 | 230 | 235 | 247 | 438 | 236 |
| Firefox SQLite `opfs-sahpool` | 363 | 407 | 439 | 465 | 496 | 513 |
| WebKit IndexedDB | 206 | 218 | 222 | 215 | 224 | 215 |

Two runs of the Chromium sweep put the crossing between roughly 5,000 and 13,000 live rows; the ranges above are those two runs. Firefox and WebKit never cross.

Other axes, none of which SQLite wins:

- **cold start**: IndexedDB 1 to 49 ms; SQLite 123 to 390 ms (wasm init plus async open plus DDL).
- **point read at the tip**: IndexedDB 122 to 305 us; SQLite 354 to 2,239 us, including a `postMessage` round-trip no tuning removes, because the OPFS sync VFS is Worker-only.
- **multi-tab, four tabs on one database**, observed rather than quoted:
  - `opfs-sahpool`: `Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.` Three of four tabs never opened.
  - `opfs`: `SQLITE_BUSY: sqlite3 result code 5: database is locked`. Three of four failed mid-run.
  - IndexedDB: four of four completed, zero row mismatches, identical throughput.
- **footprint** (at 20,775 live rows and 62,553 versions): SQLite 7.05 MB unbounded, 3.82 MB pruned to a 64-block window, prune plus `VACUUM` 1.1 s. IndexedDB 62,553 versions unbounded, 43,449 after the same prune, full-scan prune 6.3 s. `navigator.storage.estimate()` is quantised and lags (it reported MORE after a prune that dropped nothing), so record counts are the honest number there.

**The engine cost is the VFS, not SQLite.** The same wasm SQLite on `:memory:` (WebKit, where OPFS is missing) did 39 us per mutation against 559 to 1,059 over `opfs-sahpool` on Chromium. Roughly 15 to 25x of the SQLite route's write cost is the browser storage layer underneath it, which is the layer IndexedDB IS.

### 2. Does the light backend answer as-of reads at all, or only revert?

**On this real stream: REVERT ONLY, in practice.** This is a correction to what a dense synthetic workload appears to show, and the real capture is what exposed it.

The mechanism is CORRECT wherever the patches still exist: on dense streams (consecutive block numbers) backwards replay matched the recorded state at every depth, on all four runtimes.

| runtime, dense workload | state | patch log (64 blocks) | depth 1 | depth 8 | depth 32 | depth 64 | correct |
| --- | --: | --: | --: | --: | --: | --: | --- |
| Chromium | 763 KB | 1702 KB | 3.4 ms | 16.7 ms | 75.2 ms | 126.4 ms | at every depth |
| Firefox | 763 KB | 1702 KB | 6 ms | 15 ms | 64 ms | 103 ms | at every depth |
| WebKit | 763 KB | 1702 KB | 10 ms | 36 ms | 101 ms | 214 ms | at every depth |
| node 24.13.1 | 763 KB | 1702 KB | 4.7 ms | 31.2 ms | 119.1 ms | 222.3 ms | at every depth |

**But on the real stream the patches are not there.** `History` prunes a block's reversals when `tipBlockNumber - blockNumber > finality`, which is a distance in BLOCK NUMBERS, while the stream only carries event-bearing blocks that are median **429 apart**. At a finality of 64, exactly **one** block's reversals survive: the tip's. Measured on the real capture, depth 1 replays correctly and every depth beyond it has had its history pruned before anyone could ask (`results/patch-replay.json` records `patchesAvailable: false` for depths 2 through 64, separately from correctness, so the two failure modes are not confused).

So, precisely:

- **For reorg revert this is correct and sufficient.** A reorg only ever touches blocks within the finality depth OF THE TIP BY NUMBER, which is exactly what the pruning keys on.
- **For as-of reads it is not a window of 64 versions, it is a window of 64 BLOCK NUMBERS**, which on a sparse contract contains one event-block or none. The light backend must therefore advertise **`revert-only`, or a window measured in block numbers**, and the query layer must refuse historical reads against it rather than answering from the tip. Advertising "as-of within the last N updates" would be wrong on any real sparse stream.
- The patch log's SIZE follows the same fact: 1,702 KB (223% of the state) on a dense synthetic stream, and 4.4 KB (1% of the state) on the real one, because almost everything is pruned immediately.
- Where the light path does answer, cost is linear in DEPTH, so 126 ms at depth 64 on a laptop is roughly half a second on the mid-range profile.

**There is a cheaper history available in the immer world, and it is not patches.** immer's produced states share structure, so the previous states can simply be KEPT rather than reconstructed. Measured over the real stream (`run/sharing-probe.ts`, node heap after two forced GCs):

| retained | heap | cost per retained state |
| --- | --: | --: |
| tip only | 40.4 MB | |
| last 256 states | 64.4 MB | ~94 KB |
| all 1,042 states (the entire history of the deployment) | 92.7 MB | ~50 KB |

So an as-of read at any depth inside the retained window becomes an O(1) object lookup instead of a replay, at roughly 6 MB for a 64-state window and 52 MB for the whole chain's history of this game. Two things bound it, and both are actionable: the cost per retained state is the size of the top-level containers TOUCHED, not the size of the diff (writing one key of the 4,072-key `cells` map copies that map's 4,072-slot shell), so a sharded or nested state shape would cut it sharply; and none of it survives a reload, because persisting a shared state costs O(state) per snapshot. The honest capability for such a backend is therefore "as-of within the last K updates, in memory, reset on reload".

### 3. Can the entity model express a processor someone really wrote?

**Yes. The port produces state EQUAL to the original `JSProcessor` on the real launched game**: 31,332 events, 1,042 blocks, 38,192 mutations, 4,072 live rows, ten handlers exercised, byte-identical after canonicalisation. Also equal on the abandoned `base` deployment (42 events) and on generated streams that additionally reach `onForceSimpleCells`.

The oracle is the stratagems `JSProcessor` vendored verbatim, so the expected state was computed by the code that has been running on Base, not by a reimplementation. The same real trace was then applied to the REAL `@etherfold/state-store-sqlite` store on libSQL (1,042 blocks, 38,192 mutations, 3.2 s in node): **all 4,072 live rows matched**, the as-of read at depth matched the in-memory reference, and reverting to block 13,364,821 made the evil owner's `computedPoints` DECREASE from 12 to 6, which is the canonical reorg bug this design exists to prevent.

**The contortions the model forced, in full:**

1. **SEVERE, the ordered bounded array.** `state.placements` is an array with `unshift` and `pop` past seven entries, and dropping an entry drops everything nested under it. `MutationContext` is get/set/delete BY ID with **no listing**, so a handler cannot ask "which rows belong to epoch N". It took THREE entities plus a hand-maintained index: `placement` carrying a CSV of its positions purely so the cascade delete has something to walk, `placementCell` carrying a `playerCount`, and a singleton `placementWindow` holding the epoch order (ARRIVAL order, so it cannot be recovered by sorting on `epoch`). One `pop()` became an O(cells x players) loop of manual deletes against a foreign key the store cannot answer in the direction needed. This ran 100 times on the real stream, so it is not a hypothetical path.

   **The closest prior art says the array was the wrong shape, not that the model is short a feature, and that reframes this.** In The Graph's schema language a one-to-many is `@derivedFrom`, which "creates a virtual field on the entity that may be queried but cannot be set manually through the mappings API" and is "never actually created during indexing": children are their own entities keyed by their parent, and the collection is derived when READ. The Graph publishes a best practice post, *Avoiding Large Arrays*, whose advice is precisely to stop storing the array and derive it instead. So an idiomatic model of `placements` is children keyed by epoch, with no stored array, no CSV and no cascade to hand-roll. What our model is actually missing is not aggregation, it is **the READ SIDE that makes the idiomatic fix expressible from a handler**: a bounded listing by a prefix of the declared id (`{epoch}` under `{epoch, position, playerIndex}`), which is one indexed range scan on every backend measured here (a PK prefix scan in SQLite, an `IDBKeyRange.bound([epoch], [epoch, []])` cursor in IndexedDB, a sorted walk in memory) and costs nothing at write time.
2. **SEVERE in kind, small in size: no aggregation means counts are hand-maintained.** `players.push(...)` became read-count, write-at-count, write-count-plus-one. The count is exactly the aggregation the spec parks, and without it an append has no index to write at and a reader cannot tell where the list ends.

   Two things worth recording next to it. The subgraph has **no declarative count either** for this case (its `@aggregation` feature is interval rollups over timeseries, a different mechanism), so authors there hand-maintain counters exactly as this port did: the contortion is shared with the prior art rather than peculiar to this model. And the count is **self-inflicted by the id choice**: it exists only because the child's id ends in a DENSE ARRAY INDEX. Key the child by something naturally unique and ordered instead, such as `(blockNumber, logIndex)` or an event ordinal, and the append needs no count, the ordering is the key, and the aggregation question does not arise. That is a modelling rule, not a feature, and it is the cheapest of the available fixes.

   Materialising counts in the store is the option to avoid, and this spike's own numbers say why: in a versioned store every child write would open a NEW VERSION of the parent, which on the real stream means 8,485 extra `placement` versions, and version count is precisely the quantity that drove both footprint and per-write cost in the measurements above.
3. **MODERATE: uniformly async handlers colour the whole processor.** Every state read in `StratagemsContract` became an `await`; because `updateNeighbours` awaits four reads and is awaited from three call sites, `async` spread to every method including the pure-arithmetic ones. The algorithm is unchanged line for line; the noise is not.
4. **MODERATE: a scalar map needs a whole entity, and folding it in is a trap.** `state.owners[position]` became a one-field `cellOwner`. Folding `owner` into `cell` looks obvious and is WRONG: the processor writes an owner where it does not write a cell, and `set` writes a WHOLE ROW, so the fold would silently clear the nine cell fields. Correct semantics, paid for with an extra entity and a second read on every `ownerOf`.
5. **MODERATE: `uint256` has no column type.** `text` / `integer` / `real` / `blob`, and SQLite's INTEGER is 64-bit, so every u256 is decimal TEXT read back through `BigInt()`. Equality then depends on the encoding being canonical, a rule nothing in the model states or enforces. This is not academic here: 16,046 reward events on the real stream write nothing but u256 fields.
6. **MINOR: a singleton needs an invented id** (`points.global` became `globalRate` keyed `id='singleton'`), which is what the subgraph model does too.
7. **NOT a contortion, recorded as a positive:** the derived accumulator (`computedPoints`, read-then-add-then-write) needs no aggregation support and composes correctly across events in a block purely from read-your-writes. On the real stream, 16,871 of 66,113 reads were served from the block's own staging area, so that path is load-bearing rather than theoretical. That is spec user story 5, and it works.

**A defect in production code, surfaced by the port.** An entity column named `index` passes `@etherfold/state-store-sqlite`'s identifier validation (matches the regex, no `_` prefix) and then fails at `migrate()` with `near "index": syntax error`, because identifiers are interpolated into DDL unquoted and `INDEX` is a SQL keyword. The in-memory and IndexedDB backends accept the same declaration. One declaration, valid on one backend and fatal on another, failing at migration rather than at declaration. Not fixed here (this spike changes no production code beyond capture/replay); the port renamed to `playerIndex`. Captured with a fix shape in `work/notes/observations/entity-identifier-sql-keyword.md`.

**Also absent and load-bearing:** the spec says a retention window is enforced by pruning, and `@etherfold/state-store-sqlite` has no pruning at all, so every backend it ships today is effectively `unbounded`. The footprint numbers above used pruning written inside the spike.

## The incumbent, on the same fixture

Today's whole-state blob (`keepStateOnIndexedDB`, handing the entire state object to `idb-keyval` on every save) is **the fastest writer at the real workload's size**: 2.0 ms/block on Chromium against IndexedDB's 45.6 and SQLite's 74.2. That is the uncomfortable part of this result and it should be said plainly before anyone promises a speed-up.

What it does not do: it cannot answer an as-of read (it refuses), it cannot revert, and its per-block cost is **O(total state), not O(what changed)**, so it degrades on a straight line as state grows: 11 us per mutation against an empty store, 26 at 2,700 live rows, 119 at 19,000. Its cold start is a full read and revive of the blob (Chromium 70 ms at 44k rows; Firefox 167 to 190 ms at 21k rows), and every number here is a LOWER BOUND, because the real keeper also stores `lastSync` and the immer patch history alongside the state.

So the honest framing for the spec's "Further Notes": row-level writes are **not** a throughput win at today's sizes, and at 4,072 live rows they are a 20x throughput LOSS. What they buy is history, revert, bounded cold start, and a write cost that stops tracking total state. Sold as a speed-up, the first benchmark contradicts it.

## The mid-range device profile

Chromium with 4x CPU throttling, at ~7,400 live rows. It models single-core speed, not slower flash or less memory, so it is a floor on the gap rather than a phone:

| backend | ms/block laptop | ms/block throttled | us/read laptop | us/read throttled |
| --- | --: | --: | --: | --: |
| IndexedDB rows | 90.7 | 113.1 | 239 | 666 |
| whole blob | 3.9 | 15.5 | 1 | 6 |
| SQLite `opfs-sahpool` | 99.6 | 107.3 | 437 | 421 |

The storage-bound candidates barely move (they were waiting on the disk); the blob quadruples (structured-cloning a large object IS CPU work); reads triple on IndexedDB. Nothing changes the ranking.

## What is real and what is generated

The real capture drives the port equality, the shape facts, the sparsity result and the head-to-head at the real size. The **crossover sweep is generated**: real event shapes, real handlers, real mutations out of the real processor, invented play, because locating a crossover needs dataset sizes this deployment never reached. The distinction is kept in `docs/spikes/sqlite-in-the-browser/README.md`. Orders of magnitude are sound; the exact ratio of cell writes to placement writes in the generated workloads inherits an assumption about how people play.

## The artifacts, and their provenance

Kept deliberately; a later task promotes them into the conformance workload.

> **Promoted 2026-08-23** by `promote-stratagems-conformance-workload`. `fixtures/` and `vendor/stratagems/` now live in **`packages/conformance-workload-stratagems/`** (paths in the table below are relative to that package); `src/port/` STAYS in the spike, because it is the exhibit the contortion list above describes, and the promoted port is a REWRITE onto the bounded id-prefix listing: three entities instead of six, no CSV index, no hand-maintained count, 29,492 mutations instead of 38,192, and the same byte-identical golden state. Contortions 1 and 2 are therefore gone; 4 (a scalar map needs its own entity) and 5 (u256 has no column type) remain, documented in that package rather than hidden.

| artifact | what it is |
| --- | --- |
| `fixtures/stratagems-alpha1.stream.json.gz` | the golden INPUT: every log from Stratagems `0x5ab6d5bb8012fc60ab3653e025be4a59b4406ff2` (from 13,499,257), Gems `0xb2d822732347e3dc60258dcf6cf0d4c7a432b678` (12,082,307) and GemsGenerator `0xb0855eaf94bf7f122af4f444141e83b7408cc7a7` (12,082,311) on Base (chain 8453), blocks 12,082,307 to 23,400,000, captured 2026-08-22 at chain head 50,318,553. Stored gzipped: 0.6 MB against 20.5 MB of JSON, and git stores both at about 0.6 MB, so the compressed form costs nothing in the repository and saves 20 MB in every working tree. `data` and `topics` are omitted (recorded in the fixture's own provenance as `omittedFields`): they are the encoded form of the decoded `args`, and the provenance says exactly what to re-fetch if they are ever wanted. A re-capture is byte-identical apart from `capturedAt` and `chainHeadAtCapture`, verified 2026-08-22. **The FILE moved on 2026-09-06 and this row describes the bytes these measurements ran against, not the bytes committed now**: it was re-captured with `--full`, so it carries `data` and `topics` and has no `omittedFields`, and it is 33.8 MB against 1.05 MB gzipped. The omission made it unusable as a stream SEED (an event with no raw log cannot be re-decoded, so the load path clears the stream: ADR-0034, ADR-0063). Nothing measured here is invalidated, since these numbers are about folding decoded events into a store; a re-run would read a larger file |
| `fixtures/stratagems-alpha1.state.json` | the golden OUTPUT, computed by the ORIGINAL `JSProcessor` (stratagems `3d5a0b3f`, 2024-12-18). Committed, because it is the oracle: a diff on it means the processor changed meaning |
| `fixtures/*.trace.json` | the per-block mutations the spike's port emitted. NOT committed: the spike's `run/verify-port.ts` regenerates them identically in about three seconds |
| `fixtures/stratagems-base.*` | the same for the abandoned early deployment, kept as the small, fast smoke case, and plain JSON because it is small enough to read |
| `src/port/` (still in the spike), `vendor/stratagems/` | the port, and the oracle copied verbatim |

**Licence note, settled:** the vendored stratagems source is GPL-3.0 and this repository is MIT. Both are the same author's work and using it here as an example and test fixture is fine; the note exists so the difference is visible to a reader who meets the code without this context, and it is repeated in `packages/conformance-workload-stratagems/vendor/stratagems/README.md`. It is also why that package is `private` and never published (ADR-0026): the promoted port is a derived work of GPL-3.0 code, so shipping it to npm under this repository's MIT licence would misstate what it is.

Verified on all three engines: the captured fixture is fetched over HTTP, parsed by `@etherfold/core`'s own `parseStreamFixture`, replayed through the port, and lands on the byte-identical golden state node computed, with zero mismatches after a further pass through the IndexedDB backend. One input, two runtimes, one output.
