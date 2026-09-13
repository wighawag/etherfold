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
