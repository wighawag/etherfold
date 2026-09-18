---
'@etherfold/core': minor
'@etherfold/processor-entities': minor
'@etherfold/processor-sqlite': minor
'@etherfold/browser': minor
'@etherfold/server': minor
'etherfold': minor
'@etherfold/utils': patch
'@etherfold/fetcher-host': patch
'@etherfold/state-store-indexeddb': patch
'@etherfold/platform-nodejs-fetcher': patch
---

**A processor no longer DECLARES what it is. The `version` field, `getVersionHash()`, `assertProcessorVersion` and the `PROCESSOR DRIFT` report are DELETED** (ADR-0086).

An identity is now derived from what a processor IS and is handed to the engine by the ARRIVAL that produced it: the SHA-256 of a bundle's octets wherever a deployment has bytes, and a digest of the handler SOURCES for the one arrival that has none — a module a dev server hands a browser tab. An author cannot state it, so an author cannot forget to bump it, and state computed by logic that has since been replaced can no longer be served as if it were current. This is the CONTRACT step of a six-batch refactor; every caller moved first, so nothing here is a change of behaviour that was not already available.

**This RETIRES a feature that shipped days ago, and that is its correct end rather than a reversal.** `a-reload-that-changed-nothing-reports-processor-drift` landed the `PROCESSOR DRIFT` report on 2026-09-16. It was the right fix for an author-DECLARED identity: the identity could LIE — a handler edited under a static `version` named the generation already held — so the core said so, loudly, in one phrase an operator could grep for. ADR-0086 deletes the lie instead of reporting it. There is no declared identity left for the code to disagree with, so drift stops being unreported and becomes UNREPRESENTABLE, and the machinery that compensated for it goes with the thing it was compensating for. The unconsumed changeset that announced it has been deleted too: nothing has been released, so amending it would ship a release note for a report that never existed outside this repository, and the history belongs in the work record and the ADR rather than in notes to users.

What is deleted, by package:

- **`@etherfold/core`**: `EventProcessor.getVersionHash()`, `assertProcessorVersion`, `ContextIdentifier.processorFingerprint`, `ProcessorDriftReport`, `ProcessorDriftComparison`, `processorDriftReport`, `ProvidedIndexerConfig.strictProcessorDrift`, `Indexer.onProcessorDrift` and `ReceivingIndexer.onProcessorDrift`. `processorIdentity` is now REQUIRED on `IndexerGenerationOptions`, `StreamBuilderOptions` and `GenerationRebuildOptions`, and `updateProcessor` takes one; a `GenerationSpec` that supplies none is REFUSED (a fold with no name cannot be registered), which is typed as optional only because the read order is state → processor → identity, the order that makes a module arrival expressible.
- **`@etherfold/processor-entities` / `@etherfold/processor-sqlite`**: `EntityProcessor.version` and `entityProcessorVersionHash` are gone, and so is the `identity` option each took — it existed only to answer `getVersionHash()`, and a fold that computes no identity of its own has nothing for a caller to override. A host names its generation, its table namespace (ADR-0053) and its engine from ONE value it was handed.
- **`@etherfold/server`**: `ReconfigureReport`'s `unchanged` arm no longer carries `drift`, and the admin route no longer returns it. The three outcomes are still three.
- **`etherfold`**: the reconfigure endpoint's `unchanged` has ONE reading — these are the same bytes, so either the edit is not in them yet or the build has not run — instead of two plus a report to tell them apart.

**`EventProcessor.getCodeFingerprint()` and `processorCodeFingerprint` SURVIVE, in a different role, and this deviates from ADR-0086's own consequence list.** That list says the fingerprint goes with everything else; it is wrong in two places, and both were settled after it was written. A browser tab is handed an already-built processor with no bytes to hash, so `@etherfold/browser` names that fold by `processor.getCodeFingerprint()` (`moduleProcessorIdentity`) — the SEAM method rather than the standalone function, because the seam is what delegates through a wrapper (`VersionedStateEventProcessor` over `EntityEventProcessor`) to the author's own handlers, while the standalone function applied to a wrapper would fingerprint the wrapper's methods and produce a constant no edit could move. So the derivation stays, as the IDENTITY of the one arrival with no bytes, and what dies is its old role: a second opinion sitting beside a declared identity.

**A module that cannot be named that way is now REFUSED.** A processor whose handlers are all `bind`-ed or behind a proxy has no readable source, `getCodeFingerprint()` answers `undefined`, and the declared hash it used to fall back on is gone. The alternatives were all lies — a constant no edit can move, a name taken from the application (the author-declared identity through the one door left open), or a generation called `undefined` — so `@etherfold/browser` throws, before anything is registered, naming the two ways out.

**A `--processor` path that names an UNBUNDLED entry point is refused too, for the same reason**: no bytes describe it and nothing is left to name its fold. That refusal lands where the arrival is resolved, before a database is opened; `a-path-naming-an-unbundled-entry-point-is-refused` is what moves it to configuration resolution and gives it the build command an author needs.

Determinism moves from a cost concern to a correctness-of-reuse concern: a non-deterministic bundler now gives every deploy a new identity and re-folds for ever, so pinning the bundler version in the lockfile stops being advice.
