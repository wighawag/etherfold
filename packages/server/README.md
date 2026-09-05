# @etherfold/server

The indexer-server, minus any host. A [Hono](https://hono.dev) app that receives its database, its environment and (optionally) the stream-builder it folds with by INJECTION, so the same routes run on Node, on a Cloudflare Worker, or on anything else with a `fetch`.

It knows `RemoteSQL` and nothing else: no Node built-ins, no Cloudflare types, no D1. A test asserts that no source file here names a runtime.

## When you want this package

You are building a HOST. Everything platform-shaped -- which database, which environment, how the app is served -- is the host's, and the shipped ones are [`@etherfold/platform-nodejs`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs) and [the Cloudflare Worker host](https://github.com/wighawag/etherfold/tree/main/platforms/cf-worker). Reach for this package directly to write a third.

To simply RUN a read tier on Node, use [`etherfold serve`](https://github.com/wighawag/etherfold/tree/main/packages/cli). To fold into a database in one shot, use `etherfold build`.

## What a host supplies

```ts
import {createServer, indexerRegistry} from '@etherfold/server';

export const app = createServer<MyEnv>({
	getDB: (c) => myRemoteSQL(c.env), // resolved PER REQUEST: a Worker's binding arrives on `env`
	getEnv: (c) => c.env,
	// OPTIONAL: the NAMED INDEXERS this deployment hosts, resolved by name
	getIndexer: indexerRegistry({alpha: myStreamBuilder, beta: myOtherStreamBuilder}),
	// OPTIONAL: where this deployment's pipeline has got to, if it owns a store
	getCursorReport: async (c) => ({lastToBlock: await myStore.howFar()}),
});
```

`getIndexer` is the NAME-KEYED REGISTRY of the named indexers this host was built with. A **named indexer** is the multi-tenancy unit: one indexed answer set over one chain, fully isolated from every other (ADR-0036). It resolves an ENTRY OBJECT (`{ingestion}`) rather than a bare `LogIngestion`, so that what a name holds can grow -- a later generation model gives one entry several live wire contexts -- without every host's resolver changing shape. `indexerRegistry` builds one from a plain record; a host whose names depend on the request writes the function itself.

It is optional because an indexer-server is useful before it ingests anything: `/status` and `/admin/setup` answer on a server with no processor at all. When it is absent the ingestion routes answer `501` under every name, which says "this server does not do that" rather than pretending the route is missing. That is deliberately a different answer from a registry that does not hold the name asked for, which is a `404`: one is a capability this host lacks, the other is a tenant it was not built with.

`getCursorReport` is optional for the same kind of reason: only the process that OWNS the store can read a cursor, and this package has no store dependency. A host with none (the Cloudflare Worker host is one) injects no reporter and `/status` carries no `cursor` field, rather than an invented one.

**What a reporter owes the server: a SMALL, JSON-serialisable summary, and never the store's raw serialized cursor.** That value is a serialized `LastSync` carrying an unconfirmed window of DECODED EVENTS, so handing it over whole would put an unbounded blob on the one page an operator refreshes while something is wrong. The constraint lives on the seam because `/status` reports what the reporter returns VERBATIM: the server does not parse it (the cursor is opaque behind the storage seam, ADR-0027, and only the processor knows what one means), so it cannot bound it afterwards either.

## The routes

| route | |
| --- | --- |
| `GET /status` | health, database reachability, the fixed-schema version against the one this build expects, the reorg counters, the injected cursor report and the last error this PROCESS saw. `503` when the database is unreachable or the schema is not the expected version |
| `POST /admin/setup` | apply the fixed-table schema |
| `POST /{indexer}/ingest` | a `WireBatch` from a log-fetcher (ADR-0004), for ONE named indexer |
| `POST /{indexer}/ingest/expected-from-block` | where that named indexer's next batch must start |
| `GET /{indexer}/feed` | the RETRACTION-AWARE view over the stored emission stream: `seq`-ordered, `removed` entries included, resumed from an opaque `cursor` the caller holds, `limit` entries at a time |
| `GET /{indexer}/canonical` | the CANONICAL view over the same stream: live entries only, ordered by `(blockNumber, logIndex)`, at or below the caller's REQUIRED `gate`, resumed from an opaque `cursor` whose block hash the server validates |

**The indexer NAME is a ROUTE SEGMENT and is never in the envelope.** Carrying it in the payload was considered and rejected: it would make the wire FORMAT carry tenancy, and it would turn a misdirected batch into a payload error rather than a routing one. ADR-0004's envelope and its refusal families are unchanged, and one refusal sits beside them: a name this host was not built with is a `404 unknown-indexer`, never a default to the indexer it does happen to hold.

**The ingest routes are the fetcher's private API and are guarded on the PATH**, read included. Authentication is `Authorization: Bearer <INGEST_TOKEN>`, compared without leaking where two secrets first differ, and it FAILS CLOSED: with no `INGEST_TOKEN` configured the server can authenticate nobody, so every ingestion call is refused with `401`.

**The status codes are the interesting part of the contract.** `409` is the one and only RESUMABLE refusal: it carries `expectedFromBlock`, and a sender's whole recovery is to re-send from there. `400` is a sender that is wrong in a way no block number fixes (a foreign `{source, config}`, a malformed range, a payload that is not the range it claims). Collapsing the two would make a misconfigured fetcher retry forever against a server that will never accept it.

**There is no idempotency key and no dedupe table: the cursor IS the key.** A batch re-sent after a lost acknowledgement fails the `expectedFromBlock` check and is corrected, so at-least-once on the wire is exactly-once in effect.

**This route COUNTS no reorgs, and that is deliberate.** It used to, which quietly made an operational counter a fact about the TRANSPORT: a combined process folds through `createDirectIngestion`, reaches no route, and reported no reverts at all. A revert is concluded by the FOLD, so it is counted once inside `StreamBuilder.receive` and persisted by whoever owns the store (ADR-0050) -- this package reads those counts for `/status` and writes none. A host that wants them supplies a `ReorgRecorder` to the stream-builder it builds, exactly as it already supplies the database, the environment, the registry and the cursor reporter.

**This route STORES no emission stream either, and that is the same decision one step further** (ADR-0052). The stored stream (ADR-0006) is an append-only `_emissions` row per emitted log, retractions INCLUDED, superseded rows FLAGGED rather than deleted, so no retraction information is ever destroyed and the canonical view stays a cheap derived read. Every row carries two DISCRIMINATORS, both structurally part of every read and write: the INDEXER NAME and the STREAM. The stream's value is `LogIngestion.streamDigest`, the wide digest over the fetch filter plus the stream config -- deliberately NOT the wire context's `{source, config}`, which is a 32-bit whole-entry hash kept whole as an identity check between two halves of a deployment (ADR-0034): as a key it would move on a decode-only ABI change and orphan every stored row, and it would collide. Nothing about the PROCESSOR is a column and there is no generation column, because a processor change is a new generation over the SAME stream.

The write used to be HERE, on the ground that half of the key is the indexer name and the route segment was the only place that value existed. The consequence was that a COMBINED `etherfold run` stored no stream at all, and neither did the artifact `build` emits. So a host supplies an `EmissionAppender` (`emissionAppenderFor(db, indexer)`, exported by this package) to the stream-builder it builds, closed over the name it holds, and `StreamBuilder.receive` appends every batch it folds.

**That append is NOT best-effort, and it is ordered BEFORE the fold** -- the one way it differs from the reorg count. A count that fails costs an operational number. A stream silently missing a batch the state already applied is a HOLE: invisible, permanent and self-consistent, since the rows that would prove it are the ones that never arrived. So a store that cannot take the batch REFUSES the batch: nothing is folded, the cursor does not move, this route answers `500` with `lastError` set, and the sender's own recovery is unaffected -- nothing was applied, so its next attempt meets the cursor it already had.

## The feed

`GET /{indexer}/feed` is the first of ADR-0006's two views over the stored emission stream, and it is the one for a consumer that WANTS to see reorgs: it acts optimistically on a log and cancels the pending action when a retraction arrives. So retractions are DELIVERED and the `alive` flag is never consulted here. The second view is `GET /{indexer}/canonical`, below.

```json
{
	"success": true,
	"stream": "0x…",
	"generation": "<opaque>",
	"entries": [{"removed": false, "blockNumber": 101, "blockHash": "0x…", "logIndex": 0, "address": "0x…", "topics": ["0x…"], "data": "0x…", "transactionHash": "0x…", "transactionIndex": 0}],
	"cursor": "<opaque>",
	"hasMore": true
}
```

**Every response says WHICH GENERATION answered it**, page and refusal alike, on both views. A generation is a stream plus the fold over it, and `generation` exists for the one change no cursor check can catch: a `seq` is a position in a STREAM, so moving to a generation over the SAME stream leaves every cursor valid, and moving to one on a DIFFERENT stream is already refused by the cursor's stream component. What is left is SAME LOGS, DIFFERENT FOLD, which nothing in a cursor can see and which a consumer reading state alongside the feed has to be told about.

The value is OPAQUE: compare it against the last one you saw, never take it apart. Its composition is ours to change (it is `generationDigestOf` over the stream digest and the processor's version hash today) and a consumer that parsed it would be depending on something this project expects to replace. It is also stable while the fold is, so comparing it produces no false positives: more logs arriving does not move it.

**The platform ADVERTISES and does not DICTATE.** There is no rule here about what to do when the value moves. Pausing, re-scanning and carrying on are all legitimate, and only the consumer knows whether its own actions can be taken back: a notifier that already fired cannot unfire. (For the record, and NOT as a rule: pausing and letting an operator decide is the expected behaviour.) Note what a change costs a follower of the FEED, which is nothing: the cursor stays valid and the delivered logs are identical, because the generation is deliberately not a column on the log table.

**The cursor is OPAQUE, and it is VALIDATED rather than trusted.** It is a server-encoded string and not data a client parses: the same call ADR-0027 makes for the sync cursor, taken one step further out, because an encoding a client can read becomes a contract that can never change, and here the audience is not even ours (a consumer is built OUTSIDE etherfold, ADR-0005). It CARRIES the view, the indexer name, the stream and the position, and the first three are never used to route anything. The route already routed; those copies exist so that a MISMATCH is REFUSED rather than answered at a number that means something else:

| refusal | |
| --- | --- |
| `400 indexer-mismatch` | a cursor minted at one named indexer, presented at another. Two named indexers can hold byte-identical streams, so a position in one means nothing in the other. It names the indexer the caller ADDRESSED and never the one the cursor was minted at |
| `400 view-mismatch` | a cursor from the other view, whose positions count in `(blockNumber, logIndex)` rather than in `seq` |
| `400 stream-mismatch` | the cursor's stream is not the one served now. THE ONE THAT ANSWERS: it carries `stream` (the current stream's identity) and `startCursor` (a cursor at the position that stream's feed begins at), so a consumer can re-subscribe deliberately |
| `400 invalid-cursor` | anything else, and it says nothing about WHY on purpose: telling an edited cursor from an invented one would tell a client about the encoding |

**A stream mismatch is explicitly NOT a rewind.** There is no fork block to go back to, because the logs a filter change produces were never on the old stream at all. That is why it hands back a place to START rather than a place to RESUME, and why re-subscribing is a decision a consumer takes rather than a step it automates.

**Holes in `seq` are LEGAL and the read is built for them.** A page is `seq > <position> LIMIT n`, and the next position is the `seq` of the last row ACTUALLY SERVED, never the previous position plus anything. Pair-compaction drops a retracted entry together with its retraction and leaves the surrounding numbers where they were, so contiguity was never available to assume, and a consumer that derived its next position by incrementing would break the day compaction is enabled.

**No position is published anywhere**, which is the other half of the same rule: an entry carries the raw log and the `removed` verdict and no `seq`, because publishing one is how a consumer ends up incrementing it.

`limit` defaults to 100 and is capped at 1000. A larger one is REFUSED rather than silently reduced, so a short page always means the stream is short and never that the server quietly served less.

**The feed is a PUBLIC read**, unlike the ingest routes: `INGEST_TOKEN` is the fetcher's deployment secret and it guards the routes that can WRITE, so putting the feed behind it would mean handing every consumer the credential that moves the cursor. A deployment that needs the feed private puts it behind its own edge.

It does need `getIndexer`, because validating a cursor's stream means knowing WHICH stream is served, and the only thing that knows is the receiver registered under the name. The table cannot answer it: one indexer's rows may span several streams over its life, nothing in them says which is current, and picking one by a heuristic is the plausible wrong answer this design refuses. So a host with no registry answers `501` here for the same reason it does on ingest, and `etherfold serve`, the read tier, does not serve the feed today.

## The canonical view

`GET /{indexer}/canonical?gate=<block>` is the second of ADR-0006's two views, and it is the one for a consumer that never wants to hear the word reorg: `WHERE alive AND blockNumber <= gate`, ordered by `(blockNumber, logIndex)`. Its entire sync state is one advancing position, and it implements no reorg handling of its own.

```json
{
	"success": true,
	"stream": "0x…",
	"generation": "<opaque>",
	"entries": [{"blockNumber": 101, "blockHash": "0x…", "logIndex": 0, "address": "0x…", "topics": ["0x…"], "data": "0x…", "transactionHash": "0x…", "transactionIndex": 0}],
	"cursor": "<opaque>",
	"hasMore": true
}
```

**An entry here carries no `removed` field at all**, unlike the other view's. A flag that is false on every entry a view can ever serve is an invitation to write `if (entry.removed)` handling that can never fire, which is exactly the reorg handling this view exists to remove.

**`gate` is REQUIRED and is never defaulted.** A consumer that only wants settled data passes a low gate and one that wants the tip passes a high one (ADR-0007's two lanes); how deep a consumer trusts the chain is the consumer's decision, and this system deliberately knows nothing else about a consumer (ADR-0005). Every candidate default is wrong for somebody and none of them says so, so an absent or malformed `gate` is a `400 invalid-gate`. Raising the gate on a later call serves what was withheld; nothing already delivered is repeated.

**Because it hides reorgs, it owes the compensating guarantee: `409 rewind-required`.** The cursor carries the block HASH the consumer last saw, the server VALIDATES it on every request, and a cursor whose block is no longer canonical is answered with a rewind rather than a page:

```json
{"success": false, "error": "rewind-required", "stream": "0x…", "forkBlock": 103, "rewindCursor": "<opaque>", "message": "…"}
```

`forkBlock` is F, the LOWEST block the consumer must read again: it must also roll its own derived state back to before F, which no cursor can say for it. `rewindCursor` is a cursor at F, meant to be PRESENTED next -- following it is the correct automatic behaviour, which is what the "no reorg handling" promise costs the server. That is why it is named differently from the stream mismatch's `startCursor`, which is a place to BEGIN a new subscription and a decision a human takes.

Continuing from the consumer's own position instead would serve the new branch from `(blockNumber, logIndex)` onward and silently skip the replacement blocks BELOW it -- exactly the events it never received, which is the failure this validation exists to prevent. So the answer is a non-2xx and never a `200` with an instruction beside an empty page: a consumer that ignores a field it does not know would read that as "caught up".

**It is a `409` and not a `400` on purpose.** ADR-0004 already makes `409` the ONE RESUMABLE refusal in this system -- "your position is not where mine is, carry on from here" -- and this is that same sentence spoken to a consumer. Every other cursor refusal on this surface stays a `400`, because no amount of re-presenting the same cursor makes any of them right.

**One hash check is provably enough.** A reorg invalidates a CONTIGUOUS SUFFIX of the chain, so if the block at the cursor is still canonical then the whole prefix behind it is too. Nothing walks back over the window. The fork block itself is the lowest block the stream has retracted anything at SINCE the cursor was minted, which is why the cursor carries a mark as well as a hash, and why a second, deeper reorg moves the answer DOWN rather than leaving a consumer stranded at the first fork.

The read rides the partial index `_emissions_canonical` (`(indexer, stream, blockNumber, logIndex) WHERE alive = 1`), which is what lets ADR-0006 keep ONE table with a flag instead of a second table: the retractions and the rows they killed cost nothing to skip.

**ONE cursor codec across both views**, with the view carried inside the envelope and validated: presenting one view's cursor at the other is a `400 view-mismatch`, never a position read in the wrong space. Two encoders would be two refusal paths that drift, so the canonical view adds its block hash and its mark to the shared envelope rather than minting an encoding of its own. `limit`, the name and stream refusals, the `501`/`404` registry answers and the public-read stance are all the same as the feed's, for the same reasons.

**`/{indexer}/ingest/expected-from-block` is a POST for a question**, deliberately. Answering it can WRITE, because reading the cursor reconciles one belonging to a different source, config or processor version. A `GET` that writes is a trap whatever its justification, so the method matches what it does.

`/status` reports reverts concluded from ABSENCE separately from those concluded from a hash CONTRADICTION, because absence is an inference and a rising rate of it means truncation or misconfiguration rather than chain activity. It does not make the server unhealthy: it is a signal to investigate, not a fault.

**`/status` is the WHOLE query surface for now, deliberately, and the `cursor` field is the whole observability story.** A richer query layer (GraphQL over entity declarations) is decided in principle and is explicitly NOT in this milestone, so a running deployment is watched here or nowhere. The field is an OBJECT and never a bare value (ADR-0047):

```json
{"cursor": {"reported": true, "value": {"lastToBlock": 4242}}}
{"cursor": {"reported": false, "reason": "the cursor table is locked"}}
```

The envelope is the server's and the `value` is the host's, untouched. It is an object so that the GENERATION dimension can grow INSIDE it later (an indexer already holds several generations and reports progress per generation; the server does not hold them yet, so it reports one cursor and a later host adds a key beside `value`), and so that a broken reporter is distinguishable from a host that simply has no store: **a reporter that throws, rejects, reports nothing or returns something unserialisable degrades to `reported: false` with a reason** and never fails the request or changes `healthy`, exactly as the reorg counters degrade.

## Pair-compaction (off by default)

The stored emission stream is append-only, and the ONE thing that ever deletes from it is pair-compaction: a retracted entry reclaimed TOGETHER WITH its retraction, far below finality (ADR-0006). It is a call a HOST SCHEDULES and it is wired to no route and no timer, so **off by default is nobody calling it** rather than a flag this package reads.

```ts
import {compactEmissionPairs, resolvePairCompaction} from '@etherfold/server';

// at startup, so a depth this deployment cannot honour is a boot failure
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

**It is ANSWER-PRESERVING for the canonical view by construction**, which is why it may exist at all: it only ever removes rows that are already `alive = 0`, which that view already excludes, so `GET /{indexer}/canonical` answers BYTE-IDENTICALLY over the same gate before and after. The only consumer that can observe it is one following the `seq` feed further behind than finality, which is already outside the window it may rely on. A from-genesis replay is unaffected too, since an apply/retract pair has no net effect on a reducer whose revert is exact.

**The depth is BLOCK NUMBERS and no other unit, with the finality depth as its FLOOR** (ADR-0019, the rule retention already lives under). A duration would compact on wall-clock progress rather than chain progress. A depth that would compact at or above `latestBlock - finality` is **REFUSED naming both numbers, never clamped**: inside that window a retraction can still arrive, and a silent correction would leave an operator believing something untrue. A depth exactly AT the floor is legal and compacts strictly below it.

**One call does BOUNDED work** (ADR-0022): at most `maxPairs * 2` candidate rows read and `maxPairs` pairs deleted, every row named by its `seq`, in statements chunked to 100 bound parameters inside one batch. `complete` says whether the scan reached the end, so an amortised policy (a small budget, often) and a whole sweep (loop while `complete` is false) are both expressible without this package inventing a cadence.

**A pair goes together or not at all**, and `seq` is never renumbered: the holes left behind are legal by contract and both cursors already tolerate them. An unmatched row is left alone, and a LIVE row is never a candidate however old.

## Typed client

```ts
import {createClient} from '@etherfold/server';

const client = createClient('https://indexer.example');
```

The Hono RPC client type is computed at compile time from the app, so a route change breaks a caller at compile time.

## Related

[`@etherfold/core`](https://github.com/wighawag/etherfold/tree/main/packages/core) for the `StreamBuilder` on the other side of `getIndexer` and the wire types, [`@etherfold/fetcher-host`](https://github.com/wighawag/etherfold/tree/main/packages/fetcher-host) for the sender, and [`@etherfold/state-store-sqlite`](https://github.com/wighawag/etherfold/tree/main/packages/state-store-sqlite) for what a host that DOES host a processor folds into.

## Tests

`pnpm --filter @etherfold/server test`, vitest.
