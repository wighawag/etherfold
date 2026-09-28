# The FROZEN-leader takeover flake, diagnosed under load

Task: `the-frozen-leader-takeover-flake-is-diagnosed-under-load` (2026-09-28). Read by `the-tab-lease-suites-stop-flaking`, which owns the fix. Nothing is fixed here.

## The flake

`packages/browser/test/aVisibleTabTakesTheLeaseFromABackgroundedLeader.test.ts`, case "a FROZEN leader, which never answers and never learns, is displaced within the settle time, and the store stays correct when both write", failed on 2 of 3 CI runs of PR #250's `verify` job with

```
Error: this indexer was DEMOTED to a reader (unknown), so the advance answered no cursor: ...
 ❯ test/aVisibleTabTakesTheLeaseFromABackgroundedLeader.test.ts:275:3   (await indexToTip(reader))
```

## VERDICT: test race

The new leader is NOT demoted, its writer claim never loses, and the frozen leader does nothing in the window. The test advances the new leader in the gap between the takeover's seat being published and its fresh start finishing:

1. `takeOver` (`packages/browser/src/IndexerState.ts`) calls `setSeat('writer', {tookOver: true, takeoverReason})` and `publishToPort()` FIRST, then `await initAsWriter(...)`. ADR-0097 D4 wants this order: "a new leader also announces its seat the moment it holds the lock, before its container opens", so a reader never mistakes a live new leader for a frozen one.
2. Until `initAsWriter` has opened the container (`openContainer` assigns `indexer`), `isReading()` (`reading !== undefined && !indexer`) is still `true`.
3. The test's `until('the takeover', () => reader.syncing.$state.election?.role === 'writer')` is satisfied by step 1, not by step 2. Its next action is `indexToTip(reader)`, which calls `indexMore()`, which goes through `whileWriting`, whose first line is `if (demotion || isReading()) return undefined;`. That is the documented reader answer (ADR-0097 D2: "`indexMore()` and its siblings answer `undefined`" while reading), given to a hook whose seat already says `writer`.
4. `indexToTip`'s helper `demotedOrCursor` (`packages/browser/browser/workload.ts`) turns any `undefined` into "DEMOTED ... (`syncing.demotion?.reason ?? 'unknown'`)". No demotion happened, so the reason is `unknown`.

On an idle machine the fresh start (`createState` with fake-indexeddb, `openForWriting`, `openIndexer`) takes about 1 ms and `until` polls every 20 ms, so the poll that sees `writer` almost always comes after the container is open. Under CPU contention the fresh start stretches to several ms and interleaves with the poll, and the test loses.

## Evidence

All numbers from `repro.sh` in this folder, on a 32-core, 60 GB machine (other work idle, load average about 3 before each run), vitest 4.1.8, node's own `navigator.locks` and `BroadcastChannel` as the test uses them. Load is `BURNERS` busy-loop node processes (`node -e 'for(;;){}'`) plus `PARALLEL` concurrent vitest processes, both capped at `nproc - 2` = 30.

### Failure rate, unmodified test

| load | parallel vitest | burners | runs | failures | rate |
| --- | --- | --- | --- | --- | --- |
| none (serial) | 1 | 0 | 50 | 0 | 0% |
| none | 8 | 0 | 200 | 0 | 0% |
| parallel runs only | 30 | 0 | 200 | 1 | 0.5% |
| moderate | 15 | 15 | 300 | 5 | 1.7% |
| heavy | 30 | 30 | 200 | 71 | 35.5% |
| heavy | 30 | 30 | 300 | 109 | 36.3% |

Every failure, in every configuration, is the same line: `DEMOTED to a reader (unknown)` at test line 275. No other failure mode appeared.

### The deciding experiments (test side only, no production change)

| patch | what it changes | load | runs | failures | rate |
| --- | --- | --- | --- | --- | --- |
| `decide-widen` | the NEW leader's `createState` (the app's factory, in the test) waits 50 ms before claiming, i.e. a slow fresh start | none (serial) | 30 | 30 | 100% |
| `decide-wait` | after the takeover, the test waits `until(reader.promotion !== undefined)` (the `promotion` getter answers only once the container exists) before advancing | heavy (30 + 30) | 300 | 0 | 0% |

Widening the fresh start makes it fail every time with no load at all; waiting for the fresh start makes it pass every time under the heaviest load measured (which fails 36% unmodified). With `decide-wait` the rest of the test still runs: the frozen leader's later `indexMore()` is refused and demotes with `write-refused`, and the store equals `EXPECTED_A_EXTENDED`. So once the new leader's container is open, nothing the frozen leader does can make the new claim lose, which is ADR-0097's "Election is for cost, never for correctness" holding.

### The trace (`PATCH=trace`)

`trace.patch` is temporary instrumentation (reversed by the script on exit; it never lands) that records, on one shared `performance.now()` clock: every lock grant (at once, from the queue, by steal) and every rejected held request in `tabElection.ts`; `init`'s seat, `takeOver` entry, the seat publication, container open and fresh start done, `stepDown`, every `demote(reason)`, every refused write, and every `whileWriting` that answers `undefined` without running (with why) in `IndexerState.ts`; and, from the test, each tab's `createState` call and claim landing, the `until` being satisfied and the advance. `hook#1` is the frozen leader, `hook#2` the visible reader that takes over.

A FAILING run (heavy load, run 10 of 60):

