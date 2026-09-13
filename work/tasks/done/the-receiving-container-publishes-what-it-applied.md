---
title: 'The receiving container publishes what it applied'
slug: the-receiving-container-publishes-what-it-applied
spec: a-reader-learns-when-the-state-moved
blockedBy: [the-fold-publishes-what-it-just-changed]
covers: []
---

## What to build

The same signal, on the OTHER container, so that a server and the CLI can publish it at all.

The rule is "whoever applied the block tells whoever is reading", and this system has two things that apply blocks. The chain-facing container fetches, detects reorgs and folds; the RECEIVING container folds a stream it is pushed and is deliberately chain-free. Every server and CLI deployment runs the second one. It publishes nothing today, by explicit design, and that design predates anything needing a notification.

So this task gives the receiving path the same publication the previous task gave the chain-facing one, **reusing that task's assembly rather than writing a second one**. The signal type, the token, the rotation rules and the app-facing handler shape are already decided and built; what is missing is that one of the two containers never emits them. Two implementations of one publication seam is the outcome to avoid: one notification model is the whole point of the spec it comes from, and two producers that drift is exactly how that claim dies.

Worth knowing before starting, because it is the thing most likely to be assumed wrong: the server package APPLIES NO BLOCKS. Its ingest route delegates to a receiver the host constructed, so the publication belongs in the receiving container in core, and what the server needs is a way to reach it. The transport task that follows is what exposes it to a client.

## Acceptance criteria

- [ ] A fold driven through the receiving container publishes the same `StateMoved` a chain-facing fold does, from the same assembly rather than a parallel implementation.
- [ ] A retraction and a promotion rotate the token identically on this path, asserted here rather than assumed from the other container.
- [ ] The touched-entity set arrives through the same relay the chain-facing path uses, so an entity-declared processor reports real names on a server.
- [ ] A host (the server, the CLI) can subscribe to it, so the transport task has something to attach to.
- [ ] The receiving container's existing deliberate silence about state handles is unchanged in every other respect; this adds a notification, not a state-publication surface.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`the-fold-publishes-what-it-just-changed`, which defines the signal, the token and the relay that carries the entity set. This task extends that work to the second container and must not re-invent any of it.

## Prompt

The goal is that the deployment shape which actually runs on a server can publish the notification at all.

Read `work/specs/tasked/a-reader-learns-when-the-state-moved.md` and **ADR-0083** for the model, then the previous task's implementation, because your job is to EXTEND it rather than to mirror it.

Where to look: `@etherfold/core` holds both containers — the chain-facing one and the receiving one — and the receiving one folds a pushed stream through the stream builder. Read the receiving container's own documentation of what it deliberately does not publish and why, and be careful to leave that intact: it withholds a state HANDLE, which is a different thing from withholding a notification, and conflating the two would either reopen a decision that was made on purpose or leave this task undone. `@etherfold/server`'s ingest route and the CLI's receiving path are the two callers that will want to subscribe; read them to see what shape of access they can actually use, but expect the publication itself to live in core.

`CONTEXT.md` describes both containers and reserves **consumer** for a reader of the FEED, which is a different thing from a reader of this signal. The feed has its own cursor and its own delivery guarantees; this does not.

The seam to test at is a fold driven through the receiving container over the conformance workload, with a subscriber attached, asserting the same properties the chain-facing tests assert.

