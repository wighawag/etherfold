# @etherfold/server

## 0.2.0

### Minor Changes

- ddcced5: `GET /{indexer}/feed` serves the RETRACTION-AWARE view over the stored emission stream: `seq`-ordered, `removed` entries included, resumed from an opaque cursor the caller holds. The first of ADR-0006's two views.

  This is the view for a consumer that WANTS to see reorgs (it acts optimistically on a log and cancels the pending action when the retraction arrives), so retractions are DELIVERED and `alive` is never consulted. Filtering on it, and a caller-supplied block gate, belong to the canonical view, which is the next task.

  ```
  GET /alpha/feed?limit=100
  {"success": true, "stream": "0x…", "entries": [{"removed": false, "blockNumber": 101, …}], "cursor": "<opaque>", "hasMore": true}
  ```

  **The cursor is OPAQUE, and it is VALIDATED rather than trusted.** It is a server-encoded string, not data a client parses: the same call ADR-0027 makes for the sync cursor, one step further out, because an encoding a client can read becomes a contract that can never change, and here the audience is not even ours (a consumer is built outside etherfold, ADR-0005). It CARRIES the view, the indexer name, the stream and the position, and the first three are never used to route. The route already routed; those copies exist so a MISMATCH is refused:
  - a cursor minted at indexer A and presented at B is `400 indexer-mismatch`, never re-interpreted. Two named indexers can hold byte-identical streams, so a position in one means nothing in the other. The refusal names the indexer the caller ADDRESSED and never the one its cursor was minted at.
  - a cursor for the OTHER view is `400 view-mismatch`, because the two views count in different spaces.
  - a cursor whose STREAM is no longer the one served is `400 stream-mismatch`, and it is the one refusal that ANSWERS: it carries the current stream's identity (`stream`) and a cursor at the position that stream's feed begins at (`startCursor`), so a consumer can re-subscribe deliberately. It is explicitly NOT a rewind: there is no fork block, because the logs a filter change produces were never on the old stream at all.
  - anything else is `400 invalid-cursor`, which says nothing about WHY on purpose: telling an edited cursor from an invented one would tell a client about the encoding.

  **Holes in `seq` are legal, and the read is built for them.** A page is `seq > <position> LIMIT n` and the next position is the `seq` of the last row actually served, never the previous one plus anything. Pair-compaction will create the holes later; this is what already has to be true when it does, and it is tested with page sizes smaller than the widest hole.

  **No position is published anywhere.** Entries carry the raw log and the `removed` verdict and no `seq`, because publishing one is how a consumer ends up incrementing it.

  `limit` defaults to 100 and is capped at 1000, and a larger one is REFUSED rather than silently reduced: a short page must always mean the stream is short.

  The feed is a PUBLIC read and is deliberately not behind `INGEST_TOKEN`, which guards the fetcher's private write API. It does need the named-indexer registry, because validating a cursor's stream means knowing which stream is served and only the registered receiver knows that. So a host built with no registry answers `501` here exactly as it does on ingest, and `etherfold serve` does not serve the feed today.

  New export: the `FeedEntry` type. The cursor codec is deliberately NOT exported; publishing a decoder would make the encoding a contract by the back door.

- 391dbf8: **`ExistingStream.fetchFrom` returns a VERDICT and no longer CLEARS anything** (ADR-0069).

  It was `Promise<{lastSync, eventStream} | undefined>`. It is now `Promise<StreamRead>`:

  ```ts
  type StreamRead =
  	| {status: 'stream'; lastSync: StoredLastSync; eventStream: StoredLogEvent[]}
  	| {status: 'absent'}
  	| {status: 'inconsistent'; reason: string}
  	| {status: 'does-not-reach-back'; startBlock: number};
  ```

  That `undefined` carried five meanings, four of which the keeper had just DESTROYED the subtree over, while the SQL reader used the same value for the same shapes having deleted nothing. Two implementations of one seam, opposite contracts, one return value. Three defects came out of it, and all three close here:
  - **A follower could delete its writer's stream.** `readOnlyStream` no-ops `clear` so a follower cannot damage the stream the indexing generation owns, but the clear happened inside `fetchFrom`, beneath the view. A snapshot-seeded generation keeps a stream starting at block N; its follower asks from the source's start block, hits `startBlock > fromBlock`, and wiped the writer's history. The guarantee ADR-0044 documented is now actually delivered.
  - **`installStreamSeed` had to probe from `Number.MAX_SAFE_INTEGER`** purely to avoid that branch. The probe is no longer destructive at any block.
  - **Damage and emptiness were the same answer to an installer**, masked only because the keeper destroyed the damage first. Damage is now refused rather than repaired-then-installed-over.

  **If you implement `ExistingStream`:** return the verdict, and stop clearing on a read. Report `inconsistent` with a reason and let the caller decide; the caller that wants a repair calls `clear` itself.

  **If you consume it:** narrow on `status`. `IndexerGeneration` is unchanged in behaviour -- it clears and re-indexes on every non-`stream` verdict, exactly as it did when the keeper did it for it -- so an app sees no difference.

  The write side is untouched: `saveNewEvents` still raises through to the caller that counts, paces and freezes, because a swallowed write failure would leave a HOLE.

- 0f33468: A NAMED INDEXER IS A ROUTE SEGMENT AND A REGISTRY ENTRY, on both halves of the wire.

  An indexer-server hosted exactly one indexer: `ServerOptions.getIngestion` resolved a single `LogIngestion`, and the ingest routes were the unnamespaced `/ingest` and `/ingest/expected-from-block`. It now hosts SEVERAL, each under a NAME an operator supplies at deploy time (ADR-0036).

  **`/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block` replace the unnamespaced pair, which is GONE rather than kept beside them.** The name is a ROUTE SEGMENT and is deliberately NOT a field in the envelope: putting tenancy in the wire format would turn a misdirected batch into a payload error rather than a routing one. ADR-0004's `{source, config}` envelope and its refusal families (`409` resumable, `400` otherwise) are untouched.

  **`ServerOptions.getIndexer` replaces `getIngestion`, and resolves a registry ENTRY per name.** The entry is an object (`{ingestion}`) so that what a name holds can grow — a later generation model gives one entry several live wire contexts — without every host's resolver changing its return type. `indexerRegistry({name: streamBuilder})` builds one from a plain record for a host that knows its names up front; a host whose names depend on the request writes the function itself. Two named indexers on one server are isolated: a batch pushed to one is not visible to the other.

  **An unknown name is REFUSED, never defaulted: `404 unknown-indexer`.** A routing refusal, matching what the name is, and distinct from `501 ingestion-not-configured`, which a host with NO registry at all still answers under every name (a read tier, or a combined `run`). Both are in the non-retryable 4xx family a sender must not re-send into.

  **`createHttpIngestion` takes the indexer name beside the endpoint** (`@etherfold/core`) and posts to the namespaced routes; it refuses to be built without one rather than addressing nobody. `@etherfold/fetcher-host` reads it from `INDEXER_NAME` and demands it wherever it demands `INGEST_ENDPOINT` and `INGEST_TOKEN`, so a combined host that configures no wire is still asked for nothing.

  **The CLI grows `--indexer <name>` / `INDEXER_NAME`, REQUIRED on `fetch` and `index` and refused on `run`, `build` and `serve`.** The two halves of a split deployment agree on one name the way they already agree on one secret: `fetch` addresses `/{indexer}/ingest`, `index` registers exactly that name and refuses every other. The three commands with no wire route no batch by name, and refuse the flag with that reason rather than accepting and ignoring it.

  `StartOptions.getIngestion` on `@etherfold/platform-nodejs` becomes `getIndexer`, carried through unchanged as before.

- 56fda62: A REBUILD IN PROGRESS is never an empty answer: it is VISIBLE on `/status`, and a read that would otherwise lie REFUSES.

  "Nothing here yet" and "this is still being built" must not arrive in the same shape — the same absence-versus-contradiction discipline the reorg model and `SuspectedTruncationError` already keep. Two surfaces, no new endpoint, and no new top-level field.

  **`/status` grows the GENERATION DIMENSION inside the `cursor` envelope, exactly where ADR-0047 reserved room for it.** A host's reporter now hands over the envelope's TWO SLOTS explicitly (`StatusReport`): `value`, where the generation that answers reads has got to, and `generations`, one entry per generation the host holds.

  ```
  GET /status
  {"healthy": true, "cursor": {
    "reported": true,
    "value": {"lastFromBlock": 4200, "lastToBlock": 4242, "latestBlock": 4250, "unconfirmedBlocks": 3},
    "generations": [
      {"generation": "9f…", "canonical": true,  "follows": false, "value": {"lastToBlock": 4242, …}},
      {"generation": "3c…", "canonical": false, "follows": true,  "value": {"lastToBlock": 1200, …}}
    ]}}
  ```

  - **An entry is `{generation, canonical, follows, value?}` and the server fixes every field but the last.** `generation` is the same OPAQUE digest the feed advertises (compared, matched against the admin listing, never parsed); `follows` is the established word for a generation advanced by a REBUILD over the stored stream rather than by the wire (ADR-0044), so `value` on such an entry IS how far its rebuild has got — its own sync cursor, which is the rebuild's only durable checkpoint (ADR-0056). Fixing the shape is also what finally makes the SIZE bound structural: the only free-form part left is `value`, which owes exactly what the top-level `value` owes.
  - **`reported` keeps its exact meaning — is there a CURSOR — and `generations` sits beside it on both branches.** A FIRST BUILD is what makes that load-bearing: it holds a generation and has folded nothing, so it has generations to report and no cursor, and folding the two together would throw away the half that says what is being built. A generation whose cursor cannot be read yet is reported with NO `value` rather than dropped from the listing or zeroed (a zero reads as "synced to block 0").
  - **A host that injects no reporter still carries no `cursor` field at all**, and a reporter that throws, rejects, returns nothing or hands over something unserialisable still degrades the whole envelope to `{reported: false, reason}` without failing the request or changing `healthy`.

  **BREAKING for a host that injects a reporter**: `getCursorReport` now returns `{value, generations?}` instead of the report itself, so `() => readCursorReport(store)` becomes `() => ({value: await readCursorReport(store)})` — or, on this repo's CLI, `readStatusReport({folds, canonical})`. The two slots are named explicitly rather than sniffed for, because `value` is reported VERBATIM and a host is free to put a key called `generations` inside it; inspecting the reported value to decide which shape it was is precisely the parsing ADR-0047 forbids.

  **A READ against a named indexer with NO CANONICAL GENERATION is REFUSED with `503 no-canonical-generation`, never answered as an empty page (ADR-0058).** Both feed views resolve the pointer through ONE place below the routes (`resolveCanonicalGeneration`), so there is one answer to "which generation answers this read" and one refusal when none does — and a surface added later (a read tier answering over a database written elsewhere) inherits it rather than having to remember it.

  ```
  GET /alpha/feed
  503 {"success": false, "error": "no-canonical-generation", "indexer": "alpha", "building": ["3c…"], "message": "…"}
  ```

  - **Why it cannot be a `200`**: a read against a name whose pointer names nothing finds no rows and would answer an empty page with `hasMore: false` — byte-identical to "you are caught up". That is ADR-0015's rule on the read side: a consumer holding an unresolvable address is TOLD, never served an answer it cannot tell apart from a true one.
  - **Why `503`**: nothing about the request is wrong (not the `400` family), the name resolved (not the `404`), and the host CAN serve feeds (not the `501` a host with no registry answers). What is true is that this indexer cannot answer YET, and a caller that retries once a generation is canonical will be served.
  - **What it does NOT refuse** is a canonical generation that has folded little or nothing. The question is WHICH generation answers and never how far it has got; a rebuilding generation is never the one answering, because the pointer moves at the END of a rebuild.
  - `IndexerRegistryEntry.canonicalGeneration()` may therefore answer `undefined`, and the admin route REPORTS that state (`canonical` absent, the generations still listed) rather than refusing it — which is the right way round: a read served from nothing is a wrong answer, while "nothing answers reads yet, and here is what is registered" is what an operator opened that route to see.

  **`readStatusReport` (`etherfold`)** is the reporter the folding commands now inject: one cursor read per generation, nothing computed on demand, and the canonical generation's answer reused as the top-level `value`. `run` and `index` hold ONE fold and report it as one generation, so the shape of `/status` does not depend on how many a deployment happens to hold; `readCursorReport` is unchanged and still summarises one store.

