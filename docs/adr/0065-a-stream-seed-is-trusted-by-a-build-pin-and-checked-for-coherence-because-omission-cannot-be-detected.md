---
status: superseded in part by ADR-0066
---

> **ADR-0066 replaces this ADR's TRUST ANCHOR and the byte domain of its content hash.** A build cannot
> pin the hash of a ROLLING artifact, which is how this is actually deployed (a fixed web build against
> an hourly snapshot), and "same origin" is unavailable when the app is served from any IPFS gateway
> while the artifact lives on a known host. Trust is now the HOST the build names; a content hash is
> optional and is for an immutable, release-tied artifact. The 2026-09-07 amendment below, which took
> the hash over the published bytes and forced the artifact to be served without `Content-Encoding:
> gzip`, is WITHDRAWN: the hash is over the decompressed octets and there is no hosting constraint.
>
> Everything else here stands: why a stream seed needs more defence than a snapshot, the checks that
> run before the first write, refusal as data, and the omission residue that makes the whole thing rest
> on trusting whoever publishes.

# A stream seed is TRUSTED by a build pin and CHECKED for coherence, because omission cannot be detected

What a client must be satisfied of before it folds a downloaded stream, decided in one sentence and then justified: **the seed's content hash must be named by something the client already trusts, and everything a client can check on its own is checked before the first write, because the one thing that matters most cannot be checked at all.**

Three layers, and the third is why the first is mandatory rather than advisory:

1. **TRUST comes from a PIN in the client build.** The build names the seed's content hash; the seed is then exactly as trustworthy as the code that fetches it.
2. **VERIFICATION is what a client can establish alone**: identity (ADR-0064), integrity against that hash, structural coherence, and that the capture was taken far enough below the chain tip. All of it before a single event is written.
3. **OMISSION IS NOT DEFENDED AGAINST.** A seed that simply leaves logs out is structurally perfect and passes every check above. That residue is why trust is a pin and not a preference.

## Why a stream seed needs more defence than a state snapshot

Not a matter of degree. A snapshot seeds a FOLD: it installs rows, reports a retention floor at its own block (ADR-0028), and its damage is bounded by the generation that adopted it. A stream seeds the STREAM, and a stored stream is re-folded by every later generation over it, including successors that downloaded nothing, which is precisely what makes a processor-only change free (ADR-0044, ADR-0055, ADR-0056). **A poisoned stream is inherited by generations that never fetched anything**, so its blast radius grows with the app's lifetime rather than shrinking.

Note where the existing snapshot path sets the bar, because this deliberately goes past it: `bootstrapFromSnapshot` verifies APPLICABILITY and not content -- a readable format, a matching processor version, and that the snapshot was not taken inside the reorg window. It never hashes the payload and never inspects the rows. That is proportionate for a leaf. It is not proportionate for something every future generation re-folds.

## The trust boundary, and the version of it that only LOOKS like one

The deployment fact the source spec starts from is real: a filter change means the user is getting a new client build anyway, so a seed can ship pinned by the same build that fetches it. That IS the trust boundary, on one condition.

**The pin must travel IN THE CODE.** Compromising a build-pinned seed then requires compromising the build pipeline, which already owns the application, so the seed adds no attack surface that was not already there.

**What only looks like a boundary is fetching the expected hash from the same place as the artifact.** A manifest served beside the seed, advertising the seed's hash, proves nothing an attacker who controls that origin cannot forge. It verifies transport integrity, which TLS already did, and nothing else. A manifest hash is therefore a LABEL for early rejection (a client can refuse a mirror before downloading the body) and never an admission credential.

Two shapes are accepted, and one is not:

- **Build-pinned hash (the rule).** Required whenever the seed and the application are not served by the same origin: a CDN, a mirror set, an IPFS gateway.
- **Same-origin, unpinned (accepted, and cheaper).** When the seed comes from the origin that served the application, it adds no attack surface, because an attacker holding that origin would change the JavaScript rather than bother with the seed. Honest, and it stops being true the moment the artifact moves.
- **A third-party seed with no pin (refused).** This is the case the pin exists for, and no amount of structural checking substitutes for it, per the omission residue below.

