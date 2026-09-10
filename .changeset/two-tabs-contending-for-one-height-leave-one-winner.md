---
'@etherfold/state-store-indexeddb': patch
---

The browser run gains the CONTENTION case: several tabs offering the SAME heights against one database.

`browser/multi-tab.spec.ts` proved that four tabs can OPEN one database and use it (the claim ADR-0024 needs, and the one both wasm-SQLite VFSs fail), and said itself that it was not testing contention: every tab wrote heights of its own, so no two of them ever raced for one. That gap is now closed. Four tabs claim, then offer every height in one range at once, and the case asserts three things: exactly one write lands per height, every loser is refused with `StoreWriterChangedError` **specifically** rather than by some other failure or by silence, and an independent connection afterwards finds a coherent store (no half-applied block, no row from a refused writer, no cursor behind its data).

No production code changed: this is the observation behind ADR-0075's guard rather than an addition to it. It runs on Chromium, Firefox and WebKit and its output is kept in `docs/spikes/indexeddb-row-backend-browser-default/results/contention-<engine>.json`.

It is deliberately NOT in the acceptance gate, on the same reasoning as the rest of the browser run: it needs three browser binaries a clean checkout does not have. It is also the case the node suite cannot stand in for, because `fake-indexeddb` cannot demonstrate `readwrite` transactions serialising across tabs at all, which is the primitive the guard rests on. Both facts are stated where the results are kept, together with the manual observation that removing the guard turns the case red.
