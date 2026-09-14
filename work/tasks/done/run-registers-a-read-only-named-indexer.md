---
title: 'The combined run registers a READ-ONLY named indexer, so its read tier answers'
slug: run-registers-a-read-only-named-indexer
blockedBy: []
covers: []
---

## What to build

The whole read tier on the deployment `CONTEXT.md` calls the milestone, without opening the write path it deliberately closed.

`etherfold run` folds a chain and serves `/status`, and nothing else. Every data route is namespaced, and they all resolve through one shared lookup that answers `501` when a host supplies no registry of named indexers. `run` supplies none, so this is what a client gets from it today:

| route | on `run` |
| --- | --- |
| `/status`, `/admin/setup` | works |
| `/:indexer/feed`, `/:indexer/canonical` | `501` |
| `/:indexer/state-moved` | `501` |
| `/:indexer/admin/canonical-generation` | `501` |
| `/:indexer/ingest` | `501` (intended) |

So the feed, the canonical pointer, the state-moved signal and the operator's own promote/revert route are all dark on the shape most apps point at.

That was never decided. What `run` deliberately withholds is INGESTION, and the recorded reason is precise and correct: this process fetches the chain for itself, so a remote sender pushing into it would be a second writer nobody asked for. That argument covers the write path and says nothing about reads. The read routes went dark as a SIDE EFFECT of closing the write path, because registration is currently all-or-nothing.

The obstacle is one required member: `liveIngestions()` on a registry entry is what the ingest route consumes, and it is not optional, so an entry that offers the read capabilities cannot avoid offering the one that accepts writes. So this task makes "readable, not ingestible" **expressible**, and then has `run` express it.

Make the absence mean something rather than merely being tolerated: the codebase already reads an absent capability as a statement (`generations?`, `promote?`, `onStateMoved?`, `coherenceNow?`, and `holdsStreamsAcrossRequests` where absent means no). An entry that cannot be ingested into should REFUSE ingestion in the same honest way a host that cannot hold a stream across requests refuses the state-moved stream, rather than accepting a batch it will not apply.

Everything else `run` needs already exists: it holds the indexer name (every stored emission row and registry row is keyed on it, `NOT NULL`), the database, and the container that answers the generation questions. So the registration itself is assembly, not new machinery.

Note what this is NOT. It does not make `run` multi-tenant, it does not add a way to reconfigure a running process, and it does not change which generation answers. It makes the routes that already exist answer on a deployment that already holds everything they need.

## Acceptance criteria

- [ ] Under `run`, a client can read the FEED and the CANONICAL generation for the indexer that deployment folds, rather than receiving `501`.
- [ ] Under `run`, a client can subscribe to the state-moved signal and is told the state moved as the fold applies blocks, with the same payload a split deployment serves.
- [ ] Under `run`, the operator's promote and revert route answers, since this is the shape that holds generations and may add and promote one.
- [ ] Ingestion is still REFUSED under `run`, and refused because the entry states it accepts none rather than because a credential happens to be unset. Asserted with a credential present, so the refusal cannot be passing for the wrong reason.
- [ ] The refusal names why, in the shape the other capability refusals already use, so an operator can tell "this deployment does not accept pushes" from "this host has no registry at all" and from "no such indexer here".
- [ ] "Readable but not ingestible" is expressible at the registry seam rather than being a special case inside `run`, so a second host can state the same thing.
- [ ] A host that DOES accept ingestion is unchanged in every respect: `index` still registers exactly as it does today, and no existing refusal changes shape.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style, and the `@etherfold/server` platform-agnostic source scan still passes.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

None. It can start immediately.

## Prompt

The goal is that pointing an app at the combined deployment gives it the same read surface a split deployment has, while the reason `run` refuses pushes stays exactly as true as it is today.

Read `@etherfold/server`'s `registry.ts` for `IndexerRegistryEntry`, `indexerEntryOn` and `indexerRegistry`, and `api/resolve.ts` for the shared lookup that decides `501` versus `404` versus serving. The distinction that file draws is the one to extend rather than blur: a capability this host lacks, a tenant it was not built with, and a request it can answer are three different answers.

Where to look for the shape of an absent capability: `ServerOptions.holdsStreamsAcrossRequests` (absent means no, and the state-moved route refuses on it rather than sniffing a runtime) is the closest precedent, and `generations?` / `promote?` are the closest precedent for a per-entry one. The CLI's own registration is written out longhand in `indexCommand.ts` rather than built with the helpers, and the comment there says why, so follow that reasoning rather than assuming it should be refactored.

