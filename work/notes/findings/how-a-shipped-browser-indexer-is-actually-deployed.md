---
title: 'How a shipped browser indexer is actually deployed: an IPFS app, a rolling snapshot on a known host, and an embedded fallback baked into the build'
slug: how-a-shipped-browser-indexer-is-actually-deployed
source: 'derived from reading the stratagems repository @ 3d5a0b3f (2024-12-18) -- web/src/lib/state/State.ts, web/src/lib/config.ts, web/.env, web/.gitignore, .github/workflows/ipfs.yml and the root package.json indexer:index script -- plus the publishing cadence measured from the git history of the public wighawag/stratagems-snapshots repository (8,198 publishes, 2024-02-08 to 2025-01-30, see what-a-published-stream-seed-costs-to-install.md), and the maintainer''s own account of how clients behaved, 2026-09-07. NOTE the deployment ran on the PREDECESSOR library (ethereum-indexer-browser, keepStateOnIndexedDB), not on etherfold, so it is evidence about the DEPLOYMENT SHAPE and not about current APIs.'
---

> Written because this shape has now corrected three etherfold decisions after they were made, each
> time because the decision was reasoned from a spec's prose instead of from a deployment. It is
> external ground truth in the sense the contract means: a world our software has to fit, verified by
> reading it rather than assuming it.

## The shape, in one paragraph

The APP is deployed to IPFS and reached through whichever gateway a user happens to use. The SNAPSHOT
is a separate artifact on a KNOWN HTTPS host (`https://snapshots.stratagems.world`), republished on a
cron roughly hourly while the app build stays fixed for long stretches. The app carries a THIRD
thing: a snapshot EMBEDDED in its own build, at a relative path, used as a fallback. A client prefers
the freshest source it can reach, falls back to the one baked into the build, and skips a snapshot
that is behind where it already is. There is NO stream: the deployment kept state only.

## What the code says, specifically

`web/src/lib/state/State.ts` builds a list of snapshot locations, in priority order:

```ts
const embededIndexedState = {prefix: url(`/indexed-states/${initialContractsInfos.name}/`)};
const indexedStateLocations: IndexedStateLocation[] = [embededIndexedState];
if (remoteIndexedState) {
	indexedStateLocations.unshift({prefix: remoteIndexedState});
}
```

Four facts follow, and each one bears on a decision etherfold has already taken:

1. **The remote host is a build-time constant with a RUNTIME OVERRIDE.**
   `web/src/lib/config.ts` resolves `snapshotURI = params['snapshot'] || PUBLIC_SNAPSHOT_URI`, and
   `web/.env` sets `PUBLIC_SNAPSHOT_URI=https://snapshots.stratagems.world`. So the location is
   ordinarily named by the build, and a URL query parameter can point the app at a different
   snapshot host. That affordance is real and is used for development; it also means any URL can
   inject a state source, which is the app's risk to take and not the library's to prevent.
2. **There is an EMBEDDED snapshot inside the build**, generated at build time by the root
   `indexer:index` script (`pnpm --filter ./indexer index-to-file ... -f ../web/static/indexed-states/<MODE>`)
   and gitignored (`web/.gitignore`: `static/indexed-states/*`), so it is a build ARTIFACT rather
   than a committed one. It ships with the app, at a relative path, and is therefore delivered by
   exactly the same bytes and the same gateway as the code.
3. **The ORDER is freshest-first, embedded-last.** The remote is `unshift`ed ahead of the embedded
   one. So the embedded snapshot is a FALLBACK: the app still works with no reachable snapshot host
   at all, just staler, and then indexes forward from the chain.
4. **No stream keeper.** The generation was created with `keepState` only (the predecessor library's
   whole-blob state keeper). The shipped game stored and read no event stream.

## Why this keeps correcting decisions

Three so far, all of them from assuming a shape rather than reading one:

- **"A browser cannot backfill at all, so seeding is what makes it possible."** The exploration spec's
  premise. Actually the hourly snapshot plus a short servable backfill is what made it possible, and
  the stream was never part of it (`what-a-published-stream-seed-costs-to-install.md` measured the
  cadence: median 1.0 h, worst observed 50.9 h, so 1,802 to 91,527 blocks to fetch).
- **"The seed ships pinned by the build."** ADR-0065's trust anchor. A build cannot pin the hash of an
  artifact republished every hour against a build that does not change; ADR-0066 replaced it.
- **"Same origin is the cheap accepted case."** Also ADR-0065. With the app on IPFS and the snapshot
  on a named host the two origins never match, so the concept does not apply; ADR-0066 dropped it.

The pattern in all three is the same: a decision derived from prose about what a browser app *must*
need, where the deployment had already answered what it *does* need.

## The half that was still missing after ADR-0066: the EMBEDDED artifact

Neither ADR describes it, and it is arguably the most important shape for an IPFS-delivered app,
because it is the one that needs no host at all.

An artifact embedded in the build is a distinct case from both of ADR-0066's:

- it is IMMUTABLE and versioned with the build, so its content hash is knowable at build time, and
  also POINTLESS to check, because it arrives as part of the same delivery as the code that would do
  the checking. Verifying it proves nothing that was not already assumed;
- it is reachable at a RELATIVE path, so it needs no host to be named, no TLS relationship, and no
  trust decision separate from the app's own;
- and it is the LAST resort in the ordering, which is what makes the app resilient to its own
  snapshot host being down or gone.

So a location list should be able to hold one, ordering should be caller-controlled (freshest first),
and failover should walk to it. `bootstrapFromSnapshot` already supports a location list with
failover and prefers local state that is ahead, so the mechanism exists; what was missing is anybody
writing down that a BUILD-EMBEDDED location is a first-class member of that list.

## What this does NOT establish

- **Nothing about etherfold's current APIs.** The deployment ran on `ethereum-indexer-browser` with
  `keepStateOnIndexedDB` and a `{prefix}`-shaped location, all of which is retired (ADR-0037);
  today's counterpart is `bootstrapFromSnapshot` with `SnapshotLocation` as `string | {url, head}`.
  Read this for the SHAPE of a deployment, never for a signature.
- **Nothing about a STREAM seed in production**, because there was never one. Every stream-seeding
  decision remains reasoned from measurement and design rather than from operational experience.
- **Nothing about whether the query-parameter override is wise.** It is recorded because it exists
  and because it constrains what a library may assume, not as an endorsement.
