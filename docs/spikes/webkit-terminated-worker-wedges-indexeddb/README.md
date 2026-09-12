# Does a terminated worker's IndexedDB transaction wedge the next writer?

Evidence for `work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`.

**Answer: no — and that is the point.** This probe was written to confirm the obvious explanation for a WebKit-only stall in `@etherfold/browser`'s restart-and-resume case, and it falsified it instead.

## The probe

`packages/browser/spikes/webkitWedge.spec.ts`, run with:

```sh
pnpm --filter @etherfold/browser exec playwright test --config spikes/playwright.config.ts
```

It lives in the package rather than here because `docs/` is not a pnpm workspace member, so a spec here cannot resolve `@playwright/test` without a standalone install of its own. The results it writes live here, which is the half a reader needs.

It strips everything etherfold away — no store seam, no port, no fold. A worker opens a database and holds ONE `readwrite` transaction open indefinitely (chaining a new `put` from each `onsuccess`, so IndexedDB can never auto-commit it), the tab terminates it mid-transaction, and then the database is asked what still works: a new connection, a `readwrite` from the tab, a `readonly`, a `readwrite` from a SECOND WORKER, `deleteDatabase`, and finally the same questions after a page reload.

## Results (`results/`, Playwright 1.62.1, Linux, 2026-09-12)

| step | chromium | firefox | webkit |
| --- | --- | --- | --- |
| new connection from the tab | ok | ok | ok |
| `readwrite` from the tab | ok | ok | ok |
| `readonly` from the tab | ok | ok | ok |
| `readwrite` from a second WORKER | ok | ok | ok |
| `deleteDatabase` | blocked | blocked | blocked |
| after a page reload | ok | ok | ok |

All three engines agree. A terminated worker's open `readwrite` transaction does **not** block the next writer anywhere, and a second worker claims the store without trouble. `deleteDatabase` is blocked on all three only because a live connection is still open, which is ordinary IndexedDB behaviour.

## What this leaves

The product case still wedges on WebKit, and the cause is now known to need something this probe strips away: many object stores rather than one, a transaction spanning several of them, the real interleaving of a fold's writes at the moment of the kill — or a latent ordering bug of our own in `claimOrCheck`/`clearSeamRecord`, which `await`s between creating a transaction and issuing its first request.

The next step is to grow this probe towards the product until it wedges. The first step that reproduces it is the answer, and it decides whether this is a WebKit bug worth filing upstream or a bug of ours. Nothing has been filed against WebKit precisely because this probe shows the opposite of the claim a report would have to make.
