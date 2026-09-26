# @etherfold/state-moved-conformance

## 0.2.1

### Patch Changes

- Updated dependencies [414576d]
  - @etherfold/core@0.9.0

## 0.2.0

### Minor Changes

- b82408d: An APPLIED block that touched NOTHING is a notification with an empty set, on every transport, and the suite now says so.

  ADR-0083 makes "one notification per APPLIED block" ONE rule: a block whose handlers mutated nothing was still applied, its cursor still moved with it, so what crosses is an append naming it with `entities: []`. A transport is exactly where that gets quietly turned into two rules, because an empty array reads like nothing worth posting — and a reader that is not told cannot tell a fold that touched nothing from a fold that has STOPPED. The transport conformance suite asserted the empty case only as a TYPE (`entities` is an array of strings, of any length); it now drives one and asserts the value.

  `StateMovedTransport` gains a required `applyNextEmptyBlock()`: make the canonical fold apply a block that touches no entity, and answer which block that was. REQUIRED rather than optional, because all three transports can produce one and a capability-driven case that can select nothing is how a suite becomes decoration — the same rule the claim-driven convergence chapter already follows. What produces it is a handler taking a branch it did not take (a burn the fixture's processor does not track), which is the ordinary shape of an empty changed-set and is deliberately NOT a block carrying no logs: that applies no block at all and correctly publishes nothing, since there is none to name.

  The new case pins the whole reader consequence rather than only the payload: the notification carries the full five fields, its changed-set is empty, the coherence token has NOT moved (an empty block is an append, so nothing a reader holds became stale), and the two-line rule's narrow line therefore runs and yields nothing to re-read. Publishing it costs a reader nothing; withholding it costs it the truth. A `runStateMovedConformance` case asserts a transport that SWALLOWS an empty notification fails this case by name, so the case cannot rot into one that passes on a transport that drifted.

- 7428af8: One notification model across every transport, made checkable rather than asserted.

  `@etherfold/state-moved-conformance` is a new package: the conformance suite a **state-moved transport** must pass to be an ADAPTER rather than a second semantics. ONE case list, parameterised by an adapter that says how a reader ATTACHES and how the fold behind it is MOVED, run over all three transports from the packages that own them — a worker's port and the cross-tab channel in `@etherfold/browser`, the server's stream in `@etherfold/server`. It is the shape `@etherfold/state-store-conformance` already uses to parameterise over storage backends, and it exists for the reason ADR-0083's opening claim needed one: three independently-correct adapters agree on the day they are written and drift one edit at a time afterwards, each still passing the tests in its own file.

  The four chapters are the four places adapters stop agreeing: what the VALUE carries (an exact field set, never a subset), what the SEQUENCE is, what a reader ATTACHING LATE is told, and what a reader that MISSED something converges on. The last chapter is claim-driven — a transport whose reader has a state surface is asked that a read is not answered from below the block it was told about, one with none is asked how a connecting reader is told the position — and a transport offering neither fails a case saying so rather than skipping it. `runStateMovedConformance` runs the list without a test runner, which is how a deliberately-diverging transport is asserted to FAIL the suite, and how a transport built outside this repository (the anticipated GraphQL subscription adapter) checks itself.

  No behaviour changed in `@etherfold/browser` or `@etherfold/server`: both gain the suite as a dev dependency and a runner for the transports they own. `SignalStream` in the server's test harness gained an `onEvent` hook, which is what turns a frame off the wire into a call to the plain handler an app writes.

  Documentation: ADR-0083 loses its status line (absence means accepted and current) and records the three transports and the suite in its body instead; `CONTEXT.md` gains **transport conformance suite** and names the network transport as built; the browser-app guide gains "How your app learns the state moved", with the two-line reader rule wired to a real client library's invalidation callback and a statement of what the narrow half actually costs (`work/notes/findings/what-the-state-moved-payload-costs-a-normalised-cache.md`).

### Patch Changes

- Updated dependencies [1ad2d4a]
- Updated dependencies [ebfa4f0]
- Updated dependencies [0ba3c60]
- Updated dependencies [9fa7f35]
- Updated dependencies [3e36261]
- Updated dependencies [852da39]
- Updated dependencies [2b4f3fc]
- Updated dependencies [f77f8ea]
- Updated dependencies [61a5462]
- Updated dependencies [a1fccd0]
- Updated dependencies [e8cc627]
- Updated dependencies [0e53f34]
- Updated dependencies [882ba22]
- Updated dependencies [5427806]
- Updated dependencies [450494a]
- Updated dependencies [93eef2e]
- Updated dependencies [391dbf8]
- Updated dependencies [c6b5215]
- Updated dependencies [9a10668]
- Updated dependencies [0f33468]
- Updated dependencies [a64a843]
- Updated dependencies [57697f6]
- Updated dependencies [2021f99]
- Updated dependencies [1bec395]
- Updated dependencies [d92021c]
- Updated dependencies [23c1eae]
- Updated dependencies [bc63e6b]
- Updated dependencies [5729da5]
- Updated dependencies [ebfa4f0]
- Updated dependencies [2e10f5e]
- Updated dependencies [ce43a7b]
- Updated dependencies [1524a04]
- Updated dependencies [011aa87]
- Updated dependencies [fc95435]
- Updated dependencies [d8ce920]
- Updated dependencies [a4d106e]
- Updated dependencies [ee8e78d]
- Updated dependencies [1af43de]
- Updated dependencies [9ad39f4]
- Updated dependencies [af6a85a]
- Updated dependencies [72297c8]
- Updated dependencies [339d212]
- Updated dependencies [4f5588b]
- Updated dependencies [351c585]
- Updated dependencies [b647fb8]
- Updated dependencies [02f46ca]
- Updated dependencies [a448b1b]
- Updated dependencies [a2fc7d7]
- Updated dependencies [839e781]
- Updated dependencies [6b5395e]
- Updated dependencies [f0515f8]
- Updated dependencies [1769d1a]
- Updated dependencies [e72cbec]
- Updated dependencies [4e5067e]
- Updated dependencies [dc08d24]
- Updated dependencies [bdbcf26]
- Updated dependencies [29895dc]
- Updated dependencies [e7d06c9]
- Updated dependencies [aa17a93]
- Updated dependencies [da289e2]
- Updated dependencies [1c1bf33]
- Updated dependencies [c30070a]
- Updated dependencies [e652cde]
- Updated dependencies [49e73ae]
- Updated dependencies [70f98d6]
- Updated dependencies [3e9e9d0]
- Updated dependencies [9f693f3]
- Updated dependencies [1d9be43]
- Updated dependencies [ab779b0]
- Updated dependencies [793f3d6]
- Updated dependencies [1a6f68b]
- Updated dependencies [56acbef]
- Updated dependencies [1d619c9]
- Updated dependencies [d50583b]
- Updated dependencies [37146b2]
- Updated dependencies [74f74f5]
- Updated dependencies [9a41ba3]
- Updated dependencies [74b2889]
- Updated dependencies [f5fb4d2]
- Updated dependencies [114879f]
- Updated dependencies [0bf9dc7]
- Updated dependencies [11481a0]
- Updated dependencies [b0e9a0d]
- Updated dependencies [bb86a77]
- Updated dependencies [0403310]
- Updated dependencies [1ed2b80]
- Updated dependencies [8d1c6c5]
- Updated dependencies [8baecea]
- Updated dependencies [114879f]
- Updated dependencies [5adafa9]
- Updated dependencies [a6963b4]
- Updated dependencies [49151c3]
- Updated dependencies [cf1d4d5]
- Updated dependencies [cb28315]
- Updated dependencies [9d1d3cd]
- Updated dependencies [ad8d8b1]
- Updated dependencies [50748cf]
- Updated dependencies [290e827]
- Updated dependencies [d5f1039]
- Updated dependencies [c0d694f]
- Updated dependencies [d10b64e]
- Updated dependencies [01ed0ef]
- Updated dependencies [629dff0]
- Updated dependencies [9e2c66d]
- Updated dependencies [ed8e7ff]
- Updated dependencies [b824312]
- Updated dependencies [35fc4c2]
- Updated dependencies [4f206c3]
- Updated dependencies [9e5dc0d]
- Updated dependencies [449f6fb]
- Updated dependencies [3fa4afc]
- Updated dependencies [31579cc]
- Updated dependencies [7af8558]
- Updated dependencies [eee7e00]
- Updated dependencies [241e684]
- Updated dependencies [4da7b27]
- Updated dependencies [9229c30]
- Updated dependencies [8c8341a]
- Updated dependencies [40819d3]
- Updated dependencies [628df9d]
- Updated dependencies [9bfc424]
- Updated dependencies [7b64e35]
- Updated dependencies [ba5b4ba]
- Updated dependencies [5deb214]
- Updated dependencies [6d3df30]
- Updated dependencies [0a53b98]
  - @etherfold/core@0.8.0
