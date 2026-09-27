---
title: 'A build publishes what a browser app starts from'
slug: a-build-publishes-what-a-browser-app-starts-from
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

<!-- open-questions -->
<!--
  TRANSIENT BLOCK: stripped by the apply rung on full resolution.
-->

## Open questions

All answered by the maintainer on 2026-09-26. The block stays as the record of the decisions until tasking trims it into tasks and ADRs.

1. **Both** (answered). `etherfold publish --db <url> --out <dir>` writes the artifacts from any database a command wrote (`build`, `run`, `index`), and `etherfold build --publish <dir>` runs it at the tip `build` stops at, so a scheduled job is one step.
2. **An option: `all`, a depth in blocks, or `none`** (answered). How much superseded history the state snapshot carries. `none` is the current live rows only, and the consumer's history floor is the snapshot's block (ADR-0028); a depth `N` carries every version still valid within `N` blocks below it, so a tab can revert and read as-of that far down; `all` carries every version back to the source's start block. The default is an open detail for the tasks (`none` is the smallest download; the retention the database was built with is the natural ceiling).
3. **The format is designed for this, not inherited** (answered). The one that exists (`ENTITY_SNAPSHOT_FORMAT = 1`, a JSON document of `Mutation` upserts written by `createSnapshot`) has never been published, so nothing constrains it; it cannot carry history at all, and it repeats the entity name and every field name on every row. Proposed replacement, format 2:
   - **The rows are the store's own VERSIONS**, each with the block range it is valid over, rather than upserts. Then `none`, a depth and `all` are ONE shape differing only in which versions are included, and installing one writes the rows a versioned store already holds, with no re-derivation.
   - **Columnar per entity**: an entity's declaration (name, id columns, fields) is written once, then its versions as arrays in that column order.
   - **Newline-delimited and gzipped**: one entity header line, then one line per version. A browser inflates it with the built-in `DecompressionStream` and installs it chunk by chunk without holding the whole document, which is where a phone spends its time (the download and the write, per `what-a-published-stream-seed-costs-to-install`).
   - **The blocks the history window needs** (number, hash, timestamp) travel with it, so an as-of read by time works below the snapshot's block.
   - Cost to accept: installing versions is a new install path in each store backend (the current one installs live rows at a single block), and the head carries the history floor as well as the snapshot's block.
