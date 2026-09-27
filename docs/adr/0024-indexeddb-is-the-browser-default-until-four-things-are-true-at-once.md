# IndexedDB is the browser default, until four things are true at once

The browser backend behind the storage seam is **`@etherfold/state-store-indexeddb`**: versioned rows in IndexedDB, selected by `createBrowserStateStore(processor.entities)` in `@etherfold/browser` and swapped for any other `StateStore` by passing a factory. wasm SQLite is not shipped for the browser, and this ADR exists so that decision is read as a **condition** rather than as a preference: it was settled by measurement on the real workload (`work/notes/findings/sqlite-in-the-browser.md`, raw output in `docs/spikes/sqlite-in-the-browser/results/`), and the measurement says what would have to change for the answer to change.

State it as a preference and the first person to read a wasm-SQLite benchmark reverses it. State it as a condition and they can check.

## What was measured

The launched stratagems game on Base: 31,332 events over 1,042 event-bearing blocks, 38,192 mutations, 4,072 live rows, 29,393 versions. Three engines under Playwright, one laptop, 2026-08-22.

| engine | IndexedDB rows | wasm SQLite (best VFS available) | the incumbent whole-state blob |
| --- | --: | --: | --: |
| Chromium | **45.6 ms/block**, 305 us/read | 74.2 ms/block, 1,246 us/read | 2.0 ms/block, 2 us/read |
| Firefox | **10.0 ms/block**, 155 us/read | 30.1 ms/block, 490 us/read | 5.4 ms/block, 5 us/read |
| WebKit | **11.7 ms/block**, 205 us/read | unavailable (`Missing required OPFS APIs`), or `:memory:` with no persistence | 4.5 ms/block, 5 us/read |

IndexedDB wins on writes by 1.6x to 6.9x and on reads by 4x to 14x, on every engine that can run both, at the size this deployment actually reached. Cold start is 1 to 49 ms against SQLite's 123 to 390 ms; the SQLite route costs 501.9 KB gzipped of extra payload; and **three of four tabs FAIL AT OPEN on both SQLite VFSs** (`createSyncAccessHandle` on `opfs-sahpool`, `SQLITE_BUSY` on `opfs`) where IndexedDB ran four of four with zero mismatches.

## The condition: wasm SQLite wins when all FOUR of these hold

1. **The deployment targets Chromium specifically.** Chromium's IndexedDB write path degrades roughly 10x as the store grows; Firefox and WebKit do not degrade at all, so on them there is no crossover to reach.
2. **The live set is past roughly 5,000 to 13,000 rows and still growing.** That range is where two runs of the crossover sweep put the crossing. This game peaked at **4,072**.
3. **The app is single-tab by construction, or willing to build leader election.** See the three-of-four failure above. A user with the app open twice is not an exotic deployment. *Amended by [ADR-0097](0097-one-tab-indexes-by-a-web-lock-the-app-names-and-the-others-are-built-as-readers.md): leader election now EXISTS (one Web Lock per app, the other tabs built as readers), so the election half of this criterion is met by any app that opts in. What it does not change is that every tab still OPENS the store to read it, which is the open that failed three of four times on both SQLite VFSs.*
4. **The app can afford 501.9 KB gzipped and a 130 to 190 ms cold start on every load, and does not need Safari**, where OPFS is unavailable and SQLite silently becomes an in-memory database that loses everything on reload.

Fewer than four means IndexedDB. If all four ever hold, the browser adapter that would be needed is `remote-sql`'s work in another repository (that package ships libSQL, D1 and Durable Objects adapters and nothing for browsers), not this one's.

## What would overturn it

1. **A tuned IndexedDB backend.** The measured one was a prototype. The obvious suspect, read-before-write, was tested and EXONERATED (caching the whole live set left Chromium's curve unchanged: 161 to 2,174 us/mutation cached against 212 to 2,209 uncached), so the cost is in Chromium's write path. Remove the degradation and the condition collapses to "IndexedDB, always".
2. **Chromium changing its IndexedDB implementation**, since the degradation is engine-specific.
3. **A live set an order of magnitude past this game's.** 4,072 rows is comfortably inside IndexedDB's good range; 50,000 would not be.
4. **Multi-tab getting a real answer on the SQLite side.** Today it is a hard failure at open, not a tuning problem.
5. **Query shapes IndexedDB cannot serve.** Everything in this workload is point and as-of reads BY ID. The moment a browser needs filtered, sorted, paginated or joined queries over a large local set, the prior research's 20-to-100x SQLite advantage for that shape becomes the deciding number.

## What this is NOT

**It is not a speed-up.** The incumbent whole-state blob (`keepStateOnIndexedDB`, which hands the entire state object to `idb-keyval` on every save) is the FASTEST writer at today's sizes: 2.0 ms/block on Chromium against 45.6 for row-level writes. At 4,072 live rows this is a 20x throughput LOSS, and anyone who sells it otherwise is contradicted by the first benchmark someone runs.

What row-level writes buy is what the blob cannot do at any speed: **history** (an as-of read, which the blob refuses), **reorg revert** (the blob has none), a **cold start that reads one row instead of all of them** (the blob's is a full read and revive: 70 ms at 44k rows on Chromium), and a **write cost proportional to what CHANGED** rather than to total state (the blob's per-mutation cost climbs on a straight line with size: 11 us empty, 26 at 2,700 live rows, 119 at 19,000). Sold as correctness with a cost that stops growing, it is exactly what the seam is for.

## Consequences

- **The shipped store is not byte-for-byte the measured prototype**, and the differences are deliberate: closed versions carry an `upper` index (so a prune is a range scan rather than the prototype's full scan, which took 6.3 s at 62,553 versions) and versions carry a `lower` index (so a revert is two range scans and needs no per-block undo journal). Two indexes cost write time that the 45.6 ms/block figure did not pay, and **that has not been re-measured**: the numbers above are the prototype's, the ranking they establish is between STORAGE ENGINES, and a re-measurement belongs with the tuning work in overturning criterion 1.
- **The entity name is part of the KEY, not the name of an object store.** Creating an object store in IndexedDB needs a version change, and an upgrade transaction can be BLOCKED by another open tab, so a store per entity would turn "the processor declares one more entity" into a migration a second tab can stall. The schema is fixed at version 1, and every access path a per-entity store would have given is still a key range.
- **The seam's bounded listing is `IDBKeyRange.bound([entity, ...prefix], [entity, ...prefix, []])`.** `[]` sorts after every string in IndexedDB's key order, so that bound is exactly "the prefix and its descendants". This is the reason the handler seam's only set read is a prefix plus a required limit (ADR-0021): it has to be one indexed range scan on a substrate with no query planner.
- **The browser test run is not in the acceptance gate.** `pnpm test` runs the shared conformance suite against this backend under `fake-indexeddb`; `pnpm --filter @etherfold/state-store-indexeddb test:browser` runs the SAME suite plus the four-tab case in Chromium, Firefox and WebKit, and needs three browser binaries a clean CI checkout does not have. The evidence from a run is kept in `docs/spikes/indexeddb-row-backend-browser-default/results/`.
- **A deployment that wants none of this still has a light path.** `@etherfold/state-store-patch` is memory-only and `revert-only` (ADR-0023), and `createBrowserStateStore({backend: ...})` selects it without touching a processor.
