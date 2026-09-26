---
title: 'Every processor ARRIVAL names itself in the outcome it reports'
slug: every-arrival-names-itself-in-its-outcome
spec: a-processor-artifact-is-pushed-to-a-running-deployment
blockedBy: []
covers: [7, 8]
---

## What to build

Three arrivals register a processor on a running deployment: the RE-READ (the reconfigure route, which re-resolves configuration from disk), the UPLOAD (the admin route the next task builds), and the browser's HOT UPDATE. They already answer one contract, `ReconfigureReport` in `@etherfold/core`, with three outcomes (`registered`, `unchanged`, `failed`). What an operator cannot tell is WHICH arrival produced an outcome: "the endpoint said unchanged" and "HMR handed us the same module" read identically in a log.

Add the arrival as a field BESIDE the three outcomes, on every arm, and have the two arrivals that exist today fill it in. The three outcomes stay three; this is not a fourth. Name the upload's value now, so the next task only has to use it.

## Acceptance criteria

- [ ] `ReconfigureReport` carries which arrival produced it, on all three arms, typed so an arrival cannot omit it.
- [ ] The re-read route's responses (all three outcomes, including the `failed` path that answers with the deployment untouched) carry the re-read's value, asserted over HTTP.
- [ ] The browser's hot update reports carry the hot update's value, asserted in its existing suite.
- [ ] The upload's value exists in the type and is used by nothing yet. (Stories 7 and 8 are complete for the upload arm only when `a-processor-bundle-is-uploaded-to-a-running-node` uses it; that task carries the criterion.)
- [ ] Nothing about the three outcomes themselves changes.
- [ ] Neither ADR-0085's nor ADR-0093's `status: accepted, not yet implemented` line is touched: `an-uploaded-processor-survives-a-restart` owns ADR-0085's and `a-run-node-with-nothing-configured-waits-for-its-first-upload` owns ADR-0093's.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None -- can start immediately.

## Prompt

The goal is that the three ways a processor reaches a deployment are ONE feature a watcher branches on once, and still distinguishable in a log.

Read ADR-0085 and its 2026-09-22 amendment (the upload, targeting The Graph's deploy UX) and the JSDoc on `ReconfigureReport` in `@etherfold/core`, which explains why the type lives in core (the arrivals are in different packages and core is the one they all depend on) and why its name is what it is. The re-read is the CLI's reconfigurer behind the server's `POST /{indexer}/admin/reconfigure`; the hot update is `@etherfold/browser`'s.

The decision most likely to be got wrong is making the arrival a fourth outcome or an optional field. The second is naming the values after packages rather than after what arrived.

Done means: every outcome says which arrival produced it, and the upload's name is waiting for the next task.

FIRST, check this task against current reality. If the report type has moved or split, route to needs-attention with the discrepancy.

RECORD non-obvious in-scope decisions in a `## Decisions` block at the end of your FINAL REPORT, in particular the field name and its values. Do not write the done record, the commit message or the PR body yourself.
