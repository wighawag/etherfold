# Design: historical-state database

Status: **design complete, not built**. This closes the open questions of `work/specs/tasked/historical-state-database.md`. The architectural decisions it depends on are ADR-0003 through ADR-0011; this document is the storage-level detail underneath them.

Most of what follows was established by running code, not by reasoning alone: a verified prototype with benchmarks lives at `~/dev/github/wighawag/research/ethereum-indexer-historical-state-db` (versioned-row store, reorg proof, codegen and scale benchmarks on real libSQL). Where a claim is measured, the number is given.

---

## 1. What this component is

Per ADR-0003, the server-side indexer is three parts: a stateless **log-fetcher**, a **stream-builder** that owns reorg detection and the stored stream, and the existing **`EventProcessor`**. The stream-builder and processor are hosted together as the **indexer-server**, and this document describes the two stores that server owns:

- **the emission stream**, keyed by `{source, config}` (ADR-0006)
- **the versioned state**, keyed by `{source, config, processor}`

That the state key includes the processor version and the stream key does not is what makes a processor-logic upgrade a local rebuild rather than a re-fetch (ADR-0008). The split already exists in the code as `ContextIdentifier`.

---

## 2. State storage: versioned rows

**Decision: versioned rows with a half-open validity range**, the model `graph-node` uses for subgraph time-travel. Every entity version is a row carrying `_lower` (valid from, inclusive) and `_upper` (valid until, exclusive; `NULL` means still valid at the tip). Never store only the current value.

The author declares only `{name, id, fields}` per entity; the generic layer owns the range columns, the as-of rewrite and the reorg revert. That is the subgraph ergonomic property: history falls out of a schema, rather than being something each processor implements.

Per entity table:

```sql
CREATE TABLE token (
  _rowid INTEGER PRIMARY KEY AUTOINCREMENT,   -- identity of ONE version
  id     TEXT NOT NULL,                       -- business key
  ...fields...,
  _lower INTEGER NOT NULL,
  _upper INTEGER                              -- NULL = open
);
CREATE UNIQUE INDEX token_open    ON token (id) WHERE _upper IS NULL;  -- one live version per key
CREATE INDEX        token_history ON token (id, _lower);               -- time-travel probes
CREATE INDEX        token_lower   ON token (_lower);                   -- reorg revert
CREATE INDEX        token_upper   ON token (_upper);                   -- reorg revert
```

Writing an entity at block `N` is **close-then-insert**: `UPDATE ... SET _upper = N WHERE id = ? AND _upper IS NULL`, then `INSERT ... (_lower = N)`. A delete is just the close.

Reading as of block `N` is one predicate: `_lower <= N AND (_upper IS NULL OR N < _upper)`. Current state is the special case `_upper IS NULL`.

**Rejected alternatives**, briefly, because they will be proposed again:

- *Current-state-only table*: fails the requirement outright, history is gone.
- *Event sourcing, fold on read*: turns the consumer's hot path (state at one specific past block, for one entity) from an index probe into a replay of unbounded length.
- *Event log plus periodic snapshots*: works, but adds snapshot-cadence tuning and a second revert path for no gain here.

The raw stream is still kept (§4), but as the re-derivation source, not as the queryable state.

**`_upper IS NULL` rather than a sentinel value**, decided on evidence: performance is a wash (0.070 ms vs 0.063 ms on point as-of reads, both riding the same index), so it comes down to correctness, and `INT64_MAX` actually **breaks** on libSQL, which throws `"Received integer which cannot be safely represented"`. A smaller magic constant would work but leaks into every query and every consumer, and is a real value pretending to mean "none".

---

## 3. Query axes: hash, height, time

**All three are in scope, and all resolve internally to a block number** via one canonical block table:

```sql
CREATE TABLE _blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE,
                      timestamp INTEGER NOT NULL);
CREATE INDEX _blocks_timestamp ON _blocks (timestamp);
```

**No `parentHash`** (removed when the store was built). It is not on a log, so it would cost the extra block round-trip this section is about avoiding, and it would describe a linkage a sparse table does not have: rows exist only for blocks carrying our logs, so consecutive rows are almost never parent and child. The `verifyBlocks` cross-check it would serve is deferred in §9 anyway, and if it is ever built it needs the field on the log stream rather than reconstructed here.

