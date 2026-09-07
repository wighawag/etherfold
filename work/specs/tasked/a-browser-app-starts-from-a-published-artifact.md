---
title: 'A browser app starts from a published artifact: a snapshot with no stream, or a verified stream seed'
slug: a-browser-app-starts-from-a-published-artifact
taskedAfter: [a-generation-can-be-seeded-from-a-published-artifact]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **This is the BUILD spec the exploration `a-generation-can-be-seeded-from-a-published-artifact`
> emitted.** Every story below names the recorded decision that makes it buildable: ADR-0063 (the
> arrival seam and what installing writes), `work/notes/findings/what-a-published-stream-seed-costs-to-install.md`
> (the measured wire shape and the publishing cadence), ADR-0064 (the identity rule), ADR-0065
> (verification, superseded in part) and ADR-0066 (the trust anchor, which replaced ADR-0065's build
> pin after the reference deployment showed a build cannot pin a rolling artifact). Nothing here re-opens those. What the exploration found NOT
> confidently buildable is in **Out of Scope**, kept out deliberately rather than padded in.

## Problem Statement

A browser app has to come up holding indexed state, and it cannot rebuild that state from the chain:
on a public node the historical `eth_getLogs` a backfill needs is frequently refused outright. So
whatever the app knows at startup has to arrive as a PUBLISHED ARTIFACT.

Two things are wrong with how that stands today.

**The path that actually works is not a supported mode.** A client can bootstrap state from a
published snapshot (`bootstrapFromSnapshot`), and it can run with no stream keeper at all, because
`keepStream` is optional and the engine skips the save when it is absent. That combination is the
primary browser deployment and it works by accident rather than by design: nothing names it, nothing
tests it and nothing documents what it costs. An app author choosing it is guessing. (A latent defect
sits in the NEIGHBOURING combination, snapshot-seeded WITH a stream kept, which is not this mode and
is one more reason to name the boundary; see Further Notes.)

**And the other path does not exist.** A captured stream cannot be handed to an indexer: a fixture is
not a keeper (ADR-0059) and the keeper seam takes only the raw stored event (ADR-0060). There is no
loader, no published artifact shape, no identity check and no verification. So an app that WANTS a
stream underneath its state, in order to make a later processor-only change free, has no way to get
one.

## Solution

Support both, and be honest about which is which.

**A snapshot-seeded generation with NO STREAM is a first-class mode.** Two separate pieces of
evidence, and they are worth keeping apart. The PUBLISHER's cadence is MEASURED from the git history
of the snapshot repository: a median 1.0 h between publishes with a worst observed gap of 50.9 h,
leaving a client 1,802 to 91,527 blocks to fetch, all of it inside what a public node serves. That
the CLIENT ran on the snapshot alone is the maintainer's account of the deployment rather than
something the measurement shows, and it is recorded as such. Together they make this the default a
browser app should reach for rather than a fallback. Its cost is stated
rather than discovered: the generation is a LEAF (ADR-0028's retention floor, and no stream beneath
it to re-fold), so a later processor-only change waits for a republished snapshot instead of being
free.

**A STREAM SEED is the other mode, and it buys exactly one thing**: a stream under the state, so a
successor generation re-folds locally and a processor-only change costs nothing between snapshots. It
arrives through its own loader in `@etherfold/core`, is INSTALLED by writing through the public
keeper seam, is admitted only when its stream digest equals the client's, and is fetched only from the
locations the caller named, ordinarily from its build (ADR-0066).

The artifact is a single compact gzipped document carrying only the STORED half of each event, which
the measurement settled: 0.54 MB gzipped and 20.1 MB raw for the 31,332-log reference capture,
against 0.81 MB and 26.5 MB for the same events with their decoded half, which the install strips and
discards anyway.

## User Stories

1. As a **browser app developer**, I want to run an indexer with **no stream keeper at all**, as a
   named and tested configuration, so that an app starting from a state snapshot pays nothing to
   store or read a stream it will never use. *(Extension of what exists: `keepStream` is already
   optional and `promiseToSave` already returns `'skipped'`. What is missing is that it is a
   supported MODE: asserted end to end, and asserted to write NOTHING under the stream keyspace.)*
2. As a **browser app developer**, I want that mode DOCUMENTED with its trade stated, so I choose it
   knowing a snapshot-seeded generation is a leaf that cannot serve a later processor-only change
   locally, rather than discovering it at the reconfigure. *(The measured cadence belongs here, so an
   author can judge the wait.)*