- ab779b0: Every deployment shape stores the emission stream it folded, not only the one behind an HTTP route.

  `appendEmissions` had exactly one call site, the HTTP ingest route, so `etherfold run` and `etherfold build` -- which fold through the direct in-process wire and touch no route -- produced databases whose `_emissions` table was EMPTY. That made the stored stream a fact about the TRANSPORT, exactly as the reorg counters were one task earlier (ADR-0050), and on worse ground: a `build` artifact is a publishable database later fed into another process, so without a stored stream a processor-logic change has to re-fetch the whole history from the node rather than re-fold what is already on disk, and both of ADR-0006's feed views were a split-shape-only surface.

  **The append is a port on the FOLD, supplied by whoever owns the store** (ADR-0052). `StreamBuilder.receive` hands each batch's emissions to an `EmissionAppender` once, whichever entrance the batch arrived through, and the ingest route is a CALLER of `receive` rather than the owner of a write -- so a receiver that both concludes a batch and serves the request that carried it stores it once, and `run`, `build` and `index` all store what they fold.

  **This write is NOT best-effort, and it is ordered BEFORE the fold.** A reorg count that cannot be persisted is a logged miscount; a stream that cannot be persisted is a HOLE -- a state that advanced past events the stream never received, which is silent, permanent, self-consistent and invisible to the gap check. So a store that cannot take the batch refuses the batch: nothing is processed, the cursor does not move, and the next cycle re-derives the same delta.
  - **`@etherfold/core`** gains `EmissionAppender` and `EmissionWrite`, plus `StreamBuilderOptions.appendEmissions`. Like `recordReorg` it is not hashed into the wire identity, and it is optional: a host that supplies none stores no stream, and folds identically. `IngestionOutcome.emissions` is unchanged and is still REPORTED, but a caller that stored it would now be storing a second copy.
  - **`@etherfold/server`** exports `emissionAppenderFor(db, indexer)`, which binds the append to a database and a named indexer. Its ingest route performs no durable write at all now: everything a batch costs happens inside `receive`, and the route decides who may call it and which status code each refusal is. A store failure is a `500` with `lastError` set, and the sender's own recovery is unaffected -- nothing was applied, so its next attempt meets the cursor it already had.
  - **`etherfold`** builds the appender in `buildProcessor`, beside the reorg recorder and against the same handle, so no folding command can store into a database it does not fold into. **`--indexer` becomes OPTIONAL on `run` and `build`, defaulting to `default`**, and stays REQUIRED and never defaulted on `fetch` and `index`. The never-defaulted rule protects the WIRE (a name a host was not built with must be a routing error, ADR-0036), and a combined process routes nothing: it needs a name only to KEY the stream it stores, which is `NOT NULL` on every emission row. `serve` still refuses the flag.

  **One behaviour change worth reading before upgrading:** `--no-auto-setup` against a database nobody has migrated now STOPS a fold rather than degrading it, because the fixed tables carry `_emissions` and a fold that cannot store what it folded must not advance past it. The cycle is retried and the deployment catches up when the schema arrives.

  `packages/cli/test/equivalence.test.ts` compares the stored streams of `run` and `fetch` plus `index` row for row and column for column, asserts the `build` artifact carries the same seven rows under the default name, drives a refused append and asserts it leaves no hole, and serves both feed views over a database a combined process folded. `packages/server/test/oneEmissionAppendSite.test.ts` scans the workspace and asserts there is no second site appending to that table.

- 793f3d6: EVERY FEED RESPONSE SAYS WHICH GENERATION ANSWERED IT.

  Both views over the stored emission stream (`GET /{indexer}/feed` and `GET /{indexer}/canonical`) now carry `generation` on every answer they give, pages and refusals alike, beside the `stream` they already carried.

  ```json
  {"success": true, "stream": "…", "generation": "<opaque>", "entries": [], "cursor": "<opaque>", "hasMore": false}
  ```

  **It exists for the one change no cursor check can catch.** A `seq` is a position in a STREAM, so a move to a generation over the SAME stream leaves every cursor valid, and a move to one on a DIFFERENT stream is already refused by the cursor's stream component. What is left is SAME LOGS, DIFFERENT FOLD: nothing in a cursor can see it, and a consumer reading state alongside the feed has to be told. The cursor is opaque, so a readable field beside it is the only thing a consumer can compare across polls.

  **The value is OPAQUE: compared, never parsed.** `generationDigestOf` (`@etherfold/core`) renders a `GenerationId` -- the stream digest plus the processor's version hash -- as one 128-bit hex digest, so what a generation is composed of can change without a consumer noticing. The registry keeps the two halves as separate fields because it KEYS on them; a value reported outward is not a key, and a consumer handed two named fields would read one of them.

  **A processor change costs a feed consumer nothing but the notice.** Its cursor stays valid, the delivered logs are byte-identical, and no generation column is added to the log table -- which is exactly what makes such a change free.

  **The platform ADVERTISES and does not DICTATE.** There is no rule about what a consumer does when the value moves: pausing, re-scanning and carrying on are all legitimate, and only the consumer knows whether its own actions can be taken back.

  **`LogIngestion` grows `generation`** (`@etherfold/core`), the `{stream, processor}` identity of the receiver, derived on every read rather than snapshotted: `getVersionHash()` covers a processor's configuration as well as its version, so a value captured at construction can stop being true. `StreamBuilder` supplies it; a host that implements the interface itself now supplies one too.

- 8bb063e: The server's FIXED tables move into the reserved `_` namespace: `Meta` becomes `_meta` and `EmissionStream` becomes `_emissions` (with its indexes `_emissions_canonical` and `_emissions_by_address_topic`). Nothing about what they CONTAIN changes: same columns, same keys, same two indexes, same semantics.

  It closes a silent collision. Entity tables are created as `CREATE TABLE IF NOT EXISTS "<entity.name>"`, and in every combined shape the store and the server share ONE database handle (`buildProcessor`), so a processor declaring an entity called `Meta` or `EmissionStream` issued that DDL against the SERVER's table: `IF NOT EXISTS` made it succeed silently, and the failure surfaced much later as a column error on a write, pointing nowhere near the declaration that caused it.

  The mechanism that closes it already existed, and the server's tables were simply outside it. `@etherfold/state-store` reserves the `_` prefix and refuses any entity inside it, and the store's own fixed tables already live there as `_blocks` and `_cursor`. Moving the server's two in makes the collision unreachable by CONSTRUCTION, with no new API, no dependency from the store to the server, and no widening of the entity legality rules. Parameterising the reserved set so a composing host declares its fixed names was considered and rejected: it grows optional API on the store for a guard that is off by default (a browser uses the store with no server at all) and relocates the discipline rather than removing it.

  The convention is now a GUARANTEE rather than a memory: a test scans `packages/server/src/schema/sql/db.sql` and fails if any table or index it creates does not begin with `_`, with a guard so an empty or unparsed scan cannot pass it. A fixed table added later without the prefix fails the gate instead of shipping a collision.

  There is NO migration and NO compatibility shim. The `schemaVersion` row lives in the table that was renamed, so a database migrated by an older build has no `_meta` and reports the schema as UNAPPLIED, which is the correct signal: those tables really did change. `SCHEMA_VERSION` therefore stays at `2` -- no database can hold a `_meta` row this build did not write.

  `EMISSION_STREAM_TABLE` still names the table for a host appending under a name it holds; its value is now `_emissions`. `@etherfold/state-store`'s reserved-identifier refusal is unchanged in behaviour, and its message and docstring now say the prefix means "not a user entity" rather than "the store's", since two packages place tables there. The CLI's reorg counters write to `_meta`.

- 56acbef: Every deployment shape counts the reorgs it concluded, not only the one behind an HTTP route.

  `etherfold run` reverted state on a reorg correctly and then reported `{absence: 0, contradiction: 0}` on `/status` for ever, because the counter was written by the HTTP ingest route and a combined process folds through the direct in-process wire and never touches it. `etherfold build` had no `Meta` table at all. So an operational counter was a fact about the TRANSPORT, and the shape the milestone calls the default was the one that could not report it. Nothing was mis-indexed: the fold was already correct in both shapes, and the equivalence suite proved it. What was missing was the observability, on the one `/status` field the two shapes did not agree about.

  **The count is taken where the reorg is CONCLUDED, and written by whoever OWNS the store** (ADR-0050). `StreamBuilder.receive` reports a concluded revert to a `ReorgRecorder` exactly once, whichever entrance the batch arrived through, and the deployment that opened the database supplies that recorder. The ingest route is a CALLER of `receive` now rather than the owner of a write, so a receiver that both concludes a revert and serves the request that carried it counts it once, and `run`, `build` and `index` all count.
  - **`@etherfold/core`** gains `ReorgRecorder`, `ReorgCounters`, `RecordedReorg` and the durable key names (`REORG_COUNTER_KEY`, `REORG_LAST_KEY`), plus `StreamBuilderOptions.recordReorg`. The keys live here because the writer and the reader are deliberately in different packages: a read tier owns no store and still has to answer "how many reverts does this database record". `recordReorg` is not hashed into the wire identity, since where a count goes is not something a sender asserts. `IngestionOutcome.reorg` is unchanged and is REPORTED rather than delegated: a caller that counted from it would count only on the shape it happens to be, and twice on the shape that is both.
  - **`@etherfold/server`** no longer exports `recordReorg` and writes no counters. It reads them (`readReorgCounters`) for `/status`, including on a read tier that folds nothing, and `ReorgCounters` is re-exported from core. Its dependency posture is unchanged: it still owns no store package.
  - **`@etherfold/platform-nodejs`** exports `ensureFixedSchema(db)`, the auto-setup step `startServer` already performed, so a process that binds no port can still create the fixed tables.
  - **`etherfold`** owns the one writer (`recordReorg`, `reorgRecorderFor`), built by `buildProcessor` against the handle the command folds into, so no folding command can count into a database it does not fold into. **`build` applies the fixed-table schema**, which it never did: it binds no port, so nothing else ever would, and a database it emits is a publishable ARTIFACT that must carry its provenance the moment it becomes an INPUT rather than an output.

  **A counter that cannot be persisted never takes down a fold or a request**, on any shape. That guarantee belonged to the route (`recordReorgSafely`); it lives in `StreamBuilder` now, so it is owed by every shape that counts.

  `packages/cli/test/equivalence.test.ts` drops the exception it carried and compares the `/status` counters between `run` and `fetch` plus `index` directly, through the reorg it already drives: the same counts, the same classification, the same block, and once each. `packages/core/test/oneReorgWriteSite.test.ts` scans the workspace and asserts there is no second site recording a reorg.