- **Hash is the truth, and the identifier consumers should store.** If a consumer pins a block *number* and a reorg happens, "state at 18,000,123" silently changes meaning. If it pins the *hash*, the lookup correctly returns "no such block", which is itself the signal that whatever it recorded is now invalid. That asymmetry is the whole argument.
- **Number** is what the range columns are keyed on, ergonomic, and unambiguous once finalized.
- **Timestamp** resolves to the latest block with `timestamp <= T`.

`_blocks` only needs rows for **blocks that carry our logs**, not every chain block. State only changes at blocks where our events occur, so "state as of time T" is exactly "state as of the latest indexed block with `timestamp <= T`", and a consumer only ever pins a hash it saw on a log we delivered. This avoids storing tens of millions of header rows against D1's size ceiling.

Timestamps come free **on most clients**: `blockTimestamp` is returned directly on logs, standardised in `execution-apis#639` (merged 2025-08-25). Normalise on ingestion, since at least one client returns it decimal rather than hex.

It is not universal, so ingestion is opportunistic rather than assuming: take the timestamp off the log, and fall back to `eth_getBlockByHash` only for the blocks whose logs carried none. Verified by running each client, since the answer changes with releases:

| client | `blockTimestamp` on logs | since |
|---|---|---|
| reth | yes | PR #7606, Apr 2024 |
| go-ethereum | yes | PR #31887, milestone 1.15.12, shipped 1.16.0 |
| besu | yes | issue #9276, docs updated Nov 2025 |
| erigon | yes | issue #4951 closed |
| anvil (foundry) | yes | **verified empirically on 1.5.1** |
| ethereumjs | yes | PR #4074 |
| **Hardhat / EDR** | **no** | **verified empirically on hardhat 3.14.0 / edr 0.3.8** |

