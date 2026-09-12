# What a terminated worker does to an IndexedDB database

Evidence for `work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`.

**Answer: on WebKit it can wedge the database permanently -- but not for the reason the first probe looked for.** Ending a dedicated worker that has BOTH a `readwrite` and a `readonly` transaction in flight on one database can leave that database unable to run any transaction ever again: `indexedDB.open` still succeeds, and every transaction on the connection then hangs with no `complete`, no `abort` and no `error`, `readonly` as much as `readwrite`, from the page as much as from a later worker. An unrelated database in the same origin is fine. A page reload does not clear it, a new tab does not clear it, and a `deleteDatabase` afterwards never runs. The only escape found inside a browsing session is a different database name.

There are two probes here, and they are both worth reading, in this order.

## 1. `webkitWedge.spec.ts` -- the obvious explanation, falsified

```sh
pnpm --filter @etherfold/browser exec playwright test --config spikes/playwright.config.ts webkitWedge
```

A worker holds ONE `readwrite` transaction open indefinitely (chaining a new `put` from each `onsuccess`, so IndexedDB can never auto-commit it), the tab terminates it mid-transaction, and the database is then asked what still works.

Results in `results/{chromium,firefox,webkit}.json`:

| step | chromium | firefox | webkit |
| --- | --- | --- | --- |
| new connection from the tab | ok | ok | ok |
| `readwrite` from the tab | ok | ok | ok |
| `readonly` from the tab | ok | ok | ok |
| `readwrite` from a second WORKER | ok | ok | ok |
| `deleteDatabase` | blocked | blocked | blocked |
| after a page reload | ok | ok | ok |

All three engines agree: a terminated worker's open `readwrite` transaction does **not** block the next writer anywhere. `deleteDatabase` is blocked on all three only because a live connection is still open, which is ordinary IndexedDB behaviour.

This probe is right, and it is not the product's case. Two things it did that hid the real effect: it asked only whether the next **writer** was blocked, and it let the **tab** ask first. The real signature is that EVERY transaction from EVERY context hangs.

## 2. `webkitWedgeGrowth.spec.ts` -- what it actually takes

```sh
ITER=200 pnpm --filter @etherfold/browser exec playwright test --config spikes/playwright.config.ts webkitWedgeGrowth
```

The same raw substrate -- no etherfold, no seam, no port -- varying what the doomed worker was doing, with the tab asking the sharper question afterwards: can this database run a `readonly` transaction at all?

Results in `results/growth-{chromium,firefox,webkit}.json`, 200 runs per variant per engine:

| the doomed worker | chromium | firefox | webkit |
| --- | --- | --- | --- |
| `one-store-hold` -- one `readwrite` held open for ever | 0 | 0 | 0 |
| `product-fold` -- a stream of `applyBlock`-shaped transactions | 0 | 0 | 0 |
| `product-fold-jitter` -- the same, killed at a random point | 0 | 0 | 0 |
| `two-stores-puts-alone` -- one `put` per transaction | 0 | 0 | 0 |
| `two-stores-puts-plus-readwrite` -- plus a second `readwrite` loop | 0 | 0 | 0 |
| `two-stores-puts-plus-readonly` -- plus a `readonly` loop | 0 | 0 | 0 |
| `two-stores-puts-plus-readonly-jitter` -- the same, killed at a random point | 0 | 0 | **3** |
| `product-fold-plus-readonly` | 0 | 0 | **3** |
| `product-fold-plus-readonly-jitter` | 0 | 0 | **6** |
| `two-stores-puts-plus-readonly-self-close` -- ended by `self.close()`, not `terminate()` | 0 | 0 | **9** |
| `worker-writes-tab-reads-jitter` -- the read belongs to the SURVIVING page | 0 | 0 | 0 |
| `sequential-no-overlap-jitter` -- read and write each awaited to COMMIT | 0 | 0 | 0 (and 0 in 1,000) |

So it is not the number of object stores, the indexes, the length of the transaction, where in its life the kill lands, or even that it is a kill: asking the worker to `self.close()` is the worst variant of the lot. It takes **two transactions of the DYING context overlapping when it ends, one of them `readonly`**. Every wedged run also records `unrelated=ok`, `afterReload=WEDGED` and `inANewTab=WEDGED`.

The last three rows are the ones that decide what the product could do about it: a graceful `self.close()` is not safer, the overlapping read has to belong to the worker that ends, and a worker that never has two transactions in flight did not produce the wedge in 1,000 runs.

## 3. `bug-report/index.html` -- the reproduction to send upstream

A single self-contained page, no framework and no etherfold. Serve it over HTTP (IndexedDB needs a real origin) and press Run:

```sh
cd docs/spikes/webkit-terminated-worker-wedges-indexeddb/bug-report && python3 -m http.server 8000
```

**Confirmed on real hardware:** an iPhone 12 on iOS 18.3.2 / Safari 18.3.1 wedged **12 databases in 200 runs** of this page, foreground tab, over plain HTTP on a LAN address. Through Playwright: 7 to 13 in 200 on webkit (build 2359, user agent `Version/26.5`), **0 in 200** on chromium and on firefox. Each wedged line prints the whole signature, including that an unrelated database is healthy and that the wedged one is still wedged after a reload and in a new tab.

The page refuses to be used carelessly on a phone: it detects being backgrounded and marks the run contaminated, because IndexedDB after SUSPENSION is the different, already-reported problem (197050, 202705) and a report that confuses the two is worse than none.

`bug-report/bugzilla.txt` is the report body, ready to paste.

Nothing has been filed yet. 197050 and 202705 are adjacent but different: they are about IndexedDB after the network process or the app is SUSPENDED, not after a worker is terminated.

WebKit's tracker is **Bugzilla, not GitHub** -- the WebKit/WebKit ReadMe says so itself -- and webkit.org adds that "Safari is not WebKit", so a Safari-specific report goes to Apple's Feedback Assistant instead. Since this reproduces on an old shipping iOS engine AND a recent upstream build, on two ports, it is an engine bug and Bugzilla is the right place; a Feedback Assistant report cross-referencing the Bugzilla id is the optional second copy.
