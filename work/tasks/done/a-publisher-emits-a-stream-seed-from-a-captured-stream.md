---
title: 'A publisher emits a stream-seed artifact from a captured stream, and prints its digest and content hash'
slug: a-publisher-emits-a-stream-seed-from-a-captured-stream
spec: a-browser-app-starts-from-a-published-artifact
blockedBy: [the-stored-event-strip-is-exported-from-core]
covers: [4]
---

## What to build

The published artifact itself, and the producer that emits one from a captured stream, so that a client can establish WHAT an artifact is without trusting the host that served it.

**The envelope**, defined in `@etherfold/core` beside the fixture format and carrying its OWN format number. A seed is not a fixture and must not borrow `STREAM_FIXTURE_FORMAT`: the two shapes differ in what they carry and a reader must be able to refuse the wrong one rather than half-parse it. What it carries:

- **only the STORED half of each event**. The install strips the decoded half anyway (ADR-0060) and publishing it costs a third of the artifact for bytes the client parses and then discards: 0.54 MB gzipped and 20.1 MB raw for the 31,332-log reference capture, against 0.81 MB and 26.5 MB with the decoded half.
- **the RESOLVED stream config**, because a client cannot compute the publisher's 128-bit stream digest without it (ADR-0064). It is a SEPARATE input to the producer, not something recoverable from a capture, which carries only the 32-bit config hash.
- **the stream DIGEST**, as a label the client VERIFIES rather than trusts, so a manifest can be rejected before a body is downloaded.
- **the COVERAGE it claims** (where the capture reaches from and to), which is the client-side counterpart of the stored stream's coverage claim (ADR-0055), and the seed's stored context (its source-hash entries), which the identity check reads.
- **the chain head its producer OBSERVED at capture**, which the later capture-depth check reads.
- **a DECLARATION of what produced it**, typed, because the retraction rule is stated against that declaration (ADR-0065).

**Where the typing lands, because this is easy to get wrong.** The observed head and the producer declaration are TYPED FIELDS OF THE SEED ENVELOPE, which is new, and they are typed INPUTS to the producer. Today a capture carries them only as free-form keys of `StreamFixtureProvenance` (`chainHeadAtCapture`, `capturedBy` in the committed capture), so the producer may READ them from there as a convenience, but it must not depend on their being typed. Do NOT make them required fields of `StreamFixtureProvenance`: that is a published type whose shape `captureStream` writes and every committed capture already matches, so a required field would force a fixture-format bump, and ADR-0063 is explicit that `STREAM_FIXTURE_FORMAT` is untouched by this work. Widening the fixture provenance with OPTIONAL fields is allowed if it makes the producer honest and costs no format bump; anything more is out of scope.

What the envelope does NOT carry is its own integrity hash: a document cannot contain a hash of itself, and the chunked per-chunk-plus-manifest arrangement belongs to a shape this spec excludes. The client hashes the bytes it received and compares them against a value the BUILD pins. The producer's job is to PRINT that hash so a build can pin it.

**The pin is a CONTRACT between this task and the loader, so name its two halves here rather than leaving each side to choose.** The whole trust story of this spec is that a build pins a value this producer printed and a client recomputes it; if the two sides hash different bytes, every pinned install refuses with an integrity mismatch and neither task's own tests can see it, because each hashes with its own function. So pin explicitly, and state both in `## Decisions`:

- **the ALGORITHM and its rendering** (the repo already hashes with `sha256` in the stream-identity module, so reach for what exists rather than a second primitive), printed in a SELF-DESCRIBING form a build can paste, so a reader can tell which function produced it;
- **the BYTE DOMAIN**, which is DECIDED and not yours to choose (ADR-0066): SHA-256 over the DECOMPRESSED payload OCTETS, taken after any transfer decoding and before `JSON.parse`, and never over the result of re-stringifying a parsed value. It is pinned that way precisely so it is TRANSPORT-INVARIANT: a host that sets `Content-Encoding: gzip` makes `fetch` decompress transparently, one that serves the file opaque does not, and both must yield the same hash. Compute it over exactly those octets, because the loader and the admission task recompute exactly that.

