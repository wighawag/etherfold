# A generation's state is a TABLE-NAME NAMESPACE, and a NAMED INDEXER is a DATABASE

The generation model (`a-reconfigure-is-not-an-outage`) says an indexer holds several **generations**, one is canonical, and the pointer moves when a successor is ready and moves back to revert. The browser runtime got the model; the server and the CLI have the same problem and one extra question the browser never asks, because their state is versioned rows in ONE SQL database rather than a keyspace per generation in a key/value store. This ADR records where a NON-CANONICAL generation's state lives, and where a second named indexer's does. ADR-0008 decided the mechanism (rebuild alongside, flip one pointer) and is superseded only in its KEY (the processor version hash alone, which cannot express a filter change) and its RETENTION (drop the old namespace at the flip, which is what makes a revert impossible).

We decided: **a generation's state is a TABLE-NAME NAMESPACE inside one database, and a named indexer is a DATABASE of its own.** The generation namespace covers everything the state store owns (its entity tables, `_blocks`, `_cursor` and the indexes derived from them) and nothing the server owns (`_meta`, `_emissions` and the generation registry are per named indexer and shared across its generations, which is the point: a processor-only change re-folds the SAME stored stream). Deleting a generation is a `DROP`.

## Why a namespace and not a generation COLUMN on every versioned row

A column's single advantage is cross-generation queries, which nothing here wants. Against it:

- **Undoing a rebuild becomes its own bounded-chunk driver.** ADR-0008 ends a rebuild by discarding a namespace, which is `DROP TABLE` under a namespace and a full-scan `DELETE ... WHERE generation = ?` under a column, not even reclaiming pages without `VACUUM`, and bounded by the D1 per-request limits `platforms/cf-worker/src/d1.ts` already encodes.
- **Every index would have to LEAD with the generation**, and every read would seek past rows it can never return, degrading reads during exactly the window ADR-0008 exists to keep readers served through.
- **Isolation stops being structural.** Under a namespace, deleting one generation is a `DROP` rather than an argument about a filter nobody forgot.

## Why this does NOT contradict the emission table choosing COLUMNS

`_emissions` partitions on (indexer, stream) as COLUMNS, justified by a constraint that does not reach the state: a table per partition would push that table into dynamic DDL, and `packages/server/src/schema/sql/db.sql` is a STATIC, enumerable artifact (`schemaStatements` parses that one file, a test asserts the statements come from it, and wrangler's D1 migrations execute it and nothing else). The state store has no such artifact and never could: `ddlForEntity` GENERATES `CREATE TABLE IF NOT EXISTS "<entity>"` at runtime from user-declared entities. Dynamic DDL is impossible in the log regime and already the norm in the state regime, so choosing differently in the two is principled rather than inconsistent.

## Why the NAMED INDEXER is a database rather than a second level of the same mechanism

The two levels have different LIFETIMES, and that is what picks the mechanism. The indexer set is known at DEPLOY time (a host registers the N named indexers it was built with, ADR-0036), so N static bindings express it exactly, including on D1, whose bindings are static. A generation is created at RUNTIME, so it cannot get a binding and must live inside one.

There is also a correctness reason not to merely share one database: `_blocks` is `number INTEGER PRIMARY KEY` with `hash` UNIQUE, so two named indexers on DIFFERENT chains collide on block number with different hashes. Sharing would force `_blocks` and `_cursor` to be namespaced by name as well as by generation, at which point separate databases are simpler and give the isolation story the stronger guarantee: deleting everything in one leaves the other complete and readable, with no filter to forget.

**Rejected: database per GENERATION.** D1 bindings are static, so a generation created at runtime cannot get one, and it would break the one-handle property `run` relies on (one libSQL handle shared by the store and the server it answers over).

## Consequences

- **`_emissions.indexer` is redundant on every shape this repo builds today**, since each named indexer has its own database. It is KEPT: it stays correct, costs little, and is what a future serverless deployment would need to colocate several named indexers in one D1 database. Colocation is explicitly not required now.
- **A read tier must resolve the canonical pointer before it can name a state table.** That is the once-per-read-unit-of-work generation resolution the model already pins, arriving here as "which namespace answers", and it is why the registry and its pointer are durable rows rather than memory.
- **The generation namespace is derivable BEFORE the processor exists.** A generation is `{stream digest, processor version hash}`, the stream digest is a function of the source and the stream config, and `EntityEventProcessor.getVersionHash()` is a function of the declared version, the entity declarations and the processor config, so a host can name the namespace up front and the state-then-processor build order (ADR-0043) still holds.
