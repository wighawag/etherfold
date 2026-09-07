---
status: superseded in part by ADR-0067
---

> **ADR-0067 withdraws the RESUMABILITY conclusion below.** A partial install really is a contiguous
> prefix with an honest cursor, but nothing can tell one from a stream the client indexed ITSELF: in
> the target deployment the publisher and the client are the same build, so the stored `context` is
> identical and `fetchFrom` does not expose the cursor's `startBlock`. So an install now refuses any
> subtree it did not find EMPTY, and it takes the resolved stream config as an argument rather than
> relying on whatever was last set on the keeper. Everything else here stands.

# A published stream seed arrives through its OWN loader, and installs through the KEEPER SEAM

Seeding a generation from a published captured stream is decided in three parts, and only the third one was in real doubt:

1. **The loader is its own**, in `@etherfold/core`, borrowing the state-snapshot path's VOCABULARY (a list of locations, an optional `head`, failover across mirrors, refusals returned as data) while keeping its own PREDICATES, because a stream's selection question is not a snapshot's.
2. **It lives in `@etherfold/core`**, beside `stream/fixture.ts`, because everything the install is written against already lives there and `fetch` is global in every runtime this project targets.
3. **Installing writes through the PUBLIC keeper seam and nothing else**: a run of ordinary `saveNewEvents` calls on the very `ExistingStream` the generation will be handed. There is no new keeper operation, no substrate access and no second copy of the segmentation rules.

Demonstrated end to end before being written down: `docs/spikes/pin-the-seam-a-published-stream-arrives-through/` installs the committed 31,332-log stratagems capture into the real `keepStreamOnIndexedDB` keeper and folds every event of it with `eth_chainId` as the only call a node ever sees.

This ADR is `accepted, not yet implemented` on purpose. It is the output of an EXPLORATION spec (`a-generation-can-be-seeded-from-a-published-artifact`), whose done is confidence plus a build plan; the capability itself is the follow-on build spec, and nothing here ships in the same change that records it.

## What the code actually offers, since two earlier descriptions of it are stale

Written against the tree as it stands, because the spec this comes from is a launch snapshot and two of its premises had moved. `keepStateOnIndexedDB(name, remote)`, which that spec proposed extending to streams, is DELETED (ADR-0037); the live precedent for fetching a published artifact is `bootstrapFromSnapshot` in `@etherfold/processor-entities`. And `replayStream` no longer returns an `ExistingStream`: it returns a read-only `StreamFixtureReader` that is deliberately NOT the keeper seam (ADR-0059), while the keeper seam takes only the raw stored event (ADR-0060). A fixture therefore cannot be handed to an indexer as its `keepStream`, which is precisely why seeding has to WRITE.

## Why the install is the seam, and not a new operation

The question that looked hardest was what installing consists of, and the answer is that the seam already takes exactly what a seed has to deliver. `createSegmentedStream` owns every rule an installer would otherwise restate: which ordinal a segment takes, allocated from the cursor INSIDE the commit; what the cursor record holds; that the stream's `startBlock` is the first save's `lastFromBlock`, written once; and which batches are refused because they would leave a hole. An installer that reached past the seam to the substrate would be a second implementation of all of it, in a package that does not own the substrate.

So the install is a loop, and its whole content is block arithmetic. Three rules, each forced by something the keeper or the load path already does:

- **The first batch's `lastFromBlock` is the CAPTURE's `fromBlock`, never its first event's block.** That value becomes the stream's `startBlock`, and `fetchFrom` clears the entire subtree when `startBlock > fromBlock`. A contract's `startBlock` is routinely below the first log it emitted, so a seed that claimed its first event's block would be deleted on first load by the very client it was published for.
- **Each later batch continues the previous one exactly**, `lastFromBlock = previous lastToBlock + 1`. Above that the keeper REFUSES the batch (a hole no later check could see, since segments are keyed by save rather than by block). Below it is an overlap, which the keeper accepts as an ordinary tip re-scan and which for an install would silently duplicate events: the engine's own writer de-duplicates with `streamRemainderOf`, and an installer has no such thing.
- **The last batch's `lastToBlock` is the capture's own `lastToBlock`, above its last event-bearing block.** This is the client-side counterpart of the stored stream's coverage claim (ADR-0055): the rows cannot say how far a stream REACHES, because a quiet range moves the cursor without adding one. Cut it short and the client re-scans every quiet block at the end of the capture, which on a public node is exactly the fetch it cannot make.

Batches are cut on BLOCK boundaries. Nothing in the keeper requires it, since a read concatenates segments and filters by block, but a segment holding half a block is a segment whose cursor cannot honestly say which blocks it covers.

**What is written beside the segments is the cursor record, and it comes for free.** That was the half most at risk of being left vague, and going through the seam is what settles it: `saveNewEvents` writes the segment and the cursor in one commit, so a seed cannot land as segments with no cursor, which is the shape that would make a client re-scan from the start block.

**The events are stripped of their decoded half on the way in**, because that is what the seam takes (ADR-0060). **The `context` written is the SEED's own, verbatim.** Writing the client's own hashes instead would make the load path's `streamMatches` check compare the client against itself, discarding a structural defence for nothing.

