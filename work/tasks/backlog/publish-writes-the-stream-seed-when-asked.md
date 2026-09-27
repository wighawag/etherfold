---
title: '`publish --seed` also writes the stream seed, keyed by stream'
slug: publish-writes-the-stream-seed-when-asked
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy: [publish-writes-a-state-snapshot-a-browser-app-starts-from]
covers: [3, 11]
needsAnswers: true
---

## What to build

With `--seed`, `publish` also writes a stream seed of the stream the canonical generation folds (ADR-0095): the raw stream the database stores (`_emissions`), cut at the SAME block as the state snapshot, in core's existing seed envelope (`StreamSeed`, ADR-0063 to ADR-0066), gzipped, under a content-hash name. The publication index (`publication.json`) gains an entry keyed by STREAM DIGEST, replacing only its own stream's entry. It prints the content hash a release would pin (ADR-0065), as the existing seed script does.

Without `--seed`, nothing about the stream is written: the seed is opt-in because under a never-delete layout an hourly job would otherwise store a full copy of a long stream every run.

## Acceptance criteria

- [ ] With `--seed`, the published seed installs through the browser's existing seed install and passes its coherence checks (digest, coverage), covering exactly up to the cut.
- [ ] A tab that installs the seed and the snapshot, then re-folds the seed with the same processor, reaches the snapshot's state.
- [ ] Without `--seed`, no seed body is written and the index has no seed entry for this stream, while another stream's existing entry is kept.
- [ ] The printed hash is the one `pinnedStreamSeedContentHash` / the install's pin check accepts.
- [ ] Tests cover the new behaviour, mirroring the existing seed suites.

## Blocked by

- `publish-writes-a-state-snapshot-a-browser-app-starts-from`

## Prompt

> Goal: the seed half of `publish` (ADR-0095). The seed format, strip (`storedStreamOf`), digest and content hash are `@etherfold/core`'s; the reference producer is the script in `@etherfold/conformance-workload-stratagems`, which reads a captured fixture where this reads the stored stream. The stored stream is read back through the server package's replay source over the same database.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.
