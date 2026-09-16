---
title: 'A processor ARTIFACT is bytes, a hash and a loader, and a bundle that is not self-contained is refused'
slug: a-processor-artifact-is-bytes-a-hash-and-a-loader
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: []
covers: [5, 11]
---

## What to build

The unit every later task rests on: a processor that is a thing rather than a path.

A **processor artifact** is a self-contained ESM bundle plus the identity derived from it. Three capabilities, and nothing that consumes them yet: HASH some bytes into an identity, VALIDATE that those bytes are genuinely self-contained, and INSTANTIATE a processor from them without touching the filesystem.

This is the EXPAND step of a wide refactor (`work/protocol/TASKING-PROTOCOL.md` 3a). Nothing is removed, no existing caller changes, and `getVersionHash()` goes on working exactly as it does today. The gate stays green because this is pure addition.

**WHICH RUNTIME instantiates, and which deliberately does not.** This loader serves the runtimes that receive BYTES: a CLI or server reading a bundle from disk, and later a pushed artifact. Those instantiate by importing a `data:` URL, which needs no filesystem and no temporary file. The BROWSER does not need this and is not in scope here: a browser app hands the indexer a processor OBJECT that its own bundler already loaded (`IndexerState` takes `processor: EventProcessor<...>`, never bytes), so nothing in a tab evaluates bytes on this spec's paths. Whether a tab CAN evaluate bytes under a realistic Content-Security-Policy is a real question, and it belongs to `a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp`, which gates the RETENTION work rather than this one.

The identity is SHA-256 over the bundle's octets, rendered `sha256:<hex>`, reusing the convention the stream-seed path already established so a literal pasted into a build says which function produced it.

"Self-contained" is checkable rather than aspirational: a bundle that still imports a BARE SPECIFIER is not one, and it would otherwise fail much later, at the first event it folds or at an instantiation in another process. Refuse it, naming the unresolved import.

## Acceptance criteria

- [ ] Bytes hash to a stable identity rendered `sha256:<hex>`, and identical bytes always give an identical identity.
- [ ] A processor is INSTANTIATED from bytes with no filesystem access, and the resulting object satisfies the processor seam.
- [ ] A bundle that is not self-contained is REFUSED, naming the unresolved bare specifier, rather than being instantiated and failing later.
- [ ] The refusal is DATA about the artifact, in the manner the seed-install path already refuses, and not a bare throw a caller cannot branch on.
- [ ] A small REAL bundle fixture is built once and committed, and the instantiate round trip is asserted against it rather than against a hand-written string. Build it with the documented command (`esbuild`, `--bundle --format=esm --minify`), because a fixture built another way would not exercise what deployments actually produce.
- [ ] NOTHING existing changes behaviour: `getVersionHash()`, the declared `version` and the code fingerprint are all untouched by this task, and no caller is migrated. This is the expand step and its whole job is to add.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

- None. It can start immediately.

## Prompt

The goal is that a processor can be represented as BYTES that carry their own identity, so that a later task can retain one, push one, or name a generation by one.

Read **ADR-0086** first and in full: it is the decision this family implements, and its central invariant is that an author cannot STATE their processor's identity. Then **ADR-0085**, which decided the content-addressed artifact shape and says what being bytes buys. Then the stream-seed install path in `@etherfold/core`, which is the closest prior art in this repo for "receive an opaque artifact, verify everything checkable BEFORE the first write, and refuse as DATA rather than as a throw" -- borrow its vocabulary and its ordering rather than inventing a second shape.

The decision most likely to be got wrong is scope. This task adds a unit and wires it to NOTHING. It is tempting, having built a loader, to make the CLI use it; do not, because the migration is sequenced deliberately (expand, then four migrate batches, then a contract) and a caller migrated early breaks a batch that has not been written yet.

The second: the self-contained check must be a real check against the bundle, not a promise in a docstring. A bundle that survived bundling with an unresolved `import 'viem'` in it is exactly the artifact that looks fine until it folds its first event in a process that has no `viem`.

The third: do NOT build a browser instantiation path here on the assumption that it will be wanted. A tab is handed a processor object by its own bundler and never bytes, so there is nothing in this spec for it to load, and whether a tab could do so under a Content-Security-Policy is being spiked separately. Building it now would be speculative, and it would be the half most likely to be wrong.

The seam to test at is the artifact unit itself plus the committed fixture: hash it, validate it, instantiate it, and assert the instantiated object behaves like the processor it was built from.

Done means: bytes have an identity, a bundle can become a running processor, a bundle that is not self-contained is refused with its reason, and not one existing caller has changed.
