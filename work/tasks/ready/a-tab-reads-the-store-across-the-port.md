---
title: 'A tab reads the store across the port, with no query runtime'
slug: a-tab-reads-the-store-across-the-port
spec: the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
blockedBy: [the-indexer-is-hosted-in-a-dedicated-worker]
covers: [3, 13]
---

## What to build

The store's read seam, proxied across the port, so a tab can read typed rows while the store lives in the worker.

`createReadSurface` types the seam's four reads off the declarations an app already wrote, and every one of them is already async, so the proxy is mechanical: each read becomes a case on the envelope, the host serves it from the store it holds, and the tab gets back the same rows a same-thread call would return. What makes it worth its own task is what it buys — an app that reads three entities by id gets typed reads with no query language loaded at all, which is the whole reason this surface survives alongside the GraphQL work that comes later in another spec.

The result is also what makes the app usable WHILE it is still indexing: the fold is running in the worker and the tab is reading rows the whole time, rather than waiting for a sync to finish.

Keep the surface identical to the same-thread one. A tab holding the proxy and a test holding a real store should be able to run the same assertions, and a divergence between them is a bug rather than a documented difference. The proxy may use structured clone honestly — unlike the query executor that comes later, this surface has no HTTP twin to stay parity with — but it must still be the SAME rows and the same shapes.

## Acceptance criteria

- [ ] A tab can call all four reads of the read surface and get the rows the store holds, across the real boundary.
- [ ] The rows are identical to what the same reads return against a same-thread store for the same workload: the same case list runs both ways and passes both ways.
- [ ] Nothing on the tab's side can mutate the store, and the proxy exposes no way to try.
- [ ] Reading works while the fold is running, not only after it finishes.
- [ ] No query-language runtime is pulled into the tab's bundle by this path. Assert it, rather than stating it.
- [ ] A read for an entity the declarations do not describe is refused in a way the app can act on.
- [ ] It is tested in a real browser with a real worker.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`the-indexer-is-hosted-in-a-dedicated-worker`, which creates the port and the envelope this adds cases to.

## Prompt

The goal is typed reads from the tab while the store lives in the worker, with no query runtime on the first-paint path.

Read `work/specs/tasked/the-indexer-runs-in-a-worker-and-the-tab-talks-to-it.md`, **ADR-0082** (the section on the surfaces the port carries), and the **indexer host** entry in `CONTEXT.md` for the vocabulary: HOST, CONTAINER, PORT, hosting shape. Read the done record of `the-indexer-is-hosted-in-a-dedicated-worker` for the envelope's actual shape, since you are adding cases to it.

Where to look: `createReadSurface` in `@etherfold/state-store` — it is typed off an array of entity declarations and offers exactly four reads (current by id, as-of by id, current listing by prefix, as-of listing by prefix). Its own docstring and ADR-0021 explain why it is deliberately narrow: a handler runs once per event on a substrate with no query planner, so the seam has no predicate and no ordering. Do not widen it here. Richer queries are `the-same-query-runs-against-a-worker-and-a-server`'s work and they arrive as an executor on this same port, not as extra methods on this proxy.

The seam to test at is the proxy against the real surface: take the case list an existing read-surface test uses and run it through both, so "identical" is a test rather than a claim. `@etherfold/state-store-conformance` is the established pattern for parameterising one case list over several implementations — follow its shape rather than inventing a second one.

Bundle evidence: this package already has a test that bundles itself for a browser. Extend that reasoning to assert what a tab-only import pulls in.

Done means: four reads that work from a tab, prove they match the same-thread surface, and cost the tab no query runtime.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
