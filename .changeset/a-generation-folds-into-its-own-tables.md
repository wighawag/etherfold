---
'@etherfold/state-store-sqlite': minor
---

A store can be given a TABLE-NAME NAMESPACE, so several GENERATIONS fold into ONE database and touch nothing of each other's.

```ts
const successor = new VersionedStateStore(db, entities, {tableNamespace: 'genB'});
await successor.migrate(); // genB_token, _genB_blocks, _genB_cursor, _genB_token_open, ...
await successor.drop(); // and retiring it is exactly those tables
```

A generation is a stream plus a fold over it, an indexer holds several and one is canonical. ADR-0053 makes a generation's state a table-name namespace inside one database (a generation COLUMN and a database-per-generation were both rejected there), which is the substrate under "the canonical generation keeps answering while a successor rebuilds": without it a successor writes into the incumbent's rows.

**`_blocks` and `_cursor` are in the namespace too, not just the entity tables**, and that is the half that would be easy to get wrong. Two generations on one chain would otherwise share one block table, where one generation's `revertTo` deletes rows the other still needs, and one fixed cursor key (`lastSync`, the same string for every fold), where the second fold silently resumes on the first's position.

**The boundary is exact and stops at what this package owns.** `_meta`, `_emissions` and the generation registry belong to `@etherfold/server`, are per NAMED INDEXER and are deliberately SHARED across its generations, because a processor-only change re-folds the SAME stored stream and that is what makes it free. Nothing here namespaces them and nothing here reaches the static schema file.

**Absent namespace is today's names, byte for byte**, so this is additive: every existing database keeps the tables it has.

**Where the namespace goes in a name.** Inside the reserved `_` prefix: an entity's `token` becomes `<ns>_token`, and the store's own `_blocks` becomes `_<ns>_blocks`. Prefixing everything uniformly would have produced `<ns>__blocks`, which stops starting with `_` and so stops being recognisable as a fixed table: the property that makes an entity named after one impossible rather than merely unlikely, on the one database a combined deployment shares between this store and the server.

**A namespace is `[A-Za-z0-9]+` and an underscore in one is REFUSED at construction**, because the underscore is the separator: allowing one would make `a_b` + `c` and `a` + `b_c` the same table, which is two generations silently sharing rows. A rendered generation digest (`generationDigestOf`, `@etherfold/core`) is a valid namespace as it comes, leading digit and all, since every name this package emits is either quoted or begins with `_`. `sqlite` is refused as well, for the reason a `sqlite_` entity name already is.

New: `VersionedStateStoreOptions.tableNamespace` and `VersionedStateStore.drop()` (what a host wires into the generation registry's `dropState`), plus `tableNames`, the `TableNames` type, `dropSchemaStatements`, `assertStorableTableNamespace` and `inTableNamespace`.

Breaking, and deliberately so: every statement builder and every DDL function now takes the `TableNames` its store resolved, as a REQUIRED argument (`FIXED_SCHEMA_DDL`, a constant, is `fixedSchemaDDL(names)`). A default would have made forgetting it compile, and forgetting it does not fail. It quietly reads and writes the unnamespaced table beside the generation it belongs to.

Nothing constructs a namespaced store yet: wiring the namespace to a real generation is the next task.
