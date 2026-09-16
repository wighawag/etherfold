---
status: accepted, not yet implemented
---

# A processor's identity IS the hash of its bundle, and the declared `version` is DELETED

A processor's identity has always been author-declared: `getVersionHash()` is the `version` field plus the entity and config declarations, and the core discards persisted state when it changes. An author who edits a handler and forgets to bump `version` gets state computed by the previous logic, served for ever. ADR-0008 made that condition LOUD (a code fingerprint beside the hash, reported on load) rather than impossible, and was explicit that the residual remained. We propose that a processor is REQUIRED to be a self-contained bundle, that the hash of those bytes IS its identity, and that the declared `version` field, the fingerprint and everything built to reconcile the two are deleted.

## Why the declared version could not be made honest

ADR-0008 is honest about what it bought: "the residual risk is not eliminated, it is made loud", and "a missed bump still means the rebuild does not trigger, because the rebuild keys off the version hash and the fingerprint is deliberately not part of it". Everything since has been a better and better report of a condition nobody could prevent.

`utils/fingerprint.ts` records why the obvious fix was refused, and the sentence is the one to answer: folding the fingerprint into the identity "would be **safer in principle** and unusable in practice: a bundler or minifier that re-emits the same behaviour differently would invalidate every deployment's state and force a full replay with no logic change".

That was correct when written. Two things have changed it.

**The cost of a spurious identity fell.** A PROCESSOR change is a new generation over the SAME stream and re-fetches nothing: the "full replay" is a re-fold of stored data, not a re-index from the chain. Since ADR-0084 it is also a generation that lands in the `successor` slot BESIDE the incumbent, which goes on answering throughout, and that is reclaimed when nothing names it. The machinery that makes a false identity change survivable now exists; in 2026-08 it did not.

**The bundle exists anyway.** `a-generation-retains-the-code-that-folds-it` requires a self-contained bundle per generation so that a `predecessor` can be RESUMED rather than merely read. Once every processor is a bundle, its hash is available, stable and already being stored. The identity stops being a thing an author must remember and becomes a thing the artifact already is.

## The asymmetry that decides it

The two failure modes are not comparable in kind.

A DECLARED identity **under-triggers**: the author forgets, the identity does not move, and state computed by different logic is served as if it were current. That is a correctness failure, it is silent, and it is unbounded in time.

A HASH identity **over-triggers**: a toolchain change re-emits identical behaviour under new bytes, and a generation is re-folded for nothing. That is a cost failure, it is visible, and it is bounded by one re-fold.

Trading a silent correctness failure for a visible cost failure is the right direction, and it is the trade ADR-0008 could not make because the cost side was a re-index rather than a re-fold.

## The two runtimes have opposite properties, and they line up favourably

This is what settles the objection `fingerprint.ts` raises, and it was not available to it.

**A browser app, snapshot-only, is the runtime that CANNOT absorb a spurious change.** A snapshot-seeded generation is a leaf with no stream keeper at all, so there is nothing to re-fold and a new identity means going back to the chain, which a public node frequently refuses. But its processor is BUNDLED INTO THE APP: those bytes change only when a user loads a new build. And a new build already obliges its publisher to ship a matching snapshot, because a snapshot from another processor version is not a candidate at all. So in the runtime where a spurious identity change would be unrecoverable, identity changes only on a deliberate deploy that already carries what the new identity needs.

**A server or CLI is the runtime where a spurious change CAN happen**, from a refreshed lockfile or a bundler upgrade with no logic change at all. But it holds the stream, so the change costs a re-fold of stored data beside a fold that keeps answering.

The runtime that cannot absorb a spurious identity change cannot have one; the runtime that can have one can absorb it.

## Considered options

**Keep `version` as an explicit COMPATIBILITY ASSERTION** ("the bytes changed, the logic did not, keep my state"), with the hash as the identity. Attractive because it gives a server operator an answer when a lockfile refresh triggers a re-fold they did not want, and because it moves the failure from omission to commission. Rejected: it is the author-declared identity again under a nicer name. It is still declared, still can be wrong, and still silent when it is wrong, which is the precise failure this ADR exists to delete. Preserving an escape hatch whose only use is to assert an equivalence nobody verified reintroduces the hazard at the one moment someone is motivated to reach for it.

**Keep the status quo: declared identity, advisory fingerprint, drift reported.** Rejected on ADR-0008's own account of itself. A loud wrong answer is better than a silent one and worse than a right one, and the right one is now affordable.

**Make the FINGERPRINT the identity** rather than the bundle hash. Rejected: the fingerprint is derived from handler sources via `Function.prototype.toString`, which is neither the whole fold (the entity and config declarations, and every imported helper, are outside it) nor the thing that gets retained. The bundle is both.

**Have the CLI bundle on start**, so authors keep pointing at a module path. Rejected: it puts a bundler in the CLI's dependency tree and a build step on every start, and it makes the identity a function of whatever the CLI happened to bundle with rather than of an artifact the author produced and can reproduce. The CLI stays dumb; the author bundles.

## Consequences

**A large deletion, including something shipped the same week.** `version`, `assertProcessorVersion`, `getCodeFingerprint()`, `utils/fingerprint.ts` and the `PROCESSOR DRIFT` report all go. Drift becomes UNREPRESENTABLE rather than merely unreported: there is no declared identity left to disagree with the code. Note plainly that `a-reload-that-changed-nothing-reports-processor-drift` landed that report on 2026-09-16 and this retires it. That is the correct end of its life rather than a reversal: it was the right fix for an author-declared identity, and it dies with the thing it was compensating for.

**Bundling becomes mandatory for IDENTITY, not merely for retention.** A processor that is not a bundle has no name at all, so delivery (ADR-0085), retention (`a-generation-retains-the-code-that-folds-it`) and identity collapse into one artifact. This is the intended simplification, but it means the bundle requirement is absolute rather than a convenience, and a deployment that cannot produce one cannot register a generation.

**Determinism moves from a cost concern to a correctness-of-reuse concern.** Under the old design a non-deterministic bundler produced a noisy advisory; under this one it produces a new identity on every build, so persisted state is never reused and every deploy re-folds for ever. Pinning the bundler version in the lockfile stops being advice and becomes a requirement, and it belongs in the documentation beside the bundling instructions.

**ADR-0085 generalises rather than being superseded.** Its "the artifact's hash IS its version" stops being a property of the PUSHED arrival and becomes the rule for every arrival, which removes the last place two processors could have been identified two different ways depending on how they got there.

**ADR-0008 is superseded in part**, on the axis of what identifies a processor and on the fingerprint that sat beside it. Its other decisions are untouched, and its central claim (retention is what makes upgrades possible) is strengthened: retention now covers the code as well as the state.

**A dev browser setup needs a stream keeper.** With hash identity every save is a new identity, so a snapshot-only dev app has nothing for its second generation to catch up from. It fails loudly rather than silently (`refuseFollowerWithNoStream` already names the missing port), so this is a documentation item, but it is a real change to what a dev setup must configure.

**The entity and config declarations stop being named separately in the identity.** They are code, so they are in the bundle, and hashing the bundle covers them. Nothing is lost and one composite hash becomes one hash.
