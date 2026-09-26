---
title: "A configured deployment drops ANY generation's namespace through the entities of the processor it was configured with"
slug: a-generation-s-state-is-dropped-through-another-processor-s-entities
observed: 2026-09-26
---

2026-09-26: Noticed while building `a-run-node-with-nothing-configured-waits-for-its-first-upload`. `openFolding` (`packages/cli/src/folding.ts`) wires the registry's `dropState` to `stateFor(id).drop()`, and `stateFor` builds its `VersionedStateStore` over `declared.entities`, the CONFIGURED processor's. `drop` removes only the entity tables it was declared with (`dropSchemaStatements`), so dropping a generation whose processor declared different entities (an upload or a re-read that added an entity, then a successor replaced or a reclaim) would appear to leave that generation's extra entity tables behind in the database. The row is deleted before `dropState` runs (`registry.ts`), so the stored bundle cannot be read back at drop time to learn the right entities. Not verified with a test. The waiting mode added by that task narrows the gap for its own deployments by dropping through every entity a processor that arrived in the process declared, but the configured path is unchanged.
