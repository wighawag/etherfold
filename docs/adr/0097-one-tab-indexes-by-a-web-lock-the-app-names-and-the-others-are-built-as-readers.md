# One tab indexes, by a Web Lock the app names, and the others are built as readers

Every tab that opened an app built its own indexer. The newest writer claim won (ADR-0075, ADR-0077) and the older tabs demoted to readers (ADR-0078): correct, and N times the `eth_getLogs` calls, bandwidth and CPU for one store's worth of state; nothing handed the write duty back when the indexing tab closed, so the remaining tabs went stale; and every new tab fetched until it lost. We decide, with the maintainer on 2026-09-27 (decisions D1 to D4 of `one-tab-indexes-and-the-others-read`), that **one tab indexes, elected by ONE Web Lock per APP whose name the app supplies; a tab that does not hold it is BUILT AS A READER from a reader factory the app supplies beside `createState`; the election is opt-in and is the documented default; and a foreground tab taking the lease from a backgrounded one is out of this first cut.** The writer claim stays the correctness guarantee underneath: election is for COST, never for correctness.

## D1: the lock is named per APP, by the app

A host option, `tabElection: {name}` (on `createIndexerState`'s options and on a worker host's entry), names ONE Web Lock (`navigator.locks`, composed as `etherfold/tab-election/<name>`), held by the host that indexes for as long as it indexes, covering every generation that host holds. It is named the way a SharedWorker's `name` is, because the spec's first answer, the store's storage identity, does not survive contact with the host: the claim is scoped to a database name the APP chooses inside `createState`, per generation, so the host cannot name that lock before it has claimed; and one host holds several generations with a store each, so a lock per store would have one tab holding the canonical generation's lock and not its successor's. Two apps on one origin supply different names and never contend.

Web Locks is the whole mechanism. Acquisition is atomic, and the browser releases the lock when the holder's tab or worker dies, crash included, so there is no heartbeat, no stale threshold and no timeout; a queued tab is granted it the moment it is released. Nothing is stolen (`steal` is never used). The `localStorage` plus `BroadcastChannel` fallback the spec describes is not built.

**Where the lock is taken: by the HOST, wherever the host runs.** The main-thread hook takes it in the tab. A worker host (`serveIndexerHost`, reached through `hostIndexerInThisWorker` / `hostIndexerInThisSharedWorker`) takes it INSIDE the worker, because the worker is what indexes: the browser then releases it when that worker is terminated or evicted, and when the tab that owns a dedicated worker closes or crashes, since the worker dies with it. A tab that took the lock for a worker it owns would hold the write duty for a fold it does not run.

**A SharedWorker host takes it too, through the same code.** It is one indexer per origin and script, so its own tabs never contend for it and taking it costs one uncontended request; what taking it buys is that a SharedWorker host and dedicated-worker hosts of the same app (a browser without SharedWorker, say) are in ONE election rather than two writers. There is one path, as the spec asked.

## D2: a READER FACTORY sits beside `createState`

