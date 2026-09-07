---
title: 'A seed that is not for this stream, not intact, or not coherent is refused before anything is written'
slug: a-seed-that-is-not-for-this-build-is-refused-before-any-write
spec: a-browser-app-starts-from-a-published-artifact
blockedBy: [a-published-stream-seed-installs-through-the-keeper-seam]
covers: [6, 7, 8, 9]
---

## What to build

Every admission check a client can make on its own, all of them running BEFORE the first write, on one refusal path with one outcome type. They are one task rather than four because identity, integrity, coherence and capture depth share that path and that type, and splitting them would spread one type across three tasks. This also completes the "checks" half of the install call the previous task landed.

**Identity** (ADR-0064). Admission is EXACT stream-digest equality: the client computes the publisher's 128-bit digest from the artifact's own resolved config and context, and compares it with its own. A publisher whose filter is a strict SUPERSET is refused even though the invalidation model calls such a stream reusable, because those extra events would be stored under the CLIENT's digest, re-folded by every later generation, and handed to a processor that implements `handleUnparsedEvent`. The refusal names the DIRECTION of the disagreement (`seed-covers-more` versus `seed-covers-less`), with a chain mismatch and a stream-config mismatch reported SEPARATELY even though the digest already subsumes them, because telling a developer who pointed at the wrong chain that "an entry was added at block 0" is useless. The loader reports the direction and never infers "you are out of date": a deliberately narrower client is indistinguishable from a stale one, and only the application can tell.

**Location, and the OPTIONAL integrity hash** (ADR-0066, which supersedes ADR-0065 here). The trust anchor is the LOCATION, and it is the CALLER's to choose: the loader fetches from the locations it was given and nowhere else, so there is no origin check and no allowlist to build. Ordinarily those come from the build, and TLS to a named host is what the client relies on. A content HASH is optional, because a build cannot know the hash of a ROLLING artifact and rolling is how this is deployed; where the artifact is immutable and release-tied a pin is the strongest thing available and is supported. When a hash is used it is SHA-256 over the DECOMPRESSED octets, taken after transfer decoding and before `JSON.parse`, which is transport-invariant, so there is NO rule about how a host serves the file. Prove the round trip rather than assuming it: the case that pins the committed reference artifact must use the value the producer PRINTED, not a value this task's own test recomputed with this task's own function. A test that hashes with the same helper it is verifying passes while every real pinned install refuses.

The loader takes the LOCATIONS and an OPTIONAL expected content hash, both from the caller, so both travel in the client BUILD. A hash fetched from the same place as the artifact is a LABEL for early rejection and never an admission credential. There is deliberately NO same-origin condition and no refusal derived from one: the application may be served from any IPFS gateway while the artifact lives on a known host, so the two origins never match by construction, and a rule written in those terms would refuse the deployment it was meant to bless. What the client trusts is the named host; what it accepts is an artifact from there that passes every check below.

The residue this leaves is the uncomfortable half and belongs in the JSDoc rather than only here: a compromise of the named host poisons every client silently, because omission cannot be detected and a poisoned stream is inherited by every later generation. Signing against a build-pinned key is the mechanism that would close it and is deliberately not built (ADR-0066).

**Structural coherence**, all of it O(n) over the events and needing no node: block numbers non-decreasing and `(blockNumber, logIndex)` strictly increasing; exactly ONE `blockHash` per `blockNumber`, since two would be an unreconciled reorg; no duplicate `(blockHash, logIndex)`; every event inside the coverage the artifact claims; and retractions COHERENT rather than absent. Coherent means a retraction is preceded by an application of the same `(blockHash, logIndex)`, AND that the artifact's declared PRODUCER admits one: a seed that says it came from a capture and carries a retraction contradicts its own provenance and is refused on that. A blanket ban is deliberately rejected, because a seed derived from a server's append-only emission stream legitimately carries retractions and folding an apply/retract pair is correct behaviour.

**Capture depth**: the claimed coverage must end at least `finality` blocks below the chain head the producer OBSERVED, which is the stream analogue of the snapshot path's `inside-reorg-window` refusal and the check most easily missed, because what it catches leaves no trace. A capture taken near the tip can record a branch that later lost and be perfectly coherent while describing a chain that did not happen. It needs no node: the artifact carries the observed head, and the client already has the resolved `finality` it runs under, inside the stream config the digest covers.

