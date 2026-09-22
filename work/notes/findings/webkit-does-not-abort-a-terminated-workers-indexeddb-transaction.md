---
title: 'Terminating a worker with two IndexedDB transactions in flight wedges the database for ever, on WebKit'
slug: webkit-does-not-abort-a-terminated-workers-indexeddb-transaction
observed: 2026-09-12
source: 'measured by packages/browser/browser/restartsAndResumes.spec.ts with the store-open probes in browser/indexer.worker.ts, and by the probes packages/browser/spikes/webkitWedge.spec.ts and packages/browser/spikes/webkitWedgeGrowth.spec.ts (results in docs/spikes/webkit-terminated-worker-wedges-indexeddb/results/) @ 95892571, against Playwright 1.62.1 (chromium, firefox, webkit-2359) on Linux, and CONFIRMED ON REAL HARDWARE -- iPhone 12, iOS 18.3.2, Safari 18.3.1, 12 wedged in 200 -- via docs/spikes/webkit-terminated-worker-wedges-indexeddb/bug-report/index.html, 2026-09-12'
---

> **This note's first two revisions were wrong, and its third was too narrow.** It claimed WebKit fails to abort a terminated worker's IndexedDB transaction and that the surviving transaction blocks the next WRITER. A minimal probe falsified that, and the note was then rewritten to say only where the hang was. The cause is now established, and the effect is much larger than "the next writer": the whole DATABASE is permanently unable to run any transaction. The wrong versions are described below rather than quietly deleted, because the plausible-and-wrong mechanism is what a reader is most likely to arrive at independently.

## The defect

**Terminating a dedicated worker that has BOTH a `readwrite` and a `readonly` transaction in flight on one IndexedDB database can leave that database permanently unable to run any transaction at all.** On WebKit only.

**It is not a test-harness artefact.** It reproduces on REAL Apple hardware running the shipping engine: an iPhone 12 on iOS 18.3.2 / Safari 18.3.1 wedged **12 databases in 200 runs (6%)** of the standalone page, with no framework and no etherfold in it, in a foreground tab (the page marks a backgrounded run contaminated, because IndexedDB after SUSPENSION is the different, already-reported problem). Playwright's Linux build reports a much newer engine in its user agent (`Version/26.5`), so the defect is present in an old shipping release and in a recent upstream build at once, on two different ports -- which puts it in cross-platform code rather than in one port's plumbing.

Afterwards, from every context in the origin -- the page, a replacement worker, any later one:

- `indexedDB.open` **succeeds** and reports every object store;
- every transaction taken on the resulting connection then **hangs for ever**: no `complete`, no `abort`, no `error`;
- it hangs `readonly` transactions as hard as `readwrite` ones, on any object store, so it is not a lock a writer is queued behind;
- an **unrelated database in the same origin is healthy**, so it is the database and not the origin's IndexedDB;
- a **page reload does not clear it**, **a new tab does not clear it**, and a `deleteDatabase` issued afterwards never completes.

Permanence was measured, not assumed: the product's wait was raised from 15 s to 100 s, and every wedged probe run re-asks after a reload and again from a second page in the same context. **The only escape found inside a browsing session is a DIFFERENT DATABASE NAME**, because unrelated databases stay healthy (`unrelated=ok` on every wedged run) -- which for this product means re-indexing from scratch.

It is not `terminate()` specifically. A worker asked to shut itself down with `self.close()` wedges the database at the same rate or higher (9/200, the highest of any variant), so "ask the host to exit gracefully instead of killing it" is not a workaround. What matters is that the worker ends while two of its transactions are in flight, not how it is ended.

## What has to be true for it

Measured over 200 runs per variant per engine (`spikes/webkitWedgeGrowth.spec.ts`, results in
`docs/spikes/webkit-terminated-worker-wedges-indexeddb/results/growth-*.json`):

