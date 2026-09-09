---
title: 'A reconfigure is not an outage: a generation is a stream plus a fold, and the canonical pointer moves when one is ready'
slug: a-reconfigure-is-not-an-outage
taskedAfter: [appending-to-the-stream-costs-the-batch]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **REPLACES the two-generation design.** An earlier generation of this spec held exactly TWO generations
> in ONE stream, distinguished by a `live`/`staging` label in the key, promoted by relabelling. It is
> superseded, not amended, and the history is in git rather than in this file. Two reasons, both
> decisive: the label is two-valued by construction, so N generations and rollback were NOT reachable
> without redesign (the old spec claimed otherwise and was wrong); and the shared-keyspace promotion
> machinery accounted for six of the ten blocking defects four review rounds found, regenerating a new
> one each time it was fixed. Separate streams delete that machinery outright.
>
> Background, invariants established by reading the code, and the options weighed:
> `work/notes/ideas/stream-grafting-what-we-established.md`. The promotion-cost spike
> (`work/notes/findings/promotion-cost-of-a-two-label-stream.md`) answered a question this design no
> longer asks; it is retained as evidence, not as an input.
## Problem Statement

An indexer has exactly one state, and reconfiguring mutates it in place. When ADR-0034 says a change
"discards the state and re-indexes from block 0", it means the running indexer has nothing to answer
with until it has caught up. In a browser that is a blank app. On a server it is an outage
proportional to the history. The operator's only lever is to not reconfigure.

ADR-0033 and ADR-0034 shrank how OFTEN this happens. They did not change what happens when it does.

There is no way back, either. A processor change that makes the state WORSE is not revertible: the
old state was discarded to build the new one, so the only recovery is another full re-index.

## Solution

**A GENERATION is a stream plus a fold over it.** An indexer holds any number of generations; one is
CANONICAL and answers every read. Reconfiguring builds a new generation alongside the live one and moves
the canonical pointer when it is ready. A generation that is no longer canonical is kept until it is
deleted, so moving the pointer BACK is how you revert.

The whole design rests on splitting one identity into two, which is ADR-0034's distinction made
structural:

- **A STREAM is identified by its FETCH FILTER.** What was requested from the node: chain, addresses,
  topics, ranges. Streams are separate keyspaces, self-contained, and never share entries.
- **A GENERATION is identified by its stream plus its PROCESSOR and CONFIG.** What the fold means.

That split is the reason this is simpler than what it replaces. The most common reconfigure by far is
a processor change, and a processor change does not touch the filter — so it makes a **new generation on
the EXISTING stream** and re-fetches NOTHING. Only a genuine filter change makes a new stream, and
that is the rare case: in production an ABI's topic set changes rarely, and in development the history
is small enough that a re-fetch is cheap.

So the expensive path is rare, the common path is free, and neither needs a graft point, a shared
prefix, a promotion journal or a two-writer rule.

**And the expensive path does not have to be a backfill at all.** A new stream may be SEEDED from a
remote captured stream, or a new generation bootstrapped from a state snapshot, instead of re-fetching
from the node. That is not an optimisation, it is what makes the browser case possible at all — see
below.

## User Stories

1. As a browser user, I want the app to keep rendering while a new generation builds, instead of going
   blank, and to switch when it is ready.
2. As a developer, I want to change the processor without re-fetching a single log, because the
   filter did not move.
3. As a developer, I want to change the source and have the old generation keep answering until the new
   one has caught up.
4. As a developer whose new processor is WORSE, I want to move the canonical pointer back to the
   previous generation, without re-indexing.
5. As a developer, I want to know that a non-canonical generation exists and how far it has caught up,
   so I decide whether to render, dim or hide, since only I know whether my reconfigure made the old
   answers wrong or merely incomplete.
6. As a reader holding a state handle across a pointer move ON THE ENTITIES PATH, I want it to keep
   answering from whichever generation is now canonical, so holding a reference is never a way to be
   silently stale.
7. As a developer, I want a reconfigure the invalidation verdict calls a no-op to cost nothing.
8. As an operator, I want a bound on how many generations and streams an indexer can accumulate, and a
   loud refusal when I reach it rather than a silent eviction of something I still wanted.
9. As an operator, I want deleting a generation or a stream to be one cheap, complete operation.
10. As an operator, I want to PAUSE a generation so it stops indexing without being deleted, and resume
    it later, without it ever answering with state a reorg has invalidated underneath it.
11. As a developer, I want a stream to be RESOLVED by its filter, so two generations with different
    filters never collide and one with the same filter is reused.
    (Multi-tenancy across several NAMED INDEXERS is `the-server-and-cli-hold-generations-too`; a
    browser page carries one indexer and needs no discriminator beyond the `name` it already has.)
12. As a developer, I want a generation whose stream is unavailable to fall back to a full re-index,
    which is today's behaviour, so the feature degrades rather than breaks.
13. As a DEVELOPER iterating on a processor, I want the new generation to become canonical
    IMMEDIATELY, before it has caught up, because I am looking for what my edit does and stale-but-
    complete old answers are more confusing than incomplete new ones.
14. As an APP AUTHOR shipping to users, I want the opposite default — the old generation keeps
    answering until the new one is ready — because my users did not ask for a reconfigure and should
    not see the state go backwards.

## Implementation, Testing and Tasking detail

