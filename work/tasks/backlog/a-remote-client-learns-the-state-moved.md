---
title: 'A remote client learns the state moved'
slug: a-remote-client-learns-the-state-moved
spec: a-reader-learns-when-the-state-moved
blockedBy: [the-receiving-container-publishes-what-it-applied]
covers: [2, 8]
---

## What to build

The same signal, from a hosted indexer to a client over the network, so that an app reading from a server and an app indexing in its own browser run the same handler.

On a server the producer is the ingesting side, which is the same rule as everywhere else: whoever applied the block tells whoever is reading. Nothing derives change by watching storage, because a store that must be watched implies either polling or a change feed nobody asked for.

**Know where that producer actually is before you start.** The server package applies no blocks: its ingest route delegates to a receiver the HOST constructed, and the fold happens in the receiving container in `@etherfold/core`. The previous task put the publication there. What this task builds is the TRANSPORT and the route, subscribing to that publication; if you find yourself adding a fold or a publication inside `@etherfold/server`, you are rebuilding something that exists one layer down.

The transport is server-sent events. It is the honest fit for a block-paced, one-directional, best-effort signal, and it needs no socket lifecycle. Nothing is buffered for a client while it is away.

**Sync progress rides this stream too**, which is the cross-NETWORK half of the same decision that puts it on the cross-tab channel: an app reading from a hosted indexer must be able to render "syncing, N blocks behind" without a second mechanism, and it cannot compute it, because the cursor is opaque behind the storage seam (ADR-0027). The server knows its own position already.

**How a reconnecting client converges, given there is no state query surface yet.** The server exposes status, ingest, feed and admin; the query layer is deliberately deferred to `the-same-query-runs-against-a-worker-and-a-server`, and the feed is the CONSUMER path with its own cursor rather than a state read. So convergence here is NOT "re-query and compare": a client that connects is TOLD the current position and coherence token immediately, so it knows at once whether what it holds is stale. Per-operation block pinning and re-query convergence arrive with the query spec, not here.

**It is NOT SUPPORTED on Cloudflare Workers, and the host must say so rather than appear to work.** A Worker invocation is isolated, so an I/O object created in one request handler cannot be touched from another: an ingest POST cannot write into a stream opened by a different request. The remedy would be a Durable Object, which is infrastructure this deployment has not taken on and a question that belongs to whoever adds the subscription adapter later. What makes silence unacceptable is the failure mode: the server package deliberately names no runtime, enforced by its own platform-agnostic test, so a module-global subscriber registry COMPILES, passes on Node, and never fires on a Worker, which a reader cannot tell apart from a quiet chain. Refuse the endpoint where it cannot be served.

**Build the producer so that a later GraphQL subscription is an ADAPTER over it, not a rewrite of it.** A subscription over WebSocket or over SSE is wanted eventually, and this is the decision that keeps it cheap: the thing that knows a block was applied publishes the signal to a transport-agnostic seam, and SSE is the first subscriber to that seam rather than the place the publication logic lives. Adding a `graphql-ws` or hibernating-socket adapter later must require no change to the producer. Build that seam; do not build the subscription.

Explicitly out of scope: any GraphQL runtime, schema or subscription implementation. This is the plain signal. Note also that the notification model already decided the query executor stays promise-returning with no `AsyncIterable`, so nothing here should widen a query surface.

## Acceptance criteria

- [ ] A client connects to the server, receives the signal as the ingesting side applies blocks, and disconnects cleanly.
- [ ] The payload is the same notion the fold publishes — block, coherence token, entity names, generation — serialised identically to what a browser client receives, so one handler reads both.
- [ ] A remote client can render how far behind the fold is, from this stream, without a second mechanism and without deserialising a cursor.
- [ ] A retraction and a promotion both cross this transport and rotate the token the same way they do locally.
- [ ] The server holds no per-client state: nothing is buffered, nothing is replayed to a reconnecting client, and attaching many clients does not grow the producer's bookkeeping.
- [ ] A client that connects mid-fold is told the current position and token at once, so a reconnecting client that missed notifications knows immediately whether what it holds is stale.
- [ ] On a runtime that cannot hold the connection across invocations (Cloudflare Workers today), the endpoint REFUSES rather than accepting a connection it will never write to, and a test asserts the refusal. The condition is a capability the HOST declares, never a runtime the server package detects: a source-scan test forbids `node:`, `@cloudflare/` and `D1Database` inside that package, so a platform sniff is not merely discouraged, it does not compile past the gate.
- [ ] The producer is transport-agnostic: a second transport could subscribe to it with no change to the code that publishes. Demonstrated by an in-process subscriber in the tests, which is also how the case is asserted without a network.
- [ ] No GraphQL runtime, schema or subscription is added.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`the-receiving-container-publishes-what-it-applied`, which is what makes a server-shaped deployment able to publish at all (and which is itself blocked on the root task that defines the signal).

## Prompt

The goal is that pointing an app at a hosted indexer instead of at its own browser worker changes a deployment choice and not a line of the app's notification handling.

Read `work/specs/tasked/a-reader-learns-when-the-state-moved.md` and **ADR-0083**, which records both the signal's shape and the position on subscriptions: the signal is the PRIMITIVE and a GraphQL subscription is a derivable adapter over it, anticipated for the server over WebSocket or SSE and deliberately not built now. The asymmetry is the reason: a subscription is derivable from a signal by wrapping it, while a signal is not derivable from a subscription without a GraphQL runtime, which is exactly what a read-surface-only app has deliberately not loaded.

Where to look: `@etherfold/server`'s API routes for the shape of a route and how a host supplies capabilities, and `@etherfold/core`'s receiving container for the publication you are subscribing to. The CLI is the second caller and is worth reading so the access shape suits both. The **feed** is a neighbour you must not conflate with this: a feed reader is what `CONTEXT.md` reserves the word **consumer** for, it owns its own cursor, and it reads the sequenced emission stream on its own cadence. This signal is not that; it is a best-effort nudge to a reader that holds no cursor. Keep the two separate in naming and in code, or the next reader will assume this has delivery guarantees it does not have.

Read `work/notes/findings/a-worker-cannot-hold-a-timer-across-requests.md` before you design the producer. It is the same isolation constraint seen from the timer side, and it is why the Cloudflare case is decided as unsupported rather than left to the build. Read `packages/server/test/platformAgnostic.test.ts` too: the server package names no runtime, by test, which is exactly what would let a Node-only design ship green and dead.

The seam to test at is the server's existing API test setup, plus an in-process subscriber to the producer seam, so the "a second transport needs no producer change" claim is demonstrated rather than asserted.

Done means: a remote client is told the state moved and how far behind the fold is, gets the same value a local one gets, the server remembers nothing about it, the Worker case refuses honestly, and a future subscription adapter has somewhere to plug in.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. The route's shape, HOW the unsupported-runtime refusal is detected (a capability the host declares beats sniffing the platform), and whether a heartbeat comment is sent to keep intermediaries from closing an idle stream, are all such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
