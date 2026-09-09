# @etherfold/conformance-workload-stratagems

The **heavy conformance workload**: a real launched processor, its real captured event stream, and the state that game's ORIGINAL processor computed from it, replayed through every state-store backend.

A conformance WORKLOAD is a subject fed to the conformance suite's question, not a second suite (ADR-0020). [`@etherfold/state-store-conformance`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-conformance) asks a backend small, hand-written questions whose failures are readable. This asks the one question a hand-written case cannot: whether **31,332 real logs out of a game that has been running on Base** still land on the state that game's own processor computed from the same bytes.

```sh
pnpm --filter @etherfold/conformance-workload-stratagems test          # the fast smoke case
pnpm --filter @etherfold/conformance-workload-stratagems test:full     # + the launched game
```

Not published, and that is deliberate: see [Licence](#licence-gpl-30-in-an-mit-repository).

## What makes it worth a 0.6 MB fixture

- **The expected state is not ours.** It was computed by the stratagems `JSProcessor` at commit `3d5a0b3f`, vendored verbatim in [`vendor/stratagems/`](./vendor/stratagems), which is the code that has actually been running on Base. An expected value we wrote ourselves would agree with our port for exactly the reason that makes it worthless as evidence. It is now a **FROZEN** expectation rather than a recomputable one: the free-form authoring path that could re-run that processor is deleted (ADR-0037), so what is compared against is the committed file. See [`fixtures/README.md`](./fixtures/README.md), and note that `CONTEXT.md` already treated a diff on it as a FINDING rather than a fixture update, so regeneration was never the normal path.
- **The input is fixed.** No node is in the loop. The stream is a committed capture carrying its own provenance, so two backends cannot be compared on different bytes and a rerun in a year sees the same events.
- **It is big enough to be surprising.** Ten of thirteen handlers fire; the placement window takes 100 arrivals and keeps 7, so the eviction cascade runs 93 times; 16,046 of the events write nothing but `uint256` fields; and the reorg case is a real accumulated counter going back DOWN.

## The layout

| | |
| --- | --- |
| `fixtures/` | the two captured deployments and their golden states. **Read [`fixtures/README.md`](./fixtures/README.md) first**: `base` is not "the Base deployment" |
| `src/fixture-file.ts` | the fixture-file IO (`loadStreamFixture` / `saveStreamFixture`, gzip chosen by the `.gz` extension) that `fixtures/` is written and read through. It moved here when `@etherfold/fs` was deleted (ADR-0041): a fixture loader is test material and needs no storage package |
| `vendor/stratagems/` | the ORACLE, copied verbatim, GPL-3.0 ([why](./vendor/stratagems/README.md)) |
| `src/entities.ts` | the state, declared as entities, on the idiomatic model |
| `src/processor.ts` `src/stratagems-contract.ts` | the port: `on<EventName>` handlers over a `MutationContext` |
| `src/project.ts` | entity rows read back THROUGH THE SEAM and projected into the oracle's object shape |
| `src/replay.ts` `src/workload.ts` | replay a fixture into a store, project, compare against the golden text |

## The fast case and the full case

| | fixture | backends | when |
| --- | --- | --- | --- |
| `test/workload.test.ts` | `stratagems-base`, 42 events over 9 blocks | all four | **every invocation** |
| `test/alpha1.test.ts` | `stratagems-alpha1`, **31,332 events over 1,042 blocks** | memory, sqlite, patch | CI (`CI` is set) and `test:full` |
| `test/alpha1.test.ts` | the same | + indexeddb | `test:all-backends` only |

The split is a judgement about loops, not about coverage: a loop nobody runs is worse than a slower one, and a case that fails on 31,332 real events is a bug report nobody can read, so the small fixture goes first and catches a mistake in the shared machinery in seconds.

**Why IndexedDB is not in the default full run.** The cost is the SHIM's, not the backend's. On `fake-indexeddb` this replay takes about half an hour and degrades quadratically with the stored version count, while the same backend measured 45.6 ms/block on real Chromium (under a minute for the whole stream) in `work/notes/findings/sqlite-in-the-browser.md`. Half an hour per pull request would be switched off by the next person to wait for it. It still runs the whole conformance suite and the fast workload case on every invocation, and the honest route to heavy-workload coverage there is the real engine (`packages/state-store-indexeddb/browser/`) rather than a faster shim. Recorded in `fake-indexeddb-write-cost-grows-quadratically`.

Every backend is configured to keep ALL its history, because the workload replays a stream 11 million block numbers wide and then reverts 521 event-bearing blocks. Retention windows, their refusals and their pruning are what the small conformance cases interrogate, under every claim a backend can make.

## The reorg case is the point, and it is real

`reverting to block 13,364,821 makes the evil owner's computedPoints DECREASE from 12 to 6`, as a named test rather than a generic one.

A stored counter that does not go back down when its block is reverted is the canonical bug this whole design exists to make impossible, and it is not hypothetical here: `computedPoints` is accumulated through the mutation context (read, add, write), so the value a reorged-out block wrote is what the NEXT increment would be a function of. A backend that leaves it standing is not obviously broken; it is quietly and permanently wrong.

## The port was REWRITTEN, and the golden state is the proof

The port measured in `work/notes/findings/sqlite-in-the-browser.md` predates the bounded id-prefix listing (ADR-0021). Without a way to ask "which rows belong to this parent" it had to write the answer down: a `placement.positions` CSV so the cascade delete had something to walk, a `placementCell.playerCount` so an append knew which index to write at, and a `placementWindow` singleton holding the arrival order. Three maintained indexes, six entities, and one `pop()` that became an O(cells x players) loop of manual deletes.

Promoting it meant rewriting it onto the idiomatic model, not copying it:

- **children keyed by their parent, collection DERIVED WHEN READ** (`state.list('placement', {window: 'global'}, 8)`), the shape a subgraph's `@derivedFrom` describes;
- **ordered children keyed by something naturally unique** — here ARRIVAL, `(blockNumber, logIndex)` of the event and the move's index within it, fixed-width so the id's lexicographic order is the numeric one. The hand-maintained count existed only because the child's id ended in a dense array position;
- **no `placementCell` entity at all**: in the original a cell is created only in order to push a player into it, so the set of cells is the set of positions among the players, and that is derived rather than stored.

Six entities became three for the same state, and the run emits **29,492 mutations where the old port emitted 38,192**. The golden state is what says the meaning survived: byte-identical after canonicalisation, on every backend.

## Two contortions do NOT disappear, and are documented rather than hidden

1. **`uint256` has no column type.** The declarable classes are `text` / `integer` / `real` / `blob`, and SQLite's INTEGER is 64-bit, so every u256 is decimal TEXT read back through `BigInt()`. Equality then depends on the encoding being canonical (decimal, no leading zeros, never hex), which is a rule nothing in the model states or enforces (ADR-0025: a declaration describes a storage class, not a type). That is load-bearing on this workload rather than academic: **16,046 of the 31,332 events write nothing but u256 fields**. `u256()` in `src/entities.ts` is the single place the encoding is chosen, so it is one decision instead of nine call sites, and `src/project.ts` is the single place it is read back.
2. **A scalar map needs its own entity.** `state.owners[position]` is one address per cell, and folding `owner` into `cell` looks obvious and is WRONG: the processor writes an owner where it does not write a cell, and `set` writes a WHOLE ROW, so the fold would silently clear the nine cell fields. Correct semantics, paid for with an extra entity and a second read on every `ownerOf`.

## The goldens are FROZEN, and cannot be regenerated

There is no `regenerate-golden-state` any more. Recomputing a golden state meant running the vendored original, which needed the free-form authoring path (`fromJSProcessor`); that path is deleted (ADR-0037) and the script and its oracle went with it. What is kept is the committed golden state, which is what the ported processor is compared against on every backend.

That is a deliberate trade rather than an oversight, and it costs little: `CONTEXT.md` already said a diff on a golden "means the processor changed meaning, which is a FINDING and not a fixture update", so regeneration was never the normal path. What it does mean is that a diff can no longer be triaged by re-deriving the expected value. It is triaged by reading `vendor/stratagems/js-processor.ts`, which is still here, still typechecked, and still the code that ran on Base.

## Licence: GPL-3.0 in an MIT repository

The vendored stratagems source is GPL-3.0 and this repository is MIT. Both are the same author's work and using it here as a test fixture is exactly what it is for; the note exists so the difference is VISIBLE to a reader who meets the code without this context. It is repeated in [`vendor/stratagems/README.md`](./vendor/stratagems/README.md) next to the files themselves.

That licence difference is also why this package is `private` and never published: `src/processor.ts` and `src/stratagems-contract.ts` are derived works of it, and shipping them to npm under this repository's MIT licence would misstate what they are. The fixture's weight (about 1.3 MB) would be a second reason on its own.
