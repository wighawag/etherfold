---
title: 'A tab learns the state moved across the port'
slug: a-tab-learns-the-state-moved-across-the-port
spec: a-reader-learns-when-the-state-moved
blockedBy: [the-fold-publishes-what-it-just-changed]
covers: [11]
---

## What to build

The signal, delivered from a worker host to the tab holding a port to it, so an app re-reads when the fold moves instead of polling on an interval it invented.

The boundary this crosses is already built and is already designed to be extended: the port carries one request/response envelope with surfaces multiplexed on it as CASES, plus a set of PUSHES a tab subscribes to. A push is subscribed to and never broadcast, nothing is posted until a tab asks, and unsubscribing stops it. This adds one push, which is what that design anticipated.

What arrives in the tab is the same notion the fold published, unchanged. Not a richer browser-flavoured variant, not a merged progress-and-data message: the value that crossed is the value core produced, so an app that later points at a server writes one handler.

Cadence is tied to applied work rather than to a timer, matching the rule the existing progress push already follows. A host resting at the tip publishes nothing, because nothing moved.

Deliberately NOT in this task: the existing `progress` push stays exactly as it is. This is a second push with a different job, not a replacement for it, and ADR-0082's decision that status is pushed is unaffected.

## Acceptance criteria

- [ ] A tab subscribes to the signal over the port, receives one notification per applied block, and stops receiving them after unsubscribing.
- [ ] The value delivered to the tab is the one core published — same block, same token, same entity names — with no browser-specific widening or narrowing.
- [ ] It works on all three hosting shapes (dedicated worker, shared worker, main thread), through the one module where port cases and pushes are served, rather than three implementations that agree.
- [ ] A host at the tip with nothing to apply pushes nothing.
- [ ] The existing `progress` push is unchanged in shape, cadence and subscription behaviour, asserted rather than assumed.
- [ ] A message that is not ours is still ignored rather than answered, per the port's existing namespace rule.
- [ ] Tested in a real browser with a real worker, through the existing parameterised hosting-shapes behaviour suite.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`the-fold-publishes-what-it-just-changed`, which produces the value this carries.

## Prompt

The goal is that an app with the indexer in a worker re-reads at the right moment without polling.

Read `work/specs/tasked/a-reader-learns-when-the-state-moved.md`, **ADR-0083** for the signal's decided shape, and **ADR-0082** for the port, whose rules you are working inside rather than extending: one envelope, surfaces as cases, status is PUSHED, a push is subscribed to and never broadcast, and the protocol tag is a namespace rather than a version because both ends come out of one build.

Where to look: `@etherfold/browser`'s `src/host/` is the whole boundary. The envelope module declares the case map and the push map, and both carry comments saying a later task adds its key here and that nothing else about the boundary moves when it does — this is that task, so follow those notes rather than adding a channel. There is exactly one place a port case is served and a value is projected for the wire, and all three hosting shapes reach it; find it and use it, because "three files that agree" is the thing that module exists to prevent. The existing progress push and its small readable helper are the closest precedent for what a subscribed push looks like end to end, including the helper convention that a wrapper is a VIEW and never a second source of truth.

Two traps. First, everything crossing this boundary must be structured-clone-safe, so the value must be plain data; if the signal as core publishes it contains anything that is not, that is a finding about the previous task, not something to paper over with a bespoke serialisation here. Second, do not merge this with the progress push because both are "the host telling the tab something" — they answer different questions, they have different cadences, and ADR-0082 already settled that progress is its own thing.

Terminology: `CONTEXT.md` reserves **consumer** for a reader of the FEED. A tab, an app or a reader tab is a caller, an app or a reader.

The seam to test at is the existing parameterised hosting-shapes suite, run in a real browser against a real worker, asserting on the sequence of pushes and the values in them rather than on elapsed time.

Done means: a tab subscribes, gets the fold's own notification as the fold advances, unsubscribes and goes quiet, on every hosting shape.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. Whether a tab attaching part-way through is told anything before the next block, and what the push is named, are both such decisions. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**The push is named `stateMoved`, with `subscribeToStateMoved` / `unsubscribeFromStateMoved` and `IndexerPort.onStateMoved`.** It takes the vocabulary that already exists end to end (`StateMoved`, `StateMovedPublisher`, `Indexer.onStateMoved`, and `CONTEXT.md`'s *state-moved signal*), so one name spans core, the port and the app. Alternatives considered: `signal` (too generic, and *signal* is already used loosely for the progress push in ADR-0082's prose), `changed`/`invalidate` (names what a READER does with it, which would bake one reader's policy into the producer's boundary). Touches every later transport task, which should reuse this name rather than coin one: `a-reader-tab-learns-from-the-indexing-tab` and `one-handler-for-every-transport`.

**A tab attaching part way through is told NOTHING until the fold next moves, so `subscribeToStateMoved` answers `undefined`.** This is the one place the pair differs from `subscribeToProgress`, whose response IS the current progress: progress is a state, the signal is an event, and replaying the last notification would tell a fresh subscriber a block just landed when it landed some time ago, under a token it has never held. A late tab reads through the four reads it already has. Alternatives: answer with the last notification (rejected as above); answer with the current coherence token so a tab can compare (rejected: it invents a "current token" question ADR-0083 does not give the reader, and a token is only ever compared against one the reader was PUSHED). This is the residual ADR-0083 already records for every transport, so no new limit is introduced. Touches the remaining transports, which should answer this the same way, and it is asserted as a case on all three hosting shapes.

**The hosting-shapes case signature gained a second argument: the port plus what that port has been told since it was opened (`StateMovedWatch`, `watchStateMoved`).** The suite's stated criterion was "handed a PORT and nothing else", and this widens it. The reason is WHEN the behaviour happens: notifications fire as the fold APPLIES blocks, and by the time any case runs the fold is at the fixture's tip with nothing left to apply, so a case holding only a port could never observe one and "it works on every shape" would have been asserted somewhere else, in three places that agree. Each shape's setup now does what an app does (subscribe the moment it has a port, which for the workers is before the worker boots and on the main thread is before `init`), and the cases assert on that recording. Alternatives: reconfigure from inside a case to cause fresh folding (rejected: the suite forbids it, and it would change the answers every later case asserts on); a chain that grows on a timer (rejected: an elapsed-time test, which the task explicitly rules out); assert per-block delivery only in the node test (rejected: the criterion names the shared suite). `openOnTheMainThread` now joins its port before `init` for the same ordering reason. Touches every later case added to that suite and both of its runners (`browser/cut.ts`, `test/theThreeHostingShapesRunOneImplementation.test.ts`).

**`PORT_PUSH_SUBSCRIPTIONS` is a new named thing on the envelope (coherence check).** It does not re-mean anything: it states as data the pairing the case names already imply, and it sits on the envelope where the case map and push map live. It exists because a SECOND place needs that pairing: the SharedWorker fan-in filters pushes per client, and the previous task recorded that this filter is the one bit of protocol knowledge in a shape file and that "any later PUSH will need its case names added to this filter". A hand-written list there would drift one push behind the map; the `satisfies` on this one makes forgetting a line a compile error. Alternative: keep the two case names inline in `sharedWorker.ts` and add two more (rejected on that recorded hazard). Touches `sharedWorker.ts` and any later push.
