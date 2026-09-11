---
title: 'A SharedWorker serves several tabs from one host'
slug: a-sharedworker-serves-several-tabs-from-one-host
spec: the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
blockedBy: [a-terminated-worker-restarts-and-resumes-from-the-cursor]
covers: [10, 11]
---

## What to build

The second hosting shape, and the proof that the host seam from the first task was real.

A SharedWorker differs from a dedicated worker in exactly one respect: how a port is obtained. Several tabs connect to one instance, each getting its own port, and what runs inside is what a dedicated worker runs. If anything inside the host has to change to support this, the seam is wrong and that is the finding, not a thing to work around.

The choice is made at CONSTRUCTION and nowhere else. An app switching from dedicated to shared changes the argument it passes, not its code against the port. Dedicated stays the DEFAULT, for the reasons ADR-0082 records: it works everywhere, it debugs properly (a SharedWorker has no devtools panel and needs `chrome://inspect`), and the per-tab workers are not idle since each serves its own tab's reads, so reads parallelise instead of funnelling through one. Shared wins a narrower prize — one store connection and no election needed at all — which is why it is offered rather than assumed.

Two tabs attached to one SharedWorker is the case that has to work: both see the same state, both get progress, both can read, and only one fold is running. A tab disconnecting must not take the host down while another is still attached, and the last tab disconnecting should leave things in a state a later tab can resume from.

This shape is also the first rung of `one-tab-indexes-and-the-others-read`. Make it POSSIBLE and take no position on election: that spec decides which rung is used.

## Acceptance criteria

- [ ] An app selects the hosting shape at construction, and app code written against the port is byte-identical between the two shapes.
- [ ] Two tabs attached to one SharedWorker both read correct state, both receive progress, and exactly one fold is running.
- [ ] Closing one attached tab does not stop the fold for the other.
- [ ] Closing the last attached tab leaves the store consistent, and a tab opened afterwards resumes rather than re-indexing.
- [ ] What runs inside the host is unchanged between the two shapes: a reviewer can see that only port acquisition differs. If it had to change, that is reported rather than absorbed.
- [ ] The dedicated shape remains the default when nothing is specified.
- [ ] A runtime without SharedWorker support is handled: the app is told, rather than failing obscurely.
- [ ] It is tested in a real browser with real tabs and a real SharedWorker, not a simulation of one.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-terminated-worker-restarts-and-resumes-from-the-cursor`, because the shared shape multiplies the lifecycle questions (a host outliving one of its tabs) and the single-tab death path should be settled first.

## Prompt

The goal is a second hosting shape that costs an app one constructor argument and costs this package no second implementation.

Read `work/specs/tasked/the-indexer-runs-in-a-worker-and-the-tab-talks-to-it.md`, **ADR-0082** (particularly why dedicated is the default — the reasons are not arbitrary and a reviewer will check that this task did not quietly promote shared), and the **indexer host** entry in `CONTEXT.md` for the vocabulary. Use HOST, CONTAINER, PORT and HOSTING SHAPE; the glossary records that an earlier draft's *body* and *shell* are not to be reintroduced.

Where to look: the host created by `the-indexer-is-hosted-in-a-dedicated-worker` and its done record, which says where the seam is. A SharedWorker's entry receives a connect event carrying a port per client, which is the only structural difference.

Worth knowing, because it is free and the writer guard arrives at the same place from the storage side: a SharedWorker is identified by its SCRIPT URL plus its name, so two different apps on one origin get different workers with nothing to configure. That is a property to verify and note, not to build.

Scope boundary: this makes the shared shape possible. WHICH tab indexes, leader election, and what happens when a leader goes away are `one-tab-indexes-and-the-others-read`'s decisions. Do not build an election here, and do not assume one exists.

The seam to test at is the Playwright harness with more than one page attached to one SharedWorker. The existing multi-tab cases in the IndexedDB package are the closest precedent for driving several real tabs, including how their results are recorded outside the acceptance gate.

Done means: both shapes work, chosen at construction, from one implementation, with the multi-tab case demonstrated in a real browser.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. If anything inside the host had to change to support the shared shape, say so there explicitly: it is evidence about the seam, and a later reader needs it. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.
