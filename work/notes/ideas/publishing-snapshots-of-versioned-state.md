---
title: Publishing snapshots of versioned state as a first-class artifact
slug: publishing-snapshots-of-versioned-state
---

`bootstrap-an-entity-store-from-a-snapshot` deliberately covers only the CONSUMING half: a store can be loaded from a snapshot that exists, honestly, with a retention floor it did not invent. It writes whatever minimal producer its tests need and says so.

The other half is a real design and is worth a spec rather than a task, because the questions are about a published artifact's contract rather than about a function:

- **Who produces one, and when.** A CLI command, a server endpoint, a scheduled job. The free-form path effectively snapshots on every save because its state IS the file; a versioned store has no such moment, so producing a snapshot is a deliberate act with a cost.
- **Format and versioning.** The CLI already has an envelope (`{format, processor, savedAt, lastSync, state, history}`). A versioned-store snapshot is a different shape, and whether it extends that envelope or gets its own is a compatibility decision, not a taste one.
- **What it contains**, which the consuming task decides once for its own purposes but which becomes a published contract here: current rows only, or rows plus a retained window of versions. That choice is what a consumer's capability report inherits, so it is part of the artifact's meaning.
- **Mirror layout and discovery.** The browser keeper already accepts an array of locations and picks the most advanced; publishing has to produce something that shape can consume, and say what a mirror set is allowed to disagree about.
- **Retention of snapshots themselves.** `work/tasks/cancelled/snapshot-prune-script.md` exists for the CLI's files and carries `needsAnswers: true` on a destructive-deletion policy. The same question arrives with more force for published snapshots, where deleting one may strand a client that was about to fetch it.
- **Trust.** A published snapshot is state a client accepts without recomputing. The processor version hash catches "computed by different code", and nothing catches "computed by a liar". Whether that matters depends on who is allowed to publish, which is a deployment question this repository has not had to answer before.

The trigger to write the spec: the first deployment that wants clients to bootstrap from state IT publishes, rather than from a file a developer copied by hand.
