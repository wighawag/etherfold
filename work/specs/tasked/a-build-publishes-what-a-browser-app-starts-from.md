---
title: 'A build publishes what a browser app starts from'
slug: a-build-publishes-what-a-browser-app-starts-from
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

> **Tasked 2026-09-26.** The answered questions (the two command forms, the history option, format 2, the tab running the published bundle, the cut at `tip - finality`, and the keyed never-delete layout) and their reasons moved to ADR-0095; what to build moved to the tasks with `spec: a-build-publishes-what-a-browser-app-starts-from`.

## Problem Statement

A browser app often cannot index from its contracts' start block: a public node refuses the historical `eth_getLogs` a backfill needs. So what a tab holds at startup has to arrive as a PUBLISHED ARTIFACT, and etherfold already knows how to CONSUME two of them: a **state snapshot** the tab starts from and indexes forward of (the snapshot-only mode), and a **stream seed**, the raw stream installed beneath the state so a later processor change re-folds locally (ADR-0063 to ADR-0066). Both are documented in the browser guide.

Nothing PRODUCES either one from a real deployment. `etherfold build` folds the chain into a libSQL database and exits at the tip, and that database already holds both halves: the entity rows of the canonical generation and the stored raw stream (`_emissions`). But no command writes them out. `createSnapshot` only wraps rows its caller already has, because the store seam has no "list everything" read by design (ADR-0021), and the only stream-seed producer is a script inside the test-workload package, fed by a committed capture. So every app that wants the snapshot-only mode has to write its own producer against a backend's tables, which is exactly the drift a published contract exists to prevent.

The motivating case is `stratagems` (`port-stratagems-to-the-etherfold-packages`): an hourly job runs the retired `ei -f`, which wrote the free-form path's state file into `web/static/indexed-states/`, and the web app serves it statically. Ported to `etherfold`, the fold works and the publication step has no equivalent.

## Solution

The CLI writes a `build` database out as the artifacts a browser app starts from: a state snapshot of the canonical generation, sized by the state and never by the stream, and, when asked, a stream seed of the stream it folds, under one publication index (`publication.json`) into a directory a static host can serve. A browser app points one option at that index and runs the published processor bundle, and a scheduled job that runs `build --publish` replaces the old `ei -f` in one step.

## User Stories

1. As an app developer, I want one CLI command to turn the database my `build` produced into files my browser app can start from, so that I do not write a producer against the store's private tables.
2. As an app developer, I want the state snapshot it writes to be the one `bootstrapFromSnapshot` / `openAndBootstrap` already read, so that the browser side needs no new code.
3. As an app developer, I want the stream seed it writes, when I ask for one, to be the one the browser's `seed` option already installs, so that a processor-only change re-folds locally instead of waiting for a republished snapshot.
4. As an operator of a scheduled publishing job, I want the step to be one command after (or part of) `build`, so that the job is as simple as the `ei -f` it replaces.
5. As an operator, I want the output to be plain files plus one index document, so that a git repository or any static bucket can serve it.
6. As an operator, I want a republication to land without a window where a reader sees an index naming a body that is not there yet, and without deleting anything an earlier publication wrote.
7. As an app developer whose users keep an OLD build open, I want that build to keep finding the last snapshot published for its processor, so that shipping a new processor never strands users who have not reloaded.
8. As an app developer, I want the artifacts to name the processor that computed them, so that a tab running different code is refused rather than seeded with someone else's state (ADR-0040, ADR-0086).
9. As an app developer, I want the command to refuse a database whose canonical generation is not the processor I asked it to publish, naming both, so that a stale database is never published under a new build.
10. As an app developer, I want the snapshot cut below the reorg window, so that a tab that starts from it can absorb a reorg.
11. As an operator, I want the command to print what a build would PIN (the content hash of an immutable seed), as the existing seed script does, so that a release can name exactly what it trusts (ADR-0065).
12. As a maintainer, I want the snapshot producer to read every live row through ONE backend query in `@etherfold/state-store-sqlite` rather than through the seam, so that ADR-0021's "no list-everything read on the seam" stays true.

## Out of Scope

- Hosting, retention and who may publish: the output is a directory; where it goes is the operator's (as the seed script's own header says).
- Porting stratagems itself: `port-stratagems-to-the-etherfold-packages`, which is blocked on this.

## Further Notes

The idea `publishing-snapshots-of-versioned-state` framed this producer half and its questions; this spec is that idea with a concrete first user. The idea is retired now that ADR-0095 answers it.
