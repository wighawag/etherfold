---
title: '`VersionedStateEventProcessor` cannot be given a `tableNamespace`, so the SQLite convenience class cannot hold two generations in one database'
slug: the-sqlite-processor-convenience-cannot-take-a-table-namespace
observed: 2026-09-06
source: 'noticed while wiring task:two-named-indexers-never-touch-each-others-data`s guard test, trying to give each generation its own tables inside one named indexer`s database'
---

`VersionedStateProcessorOptions` (`packages/processor-sqlite/src/VersionedStateEventProcessor.ts`) is `Pick<VersionedStateStoreOptions, 'retention' | 'finalityDepth'>`, so the `tableNamespace` ADR-0053 makes a generation's state live in cannot be passed through the convenience class that builds the store for you: two generations built that way over one handle land on the same tables. The entity-path assembly (`VersionedStateStore` + `EntityEventProcessor`, which is what `packages/cli/src/folding.ts` and `packages/cli/test/aChangedContextCreatesASuccessor.test.ts` use) takes it and is unaffected, so nothing shipped is wrong; the narrow `Pick` predates the namespace and may simply not have been revisited.
