---
'@etherfold/core': minor
'@etherfold/server': minor
'etherfold': minor
---

**A generation SAYS whether it can run here, so an operator can tell before reverting** (ADR-0092). Before this, a revert target that would resume folding and one that would never advance again looked the same in the admin listing. A canonical generation whose stored code could not be built at start-up stalled, and only a log line said why.

`@etherfold/core`:

- `ReceivingIndexer.folding()` reports every registered generation as `held` (this process folds it), `instantiable` (the bundle stored on its row can be instantiated when it has to fold) or `frozen`, with a `FrozenReason`:
  - `no-bundle`: its code is gone.
  - `no-instantiator`: the host was given no `instantiateGeneration`.
  - `instantiation-failed`: an attempt in this process could not build the stored code.
  - `stream-not-fetched`: a filter change's generation.
- Answering builds nothing. `instantiable` is decided without running the code, and a failed attempt at `open` or at a refused revert is remembered and reported.
- New exported types: `GenerationFolding` and `FrozenReason`.

`@etherfold/server`:

- `IndexerRegistryEntry.folding?()` is a new optional capability, and `indexerEntryOn` forwards it.
- `GET /{indexer}/admin/canonical-generation` adds `folding` to each generation entry, plus `frozen: {reason, message}` where it is frozen. Nothing it already reported changes, and a host that does not answer `folding` gets no such field.

`etherfold`: `run` and `index` answer `folding`, so their admin listing says whether each generation can fold on this deployment.
