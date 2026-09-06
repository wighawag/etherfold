---
title: 'A generation can be seeded from a published artifact, because on a public node a browser often cannot backfill at all'
slug: a-generation-can-be-seeded-from-a-published-artifact
taskedAfter: [a-reconfigure-is-not-an-outage]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **SPLIT out of `a-reconfigure-is-not-an-outage`** under `TASKING-PROTOCOL` §2a: that spec's other
> stories are all build-taskable now and this one was not, so tasking the confident subset while
> leaving this in prose is the mis-scope §2a exists to catch.

> **THIS IS AN EXPLORATION SPEC, not a build spec** (`TASKING-PROTOCOL` §2a branch 3). Its DONE is
> CONFIDENCE plus a de-risked build plan, NOT a shipped seeding capability. It was reframed after its
> build form was found to be fiction: its Implementation Decisions read "None yet, deliberately", and
> two of its four questions were about SEAMS THAT DO NOT EXIST, so build tasks written against them
> would have described an interface nobody had chosen. The capability BUILD becomes a follow-on build
> spec, written AFTER this one says "yes, this way, and here is how", ordered from that spec by
> `taskedAfter`.
>
> The reframe is why this spec is no longer `needsAnswers`. The four questions did not get answered;
> they became the WORK. Each is now a story whose deliverable is a DECISION, and the gate that keeps
> it from being tasked prematurely is the `taskedAfter` edge, not a flag.

## Problem Statement

`a-reconfigure-is-not-an-outage` says a filter change makes a new stream, and a new stream is
backfilled from the node. In a browser, for a real user, that is frequently **impossible rather than
slow**: public nodes commonly do not serve old logs at all. Base's public endpoints are the worked
example, and it is why stratagems ships a remotely-computed snapshot rather than indexing from
genesis in the browser.

So the generation model has a hole exactly where its most valuable case lives. A developer changing
an ABI on a local node is fine. A shipped app whose filter changed cannot rebuild on the user's
machine.

The deployment reality points the same way: a filter change means the user is getting a **new client
build** anyway, so the app is already shipping something, and a stream or a snapshot is one more
artifact alongside it.

## Solution

Creating a generation accepts a **SEED** as an alternative to a backfill. `a-reconfigure` already
requires that a generation take its starting stream as an INPUT rather than assuming it fetches its
own history; this spec decides the artifact, the loader and the rules, and emits the plan to build
them.

**Two seed shapes, and they are NOT equivalent.** Both partly exist and this reuses rather than
invents:

- **A captured STREAM** (`captureStream`, `StreamFixture`, and today `replayStream`, which returns an
  `ExistingStream`). Seeds the stream itself, so every later generation over that stream can re-fold
  from it. This is the shape that composes with the generation model.
- **A state SNAPSHOT** (ADR-0028, `bootstrapFromSnapshot`, and the `remote` argument
  `keepStateOnIndexedDB` already takes). Seeds the FOLD, not the stream, so the generation reports a
  retention FLOOR at the snapshot's block and refuses reverts and as-of reads beneath it.

The distinction is the load-bearing part: a snapshot-seeded generation **cannot serve a later
processor-only change**, because there is no stream under it to re-fold. It is a LEAF. That forfeits
exactly the case the generation model makes free, so publish a stream where you can and a snapshot
only where the stream is too large, accepting the floor.

**What is NOT yet known is HOW**, and that is what this spec buys. Four things are unpicked: the
remote-loading seam does not exist (`loadStreamFixture` reads a LOCAL path, and only the STATE
snapshot path has a remote), the wire shape of a published seed is unchosen, nothing verifies a seed,
and nothing decides what happens when a publisher's filter digest does not match the client's.

## User Stories

These are REACH-CONFIDENCE stories, per the exploration kind. Each one's deliverable is a DECISION
captured where the next author will find it (an ADR where it meets the ADR gate, otherwise the build
plan), not shipped capability. The narrowest real case throughout is the one the repo already has:
the stratagems capture, 31,332 logs, 20.5 MB raw and 0.6 MB gzipped.

