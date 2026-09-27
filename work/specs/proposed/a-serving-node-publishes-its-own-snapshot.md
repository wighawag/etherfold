---
title: 'A serving node publishes its own snapshot'
slug: a-serving-node-publishes-its-own-snapshot
taskedAfter: [a-build-publishes-what-a-browser-app-starts-from]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks.

## Problem Statement

`a-build-publishes-what-a-browser-app-starts-from` (ADR-0095) makes a publication something a job WRITES: `etherfold build --publish` or `etherfold publish` produce a directory, and something else (a scheduled GitHub Action pushing to a static host) has to run it and serve the result. An app whose data already comes from a running `run`, `node` or `serve` then needs a second moving part just to hand a new tab a snapshot of the state that node is already serving.

## Solution

Every command that SERVES reads (`run`, `node`, `serve`) also serves its own publication, over the same HTTP it already answers: the publication index at `/{indexer}/publication.json` and the bodies at the same relative paths a published directory uses. It is ON by default and an operator can refuse it. A browser app lists the node, a static mirror written by a job, or both, in the one publication-index option it already has, and fails over between them. Both paths stay supported, and they publish the same format from the same producer.

## User Stories

1. As an app developer, I want my running node to serve the snapshot a new tab starts from, so that I need no separate publishing job.
2. As an app developer, I want what the node serves to be exactly what `etherfold publish` writes (the same format, the same index, the same relative layout), so that the browser side is one option whichever path I use.
3. As an app developer, I want to list the node AND a static mirror as index locations, so that a tab starts even while one of them is down.
4. As an operator, I want this on by default and refusable with one flag (`--no-publication`), so that a deployment that must not spend the work can say so. It exposes nothing new: the state is already public through the query API.
5. As an operator, I want the node to build a new snapshot at most once per interval, however many tabs ask, so that a popular app cannot make it re-read its whole state on every request. The interval defaults to an HOUR'S WORTH OF BLOCKS on that chain and is set with `--publication-every <blocks>`.
6. As an app developer whose users keep an old build open, I want the node to keep serving the last snapshot it produced for that build's generation after the generation's state is gone (a promotion that dropped it, a `reclaim`), so that an old build keeps working with no static mirror.
7. As an operator, I want those produced bodies stored in the node's own database, never deleted by a later publication (ADR-0095), so that the deployment stays self-contained.
8. As an app developer, I want the node to serve the stream seed too when I ask for it (`--publication-seed`, off by default), so that a tab can re-fold locally after a processor change.
9. As an operator, I want immutable bodies served as cacheable for ever and the index with a short lifetime, so that a CDN can sit in front of the node.
10. As an operator, I want the endpoint to answer from the same producer `etherfold publish` uses, so that the two paths cannot drift.
11. As an app developer, I want `serve` (the read tier over a database written elsewhere) to publish too, so that the process that answers my reads is also the one my tabs start from.

## Implementation Decisions

Decided with the maintainer on 2026-09-26:

- **One producer.** `publish-writes-a-state-snapshot-a-browser-app-starts-from` builds the producer as a library function in `@etherfold/server`, with the `publish` command as a thin wrapper. The serving hosts call the same function; nothing about the format, the cut at `tip - finality`, the keying by generation or the expected-processor refusal is re-implemented.
- **On by default**, refused with `--no-publication` on `run`, `node` and `serve`. A refused endpoint answers a named refusal, not an empty index, so a tab reports why and fails over.
- **At most one snapshot per interval.** Produced on the first request after the cut has moved on by at least the interval since the last one, and served from what is stored until then. The default interval is an hour's worth of blocks, estimated from the chain's recorded block timestamps; `--publication-every <blocks>` overrides it.
- **Bodies are stored in the node's database**, content-addressed and never deleted by a later publication, and they outlive the generation that produced them, so the index keeps an entry for a generation whose state is gone. The index the node serves is derived from what is stored.
- **The seed is opt-in** (`--publication-seed`), as on `publish`.
- **Caching**: bodies are served immutable (their name is their hash); the index is served with a short lifetime.
- **ADR-0095 gets a dated amendment** when this is built, recording that a publication has two producers (a job and a serving host) over one format and one layout.

## Testing Decisions

- The end-to-end claim: a `run` folds a fixture chain, a tab points its publication-index option at the running node and lands on the same state as a tab that indexed the chain itself; the same with the node listed after an unreachable location, and with a static mirror listed after an unreachable node.
- The interval: many requests within one interval produce one snapshot (asserted on what is stored, not on timing), and the first request after the cut moved on produces the next.
- An old build: after a promotion that drops the old generation's state, the node's index still names that generation's last snapshot and a tab running the old bundle starts from it.
- `--no-publication` answers the named refusal and stores nothing.

## Out of Scope

- The directory path (`publish`, `build --publish`): `a-build-publishes-what-a-browser-app-starts-from`, which this is tasked after.
- Authentication on the endpoint: it serves what the query API already serves.
- Pruning stored bodies: an operator's explicit act, as in ADR-0095.
