# A ROLLING seed is trusted by the HOST its build names, not by a hash the build cannot know

Supersedes ADR-0065 on its trust anchor and on the byte domain of its content hash. Everything else in that ADR stands unchanged: why a stream seed needs more defence than a snapshot, the checks that run before the first write, refusal as data, and the omission residue.

**The rule.** The CALLER supplies the LOCATIONS, and the loader fetches from those and nowhere else. Trust is whatever the caller's choice of location is worth -- ordinarily a host its build named, reached over TLS -- and nothing about the artifact's bytes is required to establish it. A content hash is OPTIONAL and is supported for the case where it can exist -- an IMMUTABLE artifact published for one release -- where it is the strongest thing available.

**There is no allowlist and no origin check, and saying so precisely matters**, because an earlier draft of this ADR listed "a location the build did not name" as a refusal REASON and that reason has no mechanism: a loader cannot be offered a seed from somewhere it was not pointed at. Where the caller GETS its locations is the application's business and the application's risk -- a build constant, an environment variable, or a query parameter, which the reference deployment does support (`?snapshot=` overriding the configured host, `work/notes/findings/how-a-shipped-browser-indexer-is-actually-deployed.md`). The library must not pretend to validate a decision it cannot see.

**A BUILD-EMBEDDED location is a first-class member of that list**, and is the case that needs no host at all: an artifact shipped inside the application's own build, at a relative path, delivered by the same bytes as the code. The reference deployment lists exactly that as its LAST resort, behind the rolling remote, so the app still starts when its snapshot host is unreachable or gone. Checking such an artifact's hash proves nothing that was not already assumed, since it arrived in the same delivery as the code that would check it.

**And the hash, when there is one, is SHA-256 over the DECOMPRESSED payload octets**: the bytes as they exist after any transfer decoding and before `JSON.parse`.

## Why ADR-0065's build pin cannot work, which is a fact about deployments and not a preference

That ADR reasoned from the source spec's premise: a filter change means the user is getting a new client build anyway, so a seed can ship pinned by the build that fetches it. True for a seed tied to a release. False for how this is actually deployed, and the reference deployment is the counter-example:

**The web build stayed the same for long stretches while a new snapshot was published EVERY HOUR** (8,198 publishes over 357 days, `work/notes/findings/what-a-published-stream-seed-costs-to-install.md`). A client behind the current snapshot adopted it; a client already ahead did not fetch it. A build cannot carry the hash of an artifact that did not exist when the build was made, so for a ROLLING artifact a build-pinned content hash is not merely awkward, it is impossible.

The evidence was already in the tree and ADR-0065 failed to weigh it: **`bootstrapFromSnapshot`, the path that actually shipped and worked, verifies no hash at all.** It checks the processor version and the reorg window, fetches the head to compare positions, prefers local state when local is ahead, and otherwise trusts the origin it was pointed at. That is exactly the behaviour above, and it has been the working answer the whole time.

## Why "same origin" is the wrong frame, and not merely a weaker one

ADR-0065 offered same-origin-unpinned as the cheap accepted case, reasoning that an attacker holding the origin would change the application's own code rather than its seed. That argument is sound and its PREMISE is unavailable here.

The target deployment serves the APP from IPFS, through whichever gateway a user happens to reach, while the seed and the snapshot live on a KNOWN host. The two origins therefore never match, by construction and permanently. A rule written in terms of same-origin would refuse the deployment it was meant to bless.

So the anchor is not the origin relationship, it is the NAMED HOST: the build says where a seed may come from, and that statement is what a client trusts. What the build pins is the LOCATION, and optionally the content when the content is stable enough to be pinned.

## What this costs, stated plainly

**A compromise of the named host, or of its DNS or TLS, poisons every client that fetches from it.** Combined with ADR-0065's unchanged residue -- omission cannot be detected, because a seed that simply leaves logs out is structurally perfect -- that poisoning is SILENT, and because a stored stream is re-folded by every later generation, it is inherited by generations that downloaded nothing.