**The producer**, which lives OUTSIDE `@etherfold/core` (that is what the previous task's export exists for), reduces a captured stream to a seed through the exported strip, and emits it as one compact gzipped document. Be clear about what its placement does and does not deliver: putting it in this repo's own test/tooling material means the PUBLISHED capability for a third party is the envelope type plus the exported strip plus the digest rule, and the producer itself is ours. That is the intended reading of story 4 under a spec that keeps the publishing pipeline out of scope, so keep the envelope and everything a publisher must compute on the PUBLISHED side of the boundary, and let only the emit script be private. Constrain its home rather than guessing at a new one: put it with the material that already owns the committed capture and its fixture IO, do NOT add a published CLI command surface, and do NOT build any part of a publishing pipeline (CI, hosting, retention, who may publish) which this spec keeps out of scope. Record the placement in `## Decisions`.

**The resolved config is a separate input, so the producer must not be able to publish a seed for a config the capture was not taken under.** A capture records `lastSync.context.config`, which is `streamConfigHashOf` of the config its run resolved (that is exactly what `captureStream` writes). So the producer computes `streamConfigHashOf` of the config it was handed and REFUSES to emit unless it equals the capture's. Without that check the emitted artifact is internally consistent and still wrong: it would claim a stream identity no client running that capture's config can match, and the mistake would only surface as a refusal in someone else's browser.

**The demo** is an artifact emitted from the committed 31,332-log reference capture, committed BESIDE it in that same package's fixtures, with its stream digest and its content hash printed, and its size in the neighbourhood the measurement predicts. The loader and admission tasks install exactly that artifact, reading it where you put it, so it is a deliverable and not a throwaway: keep it in ONE place, do not copy it into another package, and note its path in `## Decisions` so the next task can find it without guessing.

One wrinkle to expect rather than be surprised by: the stream digest rule is defined over a source's hash entries plus the resolved config, and a seed carries those entries in its stored context rather than an `IndexingSource`. Expressing the existing rule over the entries it already consumes is an in-scope refactor of ONE function. Do not change WHAT enters the digest, its width or its rendering: ADR-0064 is explicit that nothing here re-opens `streamDigestOf`.

## Acceptance criteria

- [ ] A seed envelope type exists in `@etherfold/core` with its OWN format constant, distinct from `STREAM_FIXTURE_FORMAT`, and a reader refuses an artifact whose format it does not read (as data or as a caught throw, whichever the loader task will consume: state which).
- [ ] The envelope carries the stored half of each event, the resolved stream config, the stream digest label, the claimed coverage, the stored context, the producer-observed chain head, and a TYPED producer declaration, with no field admitted only through a free-form index signature.
- [ ] `STREAM_FIXTURE_FORMAT` is unchanged and no field is made REQUIRED on `StreamFixtureProvenance`: the observed head and the producer declaration are typed on the SEED envelope and taken as typed inputs to the producer.
- [ ] A producer OUTSIDE `@etherfold/core` emits a seed from a captured stream, using the exported strip rather than a local copy of it.
- [ ] The producer refuses to emit when `streamConfigHashOf` of the resolved config it was given does not equal the capture's own `lastSync.context.config`, and a test asserts that refusal, so a seed cannot be published under a config its capture was not taken under.
- [ ] The emitted artifact is a single COMPACT gzipped document carrying no decoded half, and its measured size on the reference capture is in the neighbourhood the finding predicts (about 0.54 MB gzipped, 20.1 MB raw); a materially different number is reported rather than quietly accepted.
- [ ] The producer PRINTS the artifact's stream digest and its content hash, in a form a client build can pin: the content hash is SELF-DESCRIBING about the algorithm that produced it, and the BYTE DOMAIN is ADR-0066's (SHA-256 over the decompressed octets) and the producer computes it over exactly those bytes and in the producer's own documentation, so the loader recomputes over the same bytes rather than guessing.
- [ ] The hash of the committed reference artifact is asserted REPRODUCIBLE: recomputing it from the committed bytes, through the domain the producer declared, yields the value the producer printed. This is the value the loader and admission tasks pin against, so a disagreement about which bytes are hashed fails here rather than in a browser.
- [ ] An artifact emitted from the committed reference capture is committed beside that capture, in exactly one place, and a test asserts it parses as a seed, that its declared digest equals the digest recomputed from its own context and resolved config, and that its event count and coverage match the capture it came from.
- [ ] The digest rule is unchanged in what it hashes, how wide it is and how it renders: existing stream-identity tests still pass unmodified.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style, and any test that writes files writes them under its own temp/fixture location, leaving the committed artifact untouched.
- [ ] A changeset records the additive `@etherfold/core` change.
- [ ] The repo acceptance gate is green.

## Blocked by

- `the-stored-event-strip-is-exported-from-core`, because the producer must apply the ONE implementation of the strip rather than copying it, and because both tasks touch the core package entry.

## Prompt

> Define the published stream-seed artifact and build the producer that emits one from a captured stream.
>
> FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): confirm the strip is exported, that no seed envelope already exists, and that ADR-0063, ADR-0064 and ADR-0065 still say what this task assumes. If a decision moved, route to needs-attention rather than building against a stale premise.
>
> The decisions that govern you, read them before writing anything: ADR-0063 (a seed arrives through its own loader and installs through the keeper seam, and `STREAM_FIXTURE_FORMAT` is untouched), ADR-0064 (the artifact carries its RESOLVED stream config so the client computes the 128-bit digest itself, plus the digest as a verifiable label), ADR-0065 (the artifact must declare its PRODUCER because the retraction rule is stated against it, and it may carry an OPTIONAL content hash, printed for a build to pin when the artifact is immutable, computed over the bytes rather than embedded), and `work/notes/findings/what-a-published-stream-seed-costs-to-install.md` (the measured wire shape: one compact gzipped document, stored half only, and why chunking is deliberately not built).
>
> Vocabulary (`CONTEXT.md`): a **StreamFixture** is a CAPTURE, replayable, carrying decoded events and a `lastSync` whose context holds **source hash entries** plus a 32-bit config hash; **stream identity** is a 128-bit digest over the deduplicated `streamHash` values plus the RESOLVED stream config; the **stream / keepStream** seam speaks `StoredLogEvent` and refuses the decoded half (ADR-0060); a stream's **coverage claim** is how far it REACHES, which is above its last event-bearing block, and it is load-bearing (ADR-0055).
>
> Where to look, by concept: the fixture module in `@etherfold/core`'s stream folder holds the format constant, the provenance type and the parse-or-refuse reader that the seed shape is a sibling of. `captureStream` in the same folder is what produced the committed capture, and it is also where you can see that a capture's `context.config` is `streamConfigHashOf` of the config the run resolved: that is the value your emit-time check compares against. The committed capture itself (the private stratagems conformance workload's fixtures, loaded through that package's own gzip-aware fixture IO) already carries an observed chain head and a `capturedBy` in its free-form provenance, and those are the two values the SEED envelope types. `docs/spikes/pin-the-seam-a-published-stream-arrives-through/install.mjs` shows what an installer needs from an artifact, so shape the envelope so the loader task needs no second source of truth.
>
> Placement rules. The producer lives OUTSIDE `@etherfold/core` (the export exists for it), is not a new published CLI command, and builds no part of the publishing pipeline (hosting, CI, retention, permissions), which the spec keeps out of scope. The natural home is the test/tooling material that already owns the committed capture and its fixture IO. The emitted reference artifact is committed beside that capture, once, and the next two tasks read it from there. Say in your Decisions block where the producer lives, where the artifact landed, and why.
>
> Done means: an envelope with its own format number, a producer that emits one through the exported strip and refuses a config the capture was not taken under, an artifact committed from the reference capture with its digest and content hash printed, a test that the artifact is internally consistent with what it claims, an unchanged fixture format and digest rule, a changeset, and a green gate.
>
> The CONTENT HASH is a contract with the next two tasks, not a detail: they recompute it from the bytes a client received. Choose and RECORD the algorithm (the stream-identity module already uses `sha256`; do not introduce a second primitive without a reason) and the BYTE DOMAIN (the published compressed document, or the decompressed JSON text), print the value in a self-describing form a build can paste, and assert on the committed artifact that recomputing over the declared domain reproduces the printed value. Note the trap: a host serving the artifact with `Content-Encoding: gzip` makes `fetch` decompress transparently, so a client cannot recompute a hash taken over the compressed file from what it receives.
>
> RECORD non-obvious in-scope decisions you make while building, in a `## Decisions` block at the end of your FINAL REPORT: where the producer lives, the committed artifact's path, what the format number is and why, the content hash's ALGORITHM and BYTE DOMAIN (the next two tasks pin against them), whether an unreadable format is reported as data or thrown (the loader task consumes that choice), and any field you added beyond the ones listed here. The runner transcribes the block into the done record; do not write the done record, the commit message or the PR body yourself, and do not open a `decisions-*` note. If a choice meets the ADR gate, write the ADR and name it in the block.

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

