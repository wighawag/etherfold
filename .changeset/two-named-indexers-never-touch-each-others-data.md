---
'@etherfold/server': minor
'@etherfold/core': patch
'@etherfold/fetcher-host': patch
'@etherfold/platform-nodejs': patch
'@etherfold/platform-nodejs-fetcher': patch
'etherfold': patch
---

A NAMED INDEXER resolves to the DATABASE it owns, so a host registering several gives each one its own and no query, prefix scan or cap in one can reach another's rows.

ADR-0053 decides the mechanism and the reason: a generation is a table NAMESPACE inside one database, and a named indexer is the DATABASE. The two levels have different LIFETIMES: the indexer set is known at DEPLOY time, so N static bindings express it exactly (including on D1, whose bindings are static), while a generation is created at RUNTIME and must live inside one binding. There is also a correctness reason not to merely share: `_blocks` is `number INTEGER PRIMARY KEY` with `hash` UNIQUE, so two named indexers on different chains collide on block number with different hashes.

**`IndexerRegistryEntry` now carries `db`** (`@etherfold/server`). It is REQUIRED, which is what makes the isolation STRUCTURAL rather than remembered: a host registering a second named indexer cannot leave it out and silently inherit the first one's rows, because there is nothing to leave out. `getDB` stays exactly what it was and is now clearly the HOST-LEVEL handle: it answers per request and knows no name, which is right for `/status` and `/admin/setup` (facts about the deployment) and wrong for anything keyed on a tenant.

```ts
// one receiver per name, over the database that name owns
getIndexer: indexerRegistry({alpha: singleContextEntry(alphaDB, alphaBuilder), beta: singleContextEntry(betaDB, betaBuilder)});
// a host holding generations: the container answers the two questions, the host supplies the handle
getIndexer: (_c, name) => (name === 'alpha' ? indexerEntryOn(alphaDB, myReceivingIndexer) : undefined);
```

**Both feed views read through the entry's handle** (`GET /{indexer}/feed`, `GET /{indexer}/canonical`), and the ingest routes were already isolated by construction: the fold, its store, its emission appender and its reorg recorder are all the host's, bound to the database that name owns.

**Three shape changes, and nothing else moves.** `singleContextEntry(db, ingestion)` takes the handle first; `indexerRegistry` takes ENTRIES rather than bare receivers, because a name resolves to what it holds AND to where it holds it; and `indexerEntryOn(db, holds)` is new, the one line a host holding a `ReceivingIndexer` writes, since `@etherfold/core` knows no database and cannot carry one (its generation state is a type parameter precisely so it does not).

**Colocation is still expressible and is now explicit.** Two names MAY be given one handle (`_emissions.indexer` and the generation registry's own name column keep them apart, which is why those redundant columns are kept), and that is a host's decision made where it can be read rather than one the type makes for it by defaulting.

**The refusal families are unchanged.** A name this host was not built with is still a `404`, a host with no registry is still `501`, `409` is still the one resumable refusal, and a context no live receiver holds is still a `400`.

`etherfold`, `@etherfold/fetcher-host`, `@etherfold/platform-nodejs` and `@etherfold/platform-nodejs-fetcher` carry no new behaviour: each names the handle its one named indexer already folded into, where it used to register a bare receiver.

The guard is `packages/server/test/twoNamedIndexers.test.ts`: two named indexers with IDENTICAL sources, contracts, stream config and processor (so `streamDigestOf` cannot tell them apart and neither can a wire context) on a host whose own `getDB` handle is a THIRD database holding neither one's rows, so a read that forgot the discriminator answers with nothing rather than with something plausible. It asserts the routes, the store, the stored stream and the registry end to end, that a generation cap reached in one refuses in that one only, and that deleting everything in one is a `DROP` with no filter anywhere while the other stays complete and READABLE.