The decision most likely to be got wrong: do not express this by making `run` pass an entry whose `liveIngestions()` answers an empty list. That is a lie that type-checks. An empty list means "no live wire contexts right now", which is a legitimate transient state on a host that DOES accept ingestion, so overloading it would make a permanent refusal indistinguishable from a momentary one and would have the ingest route accept a batch it silently drops. The absence has to be a statement about the deployment, not a value that happens to be empty.

The second: the refusal must not depend on `INGEST_TOKEN` being unset. With no token configured every ingestion call is refused `401` anyway, and it is tempting to lean on that. It is a door held shut by a missing environment variable, and it opens the moment an operator sets one for an unrelated reason. Refuse on the declared capability, and assert it with a token present.

The seam to test at is the server's existing API test setup for the refusals and the read routes, plus whatever the CLI tests already use to stand a `run`-shaped deployment up, so the claim being checked is "this deployment serves reads and refuses pushes" rather than "this function returns this object".

Done means: `run` serves its feed, its canonical pointer, its state-moved stream and its promote route, refuses ingestion for a stated reason with a valid credential presented, and `index` is untouched.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise — route the task to needs-attention with the discrepancy as the reason.

RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT. How "accepts no ingestion" is expressed at the seam, and what the ingest route answers for it, are both such decisions: a later task may want a host that accepts ingestion for one name and not another, so the shape chosen here should not foreclose that. Do not write the done record, the commit message or the PR body yourself, and do not open an observation note for a decision you made.

## Decisions

**1. "Accepts no ingestion" is expressed by OMITTING `liveIngestions` from the entry, not by a new flag.** The codebase already reads an absent optional member as a capability statement (`generations?`, `promote?`, `onStateMoved?`, `coherenceNow?`), so this reuses that convention instead of forking a second one (`acceptsIngestion: false`, `readOnly: true`), which would have meant two ways to say a capability is missing on one type. Alternatives considered and rejected: a boolean field on the entry (a second vocabulary for absence); a host-level `ServerOptions` flag on the model of `holdsStreamsAcrossRequests` (wrong layer — it would be a statement about the deployment as a whole, and a later host wanting to accept pushes for one name and refuse them for another could not express it; per-entry absence makes that case free); and `liveIngestions()` answering `[]` (explicitly forbidden by the task and rightly: an empty list is a legitimate transient state on a host that does accept pushes). **Touches:** `IndexerRegistryEntry` (every host that builds one — `platforms/nodejs`'s passthrough type in its test needed a `NonNullable`), `indexerEntryOn`, both ingest routes, and `etherfold run`. **Residual risk, stated rather than hidden:** a host that simply *forgets* the member now silently becomes read-only instead of failing to compile. That is the same trade the four existing optional members already make, and the refusal is loud (`501` naming the reason and the command that does receive pushes) rather than silent at runtime.

**2. The ingest route answers `501 ingestion-not-accepted`, a THIRD refusal beside `ingestion-not-configured` and `unknown-indexer`.** `501` because it is the status every other capability refusal on this server already uses (`ingestion-not-configured`, `generations-not-held`, `state-moved-not-published`) and because nothing about the request is wrong and no retry helps. A NEW error code rather than reusing `ingestion-not-configured`, because the acceptance criterion is precisely that an operator can tell "this deployment does not accept pushes" from "this host has no registry at all" from "no such indexer here" — and existing tests assert the old code for the read-tier case, which is unchanged. Alternatives considered: `400 context-mismatch` with an empty `expected` (rejected — it is a payload refusal, and it would tell a sender its batch was wrong when nothing about it was), and `403` (rejected — this is not about who is calling; the caller is correctly authenticated). It is decided before the body is buffered, since no payload could change it. **Touches:** `packages/core`'s `createHttpIngestion` classification only in that this lands in the non-retryable 4xx/5xx handling it already has for `501`; no sender change was needed.

**3. `run` prints a `feed:` line at startup beside `status:`.** User-visible output change, small but not invisible: the route segment is the one thing an app pointed at a combined process must know and cannot guess (the name may have been defaulted to `default`). `index` already prints its ingest URL for the same reason. Alternative considered: print nothing and leave the name discoverable only through `--indexer` / the config docs — rejected as the worse default for the shape the milestone calls the one to reach for.

**4. No dedicated `readOnlyEntryOn` helper was added.** The statement at the seam is the ABSENCE, and `run` cannot import from `@etherfold/server` at assembly time anyway (the lazy-import reason `indexCommand.ts` records), so a third entry constructor would have had test-only callers while adding a new named concept ("read-only entry") to the package's API. A host holding a container that wants to state this passes `indexerEntryOn` what it wants answered, without that question; that path is asserted. **Touches:** anyone later adding a second read-only host (e.g. if `serve` is ever given a registry) — they get the seam, not a helper, and adding one then is cheap.
