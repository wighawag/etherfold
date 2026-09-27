---
title: '`publish --seed` also writes the stream seed, keyed by stream'
slug: publish-writes-the-stream-seed-when-asked
spec: a-build-publishes-what-a-browser-app-starts-from
blockedBy: [publish-writes-a-state-snapshot-a-browser-app-starts-from]
covers: [3, 11]
---

## What to build

With `--seed`, `publish` also writes a stream seed of the stream the canonical generation folds (ADR-0095): the raw stream the database stores (`_emissions`), cut at the SAME block as the state snapshot, in core's existing seed envelope (`StreamSeed`, ADR-0063 to ADR-0066), gzipped, under a content-hash name. The publication index (`publication.json`) gains an entry keyed by STREAM DIGEST, replacing only its own stream's entry. It prints the content hash a release would pin (ADR-0065), as the existing seed script does.

Without `--seed`, nothing about the stream is written: the seed is opt-in because under a never-delete layout an hourly job would otherwise store a full copy of a long stream every run.

> RE-SCOPED (maintainer, 2026-09-27, answering this task's needs-attention questions). The first attempt found two gaps; both are decided and are part of this task:
>
> 1. **The database records its stream's full source identity.** `StreamSeed.context.source` needs the per-event source hash entries (`sourceHashesOf(source)`, including `streamHash`), and the database stored only the 32-bit wire context, so no seed built from it could pass a tab's digest check. Persist the source hash entries at fold time (in the generation registry row, or beside the stored stream's coverage, whichever the schema makes natural; record the choice in `## Decisions`), and build the seed's source identity from them. `publish` stays node-free: no `--node-url`, no `--deployments`. There are no users yet, so no migration is owed for databases written before the change: a database without the recorded identity is refused for `--seed` by name (the state snapshot is unaffected). Assert that the digest the seed carries equals the canonical generation's stream digest.
> 2. **The seed is the COMPACTED stream.** Everything in it is at or below the cut, so final: drop every matched apply/retract pair (ADR-0006's pair-compaction) so the seed carries exactly the final chain. It installs under the core coherence rule unchanged (no height with two block hashes), and two producers of the same chain publish the same bytes and the same content hash, which a pin (ADR-0065) relies on. Do NOT loosen core's coherence check. Test a stored stream that saw a reorg below the cut.
>
> The first attempt's work is kept on the branch (the observation `a-stored-stream-seed-with-a-reorg-is-refused-as-incoherent`), and a near-complete draft of the rest (server producer, `--seed` flag, stream-keyed index entry, printed pin, tests for chunked reads, pair dropping and index merging) may still be at `/tmp/etherfold-publish-seed/wip.patch` outside the repo; reuse it if present. ADR-0095 carries the decision in its section "The stream seed is opt-in, at both ends".

## Acceptance criteria

- [ ] With `--seed`, the published seed installs through the browser's existing seed install and passes its coherence checks (digest, coverage), covering exactly up to the cut.
- [ ] A tab that installs the seed and the snapshot, then re-folds the seed with the same processor, reaches the snapshot's state.
- [ ] Without `--seed`, no seed body is written and the index has no seed entry for this stream, while another stream's existing entry is kept.
- [ ] The printed hash is the one `pinnedStreamSeedContentHash` / the install's pin check accepts.
- [ ] The database records the source hash entries at fold time, and the seed's digest equals the canonical generation's stream digest; a database without them is refused for `--seed` by name, and `publish` takes no node or deployments.
- [ ] A stored stream with a reorg below the cut publishes a seed without the matched apply/retract pair, which installs and passes the unchanged coherence check.
- [ ] Tests cover the new behaviour, mirroring the existing seed suites.

## Blocked by

- `publish-writes-a-state-snapshot-a-browser-app-starts-from`

## Prompt

> Goal: the seed half of `publish` (ADR-0095). The seed format, strip (`storedStreamOf`), digest and content hash are `@etherfold/core`'s; the reference producer is the script in `@etherfold/conformance-workload-stratagems`, which reads a captured fixture where this reads the stored stream. The stored stream is read back through the server package's replay source over the same database.
>
> FIRST, check this task against current reality: it is a launch snapshot written on 2026-09-26. Read ADR-0095 and the spec `a-build-publishes-what-a-browser-app-starts-from`, and check the tasks it is blocked by landed as it assumes. If a dependency landed differently or an ADR superseded an assumption, do not build on the stale premise: route to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Add a changeset for every published package you change (0.x: patch or minor). Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified `*.bundle.js` files.

## Decisions

- **The full source identity is stored in the existing coverage record (`_stream_coverage.source`), not the generation registry row.** The column was already typed `SourceHashEntry[]` and documented as "the fetch-filter half of the identity these logs were fetched under". A seed belongs to a stream, is keyed by stream digest, and the coverage record is stored per stream. So no schema change was needed, and only the value written differs. Alternative considered: a new column on the generation registry row (ADR-0092). I rejected it because it files a stream fact under a generation, and several generations fold one stream. What this touches: the only other reader of `coverage.source` is the server's stored-stream view (`streamReader.ts`), whose context feeds the stream half of `sourceInvalidationOf`. That check now does its per-event comparison instead of the legacy whole-source one. That is at least as accurate, and every suite passes. No ADR needed: ADR-0095 already records the decision.
- **A database without the recorded identity is detected by coverage entries that have no `streamHash`.** That is exactly the wire-context shape older databases stored, and it is refused as a new reason, `no-stream-identity`. A digest that doesn't match the generation's stream is refused under the same reason. Alternative: reuse `no-stored-stream`. I didn't, because the stream is present, so that name would mislead. What this touches: the `PublicationRefusalReason` union in `@etherfold/server`.
- **Compaction matches pairs by `(blockHash, logIndex)`.** A retraction with no earlier application is kept, so a damaged stream is refused by the install rather than silently repaired. Rows the fold rewound and re-applied on the same hash lose their first copy, so the output doesn't depend on one producer's reorg history.
- **Carried over from the prior draft and kept:**
  - Body name `seed-<hex>.json.gz`.
  - Index map `seeds` keyed by stream digest.
  - Replay read budget option `seedReadBudget`, default 10,000.
  - The seed's `producer.at` is the chain time of the cut block, so republishing the same cut gives the same bytes.
  - `chainHeadAtCapture` is the folded tip, which is `finality` above the cut.
