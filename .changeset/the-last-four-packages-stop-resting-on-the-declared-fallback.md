---
'@etherfold/processor-sqlite': patch
'@etherfold/browser': patch
'@etherfold/platform-nodejs-fetcher': patch
---

**The last four packages stop resting on the DECLARED identity fallback, and every witness left behind is labelled for the contract step** (ADR-0086).

The sixth and last migrate batch. Every place that SOURCES an identity moved in the first five; what none of them could see is every place that silently RESTS on the fallback -- a deployment that supplies no identity falls through `processorIdentityOf` to `processor.getVersionHash()`, so the fold is named by the author's declared `version` without ever mentioning it. A grep finds nothing there, so each batch honestly reported itself clean, and only running the code says otherwise. Every one of those sites is correct today and becomes a fold with NO NAME AT ALL the moment `the-declared-version-and-the-drift-report-are-deleted` removes the declared half.

This is TEST-ONLY: no published surface changes, nothing is deleted and nothing is refused. `version`, `getVersionHash()`, `getCodeFingerprint()` and the `PROCESSOR DRIFT` report all still exist and still work, and no configuration that resolves today stops resolving.

- **`@etherfold/processor-sqlite`**: the two-deployment-shapes suite hands its `IndexerGeneration`s the same identity its fold was built with, so the engine is TOLD which fold it drives instead of asking the processor to state one. Its remaining declared-path cases are WITNESSES and are untouched.
- **`@etherfold/browser`**: the snapshot-only mode and the stream-seeding refusal label their published snapshot with an arrival-derived identity rather than with `entityProcessorVersionHash(definition)`; the live-reload suites name their fake fold by the handler sources a MODULE arrival is named by (`moduleProcessorIdentity`, which is `getCodeFingerprint()`), which is also what a real dev-server module reports. One harness bug the probe exposed is fixed with them: the recording wrapper around `updateProcessor` dropped its options, so the identity the hook derived never reached the core.
- **`@etherfold/platform-nodejs-fetcher`**: the real-socket receiver hands its identity to BOTH halves -- the fold and the `StreamBuilder` the core asks -- so there is one answer to "which fold is this" and never two.
- **`@etherfold/conformance-workload-stratagems`** (private, so not named above): the publication, retraction and receiving-container suites supply a `processorIdentity` on their generation spec. None of them is about identity.

**Five WITNESSES survive, all of them labelled in place with ADR-0086, what they prove and the task that retires them**, because migrating a witness does not move coverage, it deletes it while leaving the code standing. In `@etherfold/processor-sqlite`: the whole of `version.test.ts` (11 cases) and the two `describe`s in `lifecycle.test.ts` that consult the declared hash (5 cases). In `@etherfold/browser`: `aModuleIsIdentifiedByItsHandlerSources.test.ts`'s declared-hash contrast, and a new case pinning the one place the fallback is still reachable from PRODUCTION code in that package -- `moduleProcessorIdentity` answers `undefined` for a module whose handlers have no readable source, which is a decision `the-declared-version-and-the-drift-report-are-deleted` has to make rather than discover.

Demonstrated rather than asserted, because a grep cannot see a fallback: with both halves of the declared fallback made to throw locally, these four packages fail ONLY those labelled witnesses, and the tree is green without the probe.