So the rule to hold in mind when choosing a host: **the named snapshot host must be trusted the way the build pipeline is trusted.** That is the whole of the trust story, and it should be uncomfortable enough to be said out loud rather than discovered.

One thing that is NOT made worse, and is worth stating so the risk is judged at the right size: an application served through an unverified HTTP gateway can already be replaced wholesale by that gateway, so for those users the seed adds no exposure that the app did not have. The case where this residue actually bites is the careful one: a client that verified its own build (a CID-verified load, a local node, a packaged app) and then fetches a seed from a host whose bytes nothing verifies.

**The mechanism that would close it is a SIGNATURE**, per artifact, against a public key pinned in the build. That is the shape the problem has: the key is stable while the artifact rolls, which is exactly what a content hash cannot do. It is deliberately not built (no key distribution or rotation exists here), and it is named as the answer for the day an artifact must be trustworthy INDEPENDENT of the host serving it -- a third-party mirror, an untrusted gateway, or a seed republished by someone other than the app's own publisher.

## Why the hash is over the DECOMPRESSED octets

ADR-0065's amendment took the hash over the PUBLISHED bytes and, to make that well-defined, forced the artifact to be served opaque and never with `Content-Encoding: gzip`. Withdrawn, because it is a hosting constraint a publisher frequently cannot honour: GitHub Pages, CloudFront, Cloudflare and IPFS gateways each decide transfer encoding themselves, and some will re-compress an opaque `.gz` of their own accord. A rule the publisher cannot enforce is a rule the client cannot rely on.

Hashing the DECOMPRESSED octets is transport-INVARIANT and needs no such rule: whether the host served the file opaque and the client gunzipped it, or served it with `Content-Encoding: gzip` and `fetch` decompressed transparently, the client ends up holding the same bytes.

The objection ADR-0065 raised against this domain was that a hash over something the client reconstructs makes integrity depend on the reconstruction being byte-identical. It does not apply: the client is not re-serialising anything, it is DECOMPRESSING, and gunzip of a given stream yields exactly one byte sequence. What must not happen is hashing a re-encode: hash the octets obtained after decoding, BEFORE `JSON.parse`, and never the result of stringifying the parsed value.

**And the value is RENDERED `sha256:<64 lowercase hex>`** (2026-09-07, pinned here when the producer landed). ADR-0065's amendment had said bare hex with no prefix; that amendment is withdrawn wholesale, and this ADR left the rendering unstated, which is a gap worth closing rather than leaving to two ends to guess: the byte domain is only half of what a producer and a client must agree on, and a pin is PASTED into a build where it outlives the session that produced it. A bare hex literal cannot say which function produced it, so the day a second hash exists every pinned value is ambiguous. `sha256:` is the prefix an OCI image digest uses, it splits on one character, and it is what `streamSeedContentHash` (`@etherfold/core`, `stream/seed.ts`) emits and what a loader must expect. The SRI form `sha256-<base64>` was the alternative and is rejected: base64 is harder to compare by eye and invites confusion with an `integrity` attribute nothing here implements.

## Consequences

- **ADR-0065's "unpinned third-party seed is refused" rule is withdrawn**, and with it the same-origin condition. NOTHING replaces it as a refusal: the loader fetches what it was pointed at, so there is no admission decision about location to make.
- **The loader takes an ORDERED list of locations and an OPTIONAL expected content hash.** No same-origin assertion, because the concept does not apply to the deployment this serves. Order is the caller's, and failover walks it, so "freshest remote first, build-embedded last" is expressible -- which is what the reference deployment actually does.
- **Nothing else in ADR-0065 moves.** Identity (ADR-0064), the coherence checks, the capture-depth check, refusal-as-data and the pre-write ordering are unchanged, and they remain the only things a client establishes for itself.
- **A publisher may still pin**, and should when it can: a seed shipped for a single release is immutable, so its hash is knowable at build time and is strictly better than trusting the host. The value it pins is rendered `sha256:<64 lowercase hex>` (above), so a producer that prints one and a loader that checks one cannot disagree about the string as well as about the bytes.