4. **A tab runs the BUNDLE, so its identity is the bytes' hash** (answered). The browser already accepts an identity from its arrival (`processorIdentity` on the generation spec), so a build step COULD inject the bundle's hash while the tab runs the module Vite compiled. That is the one variant to refuse: the identity would name bytes the tab does not run, which is the lie ADR-0086 exists to remove (it states that the same code as a module and as a bundle are different generations). Instead the tab loads the very bundle `build` folds with, served as a static asset: `@etherfold/browser` fetches its bytes, hashes them, and instantiates from them, the browser counterpart of `loadProcessorArtifact`. The identity then matches the publisher's by construction, and a mismatched deploy is refused by name. HMR in development keeps the module arrival and its module identity; a published snapshot is for a deployed build, as ADR-0086 already says.
5. **The producer cuts at `tip - finality`** (answered), for both the state snapshot and the stream seed, so a tab that starts from them can absorb any reorg the chain can still make. A versioned store answers the rows as of that block directly; the cursor at the cut is rebuilt from the stored stream, whose last `finality` blocks are the cursor's unconfirmed window.
6. **The layout** (answered), for a plain static host with no server logic:
   - Bodies are IMMUTABLE and named by their content hash (`state/<sha256>.ndjson.gz`, `seed/<sha256>.json.gz`), so a CDN may cache them for ever and two publications never write the same path.
   - **Nothing a publication wrote is ever deleted by a later one.** A publisher cannot know how long a user keeps an old build of the app open (or cached), and an immutable release may pin a body's hash (ADR-0065). Pruning is an explicit operator act, never a side effect of publishing.
   - One small mutable `head.json`, KEYED rather than naming one "current" publication: the latest STATE SNAPSHOT per processor identity (its body's hash and size, its block and its history floor), and the latest STREAM SEED per stream digest (hash, size, coverage). An old build runs the old processor and REFUSES every snapshot of the new one (ADR-0086), so a head naming only the newest would strand it; keyed, it finds the last snapshot published for its own processor, stale but valid, and indexes forward from there. A seed belongs to a stream and not to a processor, so an old build on the same stream still installs the newest seed. Entries are never removed, and each is a few lines.
   - `head.json` is written LAST (a rename where the filesystem allows, one commit on a git host), so a reader never sees a head naming a body that is not there yet.
   - The browser points ONE location at `head.json` and picks its own entries (its processor's snapshot, its stream's seed), instead of configuring the snapshot and the seed separately.

<!-- /open-questions -->

## Problem Statement

A browser app often cannot index from its contracts' start block: a public node refuses the historical `eth_getLogs` a backfill needs. So what a tab holds at startup has to arrive as a PUBLISHED ARTIFACT, and etherfold already knows how to CONSUME two of them: a **state snapshot** the tab starts from and indexes forward of (the snapshot-only mode), and a **stream seed**, the raw stream installed beneath the state so a later processor change re-folds locally (ADR-0063 to ADR-0066). Both are documented in the browser guide.

Nothing PRODUCES either one from a real deployment. `etherfold build` folds the chain into a libSQL database and exits at the tip, and that database already holds both halves: the entity rows of the canonical generation and the stored raw stream (`_emissions`). But no command writes them out. `createSnapshot` only wraps rows its caller already has, because the store seam has no "list everything" read by design (ADR-0021), and the only stream-seed producer is a script inside the test-workload package, fed by a committed capture. So every app that wants the snapshot-only mode has to write its own producer against a backend's tables, which is exactly the drift a published contract exists to prevent.

The motivating case is `stratagems` (`port-stratagems-to-the-etherfold-packages`): an hourly job runs the retired `ei -f`, which wrote the free-form path's state file into `web/static/indexed-states/`, and the web app serves it statically. Ported to `etherfold`, the fold works and the publication step has no equivalent.

## Solution

The CLI writes a `build` database out as the artifacts a browser app starts from: a state snapshot of the canonical generation and a stream seed of the stream it folds, each with the `head` document a location names, into a directory a static host can serve. A browser app then points its existing snapshot and seed options at that host, and a scheduled job that runs `build` and publishes replaces the old `ei -f` in one step.

## User Stories

1. As an app developer, I want one CLI command to turn the database my `build` produced into files my browser app can start from, so that I do not write a producer against the store's private tables.
2. As an app developer, I want the state snapshot it writes to be the one `bootstrapFromSnapshot` / `openAndBootstrap` already read, so that the browser side needs no new code.
3. As an app developer, I want the stream seed it writes to be the one the browser's `seed` option already installs, so that a processor-only change re-folds locally instead of waiting for a republished snapshot.
4. As an operator of a scheduled publishing job, I want the step to be one command after (or part of) `build`, so that the job is as simple as the `ei -f` it replaces.
5. As an operator, I want the output to be plain files plus a `head` document, so that a git repository or any static bucket can serve it.
6. As an operator, I want a republication to land without a window where a reader sees a `head` naming a body that is not there yet, and without deleting anything an earlier publication wrote.
7. As an app developer whose users keep an OLD build open, I want that build to keep finding the last snapshot published for its processor, so that shipping a new processor never strands users who have not reloaded.
8. As an app developer, I want the artifacts to name the processor that computed them, so that a tab running different code is refused rather than seeded with someone else's state (ADR-0040, ADR-0086).
9. As an app developer, I want the command to refuse a database whose canonical generation is not the processor I asked it to publish, naming both, so that a stale database is never published under a new build.
10. As an app developer, I want the snapshot cut below the reorg window, so that a tab that starts from it can absorb a reorg.
11. As an operator, I want the command to print what a build would PIN (the content hash of an immutable seed), as the existing seed script does, so that a release can name exactly what it trusts (ADR-0065).
12. As a maintainer, I want the snapshot producer to read every live row through ONE backend query in `@etherfold/state-store-sqlite` rather than through the seam, so that ADR-0021's "no list-everything read on the seam" stays true.

### Autonomy notes

- No `needsAnswers`: questions 1 to 6 were answered on 2026-09-26. Two details are left to the tasks: the default history option (`none` is the smallest download; the database's own retention is the ceiling) and the exact field names.
- Not `humanOnly`: once answered, the tasks are ordinary code in `etherfold` and its SQLite backend.

## Implementation Decisions

- **The stream seed is packaging.** `_emissions` is the stored stream, and `@etherfold/core` already owns the envelope (`StreamSeed`), the strip (`storedStreamOf`), the digest and the content hash. The producer reads the stream the canonical generation folds and serializes it.
- **The state snapshot needs a backend read the seam does not have**: every live row of the canonical generation's namespace (ADR-0053), as the `Mutation` upserts `createSnapshot` takes, plus that generation's cursor. It belongs in the SQLite backend, beside the queries it already owns, not on the seam.
- **The identity published is the registry's**: the canonical generation's `processor`, never re-derived (ADR-0086).
- **The rows at the cut come from the versioned store's as-of read** at `tip - finality`, so the cut needs no second fold.

## Testing Decisions

- The end-to-end claim is round trip: `build` a fixture chain, publish, then open a browser container with the snapshot-only mode (and, separately, with the seed) over the published files, and land on the same state as a container that indexed the same chain itself. `packages/browser/test/snapshotOnlyMode.test.ts` is the prior art for the consuming half.
- Refusals are asserted as outcomes a reader sees: a snapshot of another processor, a seed for another stream (ADR-0064), a database with no canonical generation.

## Out of Scope

- Hosting, retention and who may publish: the output is a directory; where it goes is the operator's (as the seed script's own header says).
- Porting stratagems itself: `port-stratagems-to-the-etherfold-packages`, which is blocked on this.

## Further Notes

The idea `publishing-snapshots-of-versioned-state` framed this producer half and its questions; this spec is that idea with a concrete first user.
