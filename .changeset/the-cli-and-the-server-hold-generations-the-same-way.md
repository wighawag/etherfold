---
'etherfold': minor
'@etherfold/server': minor
---

The five CLI commands hold GENERATIONS exactly as a deployed server does, so what a developer tests locally is what deploys -- and `build` holds exactly ONE.

`run`, `build` and `index` used to fold through a bare `StreamBuilder` over one un-namespaced store, which meant a changed context reached `processor.clear()`: the state the deployment answered from was DISCARDED and it served progressively less until it had caught up. All three now assemble a `ReceivingIndexer` (`@etherfold/core`) in `packages/cli/src/folding.ts`, which is where the CLI supplies the three things that container deliberately cannot have, because it knows no database: the registry substrate (rows in `_generations` / `_generation_pointer`, ADR-0054), the per-generation TABLE NAMESPACE its state folds into (ADR-0053), and the stored stream's two ends (the appender that stores what a fold concluded and the replay source a successor re-folds it from).

**What differs between the commands is EXECUTION, and nothing else.**

- **`run`** may ADD a generation and PROMOTE one, because it is a long-running host: `RunningIndexer.container` is the container it holds, a fold added beside the live one is a FOLLOWER (ADR-0044), and `run` advances it by one bounded chunk in the gap its fetch loop already waits between cycles (ADR-0022). The pointer moves once, when the successor is level. It still registers no named indexer, so its ingest, feed and admin routes still answer `501`.
- **`build`** creates one generation and exits: it never adds a second, never promotes, and run twice over the same inputs it RESOLVES the same generation rather than registering another. That is the same model at N=1, and it is what makes a `build` artifact indistinguishable from a `run` database on the generation axis -- the axis a reader of the artifact resolves through.
- **`index`** folds through the same container, so a batch naming a fold it has not seen creates a SUCCESSOR instead of clearing anything. Its name now resolves to a container rather than a bare receiver, so `GET`/`POST /{indexer}/admin/canonical-generation` (ADR-0057) answer there instead of `501 generations-not-held`.
- **`serve`** resolves the CANONICAL POINTER to say which generation answers reads, holding no processor, opening no registry (opening one SWEEPS, which is a write) and registering nothing. It needs no name to do it -- `--indexer` stays refused, and the rows carry the discriminator -- and it says what it found beside the URL it is listening on.

**`/status` reports one entry per generation held** on `run` and `index` (`generations: [{generation, canonical, follows, value}]`), so a rebuild in progress is visible on the page an operator already watches.

**Reading the state is now two steps, and this package exports both.** `canonicalGenerationIn(db)` and `canonicalStateNamespaceIn(db)` resolve which generation answers and the table namespace to open it under; `heldGenerationsIn(db)` lists what a database holds. `@etherfold/server` gains the read they are thin over: **`readHeldGenerations(db)`**, every named indexer's registered generations and canonical pointer, read-only over the tables that package owns.

**The assembly's exported shape moved with it.** `buildProcessor` is replaced by `openFoldingDatabase` (the handle, with the fixed tables in place) plus `openFolding` (the container over it), which is the split the new order forces: a generation's tables are named from the stream digest, so the store cannot be built before the source is resolved, while the database still is. `foldingStatusReport(container)` is the one mapping from what a process holds to what `/status` reports, and `ServeDependencies.startServer` now hands back the handle it opened, because the read tier resolves the pointer over it.

**Two behaviour changes to know about.** `--no-auto-setup` against a database nobody has migrated is now a refusal to START (a generation is registered before anything is read or written, and the registry is rows), naming both ways out rather than coming up and failing every cycle; and a database written by the pre-generation CLI is not resumed -- its state is in tables nothing points at and its stored stream is swept, so the fold starts again. Nothing is published, so that costs a re-index and no migration.

The guard is `packages/cli/test/equivalence.test.ts`, extended rather than duplicated: one fixture chain including a reorg, driven through `run`, `fetch` + `index`, `build` and `serve`, comparing the registered generation, the canonical pointer, the state namespace, the stored stream and the reorg counters -- plus a `run` that adds a successor over the same stream and promotes it in-process while the incumbent answers throughout.
