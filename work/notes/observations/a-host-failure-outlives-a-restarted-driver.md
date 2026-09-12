---
title: 'A `HostProgress.failure` outlives a restarted driver'
slug: a-host-failure-outlives-a-restarted-driver
observed: 2026-09-12
---

2026-09-12 — On both host drivers (`serveIndexerHost` in `packages/browser/src/host/serve.ts` and the main-thread host in `src/IndexerState.ts`), a driver that stopped on a non-retryable refusal records `failure` and the `refused` phase, and a later `startIndexing()` moves the phase on without clearing `failure` — so a tab can be handed `phase: 'at-tip'` with a stale failure attached. Noticed while giving the main-thread host the same reporting as the worker one during `createindexerstate-becomes-the-main-thread-host`; left matching rather than fixed on one side only, since diverging the two would be worse than the wart.

**RESOLVED 2026-09-12.** Both drivers clear the failure when a new attempt starts (`startIndexing` in `host/serve.ts`, `startAutoIndexing` in `IndexerState.ts`), so a phase that moves no longer drags the previous drive's refusal along with it. Fixed on BOTH sides together, as the note asked. `syncing.error` is deliberately NOT cleared with it: that field also carries load and update failures, so clearing it on a driver restart would discard an error the driver never caused. Pinned by `packages/browser/test/aRestartedDriverDropsTheOldFailure.test.ts`.