**A refusal must not be destructive, and this task multiplies the refusals.** Every reason added here is a new path that ends without installing, and the previous task established why that matters: the keeper's only read (`fetchFrom`) CLEARS the subtree in some branches, so a refusal path that inspects the stream before giving up can delete the very history it declined to replace. Inherit the non-destructive probe that task built rather than adding a second inspection, and assert the property on the checks landed here too: refusing on a digest mismatch, a bad pin, incoherence or capture depth leaves an EXISTING stream exactly as it was. A refusal test that starts from an empty subtree cannot see this, so at least one case must start from a populated one.

**What is deliberately NOT built**: chain anchoring and bloom consistency (specified in ADR-0065; ADR-0066 answers the untrusted-host case with a SIGNATURE, which is named and deliberately not built), and OMISSION detection, which is impossible within the premise rather than deferred and is precisely why the named host must be trusted like the build pipeline. Do not add either.

With the checks in place, this is also where the install becomes a public, advertised entry point of `@etherfold/core`.

## Acceptance criteria

- [ ] Every mandatory check runs BEFORE the first write: a refused seed writes NOTHING, asserted by reading the keyspace after the refusal, so a half-verified stream is unexpressible rather than a state somebody has to define.
- [ ] A refusal is non-destructive as well as non-writing: at least one refusal case runs against a subtree that ALREADY holds a stream, and asserts its segments and cursor record are unchanged afterwards.
- [ ] Every refusal is returned as DATA with its reason, never thrown, and the reason vocabulary covers at least: no locations, unreachable, unreadable format, chain mismatch, stream-config mismatch, the two directions, integrity mismatch, incoherent, inside reorg window, and a subtree that is not empty (ADR-0067). There is deliberately NO location-based refusal: the loader fetches what it was pointed at, so there is no admission decision about location to make (ADR-0066).
- [ ] The DIRECTION pair is asserted on both sides (`seed-covers-more` when the client indexes less than the publisher, `seed-covers-less` when the seed lacks something the client indexes), and nothing in the loader claims the client is out of date.
- [ ] A seed whose bytes do not match a caller-supplied expected content hash is refused; a seed whose bytes match is admitted; and an install with NO expected hash is admitted, since the hash is optional and a rolling artifact cannot have one pinned.
- [ ] The pin ROUND-TRIPS against the producer: the committed reference artifact installs when pinned with the hash the PRODUCER task printed for it (taken as a literal, the way a client build would carry it), so both ends are asserted to agree end to end rather than each agreeing with itself. If they disagree, that is the finding to report, not a value to quietly re-derive.
- [ ] The hash is asserted to be TRANSPORT-INVARIANT: the same artifact served opaque and served with `Content-Encoding: gzip` produces the same hash and installs under the same pin. This is the whole reason the domain is the decompressed octets, so it is asserted rather than assumed.
- [ ] Each coherence rule is asserted with its own failing artifact: out-of-order pairs, two block hashes at one block number, a duplicate `(blockHash, logIndex)`, an event outside the claimed coverage, and a retraction that contradicts the declared producer. A legitimate retraction from a producer that admits one is ADMITTED.
- [ ] A capture taken inside the reorg window is refused, using a synthetic artifact (the committed reference capture sits about 27.5M blocks below its observed head, so it cannot exercise this).
- [ ] The committed reference artifact still installs and folds after the checks land: the checks a real artifact passes are asserted to pass, so a check no real artifact can satisfy is caught here rather than disabled later.
- [ ] Chain anchoring, bloom consistency and any attempt at omission detection are NOT built.
- [ ] The install call is exported as a public entry point of `@etherfold/core`, with its trust contract stated in its JSDoc (the CALLER names the locations and owns that choice, including any runtime override it accepts; a content hash is OPTIONAL and only an immutable release-tied artifact can carry a pinned one; omission is NOT defended against, so the named host is trusted like the build pipeline).
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style, and any synthetic artifacts they build live in the tests' own fixtures rather than beside the committed reference artifact.
- [ ] A changeset records the `@etherfold/core` change.
- [ ] The repo acceptance gate is green.

## Blocked by

- `a-published-stream-seed-installs-through-the-keeper-seam`, which owns the same module and the outcome type these reasons extend.

## Prompt