Publisher SIGNING is deliberately not required and not precluded. It is what would let a client trust a seed from a publisher it did not build with, and it needs key distribution this repository has none of, so the manifest keeps room for a signature and the build plan does not depend on one.

## What is checked, all of it before the first write

ADR-0063 installs by writing through the keeper seam, so a check made afterwards would already have polluted the keyspace and would need a clear to undo it. Every mandatory check therefore precedes the first `saveNewEvents`, which is also what makes "a half-verified stream" unexpressible rather than a state somebody has to define.

**Identity**, which is ADR-0064 and is the floor: a seed that is not for this stream never reaches any of the rest.

**Integrity**: the artifact's content hash equals the pinned one. On the chunked shape this is per chunk plus the manifest, so an interrupted install verifies what it installed rather than what it eventually will.

### Amendment, 2026-09-07: the hash is SHA-256 over the PUBLISHED BYTES, and the artifact is served opaque

The paragraph above said trust comes from a pinned content hash and did not say a hash OF WHAT, which the tasker's review loop refused to task around and was right to: over a gzipped artifact the byte domain is ambiguous, and the ambiguity is not pedantic. If a host serves the seed with `Content-Encoding: gzip`, `fetch` decompresses TRANSPARENTLY, so a hash taken over the compressed file cannot be recomputed from anything the client receives, and every correctly pinned install would refuse. Two producers and two clients could each be self-consistent and never agree.

So, pinned here:

- **The hash is SHA-256**, hex-encoded, lowercase, with no prefix. One algorithm, named, because a negotiated one is two implementations that must agree.
- **The domain is the PUBLISHED BYTES**: exactly the octets the publisher wrote and a client received, which for the recommended shape is the GZIPPED document. It is not the decompressed JSON text, and it is not a canonicalised re-serialisation, because a hash over anything the client has to reconstruct makes integrity depend on the reconstruction being byte-identical, which JSON does not guarantee.
- **Therefore the artifact is served as an OPAQUE FILE and never with `Content-Encoding: gzip`**, and the client decompresses it itself. This is a constraint on the PUBLISHER as much as on the code, so it belongs with the artifact's definition rather than in a host's documentation. It is also what the measurement already did: the spike's harness served the `.gz` as a plain file and decompressed in the page with `DecompressionStream`, precisely so that the bytes measured were the bytes published.

The consequence for whoever builds this: the producer PRINTS a hash a build can pin, and the value it prints must be reproducible from the published file alone. A test that recomputes the expected value with the same helper it is verifying asserts nothing; pin the literal the producer printed.

**Structural coherence**, all O(n) over the events and needing no node:

- block numbers non-decreasing, and `(blockNumber, logIndex)` strictly increasing;
- exactly ONE `blockHash` per `blockNumber`, since two would be an unreconciled reorg;
- no duplicate `(blockHash, logIndex)`;
- every event inside the coverage the artifact claims;
- retractions COHERENT (see below).

The committed capture satisfies every one of these (0 retractions, 1,042 blocks each with a single hash, 0 out-of-order pairs), which is worth stating because a check no real artifact passes is a check that will be disabled.

**Capture depth**: the coverage must end at least `finality` blocks below the chain head the producer observed. This is the stream analogue of the snapshot path's `inside-reorg-window` refusal and it is the check most easily missed, because the thing it catches leaves no trace: a capture taken close to the tip can record a branch that later lost, and it will contain NO retraction and be perfectly coherent while simply describing a chain that did not happen. It needs no node, because the provenance carries both numbers (the committed capture reaches 23,400,000 with a head of 50,968,313 at capture, so 27.5M blocks of margin).

### Retractions: COHERENCE, not absence

`captureStream` fetches canonical historical ranges, so it cannot produce a retraction, and it is tempting to refuse any `removed: true` outright. Rejected, because it would forbid a legitimate artifact this project will plausibly want: a seed derived from a SERVER's stored stream, whose `_emissions` table is append-only INCLUDING retractions (ADR-0006) and which `storedEmissionStream` already serves. Folding an apply/retract pair is correct behaviour, not damage (ADR-0042: a replay honours the verdicts the stream carries).

