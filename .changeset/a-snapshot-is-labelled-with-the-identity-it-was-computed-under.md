---
'@etherfold/processor-entities': patch
'@etherfold/state-store': patch
'etherfold': patch
---

**A published snapshot's `processor` label is the identity its producer's ARRIVAL derived, and the candidate rule that protects a client is exactly as strict as it was** (ADR-0086).

The rule is unchanged and deliberately so: a snapshot whose label differs from the identity the client was handed IS NOT A CANDIDATE at all (`processor-mismatch`), and one installed anyway is REFUSED rather than translated (`SnapshotProcessorMismatchError`). What moved is only where the VALUE comes from. A deployment running a self-contained bundle is named by the SHA-256 of those octets, so that is what it writes into the snapshots it publishes, and a client running the same bundle derives the same name from the same bytes without being told it.

That matters most for the client least able to notice it is wrong. A snapshot-seeded generation is a LEAF: it has no stream to re-fold and no history below its own block, and on a public node the historical `eth_getLogs` a backfill would need is frequently refused outright. Such a client cannot recover from a mislabelled snapshot by re-indexing, so a browser app's upgrade path rests on the label being right: a new build already obliges its publisher to ship a matching snapshot, and under hash identity that snapshot is one the new build recognises.

**The snapshot FORMAT number does NOT move, and the reasoning is recorded beside the constant.** This is a VALUE change, not a FORMAT change. `processor` is the same field in the same place meaning the same thing, opaque on both sides (compared for equality, never parsed), so a label derived the old way is not half-understood by a new reader. It is simply another fold, which the candidate rule already answers precisely. Bumping `ENTITY_SNAPSHOT_FORMAT` would convert that precise refusal into `unreadable-format`, telling a user their app is out of date when the truth is that the snapshot is for another processor, and nothing is published, so there is no such document on either side of the distinction.

Code changes are documentation and coverage:

- `createSnapshot`'s `processor` field now says WHERE a producer gets the value: from the fold that wrote the rows (the identity its generation is registered under), never derived a second way beside it;
- `ENTITY_SNAPSHOT_FORMAT` carries the format-number decision above;
- `etherfold` gains the end-to-end case the round trip was missing (`test/aSnapshotIsLabelledWithItsBundleIdentity.test.ts`): a deployment folds blocks through a REAL committed bundle and publishes what it computed, a client that loaded the same bytes through the artifact loader installs it and resumes at the snapshot's block, and a client running the edited bundle beside it (one handler line different, nothing declared different) gets `processor-mismatch` and an untouched store. Neither side is handed the other's value, so it asserts that two derivations agree rather than that two constants are spelled the same.
