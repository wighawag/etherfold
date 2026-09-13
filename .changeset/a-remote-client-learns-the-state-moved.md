---
'@etherfold/server': minor
'@etherfold/core': minor
'@etherfold/platform-nodejs': minor
'etherfold': patch
---

**A remote client can be TOLD the state moved: `GET /{indexer}/state-moved`, server-sent events, carrying the same value a browser tab is handed over its port** (ADR-0083, the third transport).

An app reading from a hosted indexer now runs the notification handler an app indexing in its own browser runs, unchanged. What crosses is `@etherfold/core`'s `StateMoved` serialised as JSON and otherwise untouched (`event: state-moved`), so "one notification model across every transport" is a deployment choice rather than a second semantics: token unchanged, invalidate narrowly using `entities`; token changed, invalidate everything.

**Sync progress rides the same stream** (`event: progress`, `StateMovedProgress`), because a reader cannot compute it -- the sync cursor is opaque behind the storage seam (ADR-0027) -- and a second mechanism would be two failure modes for one question. It carries `lastToBlock`, `latestBlock` and `blocksBehindTip`, which is the vocabulary a tab already binds to a progress bar, read from the stream's own coverage claim and not from anybody's cursor. A `progress` frame is sent ON CONNECT and again whenever the figures move; a `state-moved` frame is never replayed, which is the same split ADR-0082 already makes on a tab's port (progress is a STATE and answers a late joiner, a notification is a thing that HAPPENED and does not).

**A connecting client is told the position and the coherence token at once**, which is how a remote reader converges: it has no store to re-read and the query layer is deferred, so it compares the token it holds against the one in force and knows immediately whether it is stale. `ReceivingIndexer.coherenceNow()` / `Indexer.coherenceNow()` are the new reads that answer it (opaque, compared, never parsed; they rotate nothing and publish nothing), forwarded onto a server host through `IndexerRegistryEntry.coherenceNow`, paired with `onStateMoved`.

**The server holds nothing per client**: one handler reference per open stream and no client identity at all, nothing buffered, nothing retried, nothing replayed. A disconnect detaches. There is deliberately NO heartbeat: an interval invented here is the polling interval the signal exists to replace, and a dropped idle stream costs a reconnect that is answered at once with the position and the token.

**It REFUSES where it cannot be served, rather than accepting a connection nothing will ever write to.** Two `501`s: `state-moved-unsupported-runtime` when the host has not declared `ServerOptions.holdsStreamsAcrossRequests` (new, absent means no), and `state-moved-not-published` when the name resolves to a host holding a bare receiver and no container. The condition is a capability the HOST declares and never a runtime this package detects, because it names no runtime by test -- and the failure it prevents is exactly the invisible one: a subscriber registry that compiles, passes on Node and silently never fires on a Worker, which a reader cannot tell apart from a quiet chain.

**If you host the server on Node** (`@etherfold/platform-nodejs`), the capability is now declared for you and `etherfold index` serves the stream. **If you host it on Cloudflare Workers**, it is deliberately not declared and the endpoint refuses: an I/O object created in one request handler is unreachable from another, so an ingest POST could not write into it. The remedy is a Durable Object, which belongs to whoever adds the subscription adapter.

No GraphQL runtime, schema or subscription is added, and none is needed: the signal is the primitive, a subscription is a derivable adapter over it, and the producer is transport-agnostic -- a second transport subscribes at `IndexerRegistryEntry.onStateMoved` with no change to the code that publishes.
