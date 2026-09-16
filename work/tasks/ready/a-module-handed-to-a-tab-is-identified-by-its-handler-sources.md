---
title: 'A MODULE handed to a tab is identified by its handler sources, because a dev server has no bytes to hash'
slug: a-module-handed-to-a-tab-is-identified-by-its-handler-sources
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [the-browser-takes-its-identity-from-the-arrival, the-declared-version-and-the-drift-report-are-deleted]
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
- [ ] A hot update that changed nothing produces the SAME identity and is reported as `unchanged`, distinguishable from having registered and from having failed.
- [ ] The derivation's LIMITS are stated where a reader will meet them, since they are real: it survives reformatting and handler re-ordering, and does not survive minification or a change of transpiler. In a dev server serving unbundled modules none of those apply, which is why this arrival can rest on it and a production one cannot.
- [ ] The same code arriving as a MODULE and as a BUNDLE has different identities, and that is documented as correct rather than papered over: a dev iteration and a deployed build are different generations either way.
- [ ] Nothing here reaches a non-browser runtime: the bytes arrivals keep hashing bytes.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`the-browser-takes-its-identity-from-the-arrival` (same files, serialised to avoid a collision) and `the-declared-version-and-the-drift-report-are-deleted` (which removes the fingerprint's OLD role, and must not remove the derivation this needs).

## Prompt

The goal is that a developer editing a handler in a tab gets a new generation, and one who saves without changing anything is told nothing changed.

Read **ADR-0086**, particularly its consequence on per-arrival derivation, which is the decision this implements. Then `packages/core/src/utils/fingerprint.ts` if it still exists at the point you start, or the done record of `the-declared-version-and-the-drift-report-are-deleted` if it does not -- that file measured exactly what the derivation survives, and those measurements are the licence for using it HERE and the reason it was refused as a production identity. Then `an-hmr-update-reconfigures-the-tab-it-is-running-in`, whose `unchanged` criterion this makes reachable, and the browser host that holds the indexer a tab runs.

The decision most likely to be got wrong is scope creep back into the bytes arrivals. This derivation exists ONLY where there are no bytes. If you find yourself making it the general rule, or comparing a module-derived identity with a bundle-derived one and trying to reconcile them, stop: they are different generations and that is the correct answer.

The second: do not let the app supply the identity. It is tempting, having found that a module has no bytes, to take a hash from the caller. That is the author-declared identity ADR-0086 deletes, re-entering through the one door left open, and it would be silent when wrong.

The third: state the limits honestly and near the code. A derivation over `Function.prototype.toString` is sound in a dev server and unsound under a minifier, and the whole reason it is acceptable here is that this arrival only ever happens in the former. A reader who meets it without that context will reasonably wonder why it is trusted.

The seam to test at is the browser package's existing indexer tests, driving the handover directly rather than simulating a bundler: hand it a module, hand it an edited module, hand it the same module again, and assert the three outcomes.

Done means: a save registers, a no-op save says so, and nothing outside the browser arrival changed how it names a processor.
