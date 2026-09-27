---
'@etherfold/browser': minor
---

One tab indexes and the others read, and a remaining tab takes over when the indexing tab closes (ADR-0097).

An opt-in tab election over ONE Web Lock per app. Give a host `tabElection: {name}` (an option of `createIndexerState`, or a field of a worker host's entry) AND a reader factory beside `createState`, `BrowserGenerationSpec.openState(context, bundle?)`, returning `{store, state}`: the same storage opened with `openForReading`, and the read handle over it. The host that finds the lock free indexes exactly as before. A host that finds it held is built from `openState`: it claims nothing and fetches nothing, answers reads from the shared store, follows the leader's state-moved signal and reports the leader's progress over a `BroadcastChannel` named from the election. When the browser releases the lock (the leader's tab or worker closed, crashed or was killed), the next host takes over through `createState`, claims, and indexes forward from the stored cursor. A worker host takes the lock inside the worker; a SharedWorker host takes it too, uncontended.

The seat is reported as `HostProgress.election` and `SyncingState.election` (`{name, role: 'reader' | 'writer', tookOver}`). On the main thread a reader remembers `startAutoIndexing()` until it takes over, and its advances answer `undefined`. A demoted tab gives the lock back. Without both the name and `openState`, or without `navigator.locks`, nothing changes. New exports: `TabElection`, `TabElectionRole`, `TabElectionState`, `ReaderState`, `tabElectionName`, `TAB_ELECTION_PROTOCOL`.
