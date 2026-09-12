---
title: 'A `test:browser` run dirties committed spike results'
slug: a-browser-run-dirties-committed-spike-results
observed: 2026-09-12
---

2026-09-12 — Running `pnpm --filter @etherfold/browser test:browser` rewrites nine committed files under `docs/spikes/a-sharedworker-serves-several-tabs-from-one-host/results/*.json` (only `ranAt` and the fixture's random `instance` ids change), so any full browser run leaves an unrelated dirty working tree that a later `git add -A` would sweep into an unrelated commit. Seen while running the browser suite for `createindexerstate-becomes-the-main-thread-host`; reverted with `git checkout`. The writer is `browser/sharedWorkerServesSeveralTabs.spec.ts`.

**RESOLVED 2026-09-12.** The recorded artifacts are deterministic now: the wall-clock stamp is dropped (git already records when a file changed, more honestly than the file can record itself), the unasserted `timings` are no longer written, and each random host `instance` id is replaced by a stable label in order of first appearance. The RELATION the ids carry is the evidence -- two tabs on one host, a third on another -- and it is preserved exactly; only the entropy is gone. Verified by running the full browser suite twice and confirming the second run leaves no diff.
