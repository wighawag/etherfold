---
title: openForWriting has no way to say the store is unusable, and a wedged browser store proves it needs one
slug: a-claim-that-can-refuse
---

## The gap

`openForWriting` claims a store by clearing the seam's `writerClaim` record, and its documented contract is emphatic: **"It does not block and it does not wait. There is no queue and no lease: a loser is not waiting its turn, it has lost."** The failure vocabulary that follows from that is a single verb -- a writer that has lost learns so at its next mutation, as `StoreWriterChangedError`.

That vocabulary has no word for a store that will never answer. It has been assumed that the backend either performs the clear or throws, and one backend has now been measured doing neither: on WebKit, a database can be left permanently unable to run any transaction (`work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`), so `clearSeamRecord('writerClaim')` never settles and `openForWriting` never returns. The host stays in `phase: 'waiting'` for ever, and the application has nothing to render, nothing to act on and nothing a reload will fix.

So the contract is false in both directions at once: the call DOES block, for ever, and the caller is given no way to find out.

## The shape a fix would take

A bounded wait on the claim, and a typed refusal when the bound is passed -- something an app can catch by name, the way it catches `StoreWriterChangedError`, and render as "this browser's local index is unusable; clear it and re-sync".

## Why this is an ADR and not a patch

It is a change to a PUBLISHED seam's failure vocabulary, and it lands on every backend at once.

- **Every backend has to answer identically.** `@etherfold/state-store-conformance` is what says they do, so a new refusal is a new conformance case that `MemoryStateStore`, the SQLite backend, the patch store and the IndexedDB backend must all satisfy. What does a memory store, which cannot wedge, do with a timeout?
- **A bound is a number nobody has.** Too low and a cold, contended, or merely slow store is declared dead while it was about to answer; too high and the app has already been staring at a spinner. It is also the first TIME-based decision anywhere near this seam, and the claim's whole design rests on there being no lease and no expiry.
- **A refusal is not a recovery, and on the measured case the obvious recovery does not work.** A reload does not clear the wedge, a new tab does not clear it, and `deleteDatabase` never completes, so "clear my local index" is not available. The only escape found inside a browsing session is to open a DIFFERENT DATABASE NAME, which is a full re-index and a decision about the user's time that a seam cannot take on an application's behalf. If a refusal is worth having, so is naming that as the documented way out.
- **It may belong one layer up.** `hostIndexerInThisWorker` could bound `createState` and report a host FAILURE through the port -- which is a surface that already exists (`HostProgress.failure`), already crosses to the tab, and does not touch the seam's contract at all. That is a smaller change and reaches the same application. The argument against it is that a store wedged under a server-side fold gets nothing, and that the seam is where the truth is known.

## What is already decided

Nothing. The measurement is done and it is not going away by itself: the wedge is a WebKit defect that has yet to be reported, let alone fixed, so every Safari user of a browser deployment can reach this state and no version of the product tells them.
