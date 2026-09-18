---
title: 'A MODULE handed to a tab is identified by its handler sources, because a dev server has no bytes to hash'
slug: a-module-handed-to-a-tab-is-identified-by-its-handler-sources
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [the-browser-takes-its-identity-from-the-arrival]
covers: [12, 13]
---

## What to build

The one arrival that cannot hash bytes, given an identity of its own.

ADR-0086's invariant is that an author cannot STATE their processor's identity, and that HOW it is derived belongs to the arrival. Every other arrival has bytes: a pushed artifact, a bundle on disk. The browser's HMR arrival does not, because a dev server serves unbundled ESM modules and hands the page a module OBJECT. There is nothing to hash.

So this arrival derives its identity from the HANDLER SOURCES. That derivation is the code fingerprint, in a new role: not a second opinion sitting beside a declared identity, which is what ADR-0086 deletes, but the identity itself where no bytes exist.

The engine is indifferent, which is what makes this legal rather than a special case: `GenerationId.processor` is a string the registry compares for equality and renders, and nothing in the tree parses it. Two arrivals deriving identities two ways is therefore not a fork in the engine.

What it buys is the outcome that would otherwise be lost: a real handler edit moves the derived identity and registers a successor, while a hot update that changed nothing does not, and is honestly reported as `unchanged`. That outcome is an acceptance criterion of `an-hmr-update-reconfigures-the-tab-it-is-running-in`, and without this task it would be unreachable.

## Acceptance criteria

- [ ] A module object handed to the indexer is identified by a derivation over its handler sources, with no declared field and nothing supplied by the app.
- [ ] A handler EDIT produces a different identity, so a save registers a successor.
- [ ] Handing the SAME module twice produces the same identity, so registering it again is a no-op. Assert this AT THE CONTAINER and not through an HMR API: `an-hmr-update-reconfigures-the-tab-it-is-running-in` is blocked on this task and builds the three-outcome surface on top of it, so asserting the outcome here would invert the dependency.
- [ ] The derivation's LIMITS are stated where a reader will meet them, since they are real: it survives reformatting and handler re-ordering, and does not survive minification or a change of transpiler. In a dev server serving unbundled modules none of those apply, which is why this arrival can rest on it and a production one cannot.
- [ ] The same code arriving as a MODULE and as a BUNDLE has different identities, and that is documented as correct rather than papered over: a dev iteration and a deployed build are different generations either way.
- [ ] Nothing here reaches a non-browser runtime: the bytes arrivals keep hashing bytes.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`the-browser-takes-its-identity-from-the-arrival` (same files, serialised to avoid a collision). That batch is done, so this task is startable now.

> **RE-ORDERED 2026-09-18, ahead of `the-declared-version-and-the-drift-report-are-deleted` rather than behind it.** This task previously also listed the contract task in `blockedBy`, for a reason that was entirely PROTECTIVE: it "must not remove the derivation this needs". Running FIRST satisfies that concern strictly better than running second, because the derivation is then certainly present -- and the edge as written deadlocked the family, since the contract task cannot delete `getVersionHash()` while the browser's module arrival has nothing else to name itself with. That is this task. Two things confirm the inversion is safe rather than convenient: this task's own Prompt already contemplates either order ("if it still exists at the point you start"), and what it actually needs is `processorCodeFingerprint`, which is exported from `packages/core/src/utils/fingerprint.ts` today and is NOT the seam method `getCodeFingerprint()` that the contract task removes. The contract task now lists THIS task in its `blockedBy`, which is the dependency the right way round. Measured and recorded in `work/notes/observations/the-adr-0086-contract-task-is-in-a-cycle-with-the-three-leaves-behind-it.md`.

## Prompt

The goal is that a developer editing a handler in a tab gets a new generation, and one who saves without changing anything is told nothing changed.

Read **ADR-0086**, particularly its consequence on per-arrival derivation, which is the decision this implements. Then `packages/core/src/utils/fingerprint.ts` if it still exists at the point you start, or the done record of `the-declared-version-and-the-drift-report-are-deleted` if it does not -- that file measured exactly what the derivation survives, and those measurements are the licence for using it HERE and the reason it was refused as a production identity. Then `an-hmr-update-reconfigures-the-tab-it-is-running-in`, whose `unchanged` criterion this makes reachable, and the browser host that holds the indexer a tab runs.

The decision most likely to be got wrong is scope creep back into the bytes arrivals. This derivation exists ONLY where there are no bytes. If you find yourself making it the general rule, or comparing a module-derived identity with a bundle-derived one and trying to reconcile them, stop: they are different generations and that is the correct answer.

The second: do not let the app supply the identity. It is tempting, having found that a module has no bytes, to take a hash from the caller. That is the author-declared identity ADR-0086 deletes, re-entering through the one door left open, and it would be silent when wrong.

The third: state the limits honestly and near the code. A derivation over `Function.prototype.toString` is sound in a dev server and unsound under a minifier, and the whole reason it is acceptable here is that this arrival only ever happens in the former. A reader who meets it without that context will reasonably wonder why it is trusted.