So the rule is two-part: a retraction must be preceded by an application of the same `(blockHash, logIndex)`, and the artifact must DECLARE what produced it. A seed that says it came from a capture and carries a retraction contradicts its own provenance and is refused on that, which is sharper than a blanket ban and leaves the stored-stream artifact buildable.

## What needs a node, and why some of it is available after all

The premise is that a public node will not serve old LOGS. It will serve old HEADERS, and that asymmetry buys two real checks exactly where the seed's whole justification says verification is impossible:

- **Chain anchoring**: `eth_getBlockByNumber` at a sampled height, comparing the seed's `blockHash` against the chain's. Cheap, and it catches a seed from another chain, another deployment, or a fabricated history wholesale.
- **Bloom consistency**: a header's `logsBloom` must contain each claimed event's address and topics. ONE-SIDED and worth being precise about: an event ABSENT from the bloom is proof of fabrication; presence proves nothing, because a bloom filter admits false positives.

**Specified here, deliberately NOT built in v1.** Sampling catches gross fabrication, which the identity check already catches most of, and it cannot catch targeted tampering, which the pin is for. Its value is concentrated in one case -- adopting a seed from a mirror without a build pin -- which the trust rule above refuses anyway. Recording the design without building it is what keeps the follow-on build spec free of a story nobody can justify yet.

## What is deliberately NOT defended, and why the residue is accepted

**Omission, and it is the important one.** A seed that leaves logs out passes every check in this ADR: the ordering holds, the coverage holds, each block has one hash, and a bloom cannot prove a log's absence. Detecting omission means knowing which blocks SHOULD have carried a matching log, which means fetching every header in the range and then the logs for every candidate: 11.3 million headers for the reference workload, and the log fetches the premise says are unavailable. It is not viable, and no cheaper formulation of it exists.

That is the sharpest form of the asymmetry this ADR opens with: an omitted event produces state that is quietly WRONG rather than obviously broken, and every successor generation inherits it by re-folding. **So omission is answered by trust, never by verification, and that is precisely why the build pin is a requirement rather than a recommendation.**

Also not defended, and both already own the application, so neither is a new exposure: a compromised build pipeline, and a publisher lying to its own users.

Not defended and out of scope by the source spec: the SNAPSHOT's own verification, which is already BUILT (`work/tasks/done/a-snapshot-a-client-cannot-read-is-refused-not-installed.md`; the source spec cites it under `work/tasks/backlog/` because it was written before that task landed), and the publishing pipeline, which is `work/notes/ideas/publishing-snapshots-of-versioned-state.md`.

## Refusal

As DATA, with the vocabulary of ADR-0064 extended by this layer's reasons (`integrity-mismatch`, `incoherent`, `inside-reorg-window`; the `unpinned-third-party` reason listed here is WITHDRAWN by ADR-0066, which has no location-based refusal), never thrown. That is `bootstrapFromSnapshot`'s judgement and the stance ADR-0040 settled.

**One note on citing ADR-0040**: its stance is what survives, not its mechanism. It decided where `BLOB_SNAPSHOT_FORMAT` lives for the free-form blob snapshot, and that path is deleted (ADR-0037) with only a stale doc reference left in `@etherfold/state-store`'s `snapshot.ts`. It is cited here for the principle -- an artifact a client cannot use is refused rather than installed, and a mirror that cannot serve is skipped rather than fatal -- and a reader following it to the code will not find it.

Because every mandatory check precedes the first write, there is no partially-installed seed to define. An install that FAILS midway is a different thing and is already answered: ADR-0063 makes it a contiguous prefix with an honest cursor, which is resumable and not damage.

## Consequences

- **The artifact must declare its PRODUCER**, not merely its provenance free-form, because the retraction rule is stated against that declaration.
- **The artifact's shape gains an integrity hash** per document (and per chunk in the chunked form), which the wire-shape finding deliberately left room for.
- **A client needs the resolved `finality` it runs under** to apply the capture-depth check, which it already has (it is in the stream config the digest covers).
- **A `handleUnparsedEvent` processor is not made safe by this ADR**; it is made safe by ADR-0064 refusing a wider seed. The two rules are separate and both are load-bearing.
- **The build plan must carry the pin as a first-class concern**, since a seeding capability whose artifacts are unpinned is one whose only real defence is absent.