## Decisions

- **Where the producer lives**: `packages/conformance-workload-stratagems/src/stream-seed.ts`, with `scripts/emit-stream-seed.ts` as the emit script and a private `emit:seed` package script. That package already owns the committed capture and its gzip-aware fixture IO, so the seed's file convention (gzip by `.gz` extension) is the same convention stated once. Alternatives considered: a new tooling package (a package for one script), and a CLI verb (explicitly out of scope). Touches: nothing published, and it is deliberately not a CLI command surface; the published capability stays the envelope + the exported strip + the digest rule.
- **Where the artifact landed**: `packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.seed.json.gz`, beside the capture, in exactly one place, and reachable as `ALPHA1.seedPath` (a new optional field on `WorkloadFixture`) so the loader and admission tasks find it without a path literal. Touches both of those tasks.
- **Format number 1**: a fresh sequence, not a continuation of `STREAM_FIXTURE_FORMAT`. Nothing preceded the seed shape, and continuing the fixture's numbering would suggest the two are versions of one format when the point of the split is that they are not.
- **Content hash algorithm and rendering**: SHA-256 (viem's, the primitive `streamDigestOf` already uses; no second primitive introduced), rendered **`sha256:<64 lowercase hex>`**. ADR-0065's withdrawn amendment had said "no prefix", but that amendment is withdrawn wholesale and the task requires a self-describing form; a bare hex literal pasted into a build cannot say which function produced it. `sha256:` is the OCI-digest form and splits on one character. Alternative considered: the SRI form `sha256-<base64>` (rejected: base64 is harder to compare by eye and invites confusion with an SRI attribute the loader does not implement). **This is a contract with the loader and the admission tasks**: they must pin and split exactly this rendering.
- **Content hash byte domain**: ADR-0066's, and not mine to choose: SHA-256 over the **decompressed payload octets**, after transfer decoding and before `JSON.parse`. Enforced in the type, not only in prose: `streamSeedContentHash` takes a `Uint8Array`, so hashing a re-serialised parse is not expressible, and the function lives in **core** rather than in the producer precisely so the loader computes the same bytes with the same code instead of writing a second implementation neither task's tests could catch disagreeing.
- **An unreadable format is a THROW, not data.** `parseStreamSeed` throws, exactly as `parseStreamFixture` does; the **loader catches and reports `unreadable-format`** as data, which is the conversion ADR-0064 already describes for the fixture parser. Alternative considered: returning a discriminated result, rejected because it would put half the refusal vocabulary in core's reader and half in the loader's outcome type. The loader task consumes this: catch around the parse, one refusal for a truncated file, a fixture handed to the wrong reader and a future format alike.
- **Fields added beyond the ones listed**: none on the envelope. `StreamSeedProducer` has three (`kind`, `name`, `at`), and `at` dates when the **events** were produced rather than when the file was written, which is what makes the emit deterministic (a re-emit of an unchanged capture is byte-identical, so a re-emit never moves a pinned hash and any diff is a real one). `StreamFixtureProvenance` gains `chainHeadAtCapture?` and `capturedBy?`, optional and unable to become required.
- **One existing test's allow-list changed**, and it is worth flagging: `packages/core/test/streamIdentity.test.ts`'s "is the ONLY implementation of ITSELF" scans `src/` for files mentioning `sha256`, so adding `streamSeedContentHash` tripped it. The guard exists to stop a **second implementation of the stream ADDRESS**; a content hash over a document's octets addresses nothing and truncates nothing, so I admitted `stream/seed.ts` with that justification **and tightened the guard** by additionally asserting that only `stream/identity.ts` truncates to `STREAM_DIGEST_LENGTH`. The digest rule itself, its inputs, width and rendering are untouched and every other stream-identity assertion passes unmodified.
- **Gzip level 9 for the artifact**: a published artifact is written once and downloaded by everybody, and it is what the wire-shape measurement used, so the emitted size reproduces the finding (0.53 MiB) instead of sitting 12% above it (0.60 MiB at zlib's default) for no stated reason. Touches the reference artifact's bytes, hence nothing pinned (the hash is over the decompressed octets and is level-invariant).
