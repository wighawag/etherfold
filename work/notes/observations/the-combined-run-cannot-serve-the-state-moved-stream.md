---
title: '`etherfold run` cannot serve the state-moved stream, because registering a name would open the ingest write path'
slug: the-combined-run-cannot-serve-the-state-moved-stream
observed: 2026-09-13
---

2026-09-13 — Noticed while building `GET /{indexer}/state-moved` (`a-remote-client-learns-the-state-moved`). The route reaches the publication through `IndexerRegistryEntry.onStateMoved`, so it answers only on a host that REGISTERS a named indexer — which is `etherfold index`, and deliberately not `etherfold run`: `packages/cli/src/run.ts` passes no `getIndexer` on purpose, because registering the container there would open `/{indexer}/ingest` to a remote sender, which is the second writer that command exists without. So the combined deployment the milestone calls the default (`CONTEXT.md`, "The COMBINED deployment is the milestone") folds, serves HTTP, and answers `501` on the one endpoint an app pointed at it would subscribe to.

Not fixed here, and not obviously a bug: it is the visible edge of a deliberate decision about the write path. But the goal this transport was built for is "an app reading from a hosted indexer", and `run` is the shape most apps will point at, so somebody should decide whether a read-only registration (an entry that answers `onStateMoved` / `coherenceNow` and nothing a write path reads) belongs there. `one-handler-for-every-transport` is the task that will next look at all three transports together.
