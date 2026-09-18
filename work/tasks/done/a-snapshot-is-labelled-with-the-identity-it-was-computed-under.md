---
title: 'A snapshot is labelled with the IDENTITY it was computed under, so the candidate rule keeps working'
slug: a-snapshot-is-labelled-with-the-identity-it-was-computed-under
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: []
covers: [9]
---

## What to build

A small change that a large promise rests on.

A published snapshot carries a `processor` label, and the client-side rule is that a snapshot from another processor version IS NOT A CANDIDATE at all. That rule is what stops a client bootstrapping state computed by different logic, and it is unchanged. What changes is the VALUE in that field: it is now the identity ADR-0086 derives rather than a declared version hash.

This matters more than its size suggests, because it is the thing that makes a browser app's upgrade path work under hash identity. An app's processor changes only when a new build is deployed, and that deploy already has to publish a matching snapshot; if the label were still computed the old way, every client would correctly refuse a snapshot that was actually for its own processor.

## Acceptance criteria

- [ ] A snapshot's `processor` label is the identity ADR-0086 derives, computed by the producer from the same artifact the deployment runs.
- [ ] The candidate rule is UNCHANGED in meaning: a snapshot whose label differs from the client's generation is still not a candidate, and is still refused rather than translated.
- [ ] A snapshot produced for a given bundle IS a candidate for a client running that bundle, asserted end to end rather than by comparing two strings.
- [ ] The snapshot FORMAT number is considered deliberately: say whether this is a format change or a value change, and why.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- None. It can start immediately.

> **RE-ORDERED 2026-09-18, out from behind `the-declared-version-and-the-drift-report-are-deleted`.** The stated reason for that edge was that "the value this writes does not exist in its final form until the declared version is gone". Checked against the code rather than assumed: `createSnapshot` does not COMPUTE the label, it is HANDED one by its caller (`packages/processor-entities/src/snapshot.ts`), and the four migrate batches already moved what a deployment hands it to the identity its ARRIVAL derived. So a producer running a bundle already labels with the hash today, and one still on the declared path already labels with what it actually ran under -- which is the correct value in both cases, because the label's whole job is to say which fold computed the rows. The edge was a purity argument rather than a mechanism one, and it was part of a cycle that deadlocked the family (`work/notes/observations/the-adr-0086-contract-task-is-in-a-cycle-with-the-three-leaves-behind-it.md`). Nothing about this task's subject changes: what is left to do here is to ASSERT the round trip end to end and to settle the FORMAT number deliberately, which is what its criteria already say.

## Prompt

The goal is that a browser app seeded from a published snapshot goes on working when identity becomes a hash.

Read **ADR-0086**, then **ADR-0028** and the bootstrap path for what a snapshot carries and how a candidate is chosen, and `CONTEXT.md`'s `bootstrap` and `seeding` entries, which state the candidate rule and why a snapshot-seeded generation is a LEAF that cannot serve a later processor-only change. That leaf property is exactly why the label must be right: such a client has no stream to re-fold and cannot recover from a mislabelled snapshot by re-indexing.

The decision most likely to be got wrong is treating this as a rename. The field keeps its name and its meaning; only the value's derivation moves. If you find yourself changing the candidate PREDICATE, stop -- the predicate is correct and is not this task's to touch.

The second: the FORMAT number. A consumer reading a snapshot cannot tell a declared-version label from a hash label by looking, and this repo's habit is to REFUSE a document it cannot read rather than half-parse it. Decide explicitly whether the envelope number moves, and say why in your report; note that nothing is published (`CONTEXT.md`), so the honest answer may be that it does not need to.

The seam to test at is the producer and the bootstrap path together: produce a snapshot for a known bundle, then bootstrap a client running that same bundle and assert it installs, plus the negative case.

Done means: a snapshot says which processor computed it in the new vocabulary, and the rule that protects a client is exactly as strict as it was.

## Decisions

**The snapshot FORMAT number does NOT move: this is a VALUE change, not a FORMAT change.** `ENTITY_SNAPSHOT_FORMAT` stays at `1`. The envelope's shape is identical, `processor` is the same field in the same place meaning the same thing, and it is opaque on both sides (compared for equality, never parsed, which is the invariant ADR-0086 rests on), so a label derived the old way is not half-understood by a new reader. The alternative considered was bumping it, on this repo's habit of refusing a document it cannot read rather than half-parsing it (ADR-0040). Rejected because that habit protects against a shape a reader would misread, and here the mismatch is already answered precisely: `processor-mismatch` (not a candidate) or `SnapshotProcessorMismatchError` at install. A bump would convert that precise refusal into `unreadable-format`, which tells a user their app or the publisher is out of date when the truth is that the snapshot is for another processor: strictly less information, on the one path where a client has no stream to re-fold. And nothing is published (`CONTEXT.md`), so there is no document on either side of the distinction. What it touches: `SnapshotFormatError` / `isReadableHead` / the `unreadable-format` outcome keep their current meaning, and `a-generation-can-be-seeded-from-a-published-artifact`'s sibling `STREAM_SEED_FORMAT` is unaffected. Recorded beside the constant with the condition that WOULD justify a bump (a field appearing, disappearing or changing meaning). Not an ADR: it is cheaply reversible (no published documents exist) and the trade-off is local to one constant.

**No producer-side derivation helper was added, and `createSnapshot` still takes the label from its caller.** The criterion "computed by the producer from the same artifact the deployment runs" is satisfied by taking the label from the fold that wrote the rows (its registered `processor`), which is what the test does and what the field's docstring now instructs. The alternative was a helper in `@etherfold/processor-entities` that hashes bytes for a publisher. Rejected on two counts: it would be a second spelling of `processorArtifactIdentity`, and it would put a node-only hash into the package a browser bundles, while publishing snapshots is deliberately out of scope (ADR-0028; `work/notes/ideas/publishing-snapshots-of-versioned-state.md`). What it touches: whoever builds the publishing spec inherits the docstring's instruction rather than an API to call.
