---
title: 'checkTxInclusion answers from the tab'
slug: checktxinclusion-answers-from-the-tab
spec: the-indexer-runs-in-a-worker-and-the-tab-talks-to-it
blockedBy: [a-tab-controls-the-indexer-across-the-port]
covers: [5]
---

## What to build

`checkTxInclusion` asked from the tab and answered by the host, so an app can lay an optimistic update over indexed state without double-counting.

This is the call that tells an app whether a transaction it sent has been folded in yet, and it exists precisely so an app can render the unconfirmed tip honestly: show the optimistic version until the indexer has actually seen the transaction, then drop it. With the fold in a worker, an app that cannot ask this from its UI thread cannot do that at all.

The answer is not a boolean and must not become one on the way across. A verdict carries a STATUS and the BASIS for it — in particular, "unknown" has distinct causes (the indexer has not synced far enough; the window does not cover the transaction) and an app renders those differently from an honest "absent". Carry the verdict shape through unchanged.

**The optional `minedAtBlock` argument crosses too, and it is not decoration.** The window is SPARSE (event-bearing blocks only), which gives the answer two documented limits: a transaction that emitted nothing indexed can never hit, and `absent` means only "not in the window". A caller holding a receipt closes both by passing the block it was mined at, which reaches the `below-window` branch. A tab is exactly the place a caller has a receipt, so dropping the argument at the boundary would remove the one affordance that makes the verdict trustworthy there.

The window this answers from is maintained by the live generation, and it moves as the fold advances and as reorgs are concluded. A verdict is therefore a snapshot: it is answered against the state at the moment of the call, and an app that wants to watch a transaction asks again rather than being handed something live. Several transactions asked about at once should cost one round trip, since that is how an app with a pending queue will actually use it.

## Acceptance criteria

- [ ] A tab can ask about one or more transaction hashes in a single call and receives a verdict per hash.
- [ ] `minedAtBlock` can be supplied per query from the tab and produces the `below-window` verdict it produces in-process.
- [ ] The verdict keeps its status AND its basis across the boundary, including the distinct causes of "unknown".
- [ ] A transaction the worker has folded reports as included; one the worker has passed the block of and not seen reports as absent; one beyond the synced point reports unknown with the not-synced basis.
- [ ] A verdict answered before and after the fold advances past the transaction differs accordingly, demonstrating it is answered from current state rather than cached.
- [ ] Asking while no generation is live, or while the window covers nothing, produces the honest unknown rather than an error or a fabricated answer.
- [ ] It is tested in a real browser with a real worker.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-tab-controls-the-indexer-across-the-port`, to serialise the edits on the boundary modules.

## Prompt

The goal is optimistic UI that does not double-count, from a tab whose indexer is in a worker.

Read `work/specs/tasked/the-indexer-runs-in-a-worker-and-the-tab-talks-to-it.md` and **ADR-0082**.

Where to look: `checkTxInclusion` and its verdict types live in `@etherfold/core`'s tx-inclusion utility, and `@etherfold/browser` already wires it into `createIndexerState`, answering from the last-sync window. Read that wiring first, including the comments about what happens when a generation stops being maintained — the honest-unknown behaviour there is the behaviour you are exposing, not behaviour you are inventing.

Domain vocabulary: read `CONTEXT.md`'s **tx inclusion** entry in full before starting. It pins the whole model in one paragraph: the verdict is answered from `LastSync.unconfirmedBlocks` and NOTHING else stored, a window hit must also be behind `lastToBlock` because `feed` publishes the window before walking the cursor through it, the receipt's block HASH is deliberately never compared, and `minedAtBlock` exists to close the sparse window's two limits. That entry also names `createIndexerState(...).checkTxInclusion` as the browser surface, which is the surface this task extends across the port.

The seam to test at is the browser harness with a real worker and a workload containing a known transaction, asking before and after the fold reaches it.

Done means: an app in a tab can ask about a pending transaction, gets the same verdict the main-thread path gives, and can tell the two kinds of unknown apart.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Requeue 2026-09-12

Previous attempt died on a transient infra timeout before producing any code; no work branch exists. Start fresh.