On the client side, `viem` added `blockTimestamp` to its `Log` type in 2.x (PR #4157); `ethers.js` has not (issue #5011, open). `eip-1193`'s `EIP1193Log` does not carry it either, so the ingestion seam widens the type locally rather than waiting on a release.

---

## 4. Stream storage

Per ADR-0006 the stream is stored in **emission form**: append-only, one row per emitted log with its own `seq`, retractions included, with superseded originals flagged dead. Two views are served over it: the `seq`-ordered full stream, and the canonical view (`WHERE alive AND blockNumber <= gate`, ordered by `(blockNumber, logIndex)`).

Two schema requirements land here, and both are cheap now and expensive later:

- **`address` and `topic0..topic3` are columns, not a JSON blob**, with a composite index on `(address, topic0, blockNumber)`; `topic1..3` stay unindexed and are filtered after the range scan. This is what makes `work/specs/proposed/node-log-api.md` (an `eth_getLogs` API over the indexed subset) possible without a migration over the whole log table.
- **Raw `data` and `topics` must be retained.** That was mutually exclusive with the idea of trimming log fields via stream config, and the conflict is settled: the `logValues` knob is DELETED (`work/specs/tasked/the-stream-stores-only-what-the-node-said.md`), so retention of the raw log is structural and no configuration can trim it.

Retention: pair-compaction (dropping a dead original together with its retraction, once far below finality) is a **config, off by default**, because a from-genesis stream is what makes processor upgrades possible.

---

## 5. Reorg at the DB layer

`revertTo(keepUpTo)` is two pure-SQL moves per entity table, then the block table:

```sql
DELETE FROM token              WHERE _lower > :keepUpTo;   -- A) drop versions born on the dead branch
UPDATE token SET _upper = NULL WHERE _upper > :keepUpTo;   -- B) re-open versions the dead branch closed
DELETE FROM _blocks            WHERE number > :keepUpTo;
```

**A must run before B, and this is not interchangeable.** SQLite enforces the partial unique index per statement, with no deferred enforcement. Re-opening first makes the reopened row and the still-present dead-branch row both `_upper IS NULL` for the same `id`, which raises `SQLITE_CONSTRAINT_UNIQUE`. The prototype verifies both the failure and the fix; this is exactly the kind of thing that only appears when the code is actually run.

After `revertTo`, the store is the state as of `keepUpTo`, history below the fork is untouched and remains fully time-travellable, and the canonical branch replays normally.

This must reproduce the revert-and-reapply contract already pinned by `packages/processor-sqlite/test/reorg.test.ts` and `packages/core/test/utils.test.ts`. Note that contract gained a case on 2026-08-21 (`d24872f`): a reorg that **removes** a block's logs without replacing them must still retract them. A `revertTo` that only handles hash-replacement would reproduce the old bug at the DB layer.

Reverts are only ever needed inside the unfinalized window, so below finality history is effectively immutable, which is also the natural pruning boundary if it is ever wanted.

---

## 6. Serverless and D1 constraints

- **One block is one `batch([...])`.** `remote-sql` exposes transactions only as `batch` (D1/libSQL semantics), so applying a block (the block row plus every entity mutation plus the stream rows) is exactly one batch: one atomic unit and one round-trip.
- **Round-trips dominate, not SQLite work.** On D1/Turso the cost is latency, not CPU. Backfill should pack **many blocks per batch** (still atomic), chunked to stay inside per-request statement and size limits.
- **Write amplification** is two statements per changed entity per block (close plus insert).
- A long rebuild cannot be a loop in a worker: it is chunked against a durable checkpoint and re-invoked (ADR-0008).
- **A shared database is fine.** Consumers' time-travel reads are plain indexed `SELECT`s and do not contend harmfully with the single writer. A read replica is a later optimisation, not a requirement.

---

## 7. Measured behaviour

On real libSQL, local file DB (indicative absolute numbers, but the **shapes** are the point):

| entities | total versions | DB size | `getAsOf` point | `getCurrent` point | full scan @block |
|---:|---:|---:|---:|---:|---:|
| 10,000 | 50,000 | 3.1 MB | 0.073 ms | 0.055 ms | 1.8 ms |
| 50,000 | 1,000,000 | 65 MB | 0.064 ms | 0.055 ms | 35 ms |
| 100,000 | 2,000,000 | 131 MB | 0.069 ms | 0.061 ms | 72 ms |

The load-bearing result: **the consumer's hot path, a point `getAsOf`, is effectively constant from 50k to 2M versions**, because it rides the `(id, _lower)` B-tree whose height grows logarithmically. Time-travel point reads do not degrade as history accumulates.

What does grow is the *whole-state-at-a-block* scan, linearly in the **live set size** rather than in history depth (~0.7 µs per live entity). If that ever becomes a hot pattern, the mitigations in order are: restrict rather than scan (covering index on the filter column plus `_lower`), a separate hot current table, or materialised snapshots at finality checkpoints.

Storage is linear in total versions at roughly **65 bytes per version including all four indexes**. The driver to model is per-entity **churn**, not entity count: one entity changing every block for a year on L1 is ~170 MB by itself.

---

## 8. SQLite, not Postgres

Postgres has nicer native primitives here (range types, GiST exclusion constraints, BRIN), but SQLite with two integer columns plus a partial index is simple, fast for these access patterns, and is what D1 and Turso actually run. The one thing given up is a DB-enforced "no two overlapping versions" guarantee, recovered in practice by the partial unique index on open rows plus the discipline that all writes go through the store layer. Revisit only if single-writer throughput is outgrown or those constraints must be DB-enforced.

---

## 9. Deliberately not decided here

- **Subgraph-parity features** beyond the core store: declarative aggregations and timeseries, FTS5 full-text search, grafting, and interface/codegen wiring. Each is written up as a self-contained task in the research repo's `tasks/`.
- **Big-number storage.** The research recommends fixed-width `BLOB` (SQLite is int64-native and *silently corrupts* larger values; D1 has no BigInt API). Needed as soon as a processor stores a `uint256`, but it is an encoding decision inside a field type, not a change to this model.
- **The GraphQL query frontend**, researched separately (Hono, Yoga, Pothos over the same model).
- **The `verifyBlocks` cross-check** at the fetcher seam (ADR-0004), deferred until the absence-driven revert signal says it is needed.

---

## References

- Prototype, benchmarks and the fuller argument: `~/dev/github/wighawag/research/ethereum-indexer-historical-state-db` (and the sibling `graphql-frontend-for-indexer-state`).
- Prior art reviewed before designing: `docs/reviews/revertable-database.md` (the deleted PouchDB prototype), `docs/reviews/event-cache.md`, `docs/reviews/todo-triage.md`.
- `graph-node` time-travel via `block_range int4range` plus `vid` in Postgres, the model this mirrors.
- Architectural decisions: ADR-0003 (component split), 0004 (fetcher wire), 0006 (stream storage and views), 0008 (rebuilds), 0010 (what was deleted).