| what the doomed worker was doing when it was terminated | chromium | firefox | webkit |
| --- | --- | --- | --- |
| ONE `readwrite` held open for ever (the first probe's case) | 0/200 | 0/200 | 0/200 |
| a stream of `applyBlock`-shaped `readwrite` transactions, alone | 0/200 | 0/200 | 0/200 |
| ...the same, killed at a random point instead of on a write announcement | 0/200 | 0/200 | 0/200 |
| one `put` per `readwrite` transaction, alone | 0/200 | 0/200 | 0/200 |
| ...plus a second `readwrite` loop on another store | 0/200 | 0/200 | 0/200 |
| ...plus a **`readonly` loop** on another store | 0/200 | 0/200 | **3/200** |
| `applyBlock`-shaped transactions plus a `readonly` loop | 0/200 | 0/200 | **3/200 - 6/200** |
| ...ended by `self.close()` rather than `terminate()` | 0/200 | 0/200 | **9/200** |
| the write loop in the worker, the `readonly` loop in the **surviving page** | 0/200 | 0/200 | 0/200 |
| a read and a write, each awaited to COMMIT, never overlapping | 0/200 | 0/200 | 0/200, and **0/1000** on webkit |

So it is not about how long a transaction is held, how many object stores it spans, whether it has indexes, or where in its life the kill lands. **It takes two transactions of the DYING context overlapping at `terminate()`, and one of them being `readonly`.** It needs nothing of etherfold: two plain object stores, a `put` loop and a `get` loop are enough.

The rate is a few percent per kill. The product case reproduces at roughly 1 in 8 to 1 in 12 because it kills deliberately, and because `terminate()` only sometimes lands in the window.

## Where the product's overlap comes from, and why it is not a bug of ours

Every read on `@etherfold/state-store-indexeddb` opens a transaction, awaits the REQUEST, and returns -- it never awaits the transaction's commit:

```ts
const store = db.transaction(CURRENT, 'readonly').objectStore(CURRENT);
const record = (await request(store.get(rowKey(declaration, id)))) as CurrentRecord | undefined;
```

That is ordinary IndexedDB and every wrapper does it, but it means a read's `readonly` transaction is still open for a moment after the caller has moved on. A call trace of the wedging run shows exactly that and nothing else: at the seam the calls are strictly sequential (`getCurrent` ends, then `applyBlock` starts), so the only overlap available is a read transaction still committing under the write that follows it.

**We are also one of the things that pulls the trigger.** `dedicatedWorkerHost` is built with `close: () => worker.terminate()` (`src/host/dedicatedWorker.ts`), and `port.ts`'s `died()` calls `corpse.close?.()` on every concluded death. A death is concluded from SILENCE -- a host that did not answer a probe -- so the host most likely to be terminated by us is a host that was busy, which is exactly the host most likely to have transactions in flight. The browser evicting a worker is out of our hands; this half is not.

The candidate that motivated the whole re-examination -- an ordering bug of our own in `claimOrCheck`/`clearSeamRecord`, which was thought to `await` between creating a transaction and issuing its first request -- **was examined and is not real**. `clearSeamRecord` creates the transaction and `claimOrCheck` issues `writer.put` in the same synchronous run; the only `await` is of an async function that has already issued its request. Both guarded paths are the same shape. There is no ordering bug there to fix.

## What was FALSIFIED on the way

The obvious mechanism -- a terminated worker's transaction keeps holding the object store, so the next writer queues behind it for ever -- does not survive `spikes/webkitWedge.spec.ts`, which holds ONE `readwrite` open indefinitely, kills the worker mid-transaction, and then asks the database for everything. All three engines answer identically: a new connection, a `readwrite` from the tab, a `readonly`, and a `readwrite` from a SECOND WORKER all succeed, and `deleteDatabase` is blocked everywhere merely because a live connection is open. That probe is still correct and still worth keeping: it is what says the effect is not the obvious one, and its shape is now one row of the table above (0/200 on every engine).

What it got wrong was to ask only whether the next WRITER was blocked, and to ask the tab first. Asking any transaction, from any context, is what turned a narrow question into the real signature.

## Why this matters

ADR-0082's restart-and-resume exists because a browser may evict a worker. If an eviction mid-write can wedge the database permanently, the app is left in `waiting` with nothing to render, nothing to act on, and nothing a reload will fix. It also sits against the storage seam's stated contract, that `openForWriting` "does not block and it does not wait".

## Upstream

**FIXED upstream on 2026-09-22, nine days after it was filed.** [321564@main](https://commits.webkit.org/321564@main) (`e8f6a9f2b506`, PR 73930), by Ahmad Saleem, reviewed by Sihui Liu, tracked as `rdar://187349025`. The reproduction went upstream with it as a web-platform test, `IndexedDB/transaction-inflight-worker-terminate.window.html` ([wpt#62846](https://github.com/web-platform-tests/wpt/pull/62846), 50 iterations at 3 s patience), so the case is now a cross-engine regression test rather than only ours.

**The cause is one place, and it accounts for the whole signature.** The server releases a connection, aborting its in-flight transactions and freeing the object-store scheduling scopes, only on `databaseConnectionClosed`. `IDBDatabase::stop()` reached that only through `close()` -> `maybeCloseInServer()`, which WITHHOLDS the message while any transaction is still active or committing. Once the worker's context is stopped those transactions can never complete on that thread, so the message is never sent, and the destructor fallback that would have sent it is defeated by the reference cycle between `IDBDatabase` and the stranded transaction. The server therefore keeps the orphaned `readwrite` in progress for ever, and since the SQLite backing store serialises read-writes, that one orphan blocks every later transaction on the database, `readonly` as much as `readwrite`. The fix has `stop()` close the connection in the server unconditionally, on the grounds that no transaction can complete after the context is stopped.

That also explains the two asymmetries the table above measured and could not explain: one transaction alone left no reference cycle for the destructor safety net to trip over (0/200), and a `readonly` belonging to a SURVIVING context never went through `stop()` at all (0/200).

**When it ships is not the same question as when it landed.** Safari 27.0 shipped 2026-09-14, eight days BEFORE the fix, so it carries none of this; the earliest release that can carry it is 27.1 (roughly November) if it is picked into that branch, and 27.2 is the safer assumption. STP 252 (posted 2026-09-10, covering up to 320112@main) predates it by some 1,450 commits, and STP 253's cutoff falls short too, so the first testable build is STP 254 or later, around early October. The STP rows are an estimate from the published ranges and the trunk commit rate, not an Apple statement; the bug carries no `target_milestone`.

**Not a duplicate, but it has four close relatives and a report that ignored them would look unsearched.** Checked through Bugzilla's REST API on 2026-09-12, over all 298 bugs in the `Website Storage` component plus a full-text sweep for `Worker.terminate` across every component:

- **288682** (FIXED, 292795@main, 2025-03) -- *IndexedDB in Worker commits when thread is terminated*. The same trigger family and the OPPOSITE failure: a terminated worker's half-finished transaction was being committed rather than aborted. Apple's analysis there is that WebKit does not perform microtasks during worker termination and so concludes no further requests are coming, which is the same machinery this sits in.
- **315804** (FIXED, 315609@main, 2026-06) -- a `readwrite` transaction that never fires `oncomplete`, `onerror` or `onabort` after a web-push subscribe in an installed PWA. Nearly identical symptom, unrelated trigger, and it recovered by itself after about 30 minutes; this one never recovers, and reproduces both on a build newer than that fix and on iOS much older than it.
- **324058** (NEW, filed 2026-09-12, the same day) -- transactions never start after a cross-site back navigation when a service worker controls the page, suspected there to be a regression from 322386. A third trigger for the same symptom.
- **251203** (NEW, open since 2023) -- *IndexedDB requests occasionally fail with no error, freezing browser*, reported in web workers, WebKit-only, with no trigger ever identified. This finding may be the reproduction that report has been missing, so the plan is to file separately and then comment there.

Three distinct triggers now produce "`open()` succeeds and then no transaction ever runs", which is itself an argument that the cause is one thing in transaction scheduling or connection teardown rather than three faults.

197050 and 202705 remain adjacent but different: they are about IndexedDB after the network process or the app is SUSPENDED, not after a worker ends.

**The component is `Website Storage`.** There is no `IndexedDB` component, which an earlier draft of the report asserted. A report is now worth filing and has what it needs: a self-contained page with no framework and no etherfold in it, `docs/spikes/webkit-terminated-worker-wedges-indexeddb/bug-report/index.html`, which reproduces at 12-13 in 200 in Safari's engine and 0 in 200 on the other two, and which prints the full signature (unrelated database healthy, `deleteDatabase` blocked, still wedged after a reload).

## What was done

- The browser case does not assert something the platform cannot do. It asserts what holds everywhere -- either the fold resumed, or the tab can still see exactly where it stopped -- and refuses the outcome where a tab cannot tell the difference.
- The store-open probes are kept, because from outside a worker all three opening steps fail identically.
- `browser/cut.ts` records an error's MESSAGE as well as its stack; on JavaScriptCore `stack` carries no message.
- **The reload claim is now measured rather than assumed, and it is the opposite of what was written.** A reload does NOT clear the wedge, in the product case or in the minimal one. The earlier "a reload recovers" came from the falsified probe, whose case is a different (recoverable) one.

## What was DECIDED, and built

**`oneTransactionAtATime`, off by default, and the library never sniffs an engine.** Settled 2026-09-12 on the measurements below: the option exists on `IndexedDBStateStoreOptions` and is forwarded by `createBrowserStateStore`; an application that wants it decides in the TAB and passes the answer to its worker. `@etherfold/state-store-conformance` runs a fourth time with it on and the whole contract passes identically, so what it changes is latency and nothing else.

**The flag cannot be un-set by a version check, and will not be.** Asked and settled 2026-09-22, when the fix landing made "turn it off on fixed builds" a real question. There is no sound way to read a WebKit engine version from script, and the counterexample is already in this repo: `docs/spikes/a-multientry-index-over-computed-field-keys/results/webkit.json` records `Version/26.6 Safari/605.1.15` on a `Macintosh; Intel Mac OS X 10_15_7` user agent, from Playwright's LINUX build, which is the same build that wedges 7 to 13 in 200. The `Version/` token on the GTK and WPE ports is synthetic and decoupled from the engine revision, so a `Version >= X` gate would call our own CI fixed while it is measurably broken. `AppleWebKit/605.1.15` has been frozen since 2017, and `navigator.userAgentData` does not exist in WebKit, so there is no second source to cross-check against.

It fails a second time on the deployment that matters. The `Version/` token is ABSENT from Chrome for iOS (`CriOS`), Firefox for iOS (`FxiOS`), every WKWebView and a Home Screen web app, which is to say from most of the all-WebKit iOS population this finding is about, and from the same installed-PWA context that 315804 hit. The OS token rescues nothing: macOS freezes it at `10_15_7` and iPadOS reports a desktop user agent. Feature detection as a PROXY for the release is the only honest technique and is not writable yet, because it needs an API that shipped in the same release as 321564@main and no such release exists. Probing for the defect directly is worse than useless as a startup gate: it is probabilistic (a few percent per iteration, which is why the upstream test runs 50), every wedging iteration strands a database that `deleteDatabase` cannot then remove, and the one deterministic-looking variant measured 0/200 on BROKEN builds, so it does not discriminate.

So the engine check stays where it is, in the TAB, and the flag stays engine-shaped rather than version-shaped. What stands in for version detection is the refusal already built (item 2 below): a transaction that has not settled inside the caller's bound is directly observable, is engine-agnostic, and covers the other two open triggers for this symptom as well as this one. Detect the symptom, not the build.

Four reasons it is a flag rather than a default. It is a workaround for someone else's defect, so it must be removable in one line the day WebKit fixes it and not archaeology. It has a measured cost on Chromium and Firefox, which have no such bug. A deployment weighing slower reads against re-index-on-wedge may legitimately answer either way, which is a choice to hand over rather than to make. And a path taken only on WebKit is the path CI exercises least on the engine that needs it most, so the browser suite has to be runnable with the flag forced both ways on all three engines.

## What is NOT done

1. ~~**File it.**~~ DONE, 2026-09-13: [WebKit 324094](https://bugs.webkit.org/show_bug.cgi?id=324094), NEW, Website Storage, severity Major, with the standalone reproduction attached, plus a comment on [251203](https://bugs.webkit.org/show_bug.cgi?id=251203) offering this as the trigger that report has never had. It was RESOLVED FIXED on 2026-09-22; see Upstream for the mechanism and the shipping timeline. What is left is to re-run `webkitWedgeGrowth` against the first build that carries it, which is not STP 252 and probably not STP 253: a run that reports 0/200 on the WORST variant (`self.close()`, 9/200 today) is what retires the workaround for that engine version, and nothing retires it for the versions already on people's phones.
2. ~~**Tell the application.**~~ DONE. `openForWriting(store, {signal})` rejects with `StoreClaimAbandonedError`, the bound belongs to the caller and the seam invents no timeout, and the refusal travels out of `createState` into `phase: 'refused'` with a `failure` the tab reads over the port. `browser/restartsAndResumes.spec.ts` now asserts that end to end on a genuinely wedged WebKit database: refused in six seconds, by name, where it used to sit in `waiting` for ever. The HOST supplies the bound (`claimWithinSeconds`, ten by default) and hands it to `createState` as a signal, so an application forwards one token rather than inventing a number; every documented example forwards it. See `work/notes/ideas/a-claim-that-can-refuse.md` for what each of the objections turned out to be worth.
3. **The evidence behind that decision, kept because the cost is what settled it.** A worker that never has two transactions in flight never produced the wedge: **0/1000** on WebKit, against 8/200 for the same case with the overlap. That is the one lever that works, and taking it needs two changes, not one:
   - reads in `@etherfold/state-store-indexeddb` await `committed(tx)` rather than just the request, which removes the `readonly` that trails under every write;
   - store access in a hosting worker is SERIALISED, because the first change alone does not stop a read served over the port from overlapping a fold's write.

   It is a WebKit workaround, not a correctness fix, and it costs a commit round trip on every read plus port reads queueing behind block writes. **That cost was measured before deciding** (`packages/browser/spikes/commitWaitCost.spec.ts`, results in `results/commit-wait-*.json`): the shipped store against itself, same rows and same workload, `oneTransactionAtATime` off and on, 8 repeats with the order alternated, compared as PAIRED per-repeat ratios.

   | | chromium | firefox | webkit | absolute cost |
   | --- | --- | --- | --- | --- |
   | point read (`getCurrent`) | x1.37 | x1.84 | x1.37 | +35 to +118 us |
   | cursor read | x1.49 | x1.94 | x1.48 | +37 to +95 us |
   | as-of read (`getAsOf`) | x1.48 | x1.88 | x1.33 | +58 to +183 us |
   | listing (`listCurrent`, 100 rows) | x1.07 | x1.16 | x1.03 | +27 to +146 us |
   | fold ms/block with a reader hammering | x1.11 | x1.21 | x1.11 | +0.09 to +0.34 ms |

   **It is not cheap, and the hoped-for answer is dead.** A single-request read costs 33% to 94% more on every engine, because the commit round trip is the same order of magnitude as the read itself. "Just do it everywhere and stop worrying about detection" would put a 37% regression on every point read on Chromium for a defect Chromium does not have, against an ADR-0024 decision that rests substantially on this backend's read speed. So the flag is not merely tidy, it is required, and something has to decide it -- which sends the decision back to tab-side detection.

   A LISTING is the exception and shows why: it issues many requests inside one transaction, so the single commit wait amortises across all of them (x1.03 to x1.16). The price is per TRANSACTION, not per row, so what it really taxes is a read pattern made of many small reads.

   **This number was wrong once, in the direction that would have decided it wrongly.** The first run reported x1.01 on WebKit and x1.11 on Chromium, and the conclusion drawn from it was "free where it matters, do it everywhere". It was measuring nothing: the harness bundles the package through its exports, which point at `dist/`, and `dist/` had not been rebuilt after the `src/` edit, so BOTH candidates were the unmodified store and the only difference was the spike's own decorator. `refuseAStaleBuild()` in the cut now checks the bundle for a member the option added and throws, so a stale build fails loudly instead of producing a plausible answer.

   Read the numbers with three caveats. The cut runs in the harness PAGE, not in a worker, so it measures the store rather than the hosting arrangement. `concurrentReadsServed` is identical (151) in both modes because the reader and the fold alternate one-for-one through the event loop; that is an artefact of the probe, not a finding about starvation. And Firefox's paired ranges still contain single-sample outliers from collections landing inside a measurement, so only the medians are usable.

4. ~~**Decide whether the port should stop terminating hosts.**~~ DONE, and it stopped. `HostAccess.close` now takes `{quiesced}`, and `dedicatedWorkerHost` terminates only when it is true. The port earns that flag by asking the host to `stopIndexing` first, which is a promise that the cycle in flight LANDED and no other will start; a host that answers nothing is ABANDONED rather than killed. So the two paths differ exactly as they should: a tab calling `close()` gets a clean shutdown, and a death concluded from SILENCE -- which is overwhelmingly a host that was busy rather than gone -- no longer kills the very worker whose death would wedge the database.

   Two things made this cheap. ADR-0075's writer token was always what stopped a second writer, so the kill was belt on top of braces; and a dedicated worker cannot outlive its document, so the cost of abandoning one is bounded by the page's own lifetime. An idle thread until the tab closes, against a local index the user cannot get back. `self.close()` is not the compromise: it wedges more often, not less (9/200, the worst variant measured).