`BrowserGenerationSpec.openState(context, bundle?)` returns `{store, state}`: the same storage `createState` would open, opened with `openForReading`, and the read handle over it (`new EntityStateView(store)` for an entity processor). A host that finds the lock held is built from it at once: no claim, no processor, no fetch, no seed install and no snapshot bootstrap (both are writes). The `context` is the `{stream}` the container would hand `createState`, computed the same way (`streamDigestOf` over the resolved stream config), so reader and writer address the same storage. Its reads answer the shared store (the main-thread hook publishes `state` from it, and a port's reads are served from `store`), it follows the state-moved signal the leader publishes, and its progress is the leader's. It queues for the lock; when the browser releases it, the reader becomes the writer through ADR-0078's recovery path: a fresh start through `createState`, taking the claim, loading the stored cursor and indexing forward from it.

**A leader publishes; it is not polled.** The leader forwards its container's state-moved values (ADR-0083, `repointed` included) and its `HostProgress` reports over a `BroadcastChannel` named from the election name, using the cross-tab adapter's own envelope (`openStateMovedAcrossTabs` is the same code under a storage-scoped name). A reader forwards the values to its own subscribers unchanged and reports the leader's phase and block figures under its own `host` and `scope`; the leader's `failure`, `publication`, `streamSeed` and `hotUpdate` are not carried over, because they describe the leader's host. A reader answers `checkTxInclusion` with `unknown` / `not-synced`: it has no cursor of its own and the published figures are not one.

**The role and a takeover are reported on the existing status surface**: `HostProgress.election` over a port (`{name, role: 'reader' | 'writer', tookOver}`) and `SyncingState.election` on the main-thread hook. `tookOver` is `true` for a host that became the writer after waiting behind a lock another tab held, measured by asking for the lock with `ifAvailable` first.

**While reading, the main-thread hook drives nothing.** `startAutoIndexing()` is remembered and answers `true` (the loop starts on the takeover); `indexMore()` and its siblings answer `undefined`, the same "no cursor" answer a demoted tab gives. A worker host's driver waits for the lock the way it waits for a tab's provider, and a reconfigure or hot update asked of a reader waits for the takeover, because both build generations and building one claims.

**A host that stops being a writer gives the lock back.** A demoted main-thread tab (a refused write, or `demoteToReader`) and a worker host whose driver stopped on a failure resign, because holding the lock while writing nothing would stop every other tab from taking over. A demotion is still one-way for that container, as ADR-0078 says.

## D3: opt-in, and the documented default

The election runs when the app supplies BOTH the name and the reader factory, and where `navigator.locks` exists in the host's scope. Otherwise a host behaves exactly as it did before (a runtime without the primitive is noted once in the log, not refused). Existing entry points are therefore unchanged. The guide ("When another tab takes the store") and `examples/browser-reference` use it, which is what makes it the default an app copies.

## D4: a foreground tab does not take the lease from a backgrounded one, yet

A throttled background tab holds its lock perfectly well while doing little. Without a way for a visible tab to ask for the lease, a backgrounded leader indexes slowly: a cost, not a correctness problem. Deferred to a later task.

## Election is for cost, never for correctness

Every failure of the election costs RPC calls and never data: two hosts that both believe they lead (a tab with no election on the same store, a runtime without Web Locks, a zombie waking from a throttled tab) are settled by the writer claim, and the loser demotes exactly as before. That case is asserted rather than stated (`test/oneTabIndexesAndTheOthersRead.test.ts`, and `browser/oneTabIndexesAndTheOthersRead.spec.ts` in real tabs).

## Amendments

- **ADR-0077**: where the claim is taken is still the factory that builds a generation's store (`createState`), and a tab that only renders still never comes through it; what is new is that a HOST can now be that tab, built from `openState`, and it moves from the one factory to the other only by winning the election.
- **ADR-0082**: "the non-leader workers are not idle" was written ahead of any leader; with the election on, a non-leader worker serves its own tab's reads from the shared store and follows the leader, and a SharedWorker still needs no election of its own but takes the same lock, uncontended, so it can share one election with dedicated-worker hosts of the same app.
- **ADR-0024**: its criterion 3 ("single-tab by construction, or willing to build leader election") is satisfied for the election half: leader election exists.

## Considered options

- **One lock per store (the spec's original scoping).** Rejected in D1: the host cannot name it, and one host holds several stores.
- **A role argument on `createState` instead of a second factory.** Rejected: `createState` returns a claimed `WritableStateStore`, and a reader must be unable to write by type, so the reader is its own factory with its own return type.
- **Default-on.** Rejected in D3: it needs a reader factory no existing entry point supplies.
- **The tab takes the lock for its dedicated worker.** Rejected: the lock would outlive a worker the port restarts, and a killed worker would not release it.
