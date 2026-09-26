# etherfold

The command line. `etherfold run` follows a chain, folds a processor into a libSQL database and answers HTTP over it, in one process; `etherfold build` is the same thing as a one-shot that exits at the tip; `etherfold fetch` is the chain-facing half of a split deployment, pushing raw logs to a server elsewhere; `etherfold index` is the half that receives those pushes and owns the database; `etherfold serve` is the READ tier over a database written elsewhere, answering `/status` -- health, schema version, reorg counters and the cursor the fold has reached. Beside those five, `etherfold upload` DEPLOYS: it sends a processor bundle you already built to a running `run`, which indexes it beside the live version before switching.

```sh
npm i -g etherfold        # or: npx etherfold …
etherfold --help
```

Every run names its intent: there is no default command, so a bare `etherfold` prints this help and indexes nothing.

Every command that folds is pointed at a processor BUNDLE rather than at a module: its bytes are what names the generation (ADR-0086), and [Producing the processor bundle](#producing-the-processor-bundle) is the one command that produces one, with the rule about its flags that an author only gets one chance to get wrong.

## When you want this, and when you do not

| you want | use |
| --- | --- |
| to run an indexer: follow a chain, fold into a database and answer HTTP | here, `run` |
| to index a contract into a database, from a terminal or a CI job | here, `build` |
| to run the chain-facing half near your node, pushing to an indexer elsewhere | here, `fetch` |
| to receive those pushes and own the database, on another host | here, `index` |
| to answer over a database something else writes | here, `serve` |
| to deploy a built processor to a running node, from a laptop or a CI job | here, `upload` |
| to index inside a browser tab, with no server | [`@etherfold/browser`](https://github.com/wighawag/etherfold/tree/main/packages/browser) |
| to write the processor being run | [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) |
| to embed the same pipeline in your own Node program | [`@etherfold/core`](https://github.com/wighawag/etherfold/tree/main/packages/core) + [`@etherfold/fetcher-host`](https://github.com/wighawag/etherfold/tree/main/packages/fetcher-host) |

## `etherfold run` -- the whole pipeline, in one process

```sh
etherfold run \
  -p ./dist/processor.bundle.js \
  --store sqlite --db file:./etherfold.db \
  -n https://rpc.example --port 2000
```

**This is the default thing to reach for.** One process, one terminal invocation: it follows the chain, folds your processor into the libSQL database you named, and answers HTTP on the port you resolved -- with no knowledge required of how the components divide. When it reaches the tip it does not stop; it backs off to a poll interval and keeps following.

It is ASSEMBLY and not a fourth engine. A log-fetcher pushes into a stream-builder through an in-process direct ingestion (the two halves of the wire with the transport removed), the stream-builder folds your processor into the store, and the server starts on the SAME database handle the store writes through. `run` IS `fetch` plus `index` plus `serve` in one process; splitting them later is a deployment change and not a rewrite.

| flag | |
| --- | --- |
| everything `build` takes | same flags, same variables, same refusals: see the table below |
| `--port <port>` | port to listen on (or `PORT`). Defaults to `2000`; `0` asks the OS for any free port |
| `--host <hostname>` | hostname to bind. Binds every interface when absent |
| `--no-auto-setup` | do not apply the fixed-table schema at startup. Then somebody else must, BEFORE this process starts: its fold is a generation, and the registry a generation is recorded in lives in those tables (see below) |
| `--promotion <on-catch-up\|immediate\|manual>` | WHEN a successor takes over answering reads, without anyone asking (or `PROMOTION_POLICY`). Defaults to `on-catch-up`, everywhere. Only this command takes it -- see below |
| `--drop-on-promotion` | discard the superseded generation at the promotion instead of retaining it. OFF by default, because the retained generation is what the pointer moves BACK to |
| `--override` | let this START replace a DIFFERENT pending successor (often an upload still catching up) without asking. Without it an interactive start asks and a non-interactive one is refused. Only this command takes it -- see below |

**It can be started with NOTHING configured, and then it waits for its first upload** (ADR-0093). Stand a node up once, and deploy to it afterwards:

```sh
ADMIN_TOKEN=… etherfold run --store sqlite --db file:./etherfold.db -n https://rpc.example
# later, from a laptop or a CI job:
ADMIN_TOKEN=… etherfold upload ./dist/processor.bundle.js --to http://indexer:2000 --indexer default
```

With no `-p` AND no source (neither `--deployments` nor `INDEXING_SOURCE`), the node does what its database says. Where the registry already has a canonical generation, it runs that generation from the bundle stored for it and folds the contracts THAT bundle carries. Where it has none, it serves, fetches nothing, answers reads with `503 no-canonical-generation` (the answer a fresh deployment gives before its first fold) and says on `/status` that it is waiting: `cursor.waiting: {for: "processor", message}`. Where the canonical generation's stored code cannot run here, it starts anyway, serves that generation frozen (`cursor.canonical.folding: "frozen"` with the reason) and fetches nothing. The first upload it registers names what it fetches from then on and makes it index; the first generation a registry holds takes `canonical` by the usual rule. Later uploads are never refused for carrying different contracts, since nothing the operator configured is there to match: one with other contracts is a successor on a new stream, as on any node whose source came from its processor. It is a MODE and not a default: only the pair may be absent, so a source with no processor is refused (contracts with nothing to fold them are a configuration error), and `build`, `index` and `fetch` still require what they required. A re-read (`POST /{indexer}/admin/reconfigure`) on such a node answers `failed`, since there is no `--processor` path to re-read.

**An upload survives a restart, including one still catching up.** A restarted node folds the canonical generation AND the pending successor from the bundles stored for them, so an upload that had not caught up when the process stopped goes on catching up and is promoted under the node's policy (`on-catch-up` by default) with nobody asking. The generation a revert would return to (`predecessor`) is not run until a revert lands on it. A `-p` naming the canonical processor, or the pending successor's, changes nothing; a `-p` naming a DIFFERENT processor registers it as the new successor, as it always has. But that REPLACES the pending successor and DELETES it (its row, its state and its stored bundle), so a START that would do it to a DIFFERENT pending successor is not allowed to do it silently: at a terminal it ASKS, naming both generations, and goes ahead only on a yes; anywhere else (a supervisor, a container, CI) it is REFUSED by name, with nothing registered or deleted, unless `--override` is given. A pipeline that redeploys per commit passes `--override` once, in its deploy configuration. Only the START is guarded: an upload and a re-read (`POST /{indexer}/admin/reconfigure`) are deliberate acts on a running node and replace a pending successor without a question.

**How it stops.** On `SIGINT` or `SIGTERM` it finishes the cycle in flight and exits `0`; nothing needs to be saved, because the store holds the rows AND the sync cursor in one transaction (ADR-0027), which is also why an interrupted run resumes from the store rather than from the start block. A refusal no waiting fixes -- a foreign `{source, config}`, the wrong chain, a suspected truncation -- ends it with a non-zero code, so a supervisor can tell a stop from a wedge. A retryable failure (an unreachable node) is retried indefinitely on an escalating, capped backoff rather than after N attempts: a transient outage should not leave a stopped indexer behind. Reaching the tip is not one of the ways it ends; that is `build`.

**`/status` reports a cursor that advances**, which is how a running deployment is observable before a query layer exists:

```json
{"healthy": true, "cursor": {"reported": true,
  "value": {"lastFromBlock": 21000001, "lastToBlock": 21004300, "latestBlock": 21004300, "unconfirmedBlocks": 3}}}
```

Four numbers, deliberately, and never the cursor itself: the stored cursor is a serialized sync structure carrying a window of decoded events, and `/status` reports whatever a host hands it verbatim (ADR-0047). `lastToBlock` is what moves; `latestBlock - lastToBlock` is how far behind it is.

**It also reports what the FETCHING half learned about your node**, in `fetcher: {reported: true, learnedRange: {ceiling, safeSpan, nextSize}, suspectResultCount: {count, source}}`. The range fetcher works out how wide an `eth_getLogs` range your provider will answer by being refused and adapting: `ceiling` is the width it has been refused at (or that the provider wrote out in a refusal), `safeSpan` is the widest span actually answered, and `nextSize` is what the next request will ask for -- all in blocks, and absent rather than zero where nothing has been learned. `run` is the shape that reports it because it is the one holding both halves; `index` and `serve` fetch nothing and carry no `fetcher` field.

It is reported so you can HAND IT BACK on the next start, as `LEARNED_RANGE` (the fetcher host's variable, documented in [`platforms/nodejs-fetcher`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs-fetcher)): paste the reported object in and the process starts from where discovery left off instead of walking up from the small starting range again. **Nothing persists it, deliberately** (ADR-0074): the chain-facing half holds no state worth losing, so the memory belongs to whoever is already durable -- your supervisor, your deployment config, or you. A run that configures none rediscovers exactly as before, and a value that has gone stale costs one refused request and is then lowered.

**It also reports WHEN it will take a successor over**, in `promotion: {reported: true, policy, dropOnPromotion}` -- the RESOLVED value, so what you read back is what will actually happen rather than what you typed, default included. It is reported because the policy is otherwise observable only as behaviour: watching a successor catch up on this page tells you nothing about whether it is going to take over by itself. `run` is the shape that reports it, because it is the one that decides it; `index` and `serve` carry no `promotion` field.

**It also counts the reorgs it concluded**, in `reorgs: {absence, contradiction, last}`, and the split is the whole point. A `contradiction` is PROOF -- the same block height now carries a different hash -- and is ordinary chain activity. An `absence` is an INFERENCE: a block we held is simply not in the re-delivered range, which is indistinguishable from a node that under-delivered it. Both revert state, so folding them into one number would hide the only signal that says "your logs are being truncated or your filter is wrong" rather than "the chain reorged" (ADR-0004). Neither makes the process unhealthy: an absence-driven revert is a signal to investigate, not a fault.

**All three folding shapes carry these counters, not just the one behind an HTTP route.** `run`, `build` and `index` all count the reverts they concluded, into the database they fold into, through one writer (ADR-0050) -- so `run` and `fetch` plus `index` agree about a reorg the way they already agree about state and the cursor, and `packages/cli/test/equivalence.test.ts` compares them directly. `serve` reports what its database holds, since it folds nothing and concludes nothing. A count that cannot be written (a database with no fixed tables, see `--no-auto-setup`) is a logged miscount and never a fold that stops.

**And all three STORE THE STREAM they folded** (ADR-0052): every emitted log, retractions included, in the `_emissions` table of the database they fold into, which is what a later processor change re-folds from instead of re-fetching the whole history from your node, and what both feed views read. That write is NOT best-effort, and it is the one thing that can stop a fold: it happens BEFORE the batch is processed, and a batch that could not be stored is not processed at all, because a state that advanced past events the stream never received is silent, permanent damage nothing downstream can detect. A `run` whose database loses that table mid-flight therefore retries its cycle and reports no progress, rather than indexing into a database that cannot record what it indexed, and it catches up by itself once the table is back.

**All three HOLD GENERATIONS, exactly as a deployed server does.** A **generation** is a stream plus a fold over it; a named indexer holds several and ONE is canonical (`CONTEXT.md`). So the fold is registered in the database it writes -- durable rows, with the canonical pointer beside them (ADR-0053, ADR-0054) -- and its state lands in that generation's own TABLE NAMESPACE rather than in tables the whole database shares. Three things follow, and they are the whole reason for it:

- **A changed context creates a SUCCESSOR instead of discarding state.** A processor upgrade used to reach `processor.clear()`, and the deployment then served progressively less until it had caught up. Now the new fold gets its own tables, the canonical generation goes on answering complete old answers, and the pointer moves when the successor is level -- which on `run` happens in-process, advanced by a bounded rebuild over the stream this process already stored, between its own fetch cycles (ADR-0022).
- **A READER resolves the pointer before it names a table.** `etherfold serve` does it (below), and so does anything opening the database yourself: read the canonical generation, then open its namespace. That is what makes a promotion one small write nobody reading has to be told about, and moving the pointer BACK a revert rather than a re-index.
- **`/status` reports one entry per generation held**, beside the cursor: `generations: [{generation, canonical, follows, value}]`. One entry until something adds a successor, two while it catches up -- so a rebuild in progress is visible on the page you already have open, and is distinguishable from an empty result. Beside it, `canonical: {generation, folding, frozen?, value}` names the generation answering reads whether or not this process folds it, in the admin listing's words (`held` / `instantiable` / `frozen` with the reason), and where it stands: a canonical generation frozen here (stored code that could not be built, a revert across a filter change) is reported with its position rather than as silence.

How many a named indexer may accumulate is BOUNDED and refuses at the bound rather than evicting: four generations and two streams, the server's own numbers, since here the database IS the durable artifact and the retained generation is what the pointer moves back to.

**`--no-auto-setup` is therefore a refusal to START rather than a slow failure**, when the database has not been migrated: a generation is registered before anything is read or written, and there is nowhere to register it. The message names both ways out -- `POST /admin/setup` on a server that already answers that database, or `applySchema` from `@etherfold/server` -- and this process never applies the schema anyway, because that flag says somebody else owns those migrations.

**A `run` process serves the named indexer it folds, and hosts no remote writer.** It registers the one name it folds under as a READ-ONLY entry, so `/{indexer}/feed`, `/{indexer}/canonical`, `/{indexer}/state-moved` and `/{indexer}/admin/canonical-generation` answer over the database this process is writing -- the same read surface a split deployment has -- while INGESTION is refused: an authenticated call to `/{indexer}/ingest` answers `501 ingestion-not-accepted`, an unauthenticated one answers `401`, and a name this process was not started with is a `404`. A remote sender pushing into a process that is already fetching would be a second writer nobody asked for; the command that receives pushes is `index`. That is why `--ingest-endpoint` and `--ingest-token` are refused here: the two halves meet in this process through a direct in-process ingestion, so there is no wire to configure.

**`--promotion` says WHEN a successor takes over, and it is the only command that takes it.** A reconfigure registers a successor beside the fold that is answering (below); this is what decides when the canonical pointer moves onto it. `on-catch-up` -- the DEFAULT, everywhere -- moves it when the successor reaches the cursor the canonical generation had, so the app keeps rendering complete old answers and switches when the new fold is ready: what you want when users did not ask for the reconfigure. `immediate` makes the successor canonical the moment it is registered, before it has folded anything, which is what you want while you are iterating on a handler, because stale-but-complete answers from the fold you just replaced are more confusing than incomplete answers from the new one. `manual` never moves it on its own, however level the successor gets, so you can inspect one before it answers anybody -- and `POST /{indexer}/admin/canonical-generation` still moves it under every value, because "only when asked" is not "never".

**It is a FLAG and never inferred, deliberately.** The axis that would select between these is development-versus-production, and nothing in a runtime can detect which it is in, so the safe value is the default everywhere and the others are a deliberate opt-in: there is no `NODE_ENV` sniff here and there is not going to be one. `build`, `index`, `fetch` and `serve` REFUSE the flag rather than accepting it, and each refusal names its own reason: a one-shot holds exactly one generation and exits, a fetcher holds none at all, and a read tier reads a pointer something else moves -- so none of those would ever apply a policy, and an accepted-and-ignored flag is a deployment believing something untrue. `index` is the one whose reason is about INPUTS rather than about having nothing to act on: it wires no reconfigure route, so it registers no successor while it runs, but the one its own configuration named at start-up IS carried to level and promoted here under the default policy -- which is how a split deployment finishes a processor upgrade by restarting. Whether this command should also take the flag is a question nothing has answered yet. `--promotion immediate` together with `--drop-on-promotion` is refused at start-up, before anything is opened: `immediate` promotes a successor that has caught up to nothing, so the previous generation has to be RETAINED until it does (ADR-0046), and that deferral is not built on this runtime. Use `on-catch-up` with the drop, or `immediate` while retaining.

**`--indexer` is accepted here, and it is the one input this command may default.** It is NOT a wire setting: the name is what every row of the stored stream is keyed on (ADR-0036), so a process that folds needs one whether or not anything addresses it by one. This process routes no BATCH by name -- it accepts none, as above -- so the never-defaulted rule that binds `fetch` and `index` does not reach it, and it defaults to `default` (ADR-0052). Name it explicitly when two answer sets will share a database, or when an app should read the feed under a name you chose, since that name is the first segment of every read route this process answers.

## `etherfold build` -- one shot, to the tip, then exit

```sh
etherfold build \
  -p ./dist/processor.bundle.js \
  --store sqlite --db file:./etherfold.db \
  -n https://rpc.example
```

Named for what it PRODUCES: a database. What it does: read the processor bundle, open the store, resolve the source, then fetch and fold until it reaches the chain tip it observed, and exit. Exit code 0 on success, 1 on failure, so a CI job can depend on it.

**It is `run` without the serving, stopping at the tip**, and that is true of the code rather than of this sentence: both commands assemble through one function and differ by whether the loop aborts on the first report that reached the tip.

**It is a ONE-SHOT and nothing else.** It does not follow the chain, does not stay up, and cannot be reconfigured while it runs: to keep a database current, run it again (a cron, a loop, a job). It resumes rather than restarting, because the sync cursor is in the store, written in the same transaction as the block it describes (ADR-0027). Live reconfiguration is the browser package's ability, not this one's.

**So it holds exactly ONE generation** -- it creates one and exits, never adds a second and never promotes -- and running it again over the same inputs RESOLVES that generation rather than registering another. That is the same model `run` holds, instantiated at N=1, and NOT a second model: the artifact this command produces is meant to become somebody else's INPUT, so a `build` that folded into differently-named tables, registered nothing, or left the pointer unset would be distinguishable from a `run` database on exactly the axis a reader of it resolves through. Holding one costs a pointer read at start-up. `packages/cli/test/equivalence.test.ts` drives both shapes over one fixture chain and compares the generation registered, the canonical pointer, the state namespace, the stored stream and the reorg counters.

**The database it emits carries its provenance**, which is why `build` applies the fixed-table schema even though it binds no port: the artifact records the schema version, the reorgs it concluded (`absence` versus `contradiction`, exactly as `run` and `index` record them -- ADR-0050) and the STREAM it folded (ADR-0052), so a `serve` pointed at it, or a later process fed it, reads the same facts a `run` database carries. The stream is the part that makes the artifact re-foldable: a processor-logic change replays what is already on disk instead of re-fetching a whole history from a node that may no longer serve it. Nothing else in this command would ever create those tables, and a database that loses its provenance the moment it becomes an INPUT is the failure this prevents. `--no-auto-setup` is refused here: the one-shot answers no queries, and there is no startup to decline the tables at.

| flag | |
| --- | --- |
| `-p, --processor <path>` | the processor BUNDLE. It must export `createProcessor` (a factory, or the processor object itself), and it must be self-contained -- see below |
| `--store <sqlite>` | REQUIRED and never defaulted. It names where the state goes, and it is the axis a second backend would arrive on |
| `--db <url>` | libSQL url: `file:./etherfold.db`, `:memory:`, or `libsql://<host>`. Required with `--store sqlite`, so no run writes a database nobody named |
| `--retention <blocks\|revert-only\|unbounded>` | how far back superseded versions are kept, in BLOCK numbers and no other unit (ADR-0019). Default `unbounded`. What falls outside it is refused on read AND dropped from storage, because this command schedules the prune its retention implies |
| `-d, --deployments <folder>` | contract deployments in hardhat-deploy / rocketh format, or `INDEXING_SOURCE` as JSON. Optional when the module supplies `contractsDataPerChain` |
| `-n, --node-url <url>` | the JSON-RPC endpoint (or `ETH_NODE_URI`) |
| `--rps <n>` | cap the requests per second made to the node (or `REQUESTS_PER_SECOND`) |
| `--indexer <name>` | the NAMED INDEXER the artifact's stored stream is keyed on (or `INDEXER_NAME`). Optional here, and the only input besides `--port` that defaults: `default` (ADR-0052). It routes nothing -- this command answers no requests |

A flag combination that names no store is REFUSED rather than ignored: an accepted-and-ignored flag is a deployment believing a retention window is enforced, or a database is being written, when neither is true.

**A retention floor is enforced on BOTH halves.** A window bounds what a read may ask about from the moment it is configured, and this command drops what falls below it: bounded passes until the state is at its floor, once it has reached the tip and before it exits, because the database it exits with is an artifact and "prunes eventually" is not a property an artifact has. `run` does the same on its cycle, one bounded pass at a time, in the gap it already waits between fetches. It is never a side effect of a write (ADR-0022), because a prune costs time proportional to what it drops and a block should not pay for work it did not cause. `revert-only` has a floor too -- the finality depth this deployment protects against -- so it is pruned as well; `unbounded` has none, and a prune there is a no-op that changes nothing about the default.

The processor module hands back the AUTHORING object (declarations plus handlers) and never picks a store; that is what makes the SAME module file the one a browser tab runs. A module still returning the retired `{kind, processor}` tag is refused by name (ADR-0037).

**`-p` names a self-contained BUNDLE, and its hash identifies the generation** (ADR-0086). A path is still how a deployment names its processor; what changes is what the path must point at. Where the file at it expects nobody else to resolve anything, these commands read it, name it `sha256:<hex>` over its octets and register a generation under that name. An edited handler is then a different generation with no author action, and the same source built on two machines is the same generation whatever directory either checked out into. Nothing here bundles anything: reading a file and hashing it is not bundling, and the author runs the build -- with the one command the next section states.

## Producing the processor bundle

Every command that folds is pointed at a bundle, so this is the step before all of them. **One command produces one, and it is the same command the refusal below hands you**:

<!-- bundle-command: the line in the fence below is CHECKED against the refusal `refuseUnbundledProcessor` emits, by `packages/cli/test/theDocsAndTheRefusalNameOneBuildCommand.test.ts`. The tool, the flags and their order must match it, because an author meets the refusal first and this second. Change one and change the other, in the same commit. -->

```sh
esbuild ./src/processor.ts --bundle --format=esm --minify --outfile=dist/processor.bundle.js
```

A single minified ESM file, which your entry point exports `createProcessor` from (a factory, or the processor object itself). `esbuild` is the documented default because one invocation with no configuration file produces exactly that.

**`--minify` is MANDATORY, and the reason is IDENTITY rather than size.** Un-minified, esbuild opens each bundled module with a `// <path>` banner naming that module RELATIVE TO THE DIRECTORY THE BUNDLER RAN IN -- so the building machine's directory layout is in the bytes, and the bytes are the generation's name. Measured: one source built from a checkout root and from its package directory hashed `f2d21373…` and `bce77ea9…` un-minified, and `bfbbcd68…` both times minified ([the measurement](https://github.com/wighawag/etherfold/blob/main/docs/spikes/the-build-command-and-its-pinning-rule-are-documented/README.md)). Drop the flag and your laptop and your CI job do not build a bigger bundle, they disagree about which generation they are: neither reuses the state the other folded, and every deploy re-folds from the start. Stripping comments, which is the reason someone would guess the flag is there, is the lesser benefit.

**PIN THE BUNDLER'S VERSION AND ITS FLAGS, not merely the tool.** The output is a function of both, and the output IS the identity, so a bundler upgrade in a refreshed lockfile and a flag somebody added to a build script are the same event: a new name for an unchanged fold. That costs a re-fold of stored data every time it happens -- bounded, visible, and pointless. So keep the bundler in your lockfile as an exact version rather than a range, and keep the command in one checked-in script (a `package.json` script is enough) rather than in a CI step that drifts from the one you run locally. A build that is not deterministic across your machines is one whose persisted state is never reused.

**`rollup` is the alternative** for anyone who wants it, with `@rollup/plugin-node-resolve` and an ESM output, and the same rule applies to it: pin its version and its configuration, because they decide the bytes. **`tsup` is not recommended** -- it is esbuild with a wrapper, so it adds a version to pin and no determinism.

**Source maps are the answer to a minified stack trace, and the spelling matters.** `--sourcemap=external` writes `dist/processor.bundle.js.map` beside the bundle and leaves the bundle itself byte-identical to the map-less build, so it does not move the identity (measured, in the table linked above). Plain `--sourcemap` appends a `//# sourceMappingURL=` comment to the bundle, which is deterministic across machines but a DIFFERENT identity from the same source built without it -- which is the pinning rule above in one flag.

### If you already had a processor: what changed, and what to run

`-p` used to accept a module ENTRY POINT and now requires the bundle built from it. The migration is that one command and a changed path: point `-p` at `dist/processor.bundle.js` instead of `dist/processor.js`. Nothing else moves -- the processor source is unchanged, and the declared `version` field it used to carry is gone rather than renamed, because an identity derived from the bytes is not something an author can state (ADR-0086).

An unmigrated path is REFUSED at configuration resolution, before a database is opened or a generation registered, because a file whose dependency closure is not in it has no bytes that describe it. The refusal names the path, what it still imports, and the same command with your path already in it:

```
-p, --processor "./dist/processor.js" names an ENTRY POINT rather than a bundle: it still imports "./abi.js",
which nothing resolves for it. A processor is ONE self-contained file, named by the sha256 of its bytes
(ADR-0086). Build one, and point `etherfold build` at it:

  esbuild ./dist/processor.js --bundle --format=esm --minify --outfile=dist/processor.bundle.js
```

A path that is not a file this process can read at all -- a package name, a directory, or much the commonest, a build that has not run -- is refused in the same shape, with `--outfile=` naming the path you asked for, because writing that file is what is missing.

## `etherfold fetch` -- the chain-facing half, and the ONLY way to run a fetcher

```sh
etherfold fetch \
  -n https://rpc.example \
  -d ./deployments \
  --indexer my-indexer \
  --ingest-endpoint https://indexer.example
```

**It follows the chain and pushes contiguous ranges of raw logs at an indexer-server elsewhere**, which is what makes splitting a deployment a deployment decision rather than a rewrite: run this on a host near your node and the folding half anywhere. It folds nothing, answers no queries, and keeps running until it is stopped.

It is a front door onto [`@etherfold/platform-nodejs-fetcher`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs-fetcher) and not a second implementation, and it is now the ONLY one: that package used to ship an `etherfold-fetch` binary configured from the environment alone, and that binary is retired with its `bin` entry. What survives there is the library the command drives.

| flag | |
| --- | --- |
| `-n, --node-url <url>` | the JSON-RPC endpoint (or `ETH_NODE_URI`) |
| `-d, --deployments <folder>` | what to index, as a deployments folder, or `INDEXING_SOURCE` as JSON. REQUIRED here in one form or the other: there is no processor module to read contracts out of |
| `--indexer <name>` | REQUIRED. The NAMED INDEXER on that server to push into (or `INDEXER_NAME`): one indexed answer set over one chain (ADR-0036), and the first segment of every ingest route. Never defaulted -- a name the receiver was not built with is refused with a `404` |
| `--ingest-endpoint <url>` | the indexer-server to push to (or `INGEST_ENDPOINT`). `/{indexer}/ingest` hangs off it |
| `--ingest-token <token>` | the wire's shared secret (or `INGEST_TOKEN`, which is preferable: a secret on a command line is visible to every process on the host) |
| `--rps <n>` | cap the requests per second made to the node (or `REQUESTS_PER_SECOND`) |

Everything else a fetcher deployment tunes -- `SUSPECT_RESULT_COUNT` (**read that package's README about this one**), the fetch bounds, the backoff, the stream identity -- stays in the environment the fetcher host already publishes, rather than growing a second name here.

**It owns no state, and the flags that would imply otherwise are REFUSED rather than ignored.** No `--store` and no `--db`, because a fetcher holds no cursor and no database (ADR-0003); no `-p`, because the chain-facing half holds no processor and whatever folds these logs lives behind `--ingest-endpoint` under `--indexer`. There is likewise no state file, no lock file and no `--from-block`: where the next batch starts is the RECEIVER's answer, and a `409` telling this process it asked from the wrong place is the ordinary correction path. So killing it costs nothing and running two of them needs no coordination.

**How it stops.** `SIGINT` / `SIGTERM` finish the cycle in flight and exit `0`. A refusal no waiting fixes -- a bad token, a `{source, config}` the server does not serve, a provider on the wrong chain, a suspected truncation -- exits non-zero, because a fetcher that stays up while achieving nothing is indistinguishable from a working one until somebody reads the state it is not producing. Everything else (an unreachable server, a `5xx`, a dropped socket) is retried on an escalating, capped backoff and never exits.

## `etherfold index` -- the RECEIVING half, which owns the database

```sh
etherfold index \
  -p ./dist/processor.bundle.js \
  --store sqlite --db file:./etherfold.db \
  -d ./deployments --indexer my-indexer --port 2000
```

**It folds what something else pushed at it.** It makes no chain call, receives contiguous ranges of raw logs over HTTP, folds them through your processor into the libSQL database you named, and keeps running. It is the other half of the pair `fetch` sends to, and together they are a split deployment: run `fetch` on a host near your node and this anywhere.

**It exposes the write path and NOT the query API, and that asymmetry is the point.** It has an HTTP surface because it must RECEIVE; answering queries is `serve`'s. So a split deployment is `index` plus `serve` against ONE database -- the writer and a stateless read tier -- and `/status` is available on both, because it reports on the database rather than on the process.

| flag | |
| --- | --- |
| `-p, --processor <path>` | the processor BUNDLE. It must export `createProcessor`, and it must be self-contained, exactly as on `build` |
| `--store <sqlite>` / `--db <url>` | REQUIRED, exactly as on `build`: this command owns the database |
| `--retention <blocks\|revert-only\|unbounded>` | as on `build`, with one difference: this command schedules NO prune. It is fed over the wire and has no cycle of its own to prune between, and a prune inside the ingest path is exactly what ADR-0022 refuses -- so a bounded retention here bounds what a read may ask about without yet reclaiming the versions below it |
| `-d, --deployments <folder>` | what to index, or `INDEXING_SOURCE` as JSON. REQUIRED here in one form or the other -- see below |
| `--indexer <name>` | REQUIRED, and never defaulted on this half of the wire (unlike `run` / `build`, which route nothing). The NAMED INDEXER this process HOSTS (or `INDEXER_NAME`): the name a sender addresses it by, and the name the stream it stores is keyed on. It registers exactly this one and refuses every other with a `404`, rather than serving a misdirected push from the only indexer it holds |
| `--ingest-token <token>` | REQUIRED. The wire's shared secret, the same name on both sides (or `INGEST_TOKEN`, which is preferable: a secret on a command line is visible to every process on the host) |
| `--port <port>` / `--host <hostname>` | where it LISTENS for pushes (or `PORT`). `/{indexer}/ingest`, `/{indexer}/admin/canonical-generation` and `/status` hang off it |
| `--no-auto-setup` | do not apply the fixed-table schema at startup. Then somebody else must, BEFORE this process starts: see `run` |

**It makes NO chain call, and that is why the source must be explicit.** `-n` and `--rps` are REFUSED naming what this command is instead: there is no node here. The source cannot be taken from a processor module that keys its contracts per chain either, because reading one costs an `eth_chainId` call -- so it comes from `-d` or `INDEXING_SOURCE`, and a module-only source is refused naming both forms. That is not fussiness: the wire identity is derived from the source and the stream config together, so a source this half discovered on its own could not be the sender's, and every push would be refused with a `400`.

**It authenticates, or it refuses everyone.** The shared secret is required, so a receiver with none configured never binds a port rather than coming up as an open-looking endpoint that answers `401` to a sender with no way to know why. A push with the wrong secret is a `401` naming the variable, and nothing is applied.

**A replayed or resumed push is safe, because the cursor IS the idempotency key.** A batch that does not start where this receiver says the next one must is refused with a `409` carrying that block, and the sender re-sends from there; a sender that fell behind is corrected with no operator involved, and a batch re-sent after a lost acknowledgement cannot be applied twice. There is no dedupe table and no idempotency header, deliberately.

**`/status` reports the cursor here, exactly as on `run`**, because this is the half that owns the store. It also counts the reorgs it derived (`absence` versus `contradiction`, ADR-0004): a rising rate of the absence kind means truncation or misconfiguration rather than chain activity. Those counts are taken by the FOLD and written by the process that owns the store (ADR-0050), so this half and a combined `run` over the same chain report the same numbers -- the ingest route is a caller of that path rather than the owner of it, and a receiver that both concludes a revert and serves the request that carried it counts it once. The same is true of the STREAM it stores (ADR-0052): the append happens inside the fold, before the batch is processed, so this half and a combined `run` over one chain store the same rows, and a store that cannot take a batch answers the sender a `500` having applied nothing -- its next push meets the cursor it already had, so nothing is lost and nothing is applied twice.

**It folds through the same GENERATION CONTAINER `run` does**, over the same durable registry, so a batch naming a fold this process has not seen creates a SUCCESSOR beside the live one instead of clearing anything -- and because the name resolves to a container rather than to a bare receiver, this half also answers the operator's surface over the pointer: `GET /{indexer}/admin/canonical-generation` lists the generations it holds and `POST` moves the pointer to one of them -- forwards to promote, BACK to revert -- guarded by its own `ADMIN_TOKEN`, which fails closed and is deliberately not the ingest credential (ADR-0057). That listing also says which SLOT holds each generation and which of them NO slot holds, and `POST /{indexer}/admin/reclaim-generations` is what takes the latter -- the row, the state namespace and the stream where nothing is left folding it -- so a cap that refuses is no longer the only instrument an operator has (ADR-0084). It never touches what a slot names, including the revert target, and it is a verb an operator runs rather than a sweep on a timer. Both used to answer `501 generations-not-held` here. `run` answers them too now, under the name it folds under: it holds generations, so it is a shape an operator may need to revert, and only INGESTION is refused there.

**How it stops.** `SIGINT` / `SIGTERM` shut the listener down and exit `0`. It never stops on its own: a receiver has no tip to reach, because what it folds arrives from somewhere else. A configuration it refuses, a module it cannot drive or a database it cannot open exits `1` without binding a port.

One thing it does not have yet: SEVERAL named indexers in one process. This is one name per process; hosting several is a registry with more entries in it rather than a change to the route.

## `etherfold serve` -- the READ tier

```sh
etherfold serve --db file:./etherfold.db --port 2000
```

**It only serves.** It holds no processor, makes no chain call, receives no logs and writes no indexed state: it answers queries over a database something ELSE wrote, so a serving tier can scale or move without carrying an indexer with it. Point it at a database `etherfold build` produced, or at the one `etherfold index` is folding into -- both carry the fixed tables, their reorg counters and the stream they folded, so a read tier reports the same numbers whichever shape wrote the database. (The FEED views are the one thing it cannot serve: validating a consumer's cursor needs to know which stream is served NOW, and only a process holding the receiver knows that.)

**It answers `/status` WITHOUT a cursor, and that is correct rather than missing.** The cursor reaches `/status` only through a reporter the host injects, and only a process that OWNS the store can read one; a read tier owns none and is given none, so its `/status` carries no `cursor` field at all rather than an invented one. What it does report is what the server derives from the DATABASE itself -- health, the schema version, the reorg counters -- so those agree with what the writer of that database reports.

**The one thing it resolves for itself is WHICH GENERATION ANSWERS.** A generation's state is a table-name namespace and a named indexer IS a database (ADR-0053), so naming a table is two steps and the first is the canonical POINTER. This command reads it out of the database it was pointed at and says so beside the URL it is listening on:

```
etherfold server listening on http://localhost:2000
  status: http://localhost:2000/status
  answering from the generation 1f0c… of the named indexer "my-indexer" (2 held)
```

It needs no name to do it -- `--indexer` stays refused here, and the rows carry the discriminator, so the read tier LEARNS which named indexer this database holds -- and it registers nothing, opens no registry and sweeps nothing, because a process that folds nothing must not delete a stream on its way to asking a question. A database nothing has folded into yet is reported as exactly that rather than refused: it answers as soon as a writer registers one. Anything reading the state itself does the same two steps (`canonicalGenerationIn` / `canonicalStateNamespaceIn`, exported from this package), which is what makes a promotion invisible to a reader beyond the answers changing once.

It starts [`@etherfold/server`](https://github.com/wighawag/etherfold/tree/main/packages/server) on Node through [`@etherfold/platform-nodejs`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs): `GET /status` (health, schema version, reorg counters, last error) and `POST /admin/setup`. Because it hosts no ingestion, the write path is a CAPABILITY it does not have rather than a route it lacks: an authenticated call to `/{anything}/ingest` answers `501 ingestion-not-configured` (an unauthenticated one answers `401`, so the absence of a processor is not something an anonymous caller can probe). `platforms/nodejs/test/serve.test.ts` asserts both.

The one thing it does write is the fixed-table SCHEMA, applied at startup if it is not already there, because the Node host is the single-operator case; `--no-auto-setup` turns that off and leaves migration to the operator.

| flag | |
| --- | --- |
| `--db <url>` | REQUIRED. The libSQL database to answer over (or `DB`). It is not defaulted, so a read tier never comes up on an empty database nobody named |
| `--port <port>` | port to listen on (or `PORT`). Defaults to `2000` |
| `--host <hostname>` | hostname to bind. Binds every interface when absent |
| `--no-auto-setup` | do not apply the fixed-table schema at startup |

The server's dependency tree is imported lazily, so `etherfold build` never pays for it.

## `etherfold upload` -- deploy a built bundle to a running node

```sh
ADMIN_TOKEN=… etherfold upload ./dist/processor.bundle.js --to http://indexer:2000 --indexer my-indexer
```

**It DEPLOYS, and it is not a way to run anything.** The five commands above are deployment intents; this one is a CLIENT of a deployment that is already running. It reads the bundle you built, sends its raw bytes to the node's `POST /{indexer}/admin/upload` (`Content-Type: text/javascript`, on the admin credential), and prints what the node did. The node registers the generation those bytes name as a SUCCESSOR beside the one answering reads, the successor catches up, and the node's own promotion policy (`--promotion` on its `run`) moves the pointer, so deploying a new version never serves a half-built state. The identity is the node's hash of the bytes (ADR-0086): nothing you pass says which generation it is.

**It only uploads; it never builds.** Produce the bundle first, with [the one build command](#producing-the-processor-bundle). A path naming an entry point that still imports something, or a build that has not run, is refused ON YOUR MACHINE before any request, with the same message and the same `esbuild` line every folding command's `--processor` gives.

**The exit code is the contract a pipeline reads.** `0` when the node answers `registered` (a new generation) or `unchanged` (these bytes are already what it folds, so a re-run on an unchanged commit stays green). `1` on everything else: a missing or refused input, the local self-containment refusal, a wrong credential (`401`), a bundle over the node's bound (`413`, 16 MiB), a bundle the node refuses (`409`: it throws on evaluation, carries no processor, or its contracts do not match a source the node was STARTED with), a node that serves no uploads (`501`) or names no such indexer (`404`), and a node that cannot be reached at all. The outcome goes to stdout and every failure to stderr, one `key: value` per line (`outcome`, `arrival`, `generation`, `status`, `error`, `reason`), with the node's reason printed as it gave it.

| input | |
| --- | --- |
| `<bundle>` | REQUIRED. The already-built, self-contained bundle, as the command's argument (or `-p`, the name every command gives the processor; not both) |
| `--to <url>` | REQUIRED. The running node's base URL (or `UPLOAD_TO`); `/{indexer}/admin/upload` hangs off it. Deliberately NOT `-n` / `ETH_NODE_URI`, which is the chain's endpoint: `-n` is refused here, and `ETH_NODE_URI` in the environment is never read as the target |
| `--indexer <name>` | REQUIRED, and never defaulted (or `INDEXER_NAME`). `run` defaults its own name to `default`, but a sender that defaulted would deploy to the wrong indexer without a word |
| `--admin-token <token>` | REQUIRED (or `ADMIN_TOKEN`, the name the node's guard reads). Prefer the variable: a secret on a command line is visible to every process on the host |

Everything a deployment is configured with -- the chain, the source, the database, the port, the promotion policy -- belongs to the node, so each of those flags is refused here with the reason. An upload carries its own contracts inside the bundle, and it is the node that checks them against a source ITS operator configured.

## Configuration: flags first, environment behind them

Every command resolves every input THE SAME WAY, which is what makes moving between them a deployment change rather than a rewrite. The rules:

- **A flag beats the environment**, the environment is used when the flag is absent, and neither present is a REFUSAL. Only the port falls back to a default (`2000`); nothing else does, because getting a database or a node URL wrong silently is how a deployment ends up believing something untrue.
- **One name per input**, and the variables are the ones a deployable already publishes: the fetcher host's (`INDEXING_SOURCE`, `ETH_NODE_URI`, `INGEST_ENDPOINT`, `INGEST_TOKEN`, `REQUESTS_PER_SECOND`) plus the Node server host's (`DB`, `PORT`).
- **A refusal names the flag AND the variable** that would have satisfied it, and it happens before the chain is dialled or a database is opened.
- **Nothing is accepted and ignored.** A flag a command does not own is refused with the reason it does not own it (`etherfold serve -p ./processor.js` says that a read tier holds no processor and points at `index` / `run` / `build`), rather than being taken and quietly having no effect. An ambient VARIABLE a command does not own is simply not read, so one host can run several commands side by side.

Some inputs have a variable and some do not, and the line is deliberate: **the environment carries what varies between deployments of one image** -- the chain, the source, the database, the wire, the port, when a successor takes over -- while a flag carries what the image IS: which processor module, which store, which retention window, which interface.

| variable | flag | |
| --- | --- | --- |
| `INDEXING_SOURCE` | `-d, --deployments` | what to index, as JSON (`{chainId, contracts}`) where the flag is a deployments folder |
| `ETH_NODE_URI` | `-n, --node-url` | the chain's JSON-RPC endpoint |
| `DB` | `--db` | the libSQL database |
| `PORT` | `--port` | the port an HTTP surface binds |
| `INDEXER_NAME` | `--indexer` | the NAMED INDEXER: what `fetch` pushes into and `index` hosts (required on both), and what the stream `run` or `build` stores is keyed on (optional there, defaulting to `default`) |
| `INGEST_ENDPOINT` | `--ingest-endpoint` | the indexer-server a `fetch` pushes to |
| `INGEST_TOKEN` | `--ingest-token` | the ingest wire's shared secret, the same name on both sides. Prefer the variable: a secret on a command line is visible to every process on the host |
| `REQUESTS_PER_SECOND` | `--rps` | the rate limit applied to the node |
| `PROMOTION_POLICY` | `--promotion` | WHEN a successor takes over answering reads: `on-catch-up` (the default), `immediate` or `manual`. `run` only |
| `UPLOAD_TO` | `--to` | the running node `upload` sends a bundle to. `upload` only |
| `ADMIN_TOKEN` | `--admin-token` | the admin credential `upload` presents. The commands that SERVE the admin surface read the same variable to check it, and refuse the flag |

The CLI used to read a second name for the node URL (`ETHEREUM_NODE`). It is RETIRED: there is one name for it, and it is `ETH_NODE_URI`, which is what the fetcher deployable already refuses by.

## The five names, the two compositions, and the sixth command

All five intents ship, and `CONTEXT.md` is the authority for what each one means. Two compositions hold in the CODE rather than in this sentence: **`run` IS `fetch` plus `index` plus `serve` in one process** (the first pairing is the in-process direct ingestion, the same log-fetcher and the same stream-builder with the transport removed), and **`build` is `run` without the serving**, stopping at the tip.

Which is why splitting is a deployment decision you can defer and then reverse. `packages/cli/test/equivalence.test.ts` asserts it at the commands rather than claiming it: the same processor, the same entity declarations and the same fixture chain -- reorg included, with the replacement branch carrying fewer events -- run once through `run` and once through `fetch` plus `index`, land on identical state and an identical cursor; and `index` plus `serve` against one database answer what `run` answers.

`upload` is the sixth command and not a sixth intent: it runs no deployment, it sends a bundle to one. It still takes its inputs from the same table, which is why moving a flag onto it that belongs to the node is refused with the reason rather than ignored.

All six rows of the configuration live in one table (`src/config.ts`), which is what makes moving between them a deployment change rather than a rewrite. Two asymmetries in it are load-bearing: `fetch` takes a source but no processor, and refuses `--store` and `--db` outright, because the chain-facing half holds no state (ADR-0003); and `index` resolves its source with NO chain call at all, so it takes it from `-d` or `INDEXING_SOURCE` and refuses a processor module that could only be resolved by asking a node for its chain id.

## Tests

`pnpm --filter etherfold test`, vitest.
