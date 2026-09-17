---
'@etherfold/server': patch
'@etherfold/state-store': patch
'etherfold': patch
---

**The CLI, the server and the state stores now describe a generation's fold half as the identity its ARRIVAL derived, and every call site that sources one takes it from there** (ADR-0086).

A processor's identity has always been author-declared: `getVersionHash()` is the `version` field plus the entity and config declarations, and the core discards persisted state when it changes. An author who edited a handler and forgot to bump `version` got state computed by the previous logic, served for ever and silently. ADR-0086's invariant removes the possibility rather than reporting it: an author cannot STATE their processor's identity, so a fold is HANDED one, derived from what the processor IS -- the SHA-256 of a self-contained bundle's octets where a deployment read one off disk -- and never asks where it came from.

This is the last MIGRATE batch of an expand -> migrate -> contract sequence, and it moves CALLERS rather than surfaces. `@etherfold/utils`, `@etherfold/core`, the two processor packages, `@etherfold/browser` and the CLI's own configuration path already carry the inputs; what changes here is that every place in these packages that NAMES a fold reads the value its arrival supplied, and every place that DESCRIBES one says so:

- `@etherfold/state-store`: `StateSnapshot.processor` and `SnapshotProcessorMismatchError` now document the label as WHICH FOLD computed the rows, as the producing deployment's arrival derived it, compared for equality and never parsed. The candidate rule, the envelope and the format number are untouched; only the vocabulary moves, and the mismatch message says "computed by processor \`x\`" rather than "by processor version \`x\`", matching what `@etherfold/processor-entities` already says. `openSnapshotAware`'s example passes the identity the deployment's arrival handed its fold instead of calling `eventProcessor.getVersionHash()`.
- `@etherfold/server`: the `_generations.processor` column, the `ReconfigureReport` docstring, the generation-registry note and the README's "what the advertised `generation` is made of" paragraph all describe the fold half in the new vocabulary. The `unchanged` outcome's two readings are now attributed to the arrival that produces them -- a bundle's identity moves with an edited handler, a declared one does not -- rather than stated as a property of every deployment. `POST /{indexer}/admin/canonical-generation`'s refusal asks for `{"stream": "<digest>", "processor": "<fold identity>"}`.
- `etherfold`: the CLI's promotion-policy suite now ships its processor as a real self-contained BUNDLE on disk, so its successor is one edited handler line rather than a bumped `version` -- which is the change a developer actually makes.

**Nothing is removed and no deployment has to move.** The declared `version`, `getVersionHash()`, `getCodeFingerprint()` and the `PROCESSOR DRIFT` report all still exist and still work; a configuration naming an unbundled module still resolves, registers and folds exactly as it did. `the-declared-version-and-the-drift-report-are-deleted` is the contract step that removes them, once every batch has landed.

The declared path keeps its own witnesses on purpose. `aDeploymentRunsFromABundle.test.ts` asserts that an unbundled module still takes its identity from `getVersionHash()`, and `anEndpointReconfiguresARunningRun.test.ts` stays whole on that route because the `PROCESSOR DRIFT` report and the `unchanged` message that names `version` exist ONLY there -- they are the compensation for an identity an author had to remember, so rewriting them onto a bundle would delete their coverage rather than migrate it.