```
  5783.3ms election lock GRANTED at once, ifAvailable (etherfold/tab-election/frozen-1-hgv6eh)
  5783.4ms hook#1 init: lock FREE, leads from the start
  5808.1ms test FROZEN leader (hook#1): createState called (writer claim begins)
  5830.0ms test FROZEN leader (hook#1): writer claim LANDED (openForWriting resolved)
  5850.4ms hook#1 container open (indexer set), isReading()=false
  5933.7ms test frozen leader indexed to its tip
  5934.7ms hook#2 init: lock held, seats as a reader
  6087.7ms election steal requested (settle time elapsed)
  6088.3ms election lock GRANTED by STEAL (etherfold/tab-election/frozen-1-hgv6eh)
  6088.6ms hook#2 takeOver(leader-backgrounded) entered, tenure=1
  6089.0ms hook#2 seat=writer published (syncing.election.role='writer'); fresh start begins: reading=true indexer=false isReading()=true
  6089.8ms test visible reader (hook#2): createState called (writer claim begins)
  6090.3ms test until('the takeover') satisfied: reader seat=writer lastSync=undefined
  6102.3ms test indexToTip(reader) called
  6102.3ms hook#2 whileWriting answers undefined WITHOUT running the step: demotion=undefined isReading()=true (reading=true indexer=false) seat=writer
```

The new leader's claim has not even landed when the test advances it: there is no refused write, no `demote`, no `stepDown` for `hook#2`, and the frozen leader (`hook#1`) has written nothing since it indexed to its tip.

A PASSING run under the same load (run 12 of 60), for contrast:

```
  6011.7ms election lock GRANTED by STEAL (etherfold/tab-election/frozen-1-ced89x)
  6011.9ms hook#2 takeOver(leader-backgrounded) entered, tenure=1
  6012.3ms hook#2 seat=writer published (syncing.election.role='writer'); fresh start begins: reading=true indexer=false isReading()=true
  6014.0ms test visible reader (hook#2): createState called (writer claim begins)
  6015.8ms test visible reader (hook#2): writer claim LANDED (openForWriting resolved)
  6020.5ms hook#2 container open (indexer set), isReading()=false
  6020.6ms hook#2 fresh start done (initAsWriter resolved): reading=true indexer=true tenure=1 mine=1
  6027.8ms test until('the takeover') satisfied: reader seat=writer lastSync=undefined
  6029.8ms test indexToTip(reader) called
  6055.6ms test indexToTip(reader) returned
  6059.5ms hook#1 a write was REFUSED (writer changed)
  6059.6ms hook#1 demote(write-refused)
```

Across all 60 traced runs under heavy load (12 failed, 48 passed) the split is exact: every passing run advanced AFTER `hook#2 container open`, every failing run advanced BEFORE it, and no run showed a demotion, a refused write or a step-down of `hook#2`.

## Is `unknown` a reporting gap?

Not in a demotion path: every demotion goes through `demote(reason)` in `IndexerState.ts`, which publishes `syncing.demotion` with its reason (`write-refused` or `lease-lost`), and none ran. `unknown` is produced by the TEST HELPER `demotedOrCursor` in `packages/browser/browser/workload.ts`, which reads every `undefined` from `indexMore()` as a demotion and prints `?? 'unknown'` when there is none. The production path that answered `undefined` is `whileWriting`'s `isReading()` branch in `IndexerState.ts`, taken while `takeOver` has already published `role: 'writer'` but `initAsWriter` has not opened the container. What IS a gap, and the fix task should weigh it: in that window `syncing.election.role` says `writer` while `indexMore()` answers as a reader, and nothing on `syncing` distinguishes "writer, container still opening" from "writer, ready". The helper's message would be accurate if it said "no cursor (not demoted: still reading)" when `syncing.demotion` is absent.

## For the fix (`the-tab-lease-suites-stop-flaking`)

Not a takeover window, so no change to ADR-0097 D4 is needed to close the flake. Two directions, for that task to choose between:

- **Test side.** After the takeover, wait for the fresh start before the first advance (for example until an advance answers a cursor, or until the container is observable), instead of treating the seat as readiness. `decide-wait.patch` shows the effect with `reader.promotion !== undefined`, which is an indirect signal and probably not the one to ship.
- **Product side.** Make `indexMore()` (and its siblings) during a takeover's fresh start wait for that fresh start instead of answering the reader's `undefined`, so the verb agrees with the seat. Moving the seat publication after the container opens instead would contradict D4 ("a new leader also announces its seat ... before its container opens"), which `leaderIsDisplaceable`'s "silence means frozen" rule leans on, so it is the option to avoid.

The other `until(... role === 'writer')` waits in the two tab-lease suites (`aVisibleTabTakesTheLeaseFromABackgroundedLeader.test.ts` lines 178, 228, 231, and `oneTabIndexesAndTheOthersRead.test.ts` line 154) are followed by an `until` on `lastSync` rather than a direct advance, so they tolerate this gap; only the FROZEN case advances straight after the seat.

## Re-running

From the repo root, after `pnpm install && pnpm build`:

```sh
S=docs/spikes/the-frozen-leader-takeover-flake/repro.sh
ITERATIONS=50  PARALLEL=1                $S   # no load
ITERATIONS=300 PARALLEL=30 BURNERS=30    $S   # heavy load (clamped to nproc - 2 each)
PATCH=trace KEEP_PASSING=1 ITERATIONS=60 PARALLEL=30 BURNERS=30 $S   # traces in $OUT/run-*.log
PATCH=decide-widen ITERATIONS=30 PARALLEL=1 $S
PATCH=decide-wait  ITERATIONS=300 PARALLEL=30 BURNERS=30 $S
```

Each vitest run is under `timeout` (`RUN_TIMEOUT`, default 120 s), each burner under `timeout 3600` and killed on exit, logs go to a fresh `/tmp` directory, and a `PATCH` is applied only if it applies cleanly and is reversed on exit. The patches are against the tree of 2026-09-28; if the test or `IndexerState.ts` has moved since, the script refuses rather than half-applying.
