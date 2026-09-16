---
'@etherfold/core': minor
'@etherfold/server': minor
'etherfold': minor
---

A reload that changed nothing now says whether the CODE changed, so a static `version` stops being silent.

A generation is identified by `getVersionHash()` — the DECLARED `version` plus the entity and config declarations — and never by the text of the handlers, so a developer who edits a handler body, saves, and calls `POST /{indexer}/admin/reconfigure` was told `unchanged`. That answer is correct and useless: it reads exactly like a save that genuinely changed nothing, and the edit is being ignored because the `version` is static rather than because anything is broken. The system already computes the second opinion (`getCodeFingerprint()`, `utils/fingerprint.ts`) and the receiving side already WROTE it into every cursor it opened — and compared none of them.

**The receiving container now reports `PROCESSOR DRIFT` in its own right.** `StreamBuilder` and `GenerationRebuild` compare the fingerprint on the cursor they ADOPT with the code loaded now, exactly as the chain-facing `IndexerGeneration` has since ADR-0008's 2026-08-21 amendment, so a `run`, `index` or server deployment that never calls the endpoint still learns from its logs. It is reported ONCE per engine rather than per batch (a receiver re-reads its cursor on every call), at `error`, and through the new `ReceivingIndexer.onProcessorDrift` — the same field name the chain-facing container publishes.

**`ReconfigureReport`'s `unchanged` arm carries a `drift?: ProcessorDriftReport`**, and the admin route returns it verbatim beside the message. The three outcomes stay three: drift is a fact about the answer, not a different thing to have done.

**The two comparisons are different questions and are named as such.** `ProcessorDriftReport` gains `compared: 'persisted-state' | 'reloaded-module'`. `persisted-state` is the BOOT question — the stored cursor's fingerprint against the code loaded now, "the state I am about to serve was computed by different logic" — and is what both containers ask. `reloaded-module` is the RELOAD question — the RUNNING fold's fingerprint against the module just re-imported, "the code I have just read differs from the code I am running" — and is what the reconfigure endpoint answers, because that is what a developer who pressed save is asking. They can disagree, so neither stands in for the other. `storedFingerprint` is accordingly renamed `previousFingerprint`: on the reload question nothing about it is stored, and a field meaning the cursor in one report and a loaded module in another would be a name meaning two things.

**The fingerprint stays ADVISORY, and that is the point rather than a caveat.** No generation is registered because of drift, no state is discarded, no identity contains it, and the stored fingerprint is never refreshed by a report — it describes the code that PRODUCED the state, so the report repeats until the author bumps `version` instead of going quiet once seen. Either side being absent (a cursor written before the field existed, a processor whose handlers are all bound or proxied and cannot be read) reports NOTHING and is never read as drift. Registering on drift would fold the fingerprint into the identity through the back door and force a full replay on a re-minification that changed no logic, which is precisely what `utils/fingerprint.ts` rejects.

New in `@etherfold/core`: `processorDriftReport`, exported because the `reloaded-module` comparison can only be made where a module is re-imported, which is the CLI — and a second `PROCESSOR DRIFT` phrasing assembled there would be a second thing for an operator to grep.