Done means: both containers publish one model, a server-shaped deployment can subscribe, and nothing about the receiving container's deliberate silence on state handles has changed.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. How a host reaches the subscription, and anything you had to factor out of the previous task's implementation to share it, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**1. How a host reaches the subscription: an OPTIONAL `onStateMoved?` on `IndexerRegistryEntry`, forwarded by `indexerEntryOn`, plus one line on the CLI's `index` entry.** The publication lives in core, as the task says, but a server ROUTE holds an `IndexerRegistryEntry` and never the container, so `ReceivingIndexer.onStateMoved` alone would leave the transport task with nothing attachable inside `@etherfold/server`. I followed the existing precedent exactly rather than inventing one: `generations?`/`promote?` are already optional-and-forwarded-when-present, and absence is already read as a capability statement there. That makes `singleContextEntry` (a host with a bare receiver and no container) report no subscription, which is what lets the transport task REFUSE rather than attach to silence — the failure mode ADR-0083 names for Cloudflare Workers. Alternatives considered: (a) leave the server untouched and let the transport task add the member — rejected, because "a host can subscribe, so the transport task has something to attach to" is this task's acceptance criterion and the shape is the decision, not the wiring; (b) a separate `subscribeToStateMoved` name — rejected as a second convention for one idea (`@etherfold/browser`'s `IndexerPort.onStateMoved` already fixed the name). It touches `@etherfold/server`, the CLI's `index` command, and the remote-transport task, which now has a named attachment point.

**2. Which fold is canonical is answered from an IN-MEMORY `canonicalFold`, re-read wherever the pointer is already consulted AND on the two paths that precede a fold.** "Only the canonical fold publishes" must be decidable synchronously, because a fold reports from inside `process()`. The chain-facing container compares against `Indexer.current`, an in-memory read pointer it owns; the receiving container deliberately has none and derives every answer from the durable registry. I added `noteCanonical`, called wherever this container already reads or writes the pointer (`add`, `canonical`, `canonicalGeneration`, `settlePromotion`, `movePointer`) and — this is the part that costs something — added one `registry.canonical()` read to `liveIngestions()` and `rebuildMore()`, the two paths a batch and a rebuild chunk go through before folding. Without those two, a pointer moved by another process (or by an admin route on a sibling isolate) would leave a retired generation publishing to readers. Alternatives considered: caching only at open (wrong across processes and across an admin promotion), and publishing without a filter (rejected outright: a follower here re-folds a whole stored stream, so an upgrade would fire thousands of notifications about past blocks). The residual is stated on the field, in the ADR and in the changeset: a cross-process move is not seen until the next read, so this container can briefly publish from a fold that stopped being canonical elsewhere — the same in-process staleness the chain-facing twin has, bounded by the same best-effort decision. It touches every deployment's ingest hot path by one small SELECT per batch.

**3. Nothing was extracted from the previous task's implementation; the shared assembly was already the right seam.** `StateMovedPublisher` already owned the subscription, the containment and both rotations, so "reuse rather than mirror" is satisfied by each container holding an instance. What is duplicated is the ~40-line container half (`relayFoldReports` / `publishFoldReport` / `onStateMoved`), and I deliberately did NOT hoist it into a shared base class or mixin: the two containers share no hierarchy today (`ReceivingIndexer` is not an `Indexer` and could not be — one holds chain-facing engines, the other `StreamBuilder`s), and the half that differs is precisely the load-bearing one (`entry === this.current` versus `fold === this.canonicalFold`, decision 2). A base class would have had to abstract exactly the line the two genuinely disagree about, which buys nothing and hides the disagreement. Alternative considered: a free function taking `(publisher, generationRecord, report)` — rejected because the filter, not the assembly, is what would still have been written twice. The difference is recorded in ADR-0083 so it is a stated asymmetry rather than a discovered one.

**4. A test-util change shared across three existing suites.** `receivingWorld.ts`'s `foldingProcessor` now implements `setFoldReporter` and reports a retraction plus one applied block per block, from inside `process()` in the same order the shipped entity fold reports (its reported entity name is a constant, `REPORTED_ENTITY`, because names are asserted where they are produced). To avoid a second definition of "which blocks did this stream apply" and "what fork point did it revert to", it imports `appliedBlocksOf`/`forkPointOf` from `stateMovedWorld.ts` and I made those two generic over `ABI` rather than casting. This touches `rebuild.test.ts` and `theCanonicalPointerMovesBack.test.ts`, which share that world; both stay green (reporting with no reporter attached is a no-op).
