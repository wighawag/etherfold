---
'etherfold': minor
'@etherfold/server': patch
---

**`etherfold node` RECEIVES uploads, and `etherfold run` stops receiving them** (ADR-0094). Each command has ONE source of truth: `run` folds what its configuration names, and `node` folds what was uploaded to it.

```sh
ADMIN_TOKEN=… etherfold node --store sqlite --db file:./etherfold.db -n https://rpc.example
ADMIN_TOKEN=… etherfold upload ./dist/processor.bundle.js --to http://indexer:2000 --indexer default
```

- **`etherfold node` is a new, seventh command**: `run`'s chain, store, database, serving and indexer name, with NO processor and NO source. It is ADR-0093's waiting mode as a command of its own: it folds its registry's canonical generation from the stored bundle where it can, and otherwise it waits for its first upload and says so on `/status` (`cursor.waiting`). It serves `POST /{indexer}/admin/upload`, takes `--promotion` and `--drop-on-promotion`, and REFUSES `-p` / `--processor` and `--deployments` by name, pointing at `etherfold upload`, and `--override`, since its starts replace nothing. `INDEXING_SOURCE` in its environment is not read, and not refused.
- **`etherfold run` requires `-p` again**, and started with neither a processor nor a source it is refused, naming `etherfold node`. It no longer serves the upload route: a configured `run` answers it `501 upload-not-held`.
- **The upload's configured-source match is deleted**: a `node` never has a configured source, so an upload carrying different contracts from the incumbent is always a successor on a new stream.
- **A database either command wrote opens in the other.** `run` over a `node`'s database is an ordinary configured start; `node` over a `run`'s database runs the canonical generation over the contracts its bundle carries, and serves it frozen (`stream-not-fetched`) where `run` had been given a source that bundle does not carry.
- **The dev loop** is `etherfold node` plus a watcher that calls `etherfold upload` on each build.

`etherfold`: `CommandName` gains `'node'`, `ResolvedConfig` gains `NodeConfig`, and `OWNERSHIP` has a `node` row; `OWNERSHIP.run.processor` is `required` and `RunConfig.processor` is `string`. New exports `node` and `nodeMain`. `ChainFollowingCommand` gains `'node'`, and `PreparedIndexing.reconfigure` and `.upload` are optional: the re-read is present on `run` and `build`, the upload on `node` alone. `ConfiguredSource` and `UploadContext.configured` are removed. `ProgramDependencies` takes a `node` handler.

`@etherfold/server`: the `501 upload-not-held` message names `etherfold node` as the deployment that receives uploads.
