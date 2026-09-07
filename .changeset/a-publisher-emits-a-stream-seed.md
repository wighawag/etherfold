---
'@etherfold/core': minor
---

A published STREAM SEED has a shape, its own format number and a content hash both ends compute the same way.

`StreamSeed` (`stream/seed.ts`) is the artifact a publisher emits and a client installs. It carries `STREAM_SEED_FORMAT` (1) and deliberately NOT `STREAM_FIXTURE_FORMAT`: a fixture is a CAPTURE holding decoded events and the source they were decoded against, a seed holds the STORED half only plus what a client needs to establish what the artifact is without trusting the host that served it. Two numbers is what makes each reader REFUSE the other's document instead of half-parsing it.

```ts
const seed = parseStreamSeed(text); // THROWS on a format this build does not read
seed.streamConfig; // RESOLVED, so the client can compute the 128-bit digest itself (ADR-0064)
seed.streamDigest; // a label the client VERIFIES, never trusts
seed.coverage; // how far it REACHES, not where its events are (ADR-0055)
seed.context; // the seed's OWN stored context, installed verbatim (ADR-0063)
seed.chainHeadAtCapture; // what the capture-depth check reads
seed.producer; // TYPED, because the retraction rule is stated against it (ADR-0065)
```

**The content hash is a contract between a producer and a loader, so its two halves are pinned in one function.** `streamSeedContentHash(payload)` is SHA-256 over the DECOMPRESSED payload octets, taken after any transfer decoding and before `JSON.parse`, rendered `sha256:<64 lowercase hex>`. That domain is ADR-0066's and it is transport-invariant: a host may serve the file opaque or with `Content-Encoding: gzip` and a client reaches the same value either way. It takes BYTES rather than a string or a parsed seed, so hashing a re-serialisation is not expressible. If the two ends hashed different bytes, every pinned install would refuse with an integrity mismatch while each side's own tests stayed green.

**`streamDigestOfSourceHashes` is the existing digest rule, rephrased over the entries it already consumes.** A seed carries its publisher's source HASH ENTRIES in its stored context and ships no `IndexingSource`, so a client checking one has the entries and cannot have the source. Nothing about what enters the digest, how wide it is or how it renders is different, and `streamDigestOf` is now defined in terms of it so the two cannot drift.

**`StreamFixtureProvenance` gains two OPTIONAL typed keys**, `chainHeadAtCapture` and `capturedBy`, which the committed captures already carry through its free-form index signature. Typing them lets a producer read them instead of casting; neither is REQUIRED and neither can become so, because that would force a fixture-format bump ADR-0063 forbids. `STREAM_FIXTURE_FORMAT` is unchanged.

The PRODUCER lives outside this package, applying the exported `storedStreamOf` rather than a copy of it, and refuses to emit under a stream config its capture was not taken under.
