---
title: 'WebKit once COMMITTED a half-applied transaction when a worker was terminated, which is the atomicity `applyBlock` rests on'
slug: webkit-once-committed-a-half-applied-block-on-worker-termination
observed: 2026-09-12
---

> **RESOLVED 2026-09-13.** The regression never reached a shipped iOS, measured on hardware rather than reasoned about. The test written to answer it stays, because the guarantee is ours and not WebKit's.

2026-09-12 — Found while searching Bugzilla for duplicates before filing the wedge report (`work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`), and it looked like a different and more dangerous bug than the one being filed.

**WebKit bug 288682, "IndexedDB in Worker commits when thread is terminated"** (reported 2025-02-27 by Fastmail, RESOLVED FIXED 2025-03-27, commit 292795@main): *"When a worker thread running an indexedDB transaction is terminated, WebKit can COMMIT the half-complete transaction rather than aborting. This makes transactions, well, non-transactional, which can cause severe data corruption."* Apple's analysis (sihui_liu@apple.com) is that a transaction auto-commits once no further request is scheduled, and that during worker termination WebKit does not run microtasks, so a promise-driven chain schedules nothing and the transaction is committed as if it had finished.

**That is precisely this project's write path, on precisely the case we test.** `IndexedDBStateStore.applyBlock` is "one block is one transaction" with the sync cursor written inside it (ADR-0027), and every request inside it is awaited through a promise (`idb.ts`), which is the shape the bug turns on. `browser/restartsAndResumes.spec.ts` terminates a worker WHILE a block is being applied, which is the trigger. If a half-applied block could commit, what fails is not "the fold is slow to resume" but "the cursor never describes state that is not there", and every later read would be wrong with nothing to indicate it.

## What settled it

**A release that CANNOT contain the fix passes the reporter's own testcase.** iOS 18.3.2 shipped on 2025-03-11 (Apple, support.apple.com/en-us/122281); the fix landed in WebKit main on 2025-03-27, sixteen days later. Fastmail's testcase (attachment 474365, fetched from Bugzilla rather than reimplemented) passes on an iPhone 12 running that release.

The only reading that fits is that **the regression never reached a shipped iOS**, which is what 288682's own metadata says if read carefully, and which nobody read at first: its `version` field is `Safari Technology Preview`, and the reporter describes the corruption as happening to "iOS beta testers". It was a beta regression, caught and fixed before release.

The honest limits: one device, and the testcase is a race, so this is strong evidence rather than proof. It is being closed because three independent things agree — the pass, the STP version field, and the reporter's own wording — and because the risk it described is now covered by a test either way.

Asking any device the same question takes one command:

```sh
curl -s https://bugs.webkit.org/rest/bug/attachment/474365 \
  | python3 -c "import json,sys,base64,pathlib; pathlib.Path('t.zip').write_bytes(base64.b64decode(json.load(sys.stdin)['attachments']['474365']['data']))"
unzip t.zip -d testcase && cd testcase && python3 -m http.server 8000 --bind 0.0.0.0
```

## What was built anyway, and why it stays

The guarantee is the seam's, not WebKit's, and nothing asserted it on any engine. `browser/blockAtomicity.spec.ts` kills a worker inside `applyBlock` and reads the database back cold, checking that three facts agree per block: the block record, the cursor, and the rows that belong to that block and no other. **600 kills across three engines, zero torn commits.**

Two things make it an instrument rather than a formality. It **reports its own aim** — 7 to 9 of every 10 kills die with a block announced and not landed — and the spec refuses a run that never managed it, because a kill that always fell between transactions would pass while asserting nothing. And it was **falsified before being trusted**: injecting one artificial inconsistency, a block record with no rows, makes it fail.

## The thing worth keeping from this

The fix's existence was never the reassurance it looked like. "Fixed upstream in March 2025" told us nothing about which releases were affected, and the first instinct — map the commit to a Safari version — was the wrong question, because the answer turned out to be "no release ever needed it". What actually settled it was reading the bug's own metadata properly and then asking a real device. Both were cheap; neither was the first thing tried.
