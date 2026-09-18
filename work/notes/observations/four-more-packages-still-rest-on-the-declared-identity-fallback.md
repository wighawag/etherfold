---
title: 'FOUR MORE packages still rest on the declared-identity fallback, so the contract step is bigger than the CLI remainder that was tasked'
slug: four-more-packages-still-rest-on-the-declared-identity-fallback
observed: 2026-09-18
---

2026-09-18 — Noticed while grounding the blast radius of `no-suite-or-example-still-rests-on-the-declared-identity` (ADR-0086's fifth and supposedly LAST migrate batch, scoped to `packages/cli`, `packages/utils` and `examples/event-processor-nfts`). That task is about deployments whose identity falls through to `processor.getVersionHash()` because the arrival supplied none, which a grep cannot see. Having built the probe, I ran it across the WHOLE tree rather than only my three paths, and four packages outside my scope still take the fallback.

## How it was measured

In the BUILT output only (`dist/` is gitignored, so this is a scratch edit that reverts by rebuilding), both halves of the declared fallback were made to throw:

- `packages/processor-entities/dist/EntityEventProcessor.js` — `entityProcessorVersionHash()` throws, which is the author-DECLARED computation (`version` plus a hash of the entity declarations and config).
- `packages/core/dist/internal/processorIdentity.js` — `processorIdentityOf()` throws when `supplied === undefined`, which is the exact shape `the-declared-version-and-the-drift-report-are-deleted` leaves behind when it removes the fallback arm.

Patching the DIST is what makes it a cross-package probe: a package's own suites run against its own `src/`, so only a CONSUMER of the built package is affected, which is precisely the dependency being looked for. Then `pnpm test` per package.

## What it reported

| package | failing | passing |
| --- | --- | --- |
| `packages/processor-sqlite` | 16 (`version.test.ts` 11, `lifecycle.test.ts` 5, one more file) | 71 |
| `packages/conformance-workload-stratagems` | 14 (`theReceivingContainerPublishesWhatItApplied` 7, `theFoldPublishesWhatItJustChanged` 5, `aRetractionNamesTheForkPoint` 2) | 28 |
| `packages/browser` | 10 (`snapshotOnlyMode` 4, `liveReload` 4, `streamSeeding` 1, `aModuleIsIdentifiedByItsHandlerSources` 1) | 353 |
| `platforms/nodejs-fetcher` | 6 (`loop.test.ts`) | 11 |

Green throughout: `core`, `utils`, `state-store*`, `processor-entities`, `server`, `platforms/nodejs`, `platforms/cf-worker`, and — after this task — `cli` and `examples/event-processor-nfts`, which fail only their three named declared-path witnesses.

## Why it is a signal rather than a defect

Every one of these is CORRECT today: the fallback exists, and taking it is what the four earlier migrate batches deliberately left alone where nothing sourced an identity. Some of the counts above are certainly legitimate declared-path WITNESSES of the same kind this repo already keeps (`browser`'s single `aModuleIsIdentifiedByItsHandlerSources` failure looks like one), and those should stay until the contract task retires them.

What the number says is that the contract task's premise — "every batch has landed, so this is a removal" — is still not true, for the same structural reason recorded in `work/notes/observations/the-adr-0086-contract-task-is-in-a-cycle-with-the-three-leaves-behind-it.md`: a textual sweep cannot see a run-time fallback, so each batch honestly reported itself clean. Roughly 46 cases across four packages would go dark, and nobody currently owns them. Unverified beyond the measurement above: I did not read the failures to separate genuine witnesses from genuine remainders, because that is triage on somebody else's packages.