- ffe7c40: **Four defects that had been sitting in `work/notes/observations/` are fixed.**

  **An id VALUE containing U+0000 is refused instead of silently merging two rows.** `entityKey` joins the entity name and the id values with U+0000, and the memory and patch backends key rows on that string, so for `id: ['x', 'y']` the distinct keys `{x: 'a\0b', y: 'c'}` and `{x: 'a', y: 'b\0c'}` produced the SAME string: the second write overwrote the first and both reads answered with it. Reproduced before and after -- on `MemoryStateStore` the two writes were accepted and both reads returned `"second"`; they are now refused by name. The SQL backend kept them apart (separate columns) and IndexedDB did too (an array key), so the same processor meant different things per backend, which is the divergence the seam exists to prevent. Refused in `idValues`, beside the existing id-is-required refusal, rather than escaped: a length-prefixed join would change every key string for data that has never had this problem, to keep admitting a value no chain produces -- an id comes from decoded event args, where a string is an address, a hash or a decimal.

  **A `contractsData`-only processor module can resolve a source.** `resolveSource` fetched `eth_chainId` only inside the `contractsDataPerChain` branch, so a module exporting only `contractsData` -- the shape the docs describe as the fallback, and the one `--deployments` calls optional "where the processor module supplies its own contract data" -- always threw `no chainId found`, on the CLI and the server alike. It now asks for the id it needs, and only when it needs it: a module supplying no contract data at all still refuses without touching the chain. The test that had locked this in as "quirky, but preserved exactly" is replaced; it was not a quirk, it was a dead path.

  **An indexer-server can state a byte ceiling on an ingest batch, and refuse an oversized one with `413`.** A wire batch is bounded by block range and by event count, and neither is a bound in BYTES: the size of a decoded batch is not known until it is built, so an ABI with large `bytes` arguments defeats a count at any setting. A receiver read the whole body into memory before it could check anything about it and answered no `413`, so its limit was whatever its runtime died at. `ServerOptions.maxIngestBytes` is optional and has NO default, deliberately: only a host knows its own ceiling (a Worker has a request limit, a Node process does not), and nothing has measured what a decoded batch costs per log for a realistic ABI, so a number invented here would be a guess. When set, the declared `Content-Length` is checked before the body is buffered, with the actual size as a backstop for a chunked request. The WHOLE batch is refused and the limit is named, because ADR-0004 forbids delivering part of a range -- a short payload is read as an absence, concluded as a reorg, and reverts state -- so the sender lowers `toBlock` and re-sends from the same `fromBlock`. It is deliberately not a `409`, which means "re-send from THIS block" and would have the sender skip the range it never delivered.

  The remaining half of that last one is unchanged and still open: bounding a batch by bytes at the SENDER needs an estimate computed where the payload is built, next to the truncation guard that already lowers `toBlock`. What this adds is the receiving half, so the ceiling is stated rather than discovered.

- f5fb4d2: One named indexer receives logs for SEVERAL LIVE STREAMS at once, so a filter change can build a successor while the incumbent keeps being fed and keeps answering.

  A FILTER or CONFIG change makes a NEW STREAM, and therefore a new `{source, config}` on the wire. With one receiver per name a successor on one could not receive a single log: `assertContext` refused its batches with the `400` that is deliberately not resumable, so it starved while the incumbent went on being fed. The route now selects the INDEXER by its segment and the batch's own `{source, config}` selects WHICH receiver inside it.

  **`IndexerRegistryEntry` is now two questions rather than one field** (`@etherfold/server`). It was `{ingestion}`; it is now `liveIngestions(): Promise<readonly LogIngestion[]>` (one receiver per LIVE wire context, at most one per stream, since a stream is ONE address on the wire) and `canonicalGeneration(): Promise<GenerationId>` (which generation answers reads). Both are ASKED rather than read, because only the generation registry answers them honestly: a generation deleted elsewhere stops being live, and the canonical pointer moves, without a host being told.

  ```ts
  // a host holding one receiver, unchanged in behaviour
  getIndexer: indexerRegistry({alpha: myStreamBuilder}); // or singleContextEntry(myStreamBuilder)
  // a host holding generations: the container answers both questions itself
  getIndexer: (_c, name) => (name === 'alpha' ? myReceivingIndexer : undefined);
  ```

  **`POST /{indexer}/ingest/expected-from-block` answers `{success, contexts: [{context, expectedFromBlock}, ...]}`**, one entry per live context, and no longer a single top-level `{expectedFromBlock, context}` pair. This is a deliberate RESPONSE-SHAPE change and the widening of what the route already did: it returned its `context` beside the number precisely so a sender knew which receiver it had reached, and one pair could only ever have named one of several — silently. It is also what lets one fetcher host later run one fetch loop per context, which is not built here.

  **The ASK NAMES THE ASKER on the sending side.** `IngestionTarget.expectedFromBlock(context)` takes the `{source, config}` the sender pushes; `LogFetcher` passes its own, and `createHttpIngestion` finds its entry in the list. A list holding no entry for this sender is an `IngestionRefusedError` with code `context-mismatch` — non-retryable, raised before a single log is fetched, and the same fact as the `400` a foreign batch earns one round trip later (over HTTP this replaces the `WireContextMismatchError` the fetcher used to raise from the ask; both are fatal and neither is resumable). `createDirectIngestion` holds one receiver and ignores the argument.

  **The refusal families are unchanged.** `409` is still the ONE resumable refusal, an unknown name is still `404`, a host with no registry is still `501`, and a context no live receiver holds is still a `400 context-mismatch`. What changed is that its `expected` field is now an ARRAY naming EVERY live context rather than a single one — the same choice `GenerationCapReachedError` makes when it names every deletable generation instead of picking one.

  **A live context has a LIFETIME, and it is DERIVED FROM THE REGISTRY.** `ReceivingIndexer.add(spec)` builds a fold beside the ones already held — its own state, its own processor, its own receiver — and registers it, which is the moment its context becomes live; a cap refuses there, with nothing partial left behind. It stops being live when its generation is DELETED (and its stream reaped with it, if it was the last on it), and a batch for it is then the ordinary `400`. Deliberately NOT derived from the canonical pointer: a superseded generation is RETAINED under the caps, so "the successor became canonical" is not by itself a reason to stop feeding the old context, and what that rule should be stays a policy input rather than a rewrite of this routing.

  **A second receiver on a stream already held is REFUSED.** A batch carries `{source, config}` and nothing that could tell two folds over one stream apart, so the second would be reachable only by iteration order. Such a fold is a PROCESSOR-change successor, and ADR-0044 already says how it advances: it re-folds the stream the writer stores, rather than being fed the same batches twice. `ReceivedGenerationSpec` accordingly takes `source` (and now a per-fold `stream` config), which is the only way to say "a different stream".

  **Both feed views answer from the CANONICAL generation alone**, its stream and its fold read TOGETHER once per request, so a response can never pair one generation's stream with another's fold. A successor being fed under the same name is invisible to a consumer until the pointer moves; when it does, a cursor for the old stream meets the existing `400 stream-mismatch`, which is explicitly not a rewind.

  `sameWireContext` is exported from `@etherfold/core`, because the host that selects a receiver must apply the same comparison the receiver would apply to refuse it — a second copy could select a receiver that then refused the batch.

  `@etherfold/platform-nodejs` and `etherfold` carry no new behaviour: they pass the registry through, and each now builds the widened entry (one live context each) where it used to build `{ingestion}`.

