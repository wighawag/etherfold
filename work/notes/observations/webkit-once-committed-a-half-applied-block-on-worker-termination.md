---
title: 'WebKit once COMMITTED a half-applied transaction when a worker was terminated, which is the atomicity `applyBlock` rests on'
slug: webkit-once-committed-a-half-applied-block-on-worker-termination
observed: 2026-09-12
---

2026-09-12 — Found while searching Bugzilla for duplicates before filing the wedge report (`work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`), and it is a different and more dangerous bug than the one being filed.

**WebKit bug 288682, "IndexedDB in Worker commits when thread is terminated"** (reported 2025-02-27 by Fastmail, RESOLVED FIXED 2025-03-27, commit 292795@main): *"When a worker thread running an indexedDB transaction is terminated, WebKit can COMMIT the half-complete transaction rather than aborting. This makes transactions, well, non-transactional, which can cause severe data corruption."* Apple's analysis (sihui_liu@apple.com) is that a transaction auto-commits when no further request is scheduled, and that during worker termination WebKit does not run microtasks, so a promise-driven chain schedules nothing and the transaction is committed as if it were finished.

**That is precisely this project's write path, on precisely the case we test.** `IndexedDBStateStore.applyBlock` is "one block is one transaction" and the sync cursor is written inside it (ADR-0027), and the whole point is that a block applies whole or not at all. Every request inside it is awaited through a promise (`idb.ts`'s `request`), which is the shape the bug report names. And `packages/browser/browser/restartsAndResumes.spec.ts` deliberately terminates a worker WHILE a block is being applied, which is the exact trigger.

If a half-applied block can commit, the guarantee that fails is not "the fold is slow to resume" but "the cursor never describes state that is not there": a block record and a cursor could land with only some of the block's rows, and every later read would be wrong with nothing to indicate it. Our own test would not catch it, because it asserts the RANGES the replacement fetched and the final state after a full resume, not the state at the instant of the kill.

**It is fixed upstream**, so this is not a bug to file; it is a statement about which engines a browser deployment can trust. The fix landed in WebKit main on 2025-03-27, which means iOS and Safari releases built before roughly that date carry it. The phone used for the wedge measurements, iOS 18.3.2 (Safari 18.3.1), predates it.

## What is NOT known, and what would settle it

Nobody has checked whether this project can still produce a half-applied block on an affected engine. Three things would settle it:

1. **Which shipped versions carry the fix.** "Committed to main in March 2025" is not a Safari version, and **Bugzilla does not record one**: 288682's `target_milestone` is `---`. So the mapping has to come from somewhere else, and it decides whether this is a live risk or a historical note. The empirical answer available today is not reassuring: the phone used for the wedge measurements is on iOS 18.3.2 in September 2026, about eighteen months behind, so "users are on a fixed version" is an assumption this project's own test hardware already falsifies. 288682 carries an attached testcase (attachment 474365) which would settle it for a given device directly.
2. **Whether our shape triggers it at all.** The bug needs the transaction to look finished during termination. `applyBlock` awaits `committed(tx)` at the end and issues its writes synchronously in the same turn where it can, so it may or may not present the window the report describes.
3. **A test that would see it.** The existing case asserts the resumed end state. Catching a half-applied block needs an assertion at the moment of the kill: that the block record, the cursor and the rows the block wrote either all exist or none do. That is a stronger claim than anything currently asserted, and it is worth having on every engine rather than only as a WebKit guard, because it is the seam's own promise.

**A landed fix nearby is not evidence the area is correct**, and this investigation has already shown that twice over: 315804 fixed a transaction that never settles in June 2026, and the wedge being filed still reproduces on a build newer than that fix.

Recording this rather than acting on it, because the wedge work is what is in flight and this is a separate question with its own evidence to gather.