3. As a **maintainer**, I want `storedEventOf` and `storedStreamOf` exported from `@etherfold/core`,
   so that the PRODUCER in story 4, which lives outside core, reduces a decoded event to a stored one
   through the ONE implementation of that rule instead of a copy. *(ADR-0063 names this as a build
   item. Note what it does NOT justify: the loader itself lives INSIDE core and can reach the
   internal module directly, so the export earns its keep only because something outside core, the
   producer and any consumer writing its own installer, has to apply the same strip. The
   exploration's spike duplicating the three-key destructure is the evidence, and that duplication is
   what ADR-0060 exists to prevent.)*
4. As a **publisher**, I want to emit a stream-seed ARTIFACT from a captured stream, carrying its
   resolved stream config, its stream digest, its coverage, the chain head its producer OBSERVED at
   capture, and a declaration of what produced it, so that a client can establish what the artifact
   is without trusting the host that served it. *(Shape from the finding. The resolved config from
   ADR-0064, because a client cannot compute the 128-bit digest without it, and it is a SEPARATE
   input to the producer rather than something it can recover from the fixture, which carries only
   the 32-bit `streamConfigHashOf`. The observed chain head and the producer declaration from
   ADR-0065: story 9's capture-depth check reads the first, and the retraction rule is stated against
   the second. Today `StreamFixtureProvenance` types neither, admitting them only through its
   free-form index signature, so this story TYPES them.)*

   Note what the artifact does NOT carry: its own integrity hash. A document cannot contain a hash of
   itself, and ADR-0065's per-chunk-plus-manifest arrangement applies to the chunked shape this spec
   excludes. In the single-document shape the hash is computed by the client over the bytes it
   received and compared against the value story 7 pins; the producer's job is to PRINT it so a build
   can pin it, not to embed it.
5. As a **browser app**, I want to install a published stream seed through ONE call that fetches,
   checks and writes, so that a seed either lands fully verified or does not land at all. *(ADR-0063
   for the install through the keeper seam and its three block rules; ADR-0065 for every mandatory
   check running BEFORE the first write, which is what makes a half-verified stream unexpressible.)*
6. As a **browser app**, I want a seed that is not for my stream REFUSED, with a reason that names the
   DIRECTION of the disagreement, so that I can tell a user whether this build indexes less than the
   publisher does or the published seed is stale relative to this build. *(ADR-0064, including that
   the loader reports the direction and never infers "you are out of date", which it cannot know.)*
7. As a **browser app**, I want the loader to fetch only from the ORDERED list of locations I give it,
   walking to the next on failure, so that what I trust is a host I chose and my app still starts when
   the freshest one is unreachable. *(ADR-0066. This is the trust anchor: the caller names the locations, ordinarily from its build, and
   TLS to a named host is what it relies on. There is deliberately NO location-based REFUSAL, because a
   loader cannot be offered a seed from somewhere it was not pointed at. The list must accept a
   BUILD-EMBEDDED artifact at a relative path, with no host at all, and failover must reach it: that is
   the shape the reference deployment ships (rolling remote first, embedded last). It replaces ADR-0065's mandatory content pin, which cannot exist for
   a ROLLING artifact -- the reference deployment held one web build against an hourly snapshot -- and
   its same-origin condition, which is unavailable when the app is served from any IPFS gateway while
   the artifact lives on a known host.)*
8. As a **publisher of a release-tied seed**, I want to give the loader an OPTIONAL expected content
   hash and have a mismatched artifact refused, so that an immutable seed shipped for one release is
   verified rather than merely fetched from the right place. *(ADR-0066: optional because a rolling
   artifact's hash cannot be known at build time, and strongest-available where it can. The hash is
   SHA-256 over the DECOMPRESSED octets, taken after transfer decoding and before `JSON.parse`, which
   is transport-invariant and therefore imposes no rule on how a host serves the file.)*
