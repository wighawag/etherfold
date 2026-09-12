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

## Decisions

**Nothing inside the host had to change, and the one structural addition is in the shape file.** A SharedWorker's entry is handed a wire per CLIENT; the host is written against one wire. `oneEndpointOverEveryClient()` (in `sharedWorker.ts`) makes N wires look like the one every shape provides, so `serve.ts` is byte-identical between the shapes. Alternative considered and rejected: teaching the host to hold several endpoints (that is a second implementation of the host, which is the accident ADR-0082 exists to prevent). Touches every later task on this port: a new case needs no change here, because the fan-in is generic over the envelope.

**Correlation ids are RE-NUMBERED per client, and that is the part that was not optional.** The envelope says an `id` is unique per port and not globally, which is exactly true and becomes load-bearing with several ports: two tabs are two documents each counting from 1, so ids collide by construction. A broadcast wire would have *resolved* one tab's `progress()` with another tab's rows, so each request gets an id in one space on the way in and the answer is re-numbered back and posted to the single client that asked. This is the evidence about the seam a later reader needs: the shared shape did not need the host changed, but it did need this, and a third shape with several clients would need it too. Node test `answers two tabs whose correlation ids collide` asserts it on the wire, not on the shapes of the values.

**Pushes are filtered in the shape, which puts two case names inside a shape file.** The host counts subscriptions in aggregate and posts when the count is non-zero, so WHICH clients asked can only be known here; the fan-in watches `subscribeToProgress`/`unsubscribeFromProgress` and posts a push only to subscribed clients. Alternative: broadcast and let an unsubscribed tab ignore what arrives (rejected: it bills every tab for the one rendering a progress bar, and it would break the host's own rule that nothing is posted to a tab that did not ask). This is the only protocol knowledge in the file. Touches any later PUSH added to `PortPushes`: it will need its subscribe/unsubscribe case names added to this filter, which the module doc says.

**A missing `SharedWorker` is a REFUSAL, not a silent fallback to dedicated.** `sharedWorkerHost` throws before calling the app's factory, naming what is missing and pointing at `dedicatedWorkerHost`. This is a new user-visible error. Alternative considered: falling back automatically (rejected: the shape decides how many writers an app has and whether an election is needed, so swapping it silently changes the deployment under the app; a fallback ladder is `one-tab-indexes-and-the-others-read`'s decision). No predicate is exported either: `typeof SharedWorker === 'undefined'` is the whole check and duplicating it as API would be a second way to ask. The async failure a runtime with `SharedWorker` but no MODULE support produces is logged by the shape and concluded as a death by the port's existing watch; no new death cause was added.

**A second entry helper, and a new cross-refusal in the DEDICATED one.** `hostIndexerInThisSharedWorker` is a sibling of `hostIndexerInThisWorker` rather than scope auto-detection inside one helper, so each shape's file holds both of its ends and the `host` label a tab is told stays a consequence of where the code ran. The cost is that calling the wrong one is possible, and it is SILENT (a shared scope has no `postMessage`; a dedicated one never fires `connect`), so `hostIndexerInThisWorker` now refuses a shared scope by name, pointing at the sibling. That is the one behaviour change to an existing file, and it converts a host-that-never-answers into a sentence. Scope detection is `'onconnect' in globalThis`, measured across all three engines (true only in `SharedWorkerGlobalScope`) rather than `instanceof`, so it is also stateable in a node test.

**No word was coined.** CLIENT is the platform's own word for a connected page (and the task's), HOST / CONTAINER / PORT / HOSTING SHAPE are the glossary's; `body`/`shell` were not reintroduced. The fan-in is described by what it does ("every attached client's wire, presented as one endpoint") rather than given a new noun, and `CONTEXT.md` was deliberately not edited: its **indexer host** entry already describes the shared shape and the URL-plus-name property, and the spec's banner assigns those entries to the final task.

**`close()` cannot take a shared host down, and the restart path differs in a way that is safe.** The dedicated port terminates a suspected-dead host before opening a successor, so two writers are impossible. A `SharedWorker` has no `terminate()` and must not be taken down by one of its tabs, so `reopen()` reconnects to the instance that is still running where there is one. That is safe precisely because a SharedWorker is a singleton by construction (its one prize), so there is no second host to create. Documented at the call site; nothing was added to `HostDeathCause`, whose single member still reflects what a tab can actually observe.

**Test-fixture shape: the harness entry is deliberately BOTH entries.** `browser/indexer.bothShapes.worker.ts` branches on its own scope and calls one of the two helpers, because the harness builds exactly one worker entry per mount, and because it makes "what runs inside the host is unchanged" a fact about ONE built file rather than a comparison of two. An app writes one of the two lines and never branches. The instance identity the spec asserts on is the fixture's own value posted off the port; no `whichHostAreYou` case was added to the envelope, because an app has no use for the answer.
