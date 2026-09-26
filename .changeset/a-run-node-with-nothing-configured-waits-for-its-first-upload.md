---
'etherfold': minor
'@etherfold/core': minor
'@etherfold/server': minor
---

**`etherfold run` may be started with NO processor and NO source, and then it waits for its first upload** (ADR-0093). Stand a node up once, and deploy to it afterwards with `etherfold upload`.

```sh
ADMIN_TOKEN=… etherfold run --store sqlite --db file:./etherfold.db -n https://rpc.example
ADMIN_TOKEN=… etherfold upload ./dist/processor.bundle.js --to http://indexer:2000 --indexer default
```

- **With a canonical generation in its registry**, the node instantiates it from its stored bundle and folds the contracts THAT bundle carries.
- **With none**, it serves, fetches nothing, answers reads with the existing `503 no-canonical-generation`, and `/status` says it is waiting: `cursor.waiting: {for: 'processor', message}`.
- **With a canonical generation it cannot instantiate**, it starts anyway, serves that generation frozen (the reason is on `/status`), and fetches nothing.
- **The first upload it registers names what it fetches** and makes it index. Later uploads are never refused for carrying different contracts: nothing the operator configured is there to match.
- **It is a MODE, not a default.** Only the pair may be absent: a source (`--deployments` or `INDEXING_SOURCE`) with no processor is refused, naming both ways out, and `build`, `index`, `fetch` and `serve` require exactly what they did. A re-read on such a node answers `failed`, because there is no `--processor` path to re-read.

`etherfold`: `RunConfig.processor` is `string | undefined`, and `OWNERSHIP.run.processor` is `optional`. `PreparedIndexing` gains `waiting()`, and on a waiting node its `host` and `source` (and `processor`, `store`, `streamWriter` until something folds) are refused rather than answered with a placeholder. The same goes for `RunningIndexer`, whose fields are now read on each access. New exports: `openWaitingFolding`, `WaitingFoldingAssembly` and `WAITING_POLL_MS`. `foldingStatusReport` takes an optional third argument, the waiting report. `UploadContext` takes an optional `foldParts`.

`@etherfold/core`: `ReceivingIndexerOptions.generation` and `.source` are optional (absent together for a container opened with nothing configured). `open` then registers nothing of its own and instantiates only the registry's canonical generation. New `ReceivingIndexer.fetchedSource`: the configured source, or the source the container's first fold carried, set once. `add` refuses a spec that names no source when the container has none. An instantiation that names its own `source` is frozen where that source is not the stream the deployment fetches.

`@etherfold/server`: the `/status` cursor envelope gains `waiting` (`WaitingReport`, exported), present only while a host waits for a processor (ADR-0047's second 2026-09-26 amendment).
