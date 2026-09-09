# Spike: can ONE multiEntry index over computed `[field, value]` subkeys serve `where` and `orderBy`?

Gates **rung 2** of [`work/specs/proposed/the-same-query-runs-against-a-worker-and-a-server.md`](https://github.com/wighawag/etherfold/blob/main/work/specs/proposed/the-same-query-runs-against-a-worker-and-a-server.md), its open question 3. Nothing else in that spec waits on this: rung 1 (scan a key range, filter and sort in memory, bounded) ships regardless, as the fallback for any unindexed field and as the reference the index path is checked against.

## The question

A subgraph-style query surface needs `where` and `orderBy` on declared fields. On SQLite that is a query planner's job. IndexedDB has none, which is why ADR-0021 narrowed the handler seam to a bounded id-prefix listing in the first place.

The obvious fix, "create an IndexedDB index per filterable field", is blocked: `createIndex` is only callable from a `versionchange` transaction, and a `versionchange` can be stalled by another open tab, so a processor declaring one more filterable field would become a migration a second tab can wedge. That is exactly the argument `packages/state-store-indexeddb/src/keys.ts` already makes for object stores ("the entity name is part of the KEY rather than the name of a store").

**So make the same move one level down: put the FIELD NAME inside the KEY rather than in the key path.** One index, declared once:

```
current  [entity, ...id] -> { lower, values, ix }
ix: [ ["price", 30], ["owner", "0xaa"] ]
createIndex('ix', 'ix', { multiEntry: true })
```

Then a `where` is `IDBKeyRange.bound(["price", lo], ["price", []])`, which is the `[...prefix, []]` idiom `startingWith` already documents, and an `orderBy` rides the index order instead of sorting in memory. A new declared field is DATA, so it needs no migration and no tab can block it.

The spec says this is legal. *Convert a value to a multiEntry key* converts each item with *convert a value to a key*, which accepts an Array exotic object (recursing, rejecting only cycles via the `seen` set), and *store a record into an object store* then adds one index record per SUBKEY. So `["price", 30]` is a legal subkey.

**Spec-legal is not engine-verified**, and multiEntry with array subkeys is a corner where engines have historically diverged. Hence this.

## The answer

**Yes, on all three engines, 9 of 9 probes, three runs each.** No engine needed a workaround and no probe was close.

| # | probe | Chromium | Firefox | WebKit |
|---|---|:--:|:--:|:--:|
| A | `createIndex` with `multiEntry` is accepted | ok | ok | ok |
| B | an array subkey is addressable (`IDBKeyRange.only(['price', 30])`) | ok | ok | ok |
| C | a field is a range-scannable bucket (`bound(['price'], ['price', []])`) | ok | ok | ok |
| D | `where` + `orderBy` ride the index, in the value's own order | ok | ok | ok |
| E | buckets are disjoint (no bleed between `price` and `owner`) | ok | ok | ok |
| F | a record whose key path yields no key is in NO index entry | ok | ok | ok |
| G | binary subkeys sort BYTEWISE | ok | ok | ok |
| H | duplicate subkeys collapse to one entry | ok | ok | ok |
| I | an empty key array indexes nothing | ok | ok | ok |

Three of those are worth more than a tick:

**F is a partial index, for free.** A record with no `ix` property is absent from the index entirely (8 index entries across 5 rows, where the fifth row carries no key). That is the same mechanism `UPPER_INDEX` already relies on (`upper: null` is not a valid key, which is what keeps a live version out of the prune's reach), and it means an index over `current` contains exactly the live set with nothing to maintain.

**G is what makes a `uint256` orderable at all.** Big-endian fixed-width bytes sorted as binary keys gave `9, 10, 2^63+7`. The same values as decimal TEXT sort `"10", "9", "9223372036854775815"`, which is wrong and is what the store holds today. So this converges with the server's sortable-BLOB approach rather than inventing a browser-only encoding, and `orderBy` on a big number depends on the bigint codec on BOTH backends (ADR-0025).

**H matters because a filter must not double-count.** A row whose computed array repeats a subkey appears once per DISTINCT subkey, so `[['tag','x'],['tag','x'],['tag','y']]` yields two entries and not three.

## What this did NOT settle: the write cost

The probe also timed 2,000 rows with **three** indexed fields each, written in batches of 100, with and without the index. Three runs:

| engine | without index (ms) | with index (ms) | overhead |
|---|--:|--:|--:|
| Chromium | 41.5 / 39 / 36 | 56 / 52 / 57 | +36% / +32% / +59% |
| Firefox | 63 / 66 / 72 | 139 / 111 / 115 | +121% / +68% / +60% |
| WebKit | 82 / 70 / 49 | 121 / 128 / 130 | +48% / +83% / +165% |

**Read that as "the overhead is real and material", and as nothing more precise.** The run-to-run variance is larger than the gaps between engines, the workload is synthetic, it is not the shipped backend, and one page on one laptop is not a measurement. What it does establish is that maintaining the index is tens of percent rather than a rounding error, for three indexed fields per row, and that the cost plausibly scales with how many fields are indexed.

That leaves the real write-path question exactly where ADR-0024's own consequences already left it: the shipped store added `lower` and `upper` indexes AFTER the 45.6 ms/block figure was taken and **that has never been re-measured**. A third index lands on top of an unmeasured regression. So rung 2 needs a proper write-path measurement on the real workload before it ships, and this probe is not it.

## Running it

```
cd docs/spikes/a-multientry-index-over-computed-field-keys
pnpm install --ignore-workspace
npx playwright test          # three engines, ~5s
```

Needs `playwright install`. Deliberately outside the acceptance gate, on the same reasoning as `packages/state-store-indexeddb/playwright.config.ts`: a gate that cannot run on a clean CI checkout is a gate that gets skipped.

```
browser/cut.ts             the nine probes, raw IndexedDB, no etherfold import
browser/multientry.spec.ts mounts them per engine, fails on any probe that did not hold
results/<engine>.json      what each engine answered, with the detail behind each tick
```

`cut.ts` deliberately imports nothing from etherfold. The question is about the ENGINE, and a probe that went through the backend would be measuring the backend.
