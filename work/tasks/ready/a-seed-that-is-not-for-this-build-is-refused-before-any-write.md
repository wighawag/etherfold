---
title: 'A seed that is not for this build, not pinned, or not coherent is refused before anything is written'
slug: a-seed-that-is-not-for-this-build-is-refused-before-any-write
spec: a-browser-app-starts-from-a-published-artifact
blockedBy: [a-published-stream-seed-installs-through-the-keeper-seam]
covers: [6, 7, 8, 9]
---

## What to build

Every admission check a client can make on its own, all of them running BEFORE the first write, on one refusal path with one outcome type. They are one task rather than four because identity, integrity, coherence and capture depth share that path and that type, and splitting them would spread one type across three tasks. This also completes the "checks" half of the install call the previous task landed.

**Identity** (ADR-0064). Admission is EXACT stream-digest equality: the client computes the publisher's 128-bit digest from the artifact's own resolved config and context, and compares it with its own. A publisher whose filter is a strict SUPERSET is refused even though the invalidation model calls such a stream reusable, because those extra events would be stored under the CLIENT's digest, re-folded by every later generation, and handed to a processor that implements `handleUnparsedEvent`. The refusal names the DIRECTION of the disagreement (`seed-covers-more` versus `seed-covers-less`), with a chain mismatch and a stream-config mismatch reported SEPARATELY even though the digest already subsumes them, because telling a developer who pointed at the wrong chain that "an entry was added at block 0" is useless. The loader reports the direction and never infers "you are out of date": a deliberately narrower client is indistinguishable from a stale one, and only the application can tell.

**Integrity and the pin** (ADR-0065). Start by reading what the PRODUCER declared, because the pin only works if both ends hash the same bytes: the producer printed a content hash over a byte domain it named (the published compressed document, or the decompressed JSON text) with an algorithm it named, and the loader declared how it turns a fetched body into an envelope. Recompute over THAT domain, and prove the round trip rather than assuming it: the case that pins the committed reference artifact must use the value the producer PRINTED, not a value this task's own test recomputed with this task's own function. A test that hashes with the same helper it is verifying passes while every real pinned install refuses.

The loader takes an EXPECTED CONTENT HASH from the CALLER, so the pin travels in the client BUILD and a seed is exactly as trustworthy as the code that fetched it. A hash fetched from the same place as the artifact is a LABEL for early rejection and never an admission credential. The pin is OPTIONAL, because a developer serving a seed from the origin that served the application gains nothing from the ceremony: an attacker holding that origin would change the application's own code. So an unpinned install is accepted only when the caller has STATED that the location is same-origin, and an unpinned THIRD-PARTY seed is refused outright. The caller states the trust it relies on; the library does not guess.

**Structural coherence**, all of it O(n) over the events and needing no node: block numbers non-decreasing and `(blockNumber, logIndex)` strictly increasing; exactly ONE `blockHash` per `blockNumber`, since two would be an unreconciled reorg; no duplicate `(blockHash, logIndex)`; every event inside the coverage the artifact claims; and retractions COHERENT rather than absent. Coherent means a retraction is preceded by an application of the same `(blockHash, logIndex)`, AND that the artifact's declared PRODUCER admits one: a seed that says it came from a capture and carries a retraction contradicts its own provenance and is refused on that. A blanket ban is deliberately rejected, because a seed derived from a server's append-only emission stream legitimately carries retractions and folding an apply/retract pair is correct behaviour.

**Capture depth**: the claimed coverage must end at least `finality` blocks below the chain head the producer OBSERVED, which is the stream analogue of the snapshot path's `inside-reorg-window` refusal and the check most easily missed, because what it catches leaves no trace. A capture taken near the tip can record a branch that later lost and be perfectly coherent while describing a chain that did not happen. It needs no node: the artifact carries the observed head, and the client already has the resolved `finality` it runs under, inside the stream config the digest covers.

**A refusal must not be destructive, and this task multiplies the refusals.** Every reason added here is a new path that ends without installing, and the previous task established why that matters: the keeper's only read (`fetchFrom`) CLEARS the subtree in some branches, so a refusal path that inspects the stream before giving up can delete the very history it declined to replace. Inherit the non-destructive probe that task built rather than adding a second inspection, and assert the property on the checks landed here too: refusing on a digest mismatch, a bad pin, incoherence or capture depth leaves an EXISTING stream exactly as it was. A refusal test that starts from an empty subtree cannot see this, so at least one case must start from a populated one.

