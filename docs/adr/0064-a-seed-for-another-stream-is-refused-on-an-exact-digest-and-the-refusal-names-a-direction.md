---
status: accepted, not yet implemented
---

# A seed for another stream is REFUSED on an exact digest, and the refusal names a DIRECTION

A published stream seed is admitted only when the stream digest the client computes for ITSELF equals the digest of the stream the publisher captured. Anything else is refused, before a single event is written, and the refusal is returned as DATA carrying which WAY the two disagree so an application can say something true to a user.

Three parts, and the middle one is the decision:

1. **The artifact carries its RESOLVED stream config**, so the client can compute the publisher's 128-bit digest rather than trust a claim or settle for a weaker comparison. It may also carry the digest itself, as a label the client VERIFIES.
2. **Admission is exact digest equality.** A publisher whose filter is a strict SUPERSET of the client's is refused, even though the invalidation model calls such a stream reusable, and the reason is what installing would do with the extra events.
3. **Refusal is data, with a direction**, following ADR-0040's refused-not-installed stance and `bootstrapFromSnapshot`'s `NotBootstrappedReason` shape.

Sits on ADR-0063, which pinned that a seed arrives through its own loader and installs by writing through the keeper seam at an address DERIVED from the client's own source. That derivation is why this decision is about whether to install at all: a seed physically cannot land under a digest the client will not read, so the failure this prevents is not a mis-addressed write but a wrongly-ADMITTED one.

## Why the artifact must carry its resolved config

A `StreamFixture` carries `source` and a `lastSync.context` holding source-hash entries plus a config HASH. `streamDigestOf` needs the resolved config OBJECT, so a client cannot recompute the publisher's digest from the artifact as it stands.

The tempting alternative is to compare what IS there: set-equality of the `streamHash` values plus equality of `context.config`. It needs no format change and it is nearly right, and it is rejected on the strength of the comparison rather than its shape. `context.config` is a `simple_hash`, 32 bits, and `streamDigestOf` deliberately hashes the config's canonical BYTES instead, for a reason its own docstring states: "that digest is 32 bits, and here a collision is not a missed invalidation but two configs sharing one stream". Admitting a downloaded artifact on a 32-bit comparison reintroduces exactly the weakness the digest was widened to 128 bits to avoid, at the one boundary where the input is not ours.

So the seed carries the resolved config, the client computes the digest, and the check is exactly as strong as the addressing it protects. Carrying the digest as well is worth it for a different reason: a manifest can be fetched and rejected before the body is downloaded, and a label the client recomputes costs nothing to distrust.

## Why a publisher SUPERSET is refused, which is the surprising half

The invalidation model already tolerates it. `verdictOn` runs with `removalInvalidates: false` for the stream half, so entries the seed has and the client does not are IGNORED and the stream reads valid. Its comment says why: "it means the filter only ever asked for MORE than it now needs, so the stream is a superset and stands." Combined with ADR-0063, a superset seed would install and fold today with no new machinery. A reader who finds this ADR refusing it is right to ask why.

The answer is that the stream verdict's tolerance is about a LOCAL cache the client already owns, where the extra events were fetched under the client's own earlier filter and are already on its disk. A downloaded artifact's extra events are not that. They are new, they arrive from somebody else, and installing them means:

- they are stored permanently, under the CLIENT's stream digest;
- they are re-folded by **every later generation** on that stream, which is precisely what ADR-0055 and ADR-0056 make cheap and routine;
- and they are DELIVERED to the fold. `runBlockHandlers` (`@etherfold/processor-entities`, `apply.ts`) skips an event carrying a `decodeError` **unless the processor implements `handleUnparsedEvent`**, in which case every foreign event is handed to it.

That last one is decisive. `handleUnparsedEvent` is a legitimate hook, and a processor that implements it would begin receiving thousands of events it never asked for, determined by nothing but which mirror the client happened to install a seed from. That is the hazard this whole family exists to prevent -- one generation adopting another's stream under a filter that does not match it -- arriving through a side door rather than through the keyspace.

## What is deliberately OVER-refused, and why that is accepted

Exact equality refuses one case that is provably safe, and it is recorded here so nobody has to rediscover it.

An event whose declared block RANGE begins above the seed's coverage (`abi-versions-are-block-ranged`) produces a source-hash entry the seed lacks, so the digests differ, while `verdictOn` reads the stream as valid because that entry "could not have contributed" below the coverage. Such a seed carries no foreign events and lacks nothing the client needs below where it reaches. It is safe, and it is refused.

Accepted because it is narrow and cheap to work around: it requires block-ranged ABI versions, and an application in that position is shipping a new client build anyway, so it can publish a seed that matches. Admitting it later is a strict RELAXATION that needs no change to the artifact, since the check is already computed from fields the seed carries.