1. As a maintainer, I want the REMOTE-LOADING SEAM pinned — whether a captured stream gets the
   `keepStateOnIndexedDB(name, remote)` treatment the snapshot path already has, a loader of its own,
   or rides on the snapshot mechanism — so the build plan targets an interface that exists rather
   than one it assumes.
2. As a maintainer, I want the PUBLISHED ARTIFACT's wire shape decided — literally a `StreamFixture`,
   or a chunked/resumable form — on MEASURED evidence rather than intuition, so the eventual build's
   "not a single 20 MB blocking blob" story is not discovered to be impossible after the format is
   frozen. Name the measurement honestly when tasking it: the repo's spike harness is desktop
   Playwright, so what is actually measurable is install time and peak memory for the 20.5 MB / 0.6 MB
   gzipped capture under a throttled profile, NOT a real phone. Either that proxy is accepted and
   said to be a proxy, or the task must name what real device it runs on.
3. As a maintainer, I want SEED VERIFICATION decided — who verifies a seed and against what — so a
   stream seed is at least as defended as a state snapshot already is, given a stream carries EVENTS
   a processor will fold and a bad one is therefore worse than a bad snapshot.
4. As a maintainer, I want the DIGEST-MISMATCH rule decided — what happens when the publisher's
   source and the client's differ, so the seed would install under a key nothing will ever read —
   including whether the seed carries its own digest and is checked, or is simply refused.
5. As a maintainer, I want a de-risked, sliced BUILD PLAN naming the vertical tasks, their order and
   their seams, so the follow-on build spec can be tasked atomically with no fiction in it.

## Implementation Decisions

**Deliberately none about HOW to build seeding** — that is the output, not the input, and writing
decisions before the questions in the stories are answered is what produced four rounds of
corrections on this family's other specs.

What IS decided, and inherited from `a-reconfigure-is-not-an-outage`, so the exploration does not
re-open it: a generation takes its starting stream as an INPUT; a seeded stream is keyed by the same
STREAM DIGEST as a fetched one; and a snapshot-seeded generation is a leaf.

**A spike here is a prototype scoped to ONE question on the narrowest real case, and the ANSWER is
the deliverable** — captured into the build plan or an ADR, never the code. Do not grow a parallel
spike vocabulary and do not let a spike become the implementation.

## Out of Scope

- **The generation model itself**, which is `a-reconfigure-is-not-an-outage`.
- **Building the seeding capability.** That is the follow-on BUILD spec this one emits a plan for,
  and it must not be pre-empted by a spike that quietly ships.
- **How an app BUILDS or hosts the artifact** (CI, hosting, signing). `captureStream` already
  produces one; the publishing pipeline is
  `work/notes/ideas/publishing-snapshots-of-versioned-state.md`.
- **Snapshot verification**, to the extent it is already owned by
  `work/tasks/backlog/a-snapshot-a-client-cannot-read-is-refused-not-installed.md`. Story 3 decides
  what a STREAM seed needs; it does not re-decide the snapshot's.

## Further Notes

Note the interaction with `the-stream-stores-only-what-the-node-said`: that spec narrows the seam so
`replayStream` stops being an `ExistingStream`. Whichever lands first, the seeding path must be
written against the seam as it stands THEN, and `CONTEXT.md`'s `seeding` entry updated with it.
Story 1 must therefore read that spec's disposition of `replayStream` before pinning anything.

**On the `taskedAfter a-reconfigure-is-not-an-outage` edge, honestly:** it is SEQUENCING, not a hard
dependency, and it is worth knowing which. An exploration needs no built machinery, and both things
this spec leans on — the stream digest (story 4) and "a generation takes its starting stream as an
input" (story 1) — are already DEFINED in that spec's prose, so nothing here is blocked on code. The
edge is kept because both definitions can still MOVE while that spec is tasked (its landable 1 owns
the digest's encoding and its landable 2 owns the creation seam), and re-deciding a seed rule against
a digest that then changed shape is the cheap mistake to avoid. It costs a tasking round on the path
that de-risks the browser case the model calls impossible without it, so a human who wants this
started earlier should feel free to task it early and accept re-checking those two definitions —
there is no file overlap to collide on, because an exploration writes decisions and throwaway spikes.
