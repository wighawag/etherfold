---
title: 'A deployment RUNS from a bundle, and the generation it registers is identified by that bundle's hash'
slug: a-deployment-runs-from-a-bundle-identified-by-its-hash
spec: a-processor-is-a-bundle-and-its-hash-is-its-identity
blockedBy: [a-processor-artifact-is-bytes-a-hash-and-a-loader]
covers: [1, 11]
---

## What to build

The tracer bullet: one thin path from a configured bundle all the way to a folded block, with the identity coming from the artifact rather than from a field.

A configuration that names a BUNDLE is read, hashed, instantiated and registered as a generation whose `processor` identity IS that hash, and that generation folds. End to end, through every layer the ordinary path already goes through.

This is still the EXPAND step. The declared `version` path goes on working UNCHANGED beside it: a configuration naming an unbundled module still resolves, still registers, still folds, still takes its identity from `getVersionHash()`. Both shapes are accepted, which is what keeps the gate green while four migrate batches follow.

The engine is INDIFFERENT to where an identity came from, and this task is where that becomes true in code rather than in an ADR. `GenerationId.processor` is a string the registry compares for equality and renders into messages; nothing parses it. So supplying it from an artifact is not a new concept in the engine, it is the same concept sourced differently.

## Acceptance criteria

- [ ] A deployment configured with a BUNDLE runs: the bundle is read, hashed, instantiated and registered, and the generation folds blocks end to end.
- [ ] The registered generation's `processor` identity is the bundle's `sha256:<hex>` and nothing else.
- [ ] Two deployments given byte-identical bundles register the SAME generation, and a deployment given a bundle with one changed handler registers a DIFFERENT one, with no author action in either case. This is the property the whole family exists for and it is asserted here first.
- [ ] The DECLARED path is untouched: a configuration naming an unbundled module resolves, registers and folds exactly as it does today, taking its identity from `getVersionHash()`. Asserted, since the four migrate batches depend on it.
- [ ] A bundle that fails to instantiate leaves the deployment exactly as it was, with nothing partially registered, matching how a failed re-read already behaves.
- [ ] Tests cover the new behaviour, mirroring the repo's existing test style.
- [ ] A changeset accompanies the change (`pnpm changeset`).

## Blocked by

`a-processor-artifact-is-bytes-a-hash-and-a-loader`. It supplies the hash, the validation and the loader this path calls.

## Prompt

The goal is one complete path from a bundle on disk to a folded block, so every later batch is moving callers onto a road that already exists rather than building it.

Read **ADR-0086**, then the task above's artifact unit, then the CLI's configuration resolution and the fold-construction path that turns a resolved configuration into a registered generation. ADR-0053 is why a generation's state is a table namespace keyed on its identity, which is what makes an identity sourced differently still land correctly.

The decision most likely to be got wrong is treating this as a migration. It is not: BOTH shapes must work when this lands. If you find yourself deleting the declared path, or making it a special case of the artifact path, stop -- the contract task deletes it, four batches later, and doing it here breaks every caller at once with no green step in between.

The second: a PATH is still how a deployment names its processor, and that does not change. What changes is what the path points AT. Reading a file and hashing it is not bundling, so nothing here acquires a bundler.

The third: do not let the identity leak into anything that INTERPRETS it. The engine compares it and renders it; that is verified (nothing in the tree parses `GenerationId.processor`) and it is what makes two derivations able to coexist during the migration. A helper that sniffs whether an identity "looks like a hash" would quietly undo that.

The seam to test at is a deployment stood up the way the CLI tests already stand one up, given a bundle rather than a module path, driven until a block is folded and the registry can be read.

Done means: a bundle runs, its hash names the generation, an edited handler names a different one, and the old path still works exactly as before.