9. As a **browser app**, I want a seed that is internally incoherent, or captured too close to the
   chain tip, refused before anything is written, so that a capture which recorded a branch that
   later lost cannot become my history. *(ADR-0065: ordering, one block hash per block number, no
   duplicates, coverage containment, retraction coherence against the declared producer, and the
   capture-depth check that mirrors the snapshot path's `inside-reorg-window`.)*
10. As a **browser app developer**, I want the seeding outcome to reach the surface I already
   subscribe to, so that an app can render "installing", "seeded at block N" or a refusal reason
   instead of an unexplained empty screen. *(ADR-0064 names this as a build-plan item; it lands on
   the existing browser status surface, which already carries `error` and `nonCanonicalGenerations`.)*
11. As a **browser app**, I want an install interrupted partway to resume WRITING from where the
    keeper's cursor already reaches, rather than writing the whole stream again, so that a closed tab
    does not corrupt the stream and does not re-do the work it had already committed. *(True by
    construction under ADR-0063, since a partial install is a contiguous prefix with an honest
    cursor, so this story ASSERTS rather than builds. Scope it honestly: in the single-document shape
    this spec chose, an interrupted install still re-fetches and re-parses the whole document, and
    only the WRITE phase resumes. Skipping the fetch is what the chunked shape buys and that shape is
    out of scope, so the spike's end-to-end resume assertion, which is a chunked run, is prior art
    for the mechanism and not for this story's scope.)*

### Autonomy notes

Neither gate flag is set. Every story above is a committed direction with its decision recorded, so
there is nothing for `needsAnswers` to carry, and nothing here is never-for-agents by nature.

The one thing a tasker should NOT infer: story 10 lands on the existing status surface deliberately,
and is not licence to implement the reactive-envelope redesign in
`work/notes/ideas/the-reactive-update-is-an-envelope-not-a-handle.md`. That is a separate, undecided
change.

## Implementation Decisions

**The slices, in order, each demoable on its own.**

**Slice A -- the snapshot-only mode (stories 1, 2).** Independent of everything else and first because
it is the path most apps should take. No new seam: it asserts and documents what the engine already
does when `keepStream` is absent. Demoable as a browser test that bootstraps from a snapshot, indexes
forward, and shows an empty stream keyspace.

**Slice B -- the artifact and its producer (stories 3, 4).** Export the strip; define the seed
envelope with its own format number beside `STREAM_FIXTURE_FORMAT` (a seed is not a fixture and must
not borrow its number); produce one from a captured stream. Demoable as a committed artifact emitted
from the committed capture, with its digest and integrity hash printed.

**Slice C -- the loader and the install (stories 5, 6, 7, 8, 9, 11).** The vertical tracer bullet:
fetch from a location list, run every check, write through the keeper seam, return an outcome.
Demoable in a browser as "a generation folds 31,332 events with no node in the loop", which the
exploration's spike already did in prototype form
(`docs/spikes/pin-the-seam-a-published-stream-arrives-through/`).

**Slice C is a CHAIN of tasks, not one task, and a tasker should cut it that way**: it carries six
stories and every admission rule, so cut as a single tracer bullet it would be the oversized task
§3's vertical slicing exists to prevent. The natural cut is (i) the loader plus the install of an
ALREADY-TRUSTED artifact, which is the tracer bullet and is demoable on its own, then (ii) the
admission checks in one task, since identity, integrity, coherence and capture depth share one
refusal path and one outcome type and splitting them would spread that type across three tasks.
Story 11 is an assertion on top of (i) and needs no task of its own.

**Slice D -- visibility (story 10).** Surfaces the outcome slice C returns. Last because it has
nothing to show until there is an outcome to show.

**The seams each slice lands on**, all of them existing: `ExistingStream` (`@etherfold/core`) for the
install, `StreamSegmentPort` beneath it untouched, the `IndexerGeneration` config's optional
`keepStream` for slice A, and the browser package's status store for slice D. The loader is NEW code
in `@etherfold/core`, beside `stream/fixture.ts`, which ADR-0063 chose because everything the install
is written against already lives there and `fetch` is global in every runtime this project targets.

**What is REUSE rather than new build**, since the exploration was asked to separate them: the
state-snapshot remote path (`bootstrapFromSnapshot`, mirror selection, failover, refusal-as-data)
already exists and slice A adds no capability to it; the segmentation rules, ordinal allocation,
cursor record and hole refusal are `createSegmentedStream`'s and are inherited rather than restated;
the strip exists and is only being exported. The genuinely new build is the artifact envelope, the
loader, the admission checks, and the outcome surface.

**The loader mirrors the snapshot path's VOCABULARY and not its predicates.** A location list, an
optional head, failover across mirrors, refusal returned as data. Its selection differs because a
stream has two bounds where a snapshot has one: a seed that does not reach back to the block the
client asks from is refused rather than merely ranked lower, and "prefer local" becomes "install only
into an EMPTY subtree", because an installer has no `streamRemainderOf` and an overlapping batch
would duplicate events.

## Testing Decisions

The load-bearing assertions, stated as external behaviour:

- **A generation folds a seeded stream with NO node call but `eth_chainId`.** The exploration's spike
  enforces this by giving the provider a `request` that throws on anything else, which is a better
  test than counting calls afterwards; copy it.
- **The stream keyspace is EMPTY in snapshot-only mode**, asserted by reading the keys, not by
  asserting a function was not called.
- **Every refusal is asserted as DATA with its reason**, including the direction pair
  (`seed-covers-more` versus `seed-covers-less`), because the direction is the half an application
  renders.
- **A refused seed writes NOTHING**, asserted on the keyspace after the refusal.
- **An interrupted install resumes its WRITES from the keeper's cursor** and lands on a stream
  identical to an uninterrupted one. The measurement harness asserts this end to end in a real
  browser for the CHUNKED shape; for the single-document shape the assertion is narrower (the writes
  resume, the fetch and parse do not), so write it against the writes rather than copying the
  chunked test's claim.
- **A capture taken inside the reorg window is refused**, which needs a synthetic artifact since the
  committed capture sits 27.5M blocks below its head.

Prior art to copy rather than reinvent: `packages/core/test/utils/streamCacheWorld.ts` for a fake
chain and an in-memory keeper, `docs/spikes/pin-the-seam-a-published-stream-arrives-through/` for the
install and the node-refusing provider, and
`docs/spikes/measure-what-a-published-stream-costs-to-install-and-pick-its-shape/` for the browser
harness.

## Out of Scope

Kept out because the exploration did NOT reach confidence on them, or reached confidence that they
should not be built yet. Each says which.

- **The CHUNKED, resumable artifact.** Designed and measured, and deliberately not built: the
  recommendation is a single document below roughly 50,000 events, and nothing in this project is
  near that. The finding names what would overturn it (a low-memory device evicting at a 50 MB peak,
  a capture growing past the threshold, a publisher that cannot serve range requests), so this
  returns as its own spec when one of those becomes true, not now.
- **Chain anchoring and bloom consistency.** Specified in ADR-0065 and deliberately not built: their
  value concentrates in adopting a seed whose host is not trusted, and ADR-0066 answers that case with
  a signature rather than a sampled check, deliberately not built.
- **Publisher SIGNING.** Would let a client trust a publisher it did not build with; needs key
  distribution this project has none of. The artifact keeps room for it.
- **Server-side seeding.** `@etherfold/server` has no `ExistingStream` writer over `_emissions` (that
  table is written by an appender inside `receive`, and `storedEmissionStream` is read-only), so
  seeding it is a different write path nobody has decided. ADR-0063 scopes itself to keeper-backed
  clients for this reason.
- **The publishing pipeline** (CI, hosting, retention of old artifacts, who is allowed to publish):
  `work/notes/ideas/publishing-snapshots-of-versioned-state.md`.
- **The snapshot's own verification**, which is BUILT, not pending:
  `work/tasks/done/a-snapshot-a-client-cannot-read-is-refused-not-installed.md` landed it. (The
  source exploration spec and ADR-0065 both cite it under `work/tasks/backlog/`, a path that no
  longer exists; the exploration spec is a launch snapshot and is left alone, and the ADR's citation
  is corrected in the same change as this spec.)
- **Detecting OMISSION.** Not deferred, IMPOSSIBLE within the premise: a seed that leaves logs out is
  structurally perfect and bloom-consistent, and finding out otherwise needs the historical logs the
  node will not serve. ADR-0065 accepts this residue explicitly, and ADR-0066 draws the consequence:
  because omission is undetectable and a poisoned stream is inherited by every later generation, the
  host a build names must be trusted the way the build pipeline is trusted.
- **Signature-based verification**, which is the only thing that makes an artifact trustworthy
  INDEPENDENT of the host serving it, and the named answer for a third-party mirror or an untrusted
  gateway. Not built: no key distribution or rotation exists here (ADR-0066).
- **The `readOnlyStream` self-clear defect**
  (`work/notes/observations/a-follower-can-self-clear-the-writers-stream-through-the-read-only-view.md`).
  Reachable only by a snapshot-seeded generation that ALSO keeps a stream, which this spec recommends
  against on independent grounds; fixing it is a design call with three candidate shapes and belongs
  to `readOnlyStream`/ADR-0044, not here.
- **Running the indexer in a worker**, and **the reactive envelope**: two separate ideas
  (`work/notes/ideas/`), both bigger than seeding.

## Further Notes

**Read the exploration's honest conclusion before adding a story about "making the browser case
possible".** The source spec opens on the premise that a browser frequently cannot backfill at all,
and treats seeding as the rescue. The operational record says the rescue was already the state
snapshot on cadence: 8,198 publishes over 357 days, median gap 1.0 h. A stream seed's justification
is narrower and is what story 5 exists for, which is why slice A comes first and is not framed as a
fallback.

**The one latent defect in the mode slice A blesses.** `createSegmentedStream.fetchFrom` self-clears
beneath `readOnlyStream`, so a follower reading a stream that does not reach back to the source's
start block clears the writer's history. A snapshot-seeded generation that also keeps a stream is
exactly the shape that produces such a stream. Slice A does not trip it (no stream at all) and slice
C does not (ADR-0063 makes a seeded stream reach back to the capture's own `fromBlock`), so this spec
can be built without fixing it -- but a task that decides to keep a stream on a snapshot-seeded
generation must read that observation first.
