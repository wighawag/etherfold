---
title: '`/status` says nothing when the canonical generation is frozen'
slug: status-says-nothing-about-a-frozen-canonical-generation
observed: 2026-09-25
---

2026-09-25, noticed while building `a-generation-says-whether-it-can-run-here`. The admin listing (`GET /{indexer}/admin/canonical-generation`) now reports a frozen canonical generation and why. The public `/status` still does not. `foldingStatusReport` (`packages/cli/src/folding.ts`) lists only the folds this process HOLDS, and `readStatusReport` (`packages/cli/src/cursorReport.ts`) takes its top-level `value` from the held canonical fold. So when nothing here folds the canonical generation (its stored code could not be built at `open`, a revert across a filter change, a host with no `instantiateGeneration`), `/status` has no `value` and no canonical entry, and it does not say why. `/status` is the query surface and ADR-0047's, so widening it was left out of that task's scope.

Separately, the module JSDoc at the top of `packages/server/src/api/admin.ts` ("The MOVE is one small write") still says that a target this host holds no fold for "is answered anyway ... with no engine at all". Since ADR-0092, a same-stream target is instantiated or the move is refused (`409 generation-cannot-fold`).

2026-09-25, merged in by the conductor from an older note of 2026-09-19 that it supersedes: its headline case (a restarted upgrade showing only the successor on `/status`) is gone on Node, because the incumbent is now instantiated at `open` and held (`an-upgrading-restart-keeps-the-incumbent-folding`, asserted in `packages/cli/test/aRestartedDeploymentGoesOnAppending.test.ts`). What survives from it is the design fork this note inherits: the position of a generation this process does NOT fold is readable with no engine (`GenerationRegistryPort.readStateCursor`), so `/status` could report an entry per REGISTERED generation rather than per held fold. Whether it should is undecided: it changes what ADR-0047's `generations` field means (what a host holds) and costs one cursor read per registered generation on every `/status`.
