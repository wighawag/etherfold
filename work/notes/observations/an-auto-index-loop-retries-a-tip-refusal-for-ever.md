---
title: 'The browser auto-index loop retries a tip refusal for ever, fetching a chain on every tick'
slug: an-auto-index-loop-retries-a-tip-refusal-for-ever
---

Spotted 2026-09-10 while building `a-refused-writer-demotes-itself-to-a-reader`, in `packages/browser/src/IndexerState.ts` (`_auto_index` / `indexToLatest`).

A tab whose store was moved FAR AHEAD by another writer BEFORE this tab ever wrote gets `block N is not above the recorded tip M` (a plain `Error`, from `blockNotAboveTip`) rather than `StoreWriterChangedError` -- correctly, because a store that has never claimed CLAIMS on its first write, so the writer guard passes and the tip check is what refuses. `_auto_index` treats that as transient, so it re-arms, re-fetches the whole range from the node and is refused identically, for ever: measured at ~90 `eth_getLogs` calls per second of wall clock in a `fake-indexeddb` test, with the cursor pinned at 0 and nothing published on `syncing.error`.

The demotion this task landed does not cover it and should not: that refusal says the CALLER is wrong (revert first, or stop writing) rather than "you lost a race", which is exactly the distinction `applyblock-refuses-a-height-below-the-recorded-tip` recorded. What is worth someone's judgement is that a NON-RETRYABLE refusal is being retried on a timer at all -- `@etherfold/core` already carries the vocabulary for it (`RetryableError`, read structurally as `err.retryable === false`), and this loop reads nothing.
