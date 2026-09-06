# `ReceivingIndexer.canonicalGeneration()` answers its opening fold where the registry names none, so a container-backed host cannot reach the new refusal

2026-09-06, noticed while building `a-rebuild-in-progress-is-never-an-empty-answer` (out of its scope: changing the fallback would change what a container-backed host ANSWERS, which the task's fence puts on the read path and not in `@etherfold/core`).

`IndexerRegistryEntry.canonicalGeneration()` may now answer `undefined`, and both feed views refuse a read on that answer (`503 no-canonical-generation`, ADR-0058) instead of serving an empty page. `ReceivingIndexer.canonicalGeneration()` (`packages/core/src/receivingContainer.ts`) cannot produce it: where `registry.canonical()` answers nothing it falls back to `this.generation`, the opening fold. Its JSDoc says why — any registry a generation has been created in has a pointer, so the fallback is "for a substrate that answered nothing rather than a case a host has to handle" — and that reasoning predates the answer being expressible at all.

The reachable case is narrow but real: `openGenerationRegistry.canonical()` resolves the pointer against the RECORDS and answers `undefined` when the pointer names a generation whose record has gone (another process deleting it, a substrate half-written). A container-backed host then serves reads from its opening fold — which may not be the generation the pointer named — where a read tier over the same rows would refuse.

Two shapes a fix could take, neither decided here: pass the registry's answer through (and let the read refuse), or keep the fallback and say so louder in the log. The first is more honest and is a behaviour change for every host built on the container, which is why it is a note rather than an edit.