> Add every admission check a client can make on its own to the stream-seed loader, all of them before the first write, and make the install a public, advertised entry point.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): read the loader and the outcome type the previous task actually landed, and the envelope the producer landed. Write against those. If a decision moved, route to needs-attention rather than reconciling it silently.
>
> The two decisions that govern you, read both in full: ADR-0064 ("A seed for another stream is REFUSED on an exact digest, and the refusal names a DIRECTION"), including why a publisher SUPERSET is refused, what is deliberately OVER-refused and accepted, and that the INFERENCE from a direction belongs to the application; and ADR-0065 ("A stream seed is trusted by a build pin and checked for coherence...", as SUPERSEDED IN PART by ADR-0066 on its trust anchor and byte domain), for the full list of coherence checks, the capture-depth check, the omission residue and what is specified but deliberately NOT built; then ADR-0066 for the trust anchor that REPLACES that ADR's build pin: the build names the LOCATIONS, a content hash is optional and is SHA-256 over the decompressed octets, and there is no same-origin condition and no hosting constraint.
>
> Vocabulary (`CONTEXT.md`): **stream identity** is the 128-bit digest over the deduplicated `streamHash` values plus the resolved stream config, and it decides WHICH stream a result belongs to; the **stream verdict versus the state verdict** is a different question and its tolerance of a superset is about a LOCAL cache the client already owns, which is exactly why it must not be borrowed here; **finality** and the reorg model decide what "far enough below the tip" means; a **retraction** in a stored emission stream is an append-only fact a replay HONOURS (ADR-0042, ADR-0006), which is why retractions are checked for coherence rather than banned.
>
> Where to look, by concept: the seed loader and envelope in core's stream folder; the stream identity module for the digest rule (do not change what enters it); the source-invalidation verdict for the direction question, since the direction is decided by whether the seed's context makes the client's stream verdict valid or invalid and at which block; the snapshot bootstrap's `NotBootstrappedReason` in `@etherfold/processor-entities` for the refusal vocabulary's shape; and the parse-or-refuse fixture reader, which THROWS on an unknown format and must therefore be caught and reported so the refusal stance holds for every reason.
>
> The load-bearing assertions, as external behaviour: every refusal is asserted as DATA with its reason, including both directions, because the direction is the half an application renders; a refused seed writes NOTHING and deletes nothing, asserted on the keyspace rather than on a spy, with at least one refusal driven against a subtree that already holds a stream (the keeper's only read clears the subtree in some branches, which is why the previous task built a non-destructive probe: inherit it, do not add a second inspection); the reference artifact still passes every check (a check no real artifact passes is a check that gets disabled); and a capture inside the reorg window is refused, which needs a synthetic artifact.
>
> Do not build chain anchoring, bloom consistency, publisher signing, or any form of omission detection. ADR-0065 records why each is out, and omission is IMPOSSIBLE within the premise rather than merely deferred: it is the reason the pin is a requirement.
>
> Done means: every mandatory check runs before the first write on one refusal path, each has its own failing case, a refusal leaves an existing stream intact, the reference artifact still installs and folds, the entry point is public with its trust contract stated, a changeset exists, and the gate is green.
>
> Before writing the integrity check, read the producer's declared hash ALGORITHM and BYTE DOMAIN and the loader's declared decompression arrangement, and pin the reference artifact in a test with the literal value the producer PRINTED. Hashing with the same helper you are verifying proves nothing; the failure this catches is a build pinning a published value and every install refusing.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT: how a caller names the trusted locations, how the direction is computed, which bytes the integrity check hashes and how that matches what the producer printed, any refusal reason you added beyond the recorded vocabulary, and how you kept the checks O(n). The runner transcribes the block into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note. If a choice meets the ADR gate, write the ADR and name it in the block.

## Note on the build pin, superseded

The tasking loop raised one blocking issue against every task in this set: ADR-0065 pinned trust to a
build-named content HASH without saying a hash of what. That is settled, but not the way the first
amendment settled it. **ADR-0066 supersedes ADR-0065 on the trust anchor and the byte domain**, and a
builder should read it before either:

- **Trust is the HOST the build NAMES**, not a content hash. A build cannot pin the hash of a ROLLING
  artifact, and rolling is how this is deployed: the reference deployment held one web build against a
  snapshot republished every hour. `bootstrapFromSnapshot`, the path that already ships and works,
  verifies no hash at all.
- **A content hash is OPTIONAL**, for a release-tied immutable artifact, where it is the strongest
  thing available. When present it is SHA-256 over the DECOMPRESSED octets, taken after transfer
  decoding and before `JSON.parse`.
- **There is NO hosting constraint.** The earlier rule forbidding `Content-Encoding: gzip` is
  withdrawn: hashing the decompressed octets is transport-invariant, so it does not matter whether a
  host serves the file opaque or compresses it in transit.
- **Same-origin is not a condition anywhere**, and the refusal it once justified is gone. The app may
  be served from any IPFS gateway while the artifact lives on a known host, so the two origins never
  match by construction.
