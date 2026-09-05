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

- 0f33468: A NAMED INDEXER IS A ROUTE SEGMENT AND A REGISTRY ENTRY, on both halves of the wire.

  An indexer-server hosted exactly one indexer: `ServerOptions.getIngestion` resolved a single `LogIngestion`, and the ingest routes were the unnamespaced `/ingest` and `/ingest/expected-from-block`. It now hosts SEVERAL, each under a NAME an operator supplies at deploy time (ADR-0036).

  **`/{indexer}/ingest` and `/{indexer}/ingest/expected-from-block` replace the unnamespaced pair, which is GONE rather than kept beside them.** The name is a ROUTE SEGMENT and is deliberately NOT a field in the envelope: putting tenancy in the wire format would turn a misdirected batch into a payload error rather than a routing one. ADR-0004's `{source, config}` envelope and its refusal families (`409` resumable, `400` otherwise) are untouched.

  **`ServerOptions.getIndexer` replaces `getIngestion`, and resolves a registry ENTRY per name.** The entry is an object (`{ingestion}`) so that what a name holds can grow — a later generation model gives one entry several live wire contexts — without every host's resolver changing its return type. `indexerRegistry({name: streamBuilder})` builds one from a plain record for a host that knows its names up front; a host whose names depend on the request writes the function itself. Two named indexers on one server are isolated: a batch pushed to one is not visible to the other.

  **An unknown name is REFUSED, never defaulted: `404 unknown-indexer`.** A routing refusal, matching what the name is, and distinct from `501 ingestion-not-configured`, which a host with NO registry at all still answers under every name (a read tier, or a combined `run`). Both are in the non-retryable 4xx family a sender must not re-send into.

  **`createHttpIngestion` takes the indexer name beside the endpoint** (`@etherfold/core`) and posts to the namespaced routes; it refuses to be built without one rather than addressing nobody. `@etherfold/fetcher-host` reads it from `INDEXER_NAME` and demands it wherever it demands `INGEST_ENDPOINT` and `INGEST_TOKEN`, so a combined host that configures no wire is still asked for nothing.

  **The CLI grows `--indexer <name>` / `INDEXER_NAME`, REQUIRED on `fetch` and `index` and refused on `run`, `build` and `serve`.** The two halves of a split deployment agree on one name the way they already agree on one secret: `fetch` addresses `/{indexer}/ingest`, `index` registers exactly that name and refuses every other. The three commands with no wire route no batch by name, and refuse the flag with that reason rather than accepting and ignoring it.

  `StartOptions.getIngestion` on `@etherfold/platform-nodejs` becomes `getIndexer`, carried through unchanged as before.

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

### Patch Changes

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

- Updated dependencies [0ba3c60]
- Updated dependencies [a1fccd0]
- Updated dependencies [5427806]
- Updated dependencies [c6b5215]
- Updated dependencies [0f33468]
- Updated dependencies [a64a843]
- Updated dependencies [5729da5]
- Updated dependencies [2e10f5e]
- Updated dependencies [ce43a7b]
- Updated dependencies [1524a04]
- Updated dependencies [a4d106e]
- Updated dependencies [351c585]
- Updated dependencies [839e781]
- Updated dependencies [4e5067e]
- Updated dependencies [dc08d24]
- Updated dependencies [29895dc]
- Updated dependencies [e7d06c9]
- Updated dependencies [da289e2]
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
- Updated dependencies [0bf9dc7]
- Updated dependencies [b0e9a0d]
- Updated dependencies [bb86a77]
- Updated dependencies [5adafa9]
- Updated dependencies [c0d694f]
- Updated dependencies [d10b64e]
- Updated dependencies [01ed0ef]
- Updated dependencies [9e2c66d]
- Updated dependencies [b824312]
- Updated dependencies [35fc4c2]
- Updated dependencies [4f206c3]
- Updated dependencies [8c8341a]
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