**The address is DERIVED, never supplied.** A keeper resolves the subtree itself from the `source` it is handed on every call plus the stream config it was given, so a seed physically cannot be installed under a digest that is not the one the client will read. What an installer must do is set that config first (`setStreamConfig` with the RESOLVED config, exactly as `IndexerGeneration.reinit` does), or it writes a perfectly valid stream to a subtree nobody reads.

### A partial install is a contiguous prefix, not damage (but it is NOT resumed: see ADR-0067)

Installing as N saves rather than one bulk write means an interrupted install leaves a shorter stream whose cursor describes it honestly, rather than a torn record. That much stands, and it is why an interrupted install is safe to CLEAR.

What this ADR originally concluded from it -- that a later install resumes by continuing from `lastToBlock + 1` -- is WITHDRAWN by ADR-0067: resuming requires telling a partial install of this seed from a locally-indexed stream, and in the deployment this feature exists for those two are indistinguishable, so the resume would duplicate events or leave a hole, silently.

## Considered options

**Ride the snapshot mechanism outright.** Rejected as not available rather than as unattractive. `bootstrapFromSnapshot` is declared over `SnapshotAwareStateStore` and `StateSnapshot`, and it lives in `@etherfold/processor-entities` because it reads `lastToBlock` out of a stored ENTITY cursor whose codec lives there. A stream has no processor, no rows and no entity cursor, so riding it would mean a fake envelope and an inverted dependency.

**Mirror the snapshot loader's shape exactly.** Rejected in its strict form, and this is where the two artifacts genuinely differ. A snapshot has ONE bound, and further along is strictly better. A stream has TWO, and the lower one is not a preference but a precondition: a seed that does not reach back to the block the client asks from is not worse, it is refused and deleted. Selection therefore filters on reach-back BEFORE ranking by reach. For the same reason the snapshot's "prefer local when local is ahead" becomes something stricter here, "install only into an EMPTY subtree": an installer cannot top up a partial local stream without either duplicating events or leaving a hole, and neither is worth a mechanism. What IS carried over unchanged is the failure philosophy, because it was right the first time: an unreachable mirror is logged and skipped rather than thrown, and "nothing usable was found" is DATA a host can act on rather than an exception.

**A bulk `installSeed` port operation**, writing every segment and the cursor in one transaction. It buys atomicity and it costs a new operation on a seam third parties implement, a second copy of the hole check and the ordinal rule, and the resumability described above. Rejected for now, and explicitly left open to the measuring task: if N transactions prove too slow in a real browser, this is the thing to reopen, and only the install's internals move.

**Put the loader in `@etherfold/browser`.** Rejected because nothing about it is browser-specific. The spike used the browser package only for the caller's own keeper, which is passed in. `@etherfold/core` names no runtime and `fetch` is a global in all of them, which is the same argument the snapshot module already makes for itself.

## Consequences

- **A seed MUST carry the raw log.** `reparse` refuses an event with no `topics` or `data` and the load path answers by CLEARING the subtree (ADR-0034), so a capture that omitted them as the encoded form of its decoded `args` is a valid REPLAY input and is not a seed at all. The spike keeps this as a negative control. The committed stratagems capture was exactly this case until 2026-09-06 and was re-captured with `--full` to fix it, which took it from 22.15 MB raw and 0.65 MB gzipped to 33.79 MB and 1.05 MB. Those are the honest numbers for an artifact that can actually be installed, and they are about 1.5x the ones the source spec quotes.
- **The strip has to be EXPORTED from `@etherfold/core` before this can be built.** `storedEventOf` and `storedStreamOf` are `internal/`, so the spike had to copy the three-key destructure, which is the duplication ADR-0060 exists to prevent. Exporting them is a build item, not a design question.
- **This is for KEEPER-BACKED clients, and the server is out of scope rather than assumed in.** `@etherfold/server` has no `ExistingStream` writer over `_emissions`: that table is written by an `EmissionAppender` from inside `receive`, and `storedEmissionStream` is read-only. Seeding it is a different write path and is nobody's decision yet.
- **A seed only saves the range it covers, so a publishable one is captured near the TIP.** The committed fixture is pinned at `toBlock` 23,400,000 for reproducibility while Base is past 51,000,000, so a client seeded from it resumes at 23,399,988 and still has 27 million blocks to fetch. That is correct behaviour and it is also the reason the fixture is a spike artifact rather than a shippable seed.
- **`STREAM_FIXTURE_FORMAT` is untouched.** Nothing here changes a byte of the fixture format; the seed shape a publisher emits is the next task's subject.

## What later tasks may still move

Named here so the ADR is not read as settling more than it did. The BATCH SIZE and whether the artifact arrives as one document or as chunks belong to `measure-what-a-published-stream-costs-to-install-and-pick-its-shape`, which may also reopen the one-transaction question above. Whether a seed whose `context` is not identical to the client's is ever adoptable belongs to `decide-what-a-mismatched-seed-digest-does`: the address is derived from the CLIENT's source and config while the stored context is the SEED's, so a superset seed is expressible here and is deliberately not decided. What is checked before the first byte is written belongs to `decide-who-verifies-a-stream-seed-and-against-what`; this ADR checks nothing.