- 20fecac: Optional PAIR-COMPACTION over the stored emission stream: a retracted entry reclaimed TOGETHER WITH its retraction, far below finality, OFF BY DEFAULT (ADR-0006). New exports: `compactEmissionPairs`, `resolvePairCompaction`, `COMPACTION_OFF`, `DEFAULT_MAX_PAIRS`, and the `PairCompactionSetting` / `PairCompaction` / `PairCompactionOptions` / `PairCompactionQuery` / `PairCompactionReport` types.

  ```ts
  import {compactEmissionPairs, resolvePairCompaction} from '@etherfold/server';

  // at startup, so a bad depth is a boot failure and not a 3am surprise
  resolvePairCompaction({blocks: 50_000}, {finality: 64});

  // on whatever cadence THIS host wants
  const report = await compactEmissionPairs(db, {
  	indexer: 'alpha',
  	stream: ingestion.streamDigest,
  	compaction: {blocks: 50_000},
  	finality: 64,
  	latestBlock: tip,
  });
  // {floor: tip - 50_000, pairsCompacted: 12, rowsDeleted: 24, scanned: 24, complete: true}
  ```

  **It is safe because it is ANSWER-PRESERVING for the canonical view by construction**, and that is asserted rather than claimed: it only ever removes rows that are already `alive = 0`, which that view already excludes, so `GET /{indexer}/canonical` returns a BYTE-IDENTICAL response over the same gate before and after a compaction. The only consumer that can observe it is one following the `seq` stream further behind than finality, which is already outside the window it may rely on. A from-genesis replay is unaffected too: an apply/retract pair has no net effect on a reducer whose revert is exact.

  **The depth is BLOCK NUMBERS and no other unit, with the finality depth as its FLOOR** (ADR-0019, the same rule retention lives under). `{blocks: N}` or `'off'`; a duration, a count or a bare number is refused naming the one unit there is, because time would compact on wall-clock progress rather than chain progress. A depth that would compact at or above `latestBlock - finality` is **REFUSED naming both numbers and never clamped** to the floor: inside that window a retraction can still arrive, and a silent correction would leave an operator believing something untrue about the deployment. A depth exactly AT the floor is legal, and compacts strictly below it.

  **Compaction is a call the HOST SCHEDULES** (ADR-0022), wired to no route and no timer: off-by-default is nobody calling it, not a flag this package reads. Appending never compacts, because the cost is proportional to what it drops and a browser tab, a backfilling CLI and a long-running server want three different cadences. **One call does bounded work**: it reads at most `maxPairs * 2` candidate rows and deletes at most `maxPairs` pairs, naming every row by its `seq` in statements chunked to 100 bound parameters (D1's cap), inside one batch. `complete` says whether the scan reached the end, so an amortised policy and a whole sweep are both expressible without the store inventing a cadence.

  **A pair goes together or not at all.** A pair is one dead application (`removed = 0, alive = 0`) and one retraction (`removed = 1`) of the same `(blockNumber, blockHash, logIndex)`; both `seq` values are named in one statement inside one batch, an unmatched row is left alone, and a LIVE row is never a candidate however old. `seq` is never renumbered: compaction leaves HOLES, which are legal by contract and which both feed cursors already tolerate.

- 08d39d8: `/status` REPORTS THE CURSOR, through a reporter a host injects beside its database.

  **`ServerOptions.getCursorReport` (`@etherfold/server`)** — optional, injected exactly like `getIngestion` and for the same reason: only the process that OWNS the store can read a cursor, and this package has no store dependency at all. It may be async, because reading a cursor is a store read rather than a handle a host already holds. A host with no store (the Cloudflare Worker host is one) injects none, and its `/status` carries no `cursor` field rather than an invented one.

  **`GET /status` gains `cursor`** — an OBJECT, never a bare value (ADR-0047): `{reported: true, value}` carrying whatever the reporter returned, unparsed and uninterpreted, or `{reported: false, reason}`. The server owns the envelope and the host owns the contents, because the sync cursor is an opaque string behind the storage seam and only the processor knows what one means (ADR-0027). It is an object so the GENERATION dimension can grow INSIDE it later — an indexer already holds several generations and reports progress per generation, the server does not hold them yet, so a later host adds a key beside `value` instead of re-typing a field clients already read.
  - **A reporter owes the server a SMALL, JSON-serialisable summary and never the store's raw serialized cursor**, which is a `LastSync` carrying an unconfirmed window of decoded events. The constraint is stated on the option because `/status` reports verbatim: the server cannot bound what it does not parse. The reporter's return type is JSON-shaped, so a `bigint` does not compile.
  - **A reporter cannot take `/status` down.** Throwing, rejecting, having nothing to report, or handing over something that cannot be serialised all degrade to `reported: false` with a reason; none of them fails the request or changes `healthy`, exactly as the reorg counters already degrade in that route. The serialisability probe is deliberate: an unserialisable report would otherwise throw inside `c.json`, where nothing can degrade it, and answer `500` on the page an operator watches while something is wrong.

  Nothing in this change wires a real store to a real server: the processes that own one are the CLI's commands, which arrive with `one-command-runs-the-whole-pipeline`.

- 114879f: **`ReplaySource.readChunk` returns a VERDICT, and `RebuildReport` says WHY a chunk stopped** (ADR-0070). This finishes ADR-0069, which corrected `ExistingStream.fetchFrom` and missed its bounded sibling reading the same `_emissions` rows.

  ```ts
  type ReplayRead<ABI> =
  	| ({status: 'chunk'} & ReplayChunk<ABI>)
  	| {status: 'absent'}
  	| {status: 'does-not-reach-back'; startBlock: number}
  	| {status: 'inconsistent'; reason: string};
  ```

  `readChunk` returned `undefined` both for "nothing has ever been stored here" and for "a perfectly good stream that starts ABOVE where this fold resumes". The first is transient -- the writer may append. The second recurs on every call for ever, because the resume point comes from the fold's own durable checkpoint, and a **seeded** stream is the shape that produces it. Collapsed, a host could only keep polling: `origin.level` stayed false, so the follower never inherited a vacant write duty and never promoted, while burning a scheduled invocation per cycle and reporting it as an ordinary "not finished yet".

  `RebuildReport.absent` is **replaced** by `stopped: RebuildStop` (`stream-consumed` / `budget` / `nothing-stored` / `does-not-reach-back` / `undecodable` / `inconsistent`). `complete` now answers one question, as `PruneReport.complete` does. Three stop reasons cannot be fixed by retrying, and **`retryCanAdvance(stopped)`** is the exported derivation that says which -- previously the only discriminator was an undocumented `toBlock === undefined && !absent`.

  **If you implement `ReplaySource`:** return the verdict. `inconsistent` has no in-repo producer and exists so a third-party store has somewhere to report damage.

  **If you schedule `rebuildMore`:** loop while `!report.complete && retryCanAdvance(report.stopped)`. Both halves matter -- `complete === false` alone spins for ever on three of the six reasons, and `retryCanAdvance` alone never stops, since it is true once the stream is consumed too.

- a6963b4: The canonical pointer moves BACK: an operator undoes a bad upgrade with one small write, and the previous generation answers exactly as before, with no re-index and no re-fetch.

  **`POST /{indexer}/admin/canonical-generation` (`@etherfold/server`) is the operator's affordance** (ADR-0057), guarded by a NEW `ADMIN_TOKEN` that FAILS CLOSED when unset. Forwards it promotes, BACKWARDS it reverts, and there is deliberately no second verb for the second direction: it is one record write.

  ```
  POST /alpha/admin/canonical-generation      Authorization: Bearer $ADMIN_TOKEN
  {"stream": "<stream digest>", "processor": "<version hash>"}
  -> 200 {"previous": {...}, "canonical": {"stream", "processor", "digest"}}
  ```

  `GET` on the same path is how an operator learns what there is to point AT: which generation answers reads now, and every generation this name holds, each with the OPAQUE `digest` a feed response advertises it by (compared, never parsed), so the advertised value is matched against the listing rather than taken apart.

  **It is an HTTP route because that is the only affordance every deployment shape has.** A Cloudflare Worker is reachable only over HTTP, so a flag on a command could never serve one, and the command set is pinned at five verbs. The CLI inherits the route by hosting the same app.

  **`ADMIN_TOKEN` is a SECOND credential and deliberately not `INGEST_TOKEN`.** That one is handed to a log shipper and guards the WRITE path; letting it also decide which generation answers reads would give a fetcher control-plane authority. The two guards now share ONE constant-time comparison (`api/auth.ts`), so "is a token accepted" has one answer rather than two that drift. `POST /admin/setup` is untouched and stays unauthenticated.

  **`ReceivingIndexer.promote` no longer requires this host to hold a FOLD for the target** (`@etherfold/core`). Reads on this runtime resolve the pointer to a table NAMESPACE (ADR-0053), so the generation reverted to answers with no engine at all -- which is the ORDINARY case, since a host redeployed with the new processor holds only the new fold. Requiring one would have meant a revert could only be performed by a process first rebuilt with the OLD processor, which is the re-index the design exists to remove. The refusal is now the registry's `UnknownGenerationError` (surfaced as `400 unknown-generation`, naming every generation the name holds) instead of a container-level "holds no fold" error.

  **A BACKWARDS move drops NOTHING, under any promotion config.** `ReceivingIndexer` now tracks whether the pointer has EVER named a held fold -- the chain-facing container's `everCanonical` flag, as a set -- and drop-on-promotion applies only to a FORWARD move: a revert supersedes nothing, and dropping what it moved away from would delete the very generation a second move forward wants (ADR-0046).

  **`IndexerRegistryEntry` gains two OPTIONAL questions**, `generations()` and `promote(id)`, which `ReceivingIndexer` already answers and `indexerEntryOn` forwards. A host holding one fold and no registry (`singleContextEntry`) answers `501 generations-not-held` on the admin surface: a capability that deployment lacks, not a route that is missing.

- 6c321a1: `GET /{indexer}/canonical` serves the CANONICAL view over the stored emission stream: live entries only, ordered by `(blockNumber, logIndex)`, at or below a block gate the CALLER supplies. The second of ADR-0006's two views, and the one for a consumer that never wants to hear the word reorg, so its entire sync state is one advancing position.

  ```
  GET /alpha/canonical?gate=4200000&limit=100
  {"success": true, "stream": "0x…", "entries": [{"blockNumber": 101, "blockHash": "0x…", "logIndex": 0, …}], "cursor": "<opaque>", "hasMore": true}
  ```

  An entry here carries **no `removed` field at all** (new `CanonicalEntry` type, exported beside `FeedEntry`). A flag that is false on every entry a view can ever serve is an invitation to write `if (entry.removed)` handling that can never fire, which is exactly the reorg handling this view exists to remove.

  **`gate` is REQUIRED and is never defaulted** (`400 invalid-gate` when absent or malformed). A consumer that only wants settled data passes a low gate and one that wants the tip passes a high one (ADR-0007's two lanes); how deep a consumer trusts the chain is the consumer's decision, and this system deliberately knows nothing else about a consumer (ADR-0005). Every candidate default is wrong for somebody and none of them says so.

  **Because it hides reorgs, it owes the compensating guarantee.** The cursor carries the block HASH the consumer last saw and the server validates it on every request. A cursor whose block is no longer canonical is answered with a REWIND and never a page:

  ```
  409 {"success": false, "error": "rewind-required", "stream": "0x…", "forkBlock": 103, "rewindCursor": "<opaque>", "message": "…"}
  ```

  `forkBlock` is F, the lowest block the consumer must read again, and it is the one thing no cursor can say for it: it must also roll its own derived state back to before F. `rewindCursor` is a cursor at F meant to be PRESENTED next, and it is named to say so, unlike the stream mismatch's `startCursor`, which is a place to BEGIN a new subscription and a decision a human takes. Continuing from the consumer's own position instead would serve the new branch from `(blockNumber, logIndex)` onward and silently skip the replacement blocks BELOW it, which is exactly the events it never received. That is also why it is a non-2xx rather than a `200` carrying an instruction: a consumer that ignores a field it does not know would read that as "caught up".

  It is a `409` and not a `400` deliberately. ADR-0004 already makes `409` the one RESUMABLE refusal in this system ("your position is not where mine is, carry on from here") and this is that same sentence spoken to a consumer; every other cursor refusal on this surface stays a `400`, because no amount of re-presenting the same cursor makes any of them right.

  **One hash check is provably enough**, because a reorg invalidates a contiguous suffix: if the block at the cursor is still canonical then the whole prefix behind it is too. Nothing walks back over the window. The fork block is the lowest block the stream has retracted anything at SINCE the cursor was minted, so a second, deeper reorg moves the answer DOWN rather than stranding a consumer at the first fork.

  **ONE cursor codec across both views.** The canonical view adds its block hash and its mark to the shared opaque envelope rather than minting a second encoding; two encoders would be two refusal paths that drift. The view is carried inside the envelope and validated, so presenting one view's cursor at the other is a `400 view-mismatch` and never a position read in the wrong space. `limit`, the `indexer-mismatch` / `stream-mismatch` / `invalid-cursor` refusals, the `501` / `404` registry answers and the public-read stance are all the feed's, unchanged.

  New exports: the `CanonicalEntry` type. The cursor codec is still deliberately not exported.

- 2c62a30: The five CLI commands hold GENERATIONS exactly as a deployed server does, so what a developer tests locally is what deploys -- and `build` holds exactly ONE.

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

- 2e10f5e: The indexer-server now STORES the emission stream (ADR-0006): an append-only `EmissionStream` table in the FIXED schema, written by `/{indexer}/ingest`, with retractions included and superseded rows FLAGGED rather than deleted. `SCHEMA_VERSION` moves to `2`.

  Every row carries the two DISCRIMINATORS, both structurally part of every read and write and neither ever defaulted: the INDEXER NAME (the route segment, ADR-0036) and the STREAM. The stream's value is the WIDE digest `streamDigestOf` builds and deliberately NOT the wire context's `{source, config}`: that is a 32-bit whole-entry hash kept whole on purpose as an identity check between the two halves of a deployment (ADR-0034), and as a KEY it fails twice. A decode-only change (a regenerated ABI, an added view function, a renamed non-indexed parameter) moves it while the fetch filter is untouched, orphaning every row already stored, and 32 bits collide, which here means one indexer silently adopting another's logs.

  Nothing about the PROCESSOR is a column and there is no GENERATION column. The stream is keyed on `{source, config}` and only the state on `{source, config, processor}`, so a processor-only change is a new generation over the SAME stream; a column carrying the processor would fork this whole history on exactly the change the generation model promises is free.

  The columns a later API depends on are created NOW rather than migrated in later: `address` and `topic0..topic3`, with ONE composite index on `(indexer, stream, address, topic0, blockNumber)` and `topic1..topic3` stored but UNINDEXED, to be filtered after the range scan (the shape decided in `work/specs/proposed/node-log-api.md`; indexing all four roughly doubles the table's index footprint against D1's 10GB ceiling). `alive` gets the partial index that makes the canonical view a cheap derived read.

  It is in the fixed schema and not dynamic DDL because two application paths must produce the same database and one of them is wrangler's D1 migration, which executes `db.sql` and nothing else; a test now runs the file the way wrangler does and compares the result against `applySchema`.

  `appendEmissions`, `EmissionAppend` and `EMISSION_STREAM_TABLE` are exported, so a host that routes batches some other way can append under a name it holds.

- 01ed0ef: The generation registry is DURABLE on SQL: which generations a named indexer holds and which one is CANONICAL are now rows in the database the server and the CLI already own, so a restarted process comes back holding what it held and pointing where it last pointed.

  `openGenerationRegistryOnSQL(db, indexer, {caps, dropState?})` (`@etherfold/server`) is the third substrate for the port `openGenerationRegistry` already defines, after the reference one in memory and the IndexedDB one in `@etherfold/browser`. It supplies rows and inherits every rule: registration resolving an already-registered generation, the caps that REFUSE at the bound and evict nothing, the deletion that refuses the canonical generation, the reaping of a stream whose last generation goes, and the sweep of subtrees no registered generation claims. Two fixed tables carry it, in the reserved `_` namespace and in the static schema file both application paths share (`SCHEMA_VERSION` is now 3): `_generations` (the records) and `_generation_pointer` (one small row per named indexer: the canonical identity, and the guard below). `listStreamDigests` and `dropStreamSubtree` answer over `_emissions`, which is where a stream physically lives on this runtime, scoped to one indexer name.

  **A commit is atomic over a seam that cannot hold a transaction open across a decision** (ADR-0054). `RemoteSQL` is `prepare` + `batch`, and a batch is a pre-built statement list, so a commit reads the state together with a REVISION token, guards every statement it writes on that token, swaps it for a fresh unique one as the last write of the same batch, and reads it back inside that batch to learn whether it won. A loser's whole batch applies to nothing and it re-reads, re-decides and retries; after `MAX_COMMIT_ATTEMPTS` losses it refuses with `GenerationCommitContentionError` rather than looping. So a cap decided by two writers at once cannot be beaten: the refusal is always made from the state the write actually lands on, never from one that had moved on.

  **The WRITER of a stream is now the OLDEST SURVIVING generation held on it** (`writerOf`, `@etherfold/core`; `GenerationRegistry.writerOf`). ADR-0044 said the writer is the first generation held on a stream and never the canonical one, and said nothing about that generation being DELETED, which unhandled is a silent stall: the receiver for a shared stream's wire context is the writer. The rule is RESTATED rather than replaced (at the start the oldest survivor IS the first one held) and succession is atomic with the delete because it is stored NOWHERE: there is no writer column to move in a second write, so the commit that removes the record is already the one that hands the duty on. See ADR-0044's amendment, which also names where the engine half lands.

  The CAPS are stored nowhere by this substrate: no caps table, no caps column, no sixth port operation, and `openGenerationRegistryOnSQL` defaults none, because how generous a server or a CLI should be is a deployment's statement and not a substrate's.

- ed8e7ff: What the fetcher has learned about your provider is now READABLE, and can be handed BACK on the next start. Nothing persists it, and that is the decision rather than an omission (ADR-0074).

  The range fetcher works out how wide an `eth_getLogs` range a node will answer by asking, being refused and adapting. It tracks three numbers, all in blocks: a `ceiling` it has been refused at (or that the provider wrote out in its refusal), the widest `safeSpan` that has actually been answered, and the `nextSize` it will ask for next. All three lived in private fields, invisible from outside and gone on restart, so every process start re-paid the discovery from the 50-block starting range upwards and an operator could only infer any of it from timings.

  **`LearnedRange` is now a published type, reported and accepted back.** `LogFetcher.learnedRange` reports it, `LogFetcher.limits` reports it beside `suspectResultCount` (the count and its source, which the previous change made readable but left off every status surface), and `fetch.learnedRange` accepts the same object as configuration. A field is ABSENT rather than zero where nothing has been learned, because a ceiling of `0` reads as "this provider serves nothing" and that is not what "nothing learned yet" means.

  **`GET /status` gains `fetcher`**, from a reporter a host injects beside its cursor reporter (`ServerOptions.getFetcherLimits`, carried through `@etherfold/platform-nodejs`): `{reported: true, learnedRange, suspectResultCount}`, or `{reported: false, reason}` when a reporter cannot answer. It is ABSENT entirely on a host that holds no fetcher, which is most of them -- the receiving half of ADR-0003 makes no chain call at all, so `index`, `serve` and the Workers host carry no such field and nothing is invented in its place. `etherfold run` holds both halves and injects one.

  Unlike the `cursor` beside it, the field is TYPED rather than opaque. A cursor's meaning lives behind the storage seam and belongs to a processor (ADR-0027), which is why ADR-0047 has the server carry it verbatim; a learned range is `@etherfold/core`'s, it is three numbers, and it hides behind no seam -- so a dashboard reading `fetcher.learnedRange.ceiling` reads a documented field. What is kept from ADR-0047 is the half that still applies: a reporter that throws, rejects or has nothing to say degrades to a reason rather than to an omission, because "this deployment runs no fetcher" and "this deployment's reporter is broken" are different news, and neither ever fails the request or changes `healthy`.

  **`LEARNED_RANGE` is the door it comes back in by** (`@etherfold/fetcher-host`, so `etherfold run`, `build` and `fetch` all read it): the reported object, pasted back as JSON. Then the first request asks for what the last run found to work. It is a STARTING POINT and never a promise -- every number is still bounded by `MAX_BLOCKS_PER_FETCH`, adaptation runs over it unchanged, and a provider that has tightened since refuses it and lowers the ceiling on that first round trip, so a stale value costs a retry and can never wedge. A partial object is legitimate (`{"ceiling":2000}` alone is a real thing to know), and an unrecognised key is IGNORED rather than refused, so a report that grows a field does not turn a supervisor that pastes it into an outage. What IS refused, at startup and naming the field, is a value that cannot be read at all: not JSON, not an object, or a member that is not a positive whole number of blocks. The startup line says when a range was remembered, so an unexpected first span is attributable.

  **Nothing is written to any store, by design.** `LogFetcher`'s docstring states the test for state the chain-facing half may hold -- losing it must cost ONE extra request and nothing else -- and the learned range fails it, since losing it re-pays the walk up from the starting range. It is still only performance, so the answer is to move the memory OUT of the stateless component rather than to give that component a store: a fetcher that writes something down can be restored from a stale copy of it, owns that copy's lifecycle, and has a place for the next block number to be put, which is the split brain ADR-0004 exists to remove. Pushing it to the receiver was rejected on its own ground: it puts a fact about ONE SENDER'S PROVIDER into a wire contract that deliberately carries no sender identity.

  A deployment that configures nothing behaves exactly as it did before, byte for byte: the discovery spans a fetcher walks through against a refusing provider are asserted unchanged.

- 449f6fb: A processor upgrade costs a LOCAL SCAN: a successor catches up by REPLAYING the stored emission stream, in bounded chunks against a durable checkpoint, and the canonical pointer moves once at the end.

  **`GenerationRebuild` (`@etherfold/core`, `generation/rebuild.ts`) is the driver**, and it is platform-neutral: a Node cron, a CLI loop, a browser idle callback and a Cloudflare queue can each drive it. One call does a bounded amount of work and REPORTS whether it finished, which is the shape `prune` and `compactEmissionPairs` already have (ADR-0022) — never a side effect of a write.

  ```ts
  const [report] = await indexer.rebuildMore({maxEmissions: 500});
  // {generation, fromBlock, toBlock, scanned, replayed, retracted, highWater, complete, absent}
  while (!report.complete) {
  	/* re-invoke; a serverless host enqueues itself instead of looping */
  }
  ```

  **The CHECKPOINT is the successor's own sync cursor, and there is no second durable value.** A chunk is applied through `EventProcessor.process`, which persists the `LastSync` describing each block in the SAME transaction as that block (ADR-0027), so "the state and the checkpoint commit together" is the guarantee the storage seam already makes rather than one this driver arranges. `GenerationRebuild` holds NO position between calls: a new process, a new isolate or a new container over the same database resumes from what the store committed.

  **A chunk is a budget in EMISSIONS, cut on a BLOCK boundary, and always ending ABOVE the fold's own position (ADR-0056).** The stored stream is `seq`-ordered and a reorg puts an application, its retraction and its replacement at ONE block at arbitrarily separated `seq` values, so a chunk ending mid-block would leave rows below its own resume point and skip them for ever. And a resume point REACHES BACK over the reorg window, so a budget spent inside blocks the fold already covers would cut the chunk where the fold already is and the same chunk would be asked for for ever — hence `ReplayChunkQuery.foldedThrough`. The budget is therefore advisory in those two places, both bounded by something else, and `RebuildReport.scanned` says how many rows were really read. `DEFAULT_MAX_EMISSIONS_PER_CHUNK` is 2000.

  **"Caught up" is measured against the stream's own COVERAGE CLAIM**, which moves on every batch including the quiet ones (ADR-0055), and therefore in the same space the promotion trigger already compares in. The emission `seq` high-water is READ and REPORTED on every chunk (`RebuildReport.highWater`) as the honest size of what is being folded, but it is not the predicate: see ADR-0056 for why it cannot be one without a second durable checkpoint.

  **`storedEmissionReplaySource` (`@etherfold/server`) is the read it consumes**: the same `_emissions` rows as `storedEmissionStream`, in bounded slices, over the coverage claim (ADR-0055) so a fold resumes past a quiet range rather than at its last log. It is read-only by construction — the port has no write on it at all — which is the one-writer rule (ADR-0044) as a type rather than as a no-op.

  **`ReceivingIndexer` now DETERMINES follower-or-receiver from the stream, and never from a flag** (ADR-0044). A fold on a stream the container already holds is a FOLLOWER: no receiver (a stream is ONE address on the wire), a `GenerationRebuild` instead, and `HeldFold.follows` reports it. `ReceivingIndexerOptions.replay` supplies the stream to re-fold, and a container given none REFUSES such a fold rather than registering a generation that could never advance. `HeldFold.ingestion` is consequently optional; `liveIngestions()` is unchanged for callers, and `ReceivingIndexer.ingestion` still answers for the fold a host opened with.

  **The pointer moves ONCE, at the end, and the generation left behind is RETAINED.** `ReceivingIndexer` applies the promotion policy (`promotion`, defaulting to `on-catch-up` with nothing dropped, as in every runtime) and exposes `promote(id)`, which no policy value gates. The TRIGGER is lifted rather than copied: `readyForPromotion` and `promotionOnAdd` are new exports of `generation/promotion.ts` and both containers now go through them, so there is one answer to "when does the pointer move on its own". `immediate` together with `dropOnPromotion` is REFUSED on this runtime, because the deferred drop that setting requires is not built here and accepting it would discard a complete state for one that has proved nothing.

  **`batchStreamForDelivery` (internal) is the delivery cut, now shared by the engine and the rebuild.** A replayed stream can carry an application, its retraction and the replacement at one block; handing all three to a single `process()` call reverts to the fork and then applies two blocks at the same height, which is a primary-key collision and not a fold. `IndexerGeneration.promiseToFeed` keeps its notifications, cancellation window and pacing and now takes the cut from this one function.

- 9229c30: The stored emission stream is now a STREAM a generation can re-fold: `storedEmissionStream(db, indexer)` is an `ExistingStream` over `_emissions`, so a processor-only upgrade rebuilds from local disk with zero `eth_getLogs` and zero writes to the stream.

  That is what ADR-0006's table was for. A successor sharing a STREAM with the incumbent is a follower (ADR-0044): it fetches nothing and re-folds what is already stored. Until now nothing on this runtime could hand a generation that stream.

  ```ts
  const generation = new IndexerGeneration(provider, processor, source, {
  	stream: {finality},
  	keepStream: storedEmissionStream(db, indexerName),
  });
  await generation.load(); // the load IS the rebuild
  ```

  **Read-only, structurally.** It goes out through `readOnlyStream`, so `saveNewEvents` and `clear` are NO-OPS. That is the one-writer rule made structural rather than conventional: only the generation that INDEXES a stream appends to it (through `EmissionAppender`, ADR-0052), and everything else folding it is handed a view whose writes go nowhere. `clear` matters more than symmetry suggests — the load path clears on every stream shape it cannot use, and a re-fold takes those branches over a table another generation is still appending to.

  **A replay, not a fetch (ADR-0042).** Retractions are delivered INCLUDED, at their original block, in `seq` order; `alive` is never consulted (that is the canonical view's rule, and applying it here would hide exactly the reorgs a re-fold has to replay); holes in `seq` are tolerated and nothing is renumbered. It deliberately does not ride `createSegmentedStream`: SQL already has a sequence, so segmentation would add ordinals, a contiguity rule and a damage class this substrate cannot exhibit.

  **A new fixed table, `_stream_coverage`, and `SCHEMA_VERSION` 4.** The rows cannot say how far a stream reaches, because a range that carried no logs moves the fetch cursor without adding one — so the claim is stored beside the stream, one row per `(indexer, stream)`, written in the SAME `batch()` as the emissions it covers. It is keyed on the STREAM and not on a generation, so every generation folding it inherits the same claim and a promotion needs no reconciliation. It carries no `processor` column, exactly as `_emissions` carries none. Read it with `readStreamCoverage`. See ADR-0055.

  `IF NOT EXISTS`, so a version-3 database gains the table EMPTY: each of its streams reads as ABSENT until its writer appends the next batch. Nothing already stored is touched.

  **PRESENCE is the claim and never "there are rows."** A stream that has been scanned and found nothing is PRESENT with an empty event list — reporting absent would re-scan from the start block on every reload. Rows with no claim are the opposite and are reported ABSENT, because they cannot say what filter produced them or how far they reach. A stream that does not reach back to the block asked for is reported absent too, and NOTHING is deleted in response: unlike the segment keeper's identical check, this view owns none of these rows.

- 5deb214: A NAMED INDEXER resolves to the DATABASE it owns, so a host registering several gives each one its own and no query, prefix scan or cap in one can reach another's rows.

  ADR-0053 decides the mechanism and the reason: a generation is a table NAMESPACE inside one database, and a named indexer is the DATABASE. The two levels have different LIFETIMES: the indexer set is known at DEPLOY time, so N static bindings express it exactly (including on D1, whose bindings are static), while a generation is created at RUNTIME and must live inside one binding. There is also a correctness reason not to merely share: `_blocks` is `number INTEGER PRIMARY KEY` with `hash` UNIQUE, so two named indexers on different chains collide on block number with different hashes.

  **`IndexerRegistryEntry` now carries `db`** (`@etherfold/server`). It is REQUIRED, which is what makes the isolation STRUCTURAL rather than remembered: a host registering a second named indexer cannot leave it out and silently inherit the first one's rows, because there is nothing to leave out. `getDB` stays exactly what it was and is now clearly the HOST-LEVEL handle: it answers per request and knows no name, which is right for `/status` and `/admin/setup` (facts about the deployment) and wrong for anything keyed on a tenant.

  ```ts
  // one receiver per name, over the database that name owns
  getIndexer: indexerRegistry({
  	alpha: singleContextEntry(alphaDB, alphaBuilder),
  	beta: singleContextEntry(betaDB, betaBuilder),
  });
  // a host holding generations: the container answers the two questions, the host supplies the handle
  getIndexer: (_c, name) => (name === 'alpha' ? indexerEntryOn(alphaDB, myReceivingIndexer) : undefined);
  ```

  **Both feed views read through the entry's handle** (`GET /{indexer}/feed`, `GET /{indexer}/canonical`), and the ingest routes were already isolated by construction: the fold, its store, its emission appender and its reorg recorder are all the host's, bound to the database that name owns.

  **Three shape changes, and nothing else moves.** `singleContextEntry(db, ingestion)` takes the handle first; `indexerRegistry` takes ENTRIES rather than bare receivers, because a name resolves to what it holds AND to where it holds it; and `indexerEntryOn(db, holds)` is new, the one line a host holding a `ReceivingIndexer` writes, since `@etherfold/core` knows no database and cannot carry one (its generation state is a type parameter precisely so it does not).

  **Colocation is still expressible and is now explicit.** Two names MAY be given one handle (`_emissions.indexer` and the generation registry's own name column keep them apart, which is why those redundant columns are kept), and that is a host's decision made where it can be read rather than one the type makes for it by defaulting.

  **The refusal families are unchanged.** A name this host was not built with is still a `404`, a host with no registry is still `501`, `409` is still the one resumable refusal, and a context no live receiver holds is still a `400`.

  `etherfold`, `@etherfold/fetcher-host`, `@etherfold/platform-nodejs` and `@etherfold/platform-nodejs-fetcher` carry no new behaviour: each names the handle its one named indexer already folded into, where it used to register a bare receiver.

  The guard is `packages/server/test/twoNamedIndexers.test.ts`: two named indexers with IDENTICAL sources, contracts, stream config and processor (so `streamDigestOf` cannot tell them apart and neither can a wire context) on a host whose own `getDB` handle is a THIRD database holding neither one's rows, so a read that forgot the discriminator answers with nothing rather than with something plausible. It asserts the routes, the store, the stored stream and the registry end to end, that a generation cap reached in one refuses in that one only, and that deleting everything in one is a `DROP` with no filter anywhere while the other stays complete and READABLE.

### Patch Changes

- ebfa4f0: **`degradingStream` is DELETED, and a stream keeper whose substrate cannot be read now RAISES from `fetchFrom` and `clear` instead of answering absent** (ADR-0068).

  The rule it encoded is unchanged and still enforced: a cache that cannot be read costs a re-index, never the indexer. What moved is WHERE it is applied. It was a wrapper each keeper put around itself, so it bound every caller -- and "absence is safe" is a statement about the LOAD PATH, which responds to an absent stream by re-indexing. It is false for `installStreamSeed`, which responds to absence by WRITING.

  Told "empty" about a subtree that was merely unreadable, the installer appended a seed underneath a stream that was really there. Measured, with a valid seed against a real stream whose reads were failing while its writes worked: `{status: 'installed'}` returned, two segments where there had been one, and the cursor's `lastToBlock` moved backwards from 600 to 200 while `startBlock` stayed at 500. Silent, permanent, and re-folded by every later generation.

  **If you implement `ExistingStream`:** stop wrapping yourself in `degradingStream` (it no longer exists) and let your substrate errors propagate. The write side is unchanged and always raised.

  **If you consume it:** `IndexerGeneration` catches and re-indexes exactly as before, so an app sees no difference. `installStreamSeed` gains one refusal reason, `subtree-unreadable`, deliberately distinct from `subtree-not-empty` -- one says "there is a stream here", the other says "I cannot tell whether there is". It writes nothing and clears nothing, and is usually transient.

  Done now rather than later because nothing is published yet: two implementations and four call sites, all in this repository. After the publish task lands it is a breaking change to a seam with implementors outside our control.

- 1524a04: A concluded reorg no longer DROPS the logs the replacement branch carries below the lowest block we held logs for. They were fetched, discarded in memory and never fetched again, because the next range starts above them: silent, permanent loss, reaching the stored emission stream and both feed views and not only the in-memory stream.

  `generateStreamToAppend` admitted an incoming block only at or above a HEIGHT (`reorgBlock.number` on a reorg, the window's top plus one otherwise). That threshold claims "we already hold everything below this", and `unconfirmedBlocks` holds only EVENT-BEARING blocks, so the window is SPARSE and its lowest entry is usually far above the height the chain actually forked at. Fork at 195 while the lowest block we held logs for is 200, and every log the new branch carries in 195..199 is inside the re-fetched range, dropped by the comparison, and gone.

  The rule is now MEMBERSHIP of the retained window, by `(number, hash)`: a re-fetched block is NEW unless the window that survived this cycle's retraction already holds it. Nothing is delivered twice, which is the job the threshold was really doing — a re-fetch never starts below `latestBlock - finality`, and a block that carried events inside that window entered `unconfirmedBlocks` when it was applied, so anything we already applied is still there unless it was retracted. It is also the rule the REPLAY path in the same file already applied, by hash, for the same de-duplication reason; the two entries now agree.

  Reorg DETECTION is untouched: the absence-versus-contradiction classification (ADR-0004), the retractions from the reorged block onward, the finality prune and the reorg counters (ADR-0050) all behave exactly as before, and no re-fetched range was widened.

  Two deliberate consequences. The no-reorg path changed on the same ground: a block inside the re-fetched range the window does not hold is now delivered even when nothing reorged and it sits below the window's top (by the same invariant, we never applied it). And the rebuilt `unconfirmedBlocks` is sorted ascending, which a height threshold used to guarantee for free and the readers of that window still assume. See ADR-0051.

- 1d9be43: Every caller, example and doc now names the GENERATION container: `IndexerGeneration` for one stream plus one fold, and the two FACTORIES for the browser hook.

  This is the MIGRATE batch of the expand → migrate → contract rename the generation container needs. Nothing is removed: `EthereumIndexer` is still exported from `@etherfold/core` as an alias to `IndexerGeneration`, and `createIndexerState` still accepts a processor built over a store. What changed is that nothing in this repository reaches for either any more, so `the-old-indexer-shape-is-deleted` can delete both without a compile error anywhere.

  **`@etherfold/browser` re-exports the class as `IndexerGeneration`, not `EthereumIndexer`.** A caller that imported the type from this package renames the import; the class itself is unchanged, and `@etherfold/core` still exports the old name for now.

  **The browser hook is written against `{createState, createProcessor}` everywhere.** The README, both example apps, the `IndexerState` and `BrowserStateStore` JSDoc examples and every test now hand over the two factories rather than a processor already built over a store:

  ```ts
  const indexer = createIndexerState({
  	createState: () => createBrowserStateStore(myProcessor.entities, {databaseName: 'my-app'}),
  	createProcessor: (store) => fromEntityProcessor(myProcessor)(store),
  });
  ```

  An indexer holds any number of generations and each folds into its OWN state, so the store cannot be a value handed over once — the hook is what calls these, once per generation. An app that needs the store it built (to rebuild a processor over it on a hot reload, or to read its capability report) captures it in the factory's own closure, which is what both examples now do.

  **The CLI's source-text guard is asserted to still bite.** `packages/cli/test/engine.test.ts` enforces that the CLI constructs and imports no browser engine by matching the identifier with regexes. A rename that left those on a name nothing uses any more would keep them green and VACUOUS — enforcing nothing, with nothing going red to say so — so the patterns are now named functions and are asserted against deliberate violations under BOTH spellings, plus the prose and the generation CONTAINER they must not fire on.

- 1a6f68b: Every published package now carries a `description` and its own `README.md`.

  Metadata and docs only: no runtime code changed. Four manifests had no `description` at all (`@etherfold/core`, `@etherfold/browser`, `etherfold`, `@etherfold/utils`), which is the line npm shows in search results and on the package page, and seven packages had no README (the four above plus `@etherfold/server`, `@etherfold/platform-nodejs` and the private Worker host). Each README says what the package is, when to reach for it INSTEAD of its neighbours, a minimal snippet taken from code that runs, and links to the related packages.

  Two summaries are worth calling out because a guessed one would have been wrong. **`etherfold index` is a ONE-SHOT**: it folds to the tip it observed and exits, does not follow the chain and cannot be reconfigured while running, so keeping a database current is running it again; live reconfigure is `@etherfold/browser`'s ability. And **`@etherfold/utils` is not a bag of hashing helpers** any more: what is in it is the Node-side loader that turns a processor PATH into the authoring object plus its indexing source, since `contextFilenames` and the `@etherfold/utils/indexer` subpath went with the blob snapshot (ADR-0037).

  One existing description is CORRECTED rather than added: `@etherfold/state-store-sqlite` called itself a "state store for `@etherfold/core`", which names the wrong seam. It depends on `@etherfold/state-store`, `remote-sql` and `named-logs` and on nothing else, and a test in that package asserts as much, because a storage backend depending on the indexer would invert ADR-0016.

  **`etherfold` no longer publishes the repo's root README.** Its `prepack` copied `../../README.md` into the package, so the npm page for the CLI described the monorepo and documented none of its flags; the package now has a README of its own, committed rather than generated, and `prepack` copies only the LICENSE.

- 0bf9dc7: Package READMEs now link to sibling packages by absolute URL instead of by relative path.

  A README is read in three places and a relative `../state-store` link is only correct in one of them. On npmjs.com it resolves against the registry page and 404s, so every cross-reference in every published README was broken for the audience most likely to follow one. In the generated API documentation the same links became `_media/<package>` references to files that do not exist, which is what turned the docs site's build red.

  No prose changed; only the link targets.

- 1fa09f5: **Five source-scanning gates now match CODE rather than the whole file, so documenting a rule no longer breaks the gate that enforces it.**

  Tests only; no shipped behaviour changes. These packages assert platform-neutrality by scanning `src/` for a forbidden word -- no `D1`, no `cloudflare`, no `console.`, no `D1Database`, and, in `@etherfold/state-store-patch`, that the as-of methods never reach for stored state. Run against raw file text they read PROSE as well as code, so the sentence explaining _why_ a store must never name D1 failed the gate that exists to keep it from naming D1. The perverse incentive is the point: the cheapest way back to green was to delete the explanation, so the check punished exactly the comment that would stop someone reintroducing the dependency.

  A shared `codeOnly()` helper strips comment trivia with the TypeScript scanner before matching. String literals are deliberately KEPT, because `'D1Database'` in a string is a real reference and a gate that ignored it could be defeated by quoting. The anchored `^\s*import ... from '...'` scans keep reading raw source, since an import cannot be a comment; only the whole-file word matchers changed. `state-store-patch`'s method-body slice still finds its boundaries in the raw text, so `\n\t}` keeps meaning "closing brace at class indent" -- only the matched text is stripped.

  Verified in both directions rather than assumed: a comment mentioning D1 and cloudflare now passes, while a bare `D1` token in code and a `@cloudflare/workers-types` import both still redden the gate.

- c0d694f: The acceptance gate no longer assumes an idle machine: every package that runs vitest sets `testTimeout` and `hookTimeout` to 60s instead of inheriting the 5s default.

  No runtime code changes in any of these packages. The bump is only because each gained (or had amended) a `vitest.config.ts`.

  Vitest's 5s default is fine on an idle box and wrong on a machine someone is working on. The gate runs `pnpm test` across the whole workspace, so suites compete with each other and with everything else running. Three unrelated packages timed out at 5s in a single session -- `core`'s base36 digest sweep, four cases in `state-store-sqlite`'s conformance suite, and `server`'s `sql2ts` round-trip -- each passing in seconds when run alone, and each blocking a task that had nothing to do with the code that failed.

  That makes a red gate ambiguous, which defeats the point of having one: red should mean broken, not "someone opened a browser". A generous timeout costs nothing when tests pass, since it is only reached on failure.

  The base36 digest sweep in `@etherfold/core`, skipped earlier the same day, is un-skipped: raising the timeout is the fix that skip was standing in for.

  See ADR-0032 for the rejected alternatives, including why a shared config file is not possible here (per-package `rootDir` puts `vitest.config.ts` under the typechecker, so importing a root-level file fails `TS6059`).

- 132cc1c: The one-shot is `etherfold build`, `serve` is only the read tier, and no command is implicit.

  **BREAKING, and it is the whole point.** `etherfold index` is gone and resolves to nothing: the word is needed for the wire receiver, which receives pushed batches, owns the database and does not terminate. The one-shot that folds to the tip and exits is now named for what it PRODUCES.

  ```sh
  etherfold index -p ./processor.js --store sqlite --db file:./etherfold.db   # before
  etherfold build -p ./processor.js --store sqlite --db file:./etherfold.db   # after
  ```

  **There is no DEFAULT command any more**, so a bare `etherfold …` now needs a command word: `etherfold -p ./processor.js --store sqlite --db file:./etherfold.db` was the one-shot and is now an unknown-option error. `etherfold` with nothing after it prints help and indexes nothing. The default existed so the rename from `ei` would not also cost users their argument order (ADR-0017); the name is changing anyway, and under a set of five names chosen so a reader can tell what a process will DO, an invocation that silently means one of them is the ambiguity the set exists to remove.

  Nothing about the pipeline moved. `build` keeps every flag (`-p`, `--store`, `--db`, `--retention`, `-d`, `-n`, `--rps`, and the `ETHEREUM_NODE` fallback), every refusal, the stop-at-tip driver and the exit codes (0 at the tip, non-zero on a refusal no waiting fixes). The package's exported `run(options)` is renamed to `build(options)` to match, and `main`'s injectable `run` collaborator becomes `build`, because `run` is a DIFFERENT command in the set being built (it follows the chain, answers queries and never terminates).

  **`serve` keeps its name and narrows its promise to serving.** It holds no processor, makes no chain call and writes no indexed state: it answers over a database something else wrote. That was already true of the code and not of the docs. It is now asserted rather than described: a server started the way `serve` starts one answers `501 ingestion-not-configured` on `/ingest` and `/ingest/expected-from-block` to an authenticated caller, while `/status` still answers, and an unauthenticated caller still gets `401` first, so the absence of a processor is not something an anonymous caller can probe.

- 41b59fe: **The server's `SCHEMA_VERSION` restarts at 1**, and the `_meta` row in `db.sql` with it.

  The constant had reached 4, with three paragraphs narrating what each step added (the reserved `_` namespace, the generation registry, the stream coverage claim) and what an existing database of each earlier version would gain. Nothing is published, so no database anywhere was created by an earlier build: those were migration notes for a population of zero, and a reader had to get to the end of them to find that out.

  The version row, the `_meta` table and the `/status` comparison are all KEPT unchanged, because what they do is entirely forward-looking and does not need a history behind it: the two paths that bring a database to this shape are not both ours (`applySchema` runs `db.sql`, and wrangler's D1 migrations execute that file and nothing else), so a deployed server can meet a database another build's SQL created, and a disagreement has to surface at `/status` rather than as a random query failure later. That is also why the row lives in the SQL rather than being written by the code that applies it.

  What replaces the ladder is the rule stated forwards: bump it when `db.sql` changes in a way an existing database has to be told about, keep the row in step (a test asserts they agree), and note the one case that is stronger than a bump -- a change that renames or removes `_meta` itself leaves an older database with no row to read, which reports `applied: false`.

  **If you are running a server against a database an earlier build of this unpublished package created**, `/status` will now report a version mismatch and answer `503`. That is the mechanism working. Re-apply the schema (`POST /admin/setup`), which upserts the row.

- 9bfc424: **BREAKING: the kept-stream keeper seam now speaks `StoredLogEvent`, so a keeper that would persist a decoded event no longer compiles.** `StreamFetcher` and `StreamSaver` — and therefore `ExistingStream` and `StreamReader` — are declared over the raw log the node reported plus the reorg verdict the indexer derived, with `args` / `eventName` / `decodeError` structurally refused. The strip already happened at runtime; this is the seam saying so, which is what stops the rule drifting across implementations.

  **What a third-party keeper implementor has to change.** Annotations, and nothing else: `saveNewEvents(source, {eventStream, lastSync})` receives `StoredLogEvent[]` and `StoredLastSync` instead of `LogEvent<ABI>[]` and `LastSync<ABI>`, and `fetchFrom` must hand back those same two shapes. Where a keeper reads its own storage back and cannot prove the shape to the compiler — a row from SQL, a record from IndexedDB — asserting the STORED type at that boundary is the sanctioned move and is what the shipped keepers do. What is NOT: widening the seam, or re-typing a keeper to `BaseLogEvent` or `EmittedLog`, both of which a decoded event satisfies, so either would compile while enforcing nothing.

  **The cursor gets a stored variant, and `LastSync` is untouched.** `StoredLastSync` (with `StoredEventBlock`) is `LastSync` with the unconfirmed window's events narrowed the same way, and it is used by these two function types and nowhere else — the processor seam, the load path, the state keepers and the wire all still speak `LastSync<ABI>`. Core strips the window on the way into `saveNewEvents` exactly as it strips the batch, so a seam that still declared `LastSync<ABI>` there would have been promising an implementor a decoded half that is `undefined` at runtime. No keeper stores a window at all (ADR-0035, as amended), so the return side costs an implementation nothing.

  **The stored type governs WRITES; READS tolerate a decoded half; nothing is migrated.** Segments written before this keep their `args` and `eventName` forever, are served rather than treated as damage, and are never rewritten — the re-decode drops and re-derives that half regardless (ADR-0034). Adopting the stricter type therefore costs an existing deployment no rebuild, which is pinned by a test that writes a segment the previous version's way and replays it end to end.

  Also narrowed with them: `StreamSegment` is now `{events: StoredLogEvent[]}` and carries no ABI type parameter, since a segment holds nothing an ABI was needed for. `EmittedLog` keeps its own meaning and its own callers on the emission-append path, unchanged.

- 0a53b98: Close the residue the generation work left behind: writer succession is real in a running process, a reaped stream takes its coverage claim with it, and a container no longer answers reads from a generation the pointer does not name.

  **WRITER SUCCESSION now moves the ENGINE, not only the records** (`@etherfold/core`, ADR-0044's second 2026-09-06 amendment). ADR-0044 says the writer of a stream is the oldest SURVIVING generation on it, and that succession is atomic with a delete because it is stored nowhere — but only the durable half was built. In a running process, deleting a writer removed the only RECEIVER its stream had: an incoming batch resolved to nothing, nothing appended, and `/status` went on looking healthy while the cursor stopped. `ReceivingIndexer` now re-derives which held fold writes each stream from the records it is already reading, and hands the survivor the engine — the fold stops following, its bounded rebuild is retired, and it gets a receiver carrying the emission appender. It is a reconciliation rather than an event handler, because a generation can be deleted by another process, and it costs nothing when nothing moved.

  **A survivor that has not caught up does NOT take the wire.** A receiver asks `expectedFromBlock` from its own fold position and ADR-0052 appends a re-sent batch again, so handing the wire to a follower mid-rebuild would store a second copy of everything back to its cursor — indistinguishable afterwards from real emissions. It keeps following until its rebuild reports level, then takes over. An unfed stream is visible and recoverable; a duplicated range is neither.

  **`ReceivingIndexer.canonicalGeneration()` now returns `GenerationId | undefined`** rather than falling back to the fold it opened with. `openGenerationRegistry.canonical()` resolves the pointer against the RECORDS, so it answers nothing when the pointer names a generation whose record has gone. The fallback served reads from a generation nobody asked for, silently, where a read tier over the same rows refuses (`503 no-canonical-generation`, ADR-0058) — one database with two answers depending on who was asking. The registry's answer is now passed through, so every host agrees. `IndexerRegistryEntry.canonicalGeneration` already had this shape and the feed already refused on it, so no call site changes.

  **`dropStreamSubtree` deletes the stream's COVERAGE CLAIM with its rows** (`@etherfold/server`). A stream lives in two tables — its emissions, and the `_stream_coverage` row saying how far they reach — and they are written in one batch. They are now deleted in one batch too. PRESENCE is the claim and never the rows, so a reap that took the rows and left the claim left a stream reading as PRESENT AND COMPLETE with nothing in it: a generation folding it would be told it had re-folded the whole history and could resume at the old tip, with empty state, durably, with no error anywhere. That is the whole-history form of the hazard `startBlock` exists to prevent, and it was reachable through the ordinary unregistered-subtree sweep.

  **`VersionedStateProcessorOptions` accepts `tableNamespace`** (`@etherfold/processor-sqlite`). A generation's state is a table-name namespace (ADR-0053), so without it two generations built through this convenience class over one handle landed on the same tables and shared rows silently. The entity-path assembly the CLI folds through always took the option; the narrow `Pick` predated the namespace.

- Updated dependencies [ebfa4f0]
- Updated dependencies [0ba3c60]
- Updated dependencies [9fa7f35]
- Updated dependencies [3e36261]
- Updated dependencies [2b4f3fc]
- Updated dependencies [f77f8ea]
- Updated dependencies [61a5462]
- Updated dependencies [a1fccd0]
- Updated dependencies [5427806]
- Updated dependencies [391dbf8]
- Updated dependencies [c6b5215]
- Updated dependencies [0f33468]
- Updated dependencies [a64a843]
- Updated dependencies [d92021c]
- Updated dependencies [23c1eae]
- Updated dependencies [bc63e6b]
- Updated dependencies [5729da5]
- Updated dependencies [ebfa4f0]
- Updated dependencies [2e10f5e]
- Updated dependencies [ce43a7b]
- Updated dependencies [1524a04]
- Updated dependencies [011aa87]
- Updated dependencies [a4d106e]
- Updated dependencies [339d212]
- Updated dependencies [4f5588b]
- Updated dependencies [351c585]
- Updated dependencies [a448b1b]
- Updated dependencies [839e781]
- Updated dependencies [6b5395e]
- Updated dependencies [f0515f8]
- Updated dependencies [e72cbec]
- Updated dependencies [4e5067e]
- Updated dependencies [dc08d24]
- Updated dependencies [29895dc]
- Updated dependencies [e7d06c9]
- Updated dependencies [aa17a93]
- Updated dependencies [da289e2]
- Updated dependencies [49e73ae]
- Updated dependencies [70f98d6]
- Updated dependencies [3e9e9d0]
- Updated dependencies [1d9be43]
- Updated dependencies [ab779b0]
- Updated dependencies [793f3d6]
- Updated dependencies [1a6f68b]
- Updated dependencies [56acbef]
- Updated dependencies [1d619c9]
- Updated dependencies [d50583b]
- Updated dependencies [37146b2]
- Updated dependencies [74f74f5]
- Updated dependencies [9a41ba3]
- Updated dependencies [74b2889]
- Updated dependencies [f5fb4d2]
- Updated dependencies [114879f]
- Updated dependencies [0bf9dc7]
- Updated dependencies [b0e9a0d]
- Updated dependencies [bb86a77]
- Updated dependencies [8d1c6c5]
- Updated dependencies [8baecea]
- Updated dependencies [114879f]
- Updated dependencies [5adafa9]
- Updated dependencies [a6963b4]
- Updated dependencies [cb28315]
- Updated dependencies [ad8d8b1]
- Updated dependencies [50748cf]
- Updated dependencies [290e827]
- Updated dependencies [c0d694f]
- Updated dependencies [d10b64e]
- Updated dependencies [01ed0ef]
- Updated dependencies [629dff0]
- Updated dependencies [9e2c66d]
- Updated dependencies [ed8e7ff]
- Updated dependencies [b824312]
- Updated dependencies [35fc4c2]
- Updated dependencies [4f206c3]
- Updated dependencies [449f6fb]
- Updated dependencies [31579cc]
- Updated dependencies [7af8558]
- Updated dependencies [eee7e00]
- Updated dependencies [241e684]
- Updated dependencies [4da7b27]
- Updated dependencies [9229c30]
- Updated dependencies [8c8341a]
- Updated dependencies [40819d3]
- Updated dependencies [628df9d]
- Updated dependencies [9bfc424]
- Updated dependencies [7b64e35]
- Updated dependencies [ba5b4ba]
- Updated dependencies [5deb214]
- Updated dependencies [0a53b98]
  - @etherfold/core@1.0.0

## 0.1.0

### Minor Changes

- 086de7b: Adds the platform-agnostic indexer-server and its Node host, and a `serve` command to the CLI.

  `@etherfold/server` is a Hono app that receives its database and environment by injection (`{getDB, getEnv}`) and imports no runtime: no Node built-ins, no Cloudflare types, no concrete driver. It ships the fixed-table schema and a `/status` route reporting database reachability, whether the schema is applied and at which version, and the last error this process saw. `POST /admin/setup` applies the schema. A test asserts the package names no runtime, so the property is checked rather than trusted.

  `@etherfold/platform-nodejs` is the Node host: a libSQL-backed `RemoteSQL`, environment from the process, served over HTTP. It applies the schema at startup by default (one process owning one file), which `autoSetup: false` disables.

  The CLI gains `etherfold serve`, which runs that host, so a project can start an indexer-server without wiring anything. `etherfold index` remains the default command, so existing `etherfold -p <processor> -f <folder>` invocations are unchanged.

  A Cloudflare Worker host also exists, at `platforms/cf-worker`, and is not published: it is a deployable, not a library.

  The server is a skeleton. It serves status and schema only: no chain logic, no store wiring, no feed. Those arrive with the tasks that follow ADR-0003.

- b40298e: **Asking where the next batch starts is now `POST /ingest/expected-from-block`, not `GET /ingest`.**

  Answering that question can WRITE: it reconciles a persisted cursor belonging to a different source, config or processor version by calling `processor.clear()`, exactly as `load()` does in the single-process shape. A `GET` that writes is a trap whatever its justification — proxies, browser prefetch, link scanners and retrying clients all assume a `GET` is safe, and HTTP says it is — so the method now matches what it does.

  The token guard is registered on BOTH `/ingest` and `/ingest/*`: Hono matches `/ingest` exactly and would not have covered the new sub-path, which would have left half the fetcher-facing surface open while looking guarded. A test asserts a 401 on each.

- e0a6480: The log ingestion endpoint, and the receiving half of the wire contract (ADR-0004).

  `@etherfold/core` gains **`StreamBuilder`**: the stream-builder of ADR-0003, as an object. It takes contiguous ranges of raw logs from a stateless log-fetcher, derives every retraction itself, drives an `EventProcessor`, and is authoritative about where the next range must start. It makes no chain calls at all, which is why it is not `EthereumIndexer`: that class opens `load()` with `eth_chainId`, so the half of a split deployment that hosts the processor could never use it. It reads the persisted cursor on every call rather than caching one, because the intended host is serverless and an in-memory cursor is one isolate's private opinion of a value the database owns.

  `@etherfold/server` gains **`GET` and `POST /ingest`**, behind an `INGEST_TOKEN` bearer token. The stream-builder is injected exactly like the database (`getIngestion` alongside `getDB` / `getEnv`), so which processor runs against which source stays a deployment's choice; a server with none answers `501` rather than pretending to have a cursor.

  The cursor is the idempotency key, so there is no dedupe table and no idempotency header. A batch whose `fromBlock` is not the server's `expectedFromBlock` is refused with **`409` carrying that value**, and the sender re-sends from there; a batch re-sent after a lost acknowledgement takes exactly that path, so at-least-once on the wire is exactly-once in effect. `409` is the only resumable refusal: a foreign `{source, config}`, a malformed range, or a payload that is not the range it claims are `400`, because no block number makes them right and a sender must not retry them forever.

  `generateStreamToAppend` now throws a typed `UnexpectedFromBlockError` carrying `expectedFromBlock`, instead of an `Error` whose message had to be parsed. Same rule, same message, one place: the HTTP layer reads the number off the error rather than re-deriving it, so the wire and the engine cannot drift apart.

  A revert concluded from **absence** is surfaced and counted apart from one concluded from a hash **contradiction**. Absence is an inference and is indistinguishable from a sender that under-delivered a range, so `/status` now reports `reorgs: {absence, contradiction, last}` from the database (not from process memory, since a rate is the point and isolates are recycled), and an absence-driven revert is logged at `error` level naming the range. It does not make the server unhealthy: it is a signal to investigate, not a fault.

  Wire batches are serialized with `serializeWireBatch` / `parseWireBatch`, which tag BigInts as `{__bigint__: "..."}`. A decoded log's `args` hold a BigInt for every `uint256` an ABI declares and `JSON.stringify` throws on those, while the older `"123n"` suffix convention would revive a contract-emitted string ending in `n` as a number. The tagged codec now lives once, in `@etherfold/core` (`taggedBnReplacer` / `taggedBnReviver`), and `@etherfold/processor-entities`' sync-cursor codec uses it instead of its own copy.

### Patch Changes

- Updated dependencies [6c875dd]
- Updated dependencies [535ccc1]
- Updated dependencies [0957f8c]
- Updated dependencies [c681b79]
- Updated dependencies [9d21d67]
- Updated dependencies [ca6f981]
- Updated dependencies [31833b6]
- Updated dependencies [047cd73]
- Updated dependencies [eba61c3]
- Updated dependencies [dece521]
- Updated dependencies [939364a]
- Updated dependencies [d24872f]
- Updated dependencies [78d8377]
- Updated dependencies [3de4c35]
- Updated dependencies [bc118e4]
- Updated dependencies [bc5d71a]
- Updated dependencies [e0a6480]
- Updated dependencies [9738f1c]
- Updated dependencies [33afc5b]
- Updated dependencies [4097ccd]
- Updated dependencies [e0e5832]
- Updated dependencies [3a78285]
- Updated dependencies [0ac08c0]
- Updated dependencies [cefe0de]
  - @etherfold/core@0.7.0
