<!-- dorfl-sidecar: item=task:a-remaining-tab-takes-over-when-the-indexing-tab-closes type=task slug=a-remaining-tab-takes-over-when-the-indexing-tab-closes allAnswered=false -->

## Q1

**'task:a-remaining-tab-takes-over-when-the-indexing-tab-closes' was bounced — how should we proceed?**

> The task assumes a host can (a) open a tab as a READER "at once (no claim, no fetch, reads the shared store)" and (b) take "ONE exclusive lock per store, scoped exactly as the writer claim is". Neither is expressible with the current host surface, and choosing how to make them expressible is an unresolved public-API design decision.
>
> 1. No reader factory exists. `BrowserGenerationSpec.createState` (packages/browser/src/IndexerState.ts, doc "A reader never comes through here") returns a CLAIMED `WritableStateStore`, and the app calls `openForWriting` inside it. The container calls it when it opens at `init` (packages/core/src/container.ts:916, reached from `openContainer` in IndexerState.ts and from host/serve.ts). `createProcessor` also takes a `WritableStateStore`, and the reactive `state` / port reads come from that processor. So a host that does not hold the lock has no way to build the state its reads answer from without claiming. Claiming would demote the real writer under ADR-0075/0077, and building nothing would leave reads waiting. That contradicts "reads the same state ... from the start" and "its reads keep answering throughout". The snapshot bootstrap inside `createState` (`openAndBootstrap`) and the seed install in `publishedStart.prepare` are writes a reader would also have to skip.
>
> 2. The lock's name is not knowable by the host. The claim is scoped to the IndexedDB `databaseName`, which the APP chooses inside `createState` per generation (e.g. `reference-${context.stream}` in examples/browser-reference/browser/indexer.worker.ts, and a separate database per hot-update save). The host only learns it by calling the claiming factory, and the seam type does not expose it afterwards. The only identity the host holds is the stream digest, which two apps on one origin indexing the same contract share, violating "two apps on one origin never share one".
>
> 3. "One lock per store" does not match "one indexing tab". One host holds several generations, each with its own store, so it would hold several locks and could hold the canonical generation's lock but not a successor's.
>
> Suggested re-scope (pick one and state it in the task):
> - (A) Add an app-supplied election identity: a host option such as `tabElection: {name} | false`, mirroring how a SharedWorker's `name` and `openStateMovedAcrossTabs({databaseName})` are app-supplied. Also add a reader factory to `BrowserGenerationSpec`, e.g. `openState(context, bundle?) => StateStore` plus a processor over it, or a role argument to `createState`, with the election enabled only when both are present. Decide whether that is opt-in, which contradicts the "opt-out" wording, or default-on, which breaks every existing entry point.
> - (B) Narrow the task so that a non-holding tab does not init at all until it gets the lock, and its reads come from the app's own `openForReading(createBrowserStateStore(...))` plus the cross-tab channel. That drops the "host answers reads from the start" criterion.
> - (C) Split it: first a task deciding the reader-factory and election-identity seam (with an ADR amending ADR-0077/0082), then this task on top.
>
> Also note: the task file sits in work/tasks/backlog/ (not ready/) and has no `spec:` field; the closest spec is work/specs/proposed/one-tab-indexes-and-the-others-read.md.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):