The seam to test at is the browser package's existing indexer tests, driving the handover directly rather than simulating a bundler: hand it a module, hand it an edited module, hand it the same module again, and assert the three outcomes.

Done means: a save registers, a no-op save says so, and nothing outside the browser arrival changed how it names a processor.

## Decisions

**The derivation is ASKED of `EventProcessor.getCodeFingerprint()`, not computed by calling `processorCodeFingerprint` on the handed object — so the contract task must keep that seam.** The task's re-order note states that what this needs is `processorCodeFingerprint` and "is NOT the seam method `getCodeFingerprint()` that the contract task removes". That premise is false in detail: what a tab holds is a fold built OVER A STORE (`EntityEventProcessor`), and the handlers a developer edits live on the author's object INSIDE it, so `processorCodeFingerprint(thatObject)` hashes the library's own methods — identical for every processor ever built that way, a constant no edit could move, which is exactly the silent lie the derivation exists to remove. `getCodeFingerprint()` is the seam each implementation already answers from the author's object. Alternatives considered: reaching into the wrapper's internals (the browser would have to know about `EntityEventProcessor`'s shape), or a new seam method (a second name for a value that already exists — refused by the coherence check, since `getCodeFingerprint` already MEANS "a derivation over this processor's handler sources"; only its ROLE changes). **Touches:** `the-declared-version-and-the-drift-report-are-deleted`, which may delete the DRIFT REPORT but must leave `EventProcessor.getCodeFingerprint()` answering, or the one arrival with no bytes has no name at all. I said so in the JSDoc on both the seam and `processorCodeFingerprint`, and in the changeset.

**The derivation runs wherever the browser builds a fold with no supplied identity, not only at `updateProcessor`.** Criterion 1 reads literally as the direct handover, but naming only that one would leave the incumbent (named at `init` by the declared hash) and the newcomer (named by the derivation) incomparable, so the FIRST save after every page load would look like a change and discard a warm fold even when nothing was edited — the precise outcome this task exists to make honest. It is also the only way a dev app can name itself once the declared fallback is deleted. Alternative: `updateProcessor` alone, leaving `init` declared — rejected as making "a no-op save says so" false exactly once per page load, and leaving the contract task with a browser that cannot name anything. **Touches:** `an-hmr-update-reconfigures-the-tab-it-is-running-in` (whichever call its API uses is now named the same way) and the contract task's sweep of browser fixtures.

**A module whose handlers have no readable source keeps the declared fallback rather than being REFUSED.** `processorCodeFingerprint` answers `undefined` for a processor that is all bound or proxied functions, and "cannot tell" is a real answer. Inventing a refusal here would be a new user-visible error on a path nobody has reported, and it would be the contract task's problem to answer for anyway once the fallback goes. Alternatives: hash a constant (the silent lie), or throw (a new refusal). **Touches:** `the-declared-version-and-the-drift-report-are-deleted`, which has to decide what a non-derivable module arrival does once `getVersionHash()` is gone.

**A generation spec built by the browser must reach the container WHOLE, and two call sites were changed to stop spreading it.** The identity of a module arrival is only knowable after the processor object exists, and `Indexer.add` resolves `spec.processorIdentity` immediately after `createProcessor` returns — so the spec fills its own field in there. A spread (`{source, ...specFor(...)}`) would copy the field while still `undefined` and silently fall back to the declared hash, so `source` is now a parameter of the builder in both `IndexerState.ts` and `host/serve.ts`, with the reason stated at all four places. Alternatives: a getter (same hazard under spread, and more magical), or teaching `@etherfold/core` to accept a function-valued identity (a second way to say a thing the ADR deliberately keeps as an opaque string, and it would reach the bytes arrivals). The host-path half is pinned by a test that fails without it. **Touches:** any future caller that builds a browser generation spec.

**The identity covers handler SOURCE TEXT and nothing else, and the gap is documented rather than closed.** Entity declarations, imported helpers, and behaviour decided by a value the handler captured are all invisible to it, so a schema edit in a dev tab does not move the identity; `{force: true}` is the stated escape hatch. Closing it would need a new seam exposing the declarations, and folding the author's `version` back in is the thing ADR-0086 deletes. Stated in `moduleIdentity.ts`, the README, the guide, the example and the test that drives it (`processorVariant` versus `editedProcessorVariant` are that pair on purpose). **Touches:** nothing today; a later task that wants declarations in the name would add the seam, not reuse `version`.

**`@etherfold/core` and `examples/browser-reference` are edited, documentation only.** No behaviour outside the browser arrival changed: the bytes arrivals still hash bytes and core still only compares what it is handed. But `types.ts` said the fingerprint is "advisory ... never discards state because of it", `fingerprint.ts` said folding it into an identity is "unusable in practice", `CONTEXT.md` said it "deliberately stays out of the identity", and the reference app told authors their edit would never run — four statements this task makes false in one place each, and a muddled term is cheaper to fix now than after the next artifact inherits it. **Touches:** the contract task, which rewrites the server half of that `CONTEXT.md` entry; I added a scoped clause rather than rewriting the entry, so the two changes do not collide.
