---
title: 'A tab starts from a publication index'
slug: a-tab-starts-from-a-publication-index
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy:
  - a-state-snapshot-round-trips-from-a-build-database
  - publish-writes-a-state-snapshot-a-browser-app-starts-from
  - publish-writes-the-stream-seed-when-asked
  - a-tab-runs-a-published-processor-bundle
covers: [2, 3, 7]
---

## What to build

One browser option points a tab at a published PUBLICATION INDEX (`publication.json`, ADR-0095), as a LIST of locations it fails over between, as the snapshot bootstrap fails over between mirrors today. The tab reads the index and picks the STATE SNAPSHOT entry for its own GENERATION: its processor identity AND its stream digest, which is its source and stream config. It starts from it through the existing bootstrap (the snapshot-only mode). It installs the STREAM SEED entry for its own stream ONLY when the app asks for the seed; by default it downloads the snapshot alone, so an app with a small state over a long history pays only for the state.

Keyed by generation because a tab keeps an installed snapshot only when the cursor's source and stream-config hashes match its own (`IndexerGeneration.load` otherwise discards it and indexes from the start block). So an index with an entry for this PROCESSOR but another stream is reported by name (the publisher's contracts or finality differ from the app's) and nothing is installed; it is never installed and then discarded.

An old build (an older processor identity) finds its own, older entry and starts from it, then indexes forward. No entry for this generation, and an unreachable index, are reported as outcomes on the existing status surface and the tab indexes from the chain as it does today with no snapshot.

## Acceptance criteria

- [ ] A tab whose generation has an entry starts from that snapshot and indexes forward from its block, and the state is KEPT across the first load (not discarded as a changed processor).
- [ ] A tab with an OLDER processor, whose entry is older, starts from its own entry, never from the newer processor's.
- [ ] An entry for the same processor over ANOTHER stream (a different source or finality) is refused by name, and nothing is downloaded beyond the index.
- [ ] By default no seed is fetched even when the index lists one (asserted on the requests made); with the seed asked for, it is installed.
- [ ] No entry for this generation, and an unreachable index (all locations), are reported and fall back to indexing from the chain; a second location is used when the first is unreachable.
- [ ] Tests cover the new behaviour, mirroring `snapshotOnlyMode.test.ts` and the seed status suites.

## Blocked by

- `a-state-snapshot-round-trips-from-a-build-database`
- `publish-writes-a-state-snapshot-a-browser-app-starts-from`
- `publish-writes-the-stream-seed-when-asked`
- `a-tab-runs-a-published-processor-bundle` (both edit the browser's generation options and hosts)

## Prompt

> Goal: the browser side of the publication index (ADR-0095). It composes the existing snapshot bootstrap and seed install; it does not replace them. The index's shape is whatever `publish-writes-a-state-snapshot-a-browser-app-starts-from` and `publish-writes-the-stream-seed-when-asked` wrote: read their tests.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **The chosen snapshot reaches the app as a fourth `createState` argument; the browser doesn't install it itself.** The install has to happen on the store before it is claimed, and the claimed store comes out of the app's own `createState`. `@etherfold/browser` also deliberately doesn't depend on the package that holds the cursor code. So the hook picks the entry and hands over exactly the two arguments `openAndBootstrap` takes, and "the existing bootstrap" really is the existing one. Alternatives: the browser doing the bootstrap (needs a new dependency and a different factory contract), or separate snapshot and seed options that each read the index. Touches: the `createState` signature, which the worker hosts share (they pass `undefined`).
- **The index document moved to `@etherfold/core`, and the server re-exports it.** Both the producer and the tab depend on core; the browser can't depend on the server. Alternative: restate the shape in the browser, which would give two definitions of one contract. Touches: the server's `publication.ts` (types and constants re-exported; `parsePublicationIndex` now uses `isPublicationIndex`).
- **The first index read wins, and failover only happens on transport or format failures.** A mirror that answers but has no entry gives `no-entry`; the tab doesn't move on to the next location. This keeps "nothing beyond the index" cheap and failover as the task describes it. Alternative: read every location looking for an entry.
- **Only the generation built at `init` gets a snapshot.** Generations added later (reconfigure, HMR) get no fourth argument, and `syncing.publication` describes that boot generation. It is cleared on `dispose`, like `streamSeed`.
- **New refusal `no-processor-identity` for a module arrival.** A module's identity is only known after its processor is built, which is after `createState`. So it is refused by name rather than matched on the stream alone. A bundle arrival, or an explicit `processorIdentity`, works.
- **New error:** asking for `publication.seed` alongside the `seed` option throws at `init` ("a boot installs ONE stream seed"). It's a wiring mistake, handled the same way as a seed without a `keepStream`.
- **A seed asked for but not listed goes to the install with no locations.** The install then reports its own `no-locations` refusal on `streamSeed`, so no made-up outcome is added.
- **The index's `contentHash` is not passed as the seed pin.** ADR-0066 says a pin read from the same place as the artifact proves nothing. The app can still pass `expectedContentHash` from its build.
- **The snapshot body is offered only at the index location that named it**, not mirrored across the other index locations. That avoids the head read `bootstrapFromSnapshot` makes at every location.
- **The index is fetched on every boot, reloads included.** The hook can't see the local cursor before `createState`; `openAndBootstrap` still downloads nothing when the local store is already ahead.
- **Worker hosts don't get the option.** The existing `seed` option is main-thread only as well; adding it to `HostedIndexerSpec` is additive later.