**What is deliberately NOT built**: chain anchoring and bloom consistency (specified in ADR-0065, their value concentrates in adopting an unpinned third-party seed, which the pin rule refuses outright), and OMISSION detection, which is impossible within the premise rather than deferred and is precisely why the pin is mandatory. Do not add either.

With the checks in place, this is also where the install becomes a public, advertised entry point of `@etherfold/core`.

## Acceptance criteria

- [ ] Every mandatory check runs BEFORE the first write: a refused seed writes NOTHING, asserted by reading the keyspace after the refusal, so a half-verified stream is unexpressible rather than a state somebody has to define.
- [ ] A refusal is non-destructive as well as non-writing: at least one refusal case runs against a subtree that ALREADY holds a stream, and asserts its segments and cursor record are unchanged afterwards.
- [ ] Every refusal is returned as DATA with its reason, never thrown, and the reason vocabulary covers at least: no locations, unreachable, unreadable format, chain mismatch, stream-config mismatch, the two directions, integrity mismatch, incoherent, inside reorg window, and an unpinned third-party install.
- [ ] The DIRECTION pair is asserted on both sides (`seed-covers-more` when the client indexes less than the publisher, `seed-covers-less` when the seed lacks something the client indexes), and nothing in the loader claims the client is out of date.
- [ ] A seed whose bytes do not match a caller-supplied expected content hash is refused; a seed whose bytes match is admitted.
- [ ] The pin ROUND-TRIPS against the producer: the committed reference artifact installs when pinned with the hash the PRODUCER task printed for it (taken as a literal, the way a client build would carry it), so the producer's byte domain and algorithm and the loader's are asserted to agree end to end rather than each side agreeing with itself. If they disagree, that is the finding to report, not a value to quietly re-derive.
- [ ] An unpinned install from a location the caller has NOT stated is same-origin is refused; an unpinned install the caller has stated is same-origin is admitted; the caller states this rather than the library inferring it.
- [ ] Each coherence rule is asserted with its own failing artifact: out-of-order pairs, two block hashes at one block number, a duplicate `(blockHash, logIndex)`, an event outside the claimed coverage, and a retraction that contradicts the declared producer. A legitimate retraction from a producer that admits one is ADMITTED.
- [ ] A capture taken inside the reorg window is refused, using a synthetic artifact (the committed reference capture sits about 27.5M blocks below its observed head, so it cannot exercise this).
- [ ] The committed reference artifact still installs and folds after the checks land: the checks a real artifact passes are asserted to pass, so a check no real artifact can satisfy is caught here rather than disabled later.
- [ ] Chain anchoring, bloom consistency and any attempt at omission detection are NOT built.
- [ ] The install call is exported as a public entry point of `@etherfold/core`, with its trust contract stated in its JSDoc (the pin comes from the build; an unpinned third-party seed is refused; omission is not defended against).
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
> The two decisions that govern you, read both in full: ADR-0064 ("A seed for another stream is REFUSED on an exact digest, and the refusal names a DIRECTION"), including why a publisher SUPERSET is refused, what is deliberately OVER-refused and accepted, and that the INFERENCE from a direction belongs to the application; and ADR-0065 ("A stream seed is TRUSTED by a build pin and CHECKED for coherence, because omission cannot be detected"), including the three trust shapes (build-pinned, same-origin unpinned, third-party unpinned which is refused), the full list of coherence checks, the capture-depth check, and what is specified but deliberately NOT built.
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
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT: how a caller states same-origin trust, how the direction is computed, which bytes the integrity check hashes and how that matches what the producer printed, any refusal reason you added beyond the recorded vocabulary, and how you kept the checks O(n). The runner transcribes the block into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note. If a choice meets the ADR gate, write the ADR and name it in the block.

## Note on the build pin, resolved

The tasking loop raised one blocking issue against every task in this set: ADR-0065 pinned trust to a
build-named content hash without saying a hash OF WHAT, and over a gzipped artifact that is ambiguous
enough to break every correctly pinned install (a host sending `Content-Encoding: gzip` makes `fetch`
decompress transparently, so a hash over the compressed file cannot be recomputed from what the client
receives). It is resolved at the source: ADR-0065 now carries a 2026-09-07 amendment fixing SHA-256 over
the PUBLISHED BYTES, with the artifact served as an opaque file and never with `Content-Encoding: gzip`.
Build to that; the producer's printed hash must be reproducible from the published file alone.