**Tasked on 2026-09-02; the detail moved to the tasks.** This spec's Implementation Decisions, Testing
Decisions and Tasking note have been removed as the one-time trim `TASKING-PROTOCOL` §6 describes: they
are now owned by the ten tasks below, which is where they will be kept true. Nothing was lost — the
full text is in git history, and the invariants and the options weighed (including the two-generation
design this replaces) are in `work/notes/ideas/stream-grafting-what-we-established.md`.

The ten tasks, in dependency order:

1. `a-stream-is-identified-by-the-digest-of-its-filter` — the stream digest, the wide synchronous hash,
   and filling the digest level the prerequisite left as a placeholder.
2. `generations-are-registered-and-one-pointer-is-canonical` — the registry, the canonical pointer, the
   caps that REFUSE, deletion and reaping, and the unregistered-subtree sweep.
3. `the-invalidation-verdict-becomes-a-published-answer` — publishing the verdict, additively.
4. `the-generation-container-expands-beside-the-old-shape` — EXPAND.
5. `every-caller-moves-onto-the-generation-container` — MIGRATE.
6. `the-old-indexer-shape-is-deleted` — CONTRACT. (4–6 are one landable cut expand → migrate → contract
   per §3a, because an exported class name plus a factory signature change across 37 call sites cannot
   compile as a single swap.)
7. `a-non-canonical-generation-advances-on-a-shared-stream` — the read-only stream view and the
   follower that fetches nothing.
8. `a-generation-pauses-by-cap-and-drain` — pause that truncates nothing.
9. `the-promotion-policy-moves-the-canonical-pointer` — the three policies, the `on-catch-up` default,
   drop-on-promotion.
10. `generation-progress-is-visible-and-a-bad-stream-degrades` — story 5 and story 12.

**Story-to-task map**, so a hole is visible rather than argued: 1 → 9; 2 → 1 + 6; 3 → 9; 4 → 2; 5 → 10;
6 → 6; 7 → 3 (observable at 6); 8 → 2; 9 → 2; 10 → 8; 11 → 1; 12 → 10; 13 → 9; 14 → 9. Task 7 is never
a named deliverer and that is deliberate: it is the dependency under stories 1, 3, 13 and 14, whose
observable behaviour task 9 delivers.

**Seeding is SPLIT OUT** to `work/specs/tasked/a-generation-can-be-seeded-from-a-published-artifact.md`
— it needs a remote captured-stream loader and a decision about the publishing side, neither of which
exists. All this spec owes it is that creating a generation takes its starting stream as an INPUT, which
is an acceptance criterion on task 2.

**The SERVER side** of this generalisation is `the-server-and-cli-hold-generations-too`, per ADR-0008's
2026-08-31 amendment. This spec is the MODEL and the browser runtime.

## Out of Scope

- **Sharing a prefix between two streams.** The named, deliberately-declined optimisation: when a new
  filter is a superset of an old one, the new stream is identical to the old up to some point and
  could reuse it.

  **If it is ever built, it makes a REMOVABLE thing PERMANENT, and that cost must be counted at the
  time.** `appending-to-the-stream-costs-the-batch` keeps a prefix on a gap rather than clearing, and
  isolated that recovery so it could be dropped later. **BOTH ARE NOW GONE, and the cost argument
  changes shape rather than disappearing.** ADR-0035's amendment withdrew the per-segment SCANNED
  EXTENT, the prefix-keeping gap recovery and the SEAL itself; a segment is `{events}` and nothing
  else, and an inconsistent stream is CLEARED rather than repaired. So prefix sharing can no longer
  make an existing mechanism permanent — it would have to REINTRODUCE the extent (or an equivalent)
  from nothing, and own it alone. That is a cleaner trade than the one this paragraph used to
  describe, and a strictly larger build. Do not read the old form and go looking for an extent to
  reuse: there is none.

  Note also that it is not as cheap as it sounds: a segment lives under exactly ONE stream's subtree
  and a superset filter yields a DIFFERENT digest, so reuse needs an indirection from one stream's
  address to another's segments — which is the head pointer that spec rejected on merit, and which
  hierarchical addressing makes no easier. Worth doing later, and cheap to add because streams are addressed by digest and
  nothing about this design assumes a stream was fetched entirely by its own generation. Not now: it
  buys a rare case and it is where all the complexity of the superseded design lived.
- **Sharing streams ACROSS named indexers.** Reachable; see the multi-tenancy decision for why not
  first.
- **Pruning segments WITHIN a stream.** Not needed: the bound is the caps plus explicit deletion.
- **Exposing which generation answered a read.** Purely additive later; a query layer is its home.
- **Smoothing the pointer move.** It is a step. Interpolating would serve a state neither generation had.

## Further Notes

**The unit is a GENERATION, and the word was chosen by elimination.** `version` is taken twice over —
an entity row's half-open block-validity range (`CONTEXT.md`), and a processor's `version` field,
which is an INPUT to a generation's identity here rather than the thing itself, so the same word
would mean two things one sentence apart. `deployment` is worse (it already means the fetcher/server
topology and a browser installation, both a level ABOVE this). `candidate` is taken by the entity
snapshot path. `generation` had zero prior uses ANYWHERE when this spec was written (it is now, of
course, used throughout `CONTEXT.md` and cited by ADRs 0008, 0033, 0036 and 0037 — all of them
downstream of this spec); it remains unused in `packages/*/src`, which is the half that matters, and
is pinned in the `CONTEXT.md` glossary alongside `stream`, `indexer` and `canonical pointer`.

The design record `work/notes/ideas/stream-grafting-what-we-established.md` carries the invariants
this rests on and the options weighed, including the two-generation design this replaces.