Note what is NOT in this category, because it looks like it should be and is not: a client that ADDED A CONTRACT deployed above the seed's coverage. `sourceHashesOf` hashes every contract's address and `startBlock` into ONE skeleton entry at block 0, so any change to the contract set invalidates from block 0 under the existing verdict too ("a changed chain id, genesis hash, address or `startBlock` still invalidates the whole indexed history"). That case is refused by the model, not merely by this rule.

## The refusal, and the direction it names

Returned as DATA, never thrown, which is `bootstrapFromSnapshot`'s judgement and ADR-0040's settled stance: an artifact a client cannot use is refused rather than installed, and not finding a usable one is a normal condition a host acts on rather than an exception. The vocabulary parallels `NotBootstrappedReason` and adds the direction:

- **`no-locations`**, **`unreachable`** -- as the snapshot path means them.
- **`unreadable-format`** -- the fixture's `format` is not one this build reads. Note the conversion this forces: `parseStreamFixture` THROWS on an unknown format, so the loader catches and reports rather than propagating, or the refusal stance would hold for every reason except this one.
- **`chain-mismatch`** -- structurally subsumed by the digest, since `chainId` and `genesisHash` are inside the block-0 skeleton entry, and reported SEPARATELY anyway because telling a developer who pointed at the wrong chain that an "entry was added at block 0" is useless.
- **`stream-config`** -- the resolved configs differ. Invalidates from block 0 on both halves in the existing model, and is a refusal here for the same reason.
- **`seed-covers-more`** -- the digests differ and the stream verdict is VALID, so the seed is strictly wider: this client indexes LESS than the publisher does.
- **`seed-covers-less`** -- the digests differ and the verdict is INVALID with an added entry at or below the seed's coverage: the seed LACKS something this client indexes.

**The direction is data, and the INFERENCE from it belongs to the application.** A digest mismatch alone says nothing about who is behind, and even the direction is only evidence: a deliberately narrower client is indistinguishable from an out-of-date one. So the loader reports `seed-covers-more` and an app may render "a newer version of this app may be available"; the loader itself must never claim that, because it cannot know.

**This must reach the application's own surface, not only the boot path's return value.** An app that cannot say why it has no seed will show an empty screen instead of an explanation, which is the outcome this whole spec exists to avoid. Which surface (a status field, the reactive envelope proposed in `work/notes/ideas/the-reactive-update-is-an-envelope-not-a-handle.md`) is a `@etherfold/browser` decision and is named as a build-plan item rather than settled here.

## What a refusal actually costs the user

Stated plainly, because "fall back to backfilling" is not available on the node this feature exists for.

A refused stream seed does NOT stop an application. State still advances: it bootstraps from a published state SNAPSHOT (ADR-0028) and indexes forward from the tip. Nothing is fetched to fill the range below, because on a public node that fetch is exactly what does not work. What is lost is the STREAM underneath, so the generation is a LEAF: a later processor-only change cannot re-fold locally and has to wait for a republished snapshot instead of being free.

On the measured cadence of the reference deployment that is a mild loss (`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`: a state snapshot was republished a median 1.0 h apart, worst observed 50.9 h, leaving 1,802 to 91,527 blocks to backfill, all of it servable). A stream seed's value is making a processor change free BETWEEN snapshots, not making the app start.

## Considered options

- **Admit the superset and store it VERBATIM.** What the invalidation model permits. Rejected above on the fold-delivery and permanent-inheritance grounds.
- **Admit the superset but FILTER at install** to what the client's own source decodes, storing the client's own context. Coherent, and it does not lie: what is stored is still exactly what the node said, just less of it. Rejected for now rather than as wrong, and it is the sanctioned way to relax this: it costs an install-time pass over every event, it makes the load-time verdict vacuous for that stream (the stored context becomes the client's own, so the check compares the client against itself), and it needs a "would my filter have asked for this log" predicate that does not exist yet as a function.
- **Compare the seed's `context` instead of the digest** (set equality plus the 32-bit config hash). Rejected on strength, above.
- **Install a mismatched seed under the PUBLISHER's digest**, as a second stream. Rejected: it stores a history nothing will ever read, which is the silent waste this task existed to forbid, and ADR-0063's derived addressing already makes it unreachable.
- **Throw on a mismatch.** Rejected: it contradicts ADR-0040 and it destroys the direction, which is the half an application needs.

## Consequences

- **The artifact gains one required field** (the resolved stream config) and one optional label (the digest). Both fit the shape `measure-what-a-published-stream-costs-to-install-and-pick-its-shape` recommended, which deliberately left the envelope open for exactly this.
- **A seed is checked BEFORE anything is written.** ADR-0063's install is a run of `saveNewEvents` calls, so a check made afterwards would already have polluted the keyspace and would need a clear to undo. There is no half-installed state to define: the admission decision precedes the first write.
- **`decide-who-verifies-a-stream-seed-and-against-what` builds on this floor** rather than restating it: identity is settled here, and what else must be true before folding is that task's subject.
- **The digest stays what it is.** Nothing here re-opens `streamDigestOf`, its inputs or its width; this decides only who may install under one.
