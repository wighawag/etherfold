# @etherfold/server

The indexer-server, minus any host. A [Hono](https://hono.dev) app that receives its database, its environment and (optionally) the stream-builder it folds with by INJECTION, so the same routes run on Node, on a Cloudflare Worker, or on anything else with a `fetch`.

It knows `RemoteSQL` and nothing else: no Node built-ins, no Cloudflare types, no D1. A test asserts that no source file here names a runtime.

## When you want this package

You are building a HOST. Everything platform-shaped -- which database, which environment, how the app is served -- is the host's, and the shipped ones are [`@etherfold/platform-nodejs`](https://github.com/wighawag/etherfold/tree/main/platforms/nodejs) and [the Cloudflare Worker host](https://github.com/wighawag/etherfold/tree/main/platforms/cf-worker). Reach for this package directly to write a third.

To simply RUN a read tier on Node, use [`etherfold serve`](https://github.com/wighawag/etherfold/tree/main/packages/cli). To fold into a database in one shot, use `etherfold build`.

## What a host supplies

```ts
import {createServer, indexerRegistry, singleContextEntry} from '@etherfold/server';

export const app = createServer<MyEnv>({
	// the HOST-LEVEL handle: what `/status` reports on and `/admin/setup` migrates.
	// Resolved PER REQUEST: a Worker's binding arrives on `env`
	getDB: (c) => myRemoteSQL(c.env),
	getEnv: (c) => c.env,
	// OPTIONAL: the NAMED INDEXERS this deployment hosts, resolved by name -- each to
	// what it holds AND to the DATABASE it holds it in
	getIndexer: indexerRegistry({
		alpha: singleContextEntry(alphaDB, myStreamBuilder),
		beta: singleContextEntry(betaDB, myOtherStreamBuilder),
	}),
	// OPTIONAL: where this deployment's pipeline has got to, if it owns a store
	getCursorReport: async (c) => ({lastToBlock: await myStore.howFar()}),
});
```

`getIndexer` is the NAME-KEYED REGISTRY of the named indexers this host was built with. A **named indexer** is the multi-tenancy unit: one indexed answer set over one chain, fully isolated from every other (ADR-0036). It resolves an ENTRY, and an entry is a DATABASE (`db`) plus SEVERAL LIVE WIRE CONTEXTS: it answers `liveIngestions()` (one receiver per live context) and `canonicalGeneration()` (which generation answers reads). The route segment selects the INDEXER and the batch's own `{source, config}` selects WHICH receiver inside it, so a filter-change successor on a new stream is fed while the incumbent keeps being fed and keeps answering.

**`liveIngestions` is OPTIONAL, and leaving it off states that this name ACCEPTS NO INGESTION**: the ingest routes then answer `501 ingestion-not-accepted`, while the feed, the canonical view, the state-moved signal and the pointer surface answer normally. That is the COMBINED deployment (`etherfold run`), which fetches the chain for itself and folds through an in-process wire, so a remote sender pushing into it would be a second writer nobody asked for. It is a statement about the DEPLOYMENT and is deliberately not the same thing as an EMPTY list, which means "no live wire context right now" on a host that does accept pushes and still answers the `400` a foreign context gets.

**A named indexer IS a database** (ADR-0053), so the handle is part of what the name resolves to and every route acting on ONE named indexer reads through it. `getDB` is the host's own handle and knows no name, which is right for `/status` and `/admin/setup` -- facts about the deployment -- and wrong for anything keyed on a tenant. A host with ONE name ordinarily passes the same handle in both places (`etherfold run` and `etherfold index` do); a host with several gives each name its own, and deleting one is then a complete, cheap operation with no filter to forget. Colocating two names in one database is still expressible -- the rows carry the name -- and is a decision made where it can be read rather than one that happens by default.

The two questions are asked rather than read, because only the generation registry can answer them honestly: a generation deleted elsewhere stops being live, and the canonical pointer moves, without this host being told. `indexerRegistry` builds a registry from a plain record of entries; `singleContextEntry(db, ingestion)` is the entry for a host holding one receiver per name; `indexerEntryOn(db, container)` is the entry for a host holding a `ReceivingIndexer` (`@etherfold/core`), which answers both questions itself and knows no database; and a host whose names depend on the request writes the resolver itself.

It is optional because an indexer-server is useful before it ingests anything: `/status` and `/admin/setup` answer on a server with no processor at all. When it is absent the ingestion routes answer `501` under every name, which says "this server does not do that" rather than pretending the route is missing. That is deliberately a different answer from a registry that does not hold the name asked for, which is a `404`: one is a capability this host lacks, the other is a tenant it was not built with.

`getCursorReport` is optional for the same kind of reason: only the process that OWNS the store can read a cursor, and this package has no store dependency. A host with none (the Cloudflare Worker host is one) injects no reporter and `/status` carries no `cursor` field, rather than an invented one.

`holdsStreamsAcrossRequests` is not a reporter but a CAPABILITY the host declares about its runtime, and it gates exactly one surface: `GET /{indexer}/state-moved`, below. Absent means NO, so a host that says nothing gets a refusal rather than a stream nothing can write to. See that section for why it is declared rather than detected.

`getFetcherLimits` is optional on the same ground, one half of the pipeline further out: it reports what this deployment's LOG-FETCHER has learned about the node it reads, and almost no host has one. The receiving half of ADR-0003 makes no chain call at all, so `etherfold index`, `etherfold serve` and the Workers host inject none and `/status` carries no `fetcher` field; the COMBINED shape (`etherfold run`) holds both halves and is the one that reports it. What it carries is `{reported: true, learnedRange: {ceiling?, safeSpan?, nextSize}, suspectResultCount: {count, source}}`, or `{reported: false, reason}` when a reporter cannot answer. Unlike the cursor it is TYPED here rather than opaque: a learned range is `@etherfold/core`'s, it is three numbers, and it hides behind no storage seam -- so a dashboard reading `fetcher.learnedRange.ceiling` is reading a documented field. It is reported so an operator can hand it BACK as configuration on the next start, which is how a restart resumes where discovery left off while the fetcher itself persists nothing (ADR-0074).

`getPromotionPolicy` is optional on the same ground once more, and one level IN rather than out: it reports WHEN this deployment moves its canonical pointer onto a successor on its own, which is a decision a GENERATION CONTAINER (`@etherfold/core`) makes and this package holds none of -- a route holds a registry entry. A read tier reads a pointer something else moves, so `etherfold serve` injects none and `/status` carries no `promotion` field rather than a claim about a decision it does not make. What it carries is `{reported: true, policy, dropOnPromotion}`, or `{reported: false, reason}` when a reporter cannot answer, and the value is the RESOLVED one rather than what was configured, so an operator reads what will actually happen including the half nobody mentioned. TYPED here for `getFetcherLimits`'s reason: it is `@etherfold/core`'s `UsedPromotionConfig`, a three-valued string and a boolean, hiding behind no seam. It is reported because the policy is otherwise observable only as BEHAVIOUR -- whether a successor takes over as soon as it exists, when it has caught up, or only when asked -- and an operator watching a rebuild on this page can see the successor without being able to see what is going to happen to it.

**What a reporter owes the server: a SMALL, JSON-serialisable summary, and never the store's raw serialized cursor.** That value is a serialized `LastSync` carrying an unconfirmed window of DECODED EVENTS, so handing it over whole would put an unbounded blob on the one page an operator refreshes while something is wrong. The constraint lives on the seam because `/status` reports what the reporter returns VERBATIM: the server does not parse it (the cursor is opaque behind the storage seam, ADR-0027, and only the processor knows what one means), so it cannot bound it afterwards either.

## The routes

| route | |
| --- | --- |
| `GET /status` | health, database reachability, the fixed-schema version against the one this build expects, the reorg counters, the injected cursor report, what the fetcher (if this host holds one) has learned about its node, and the last error this PROCESS saw. `503` when the database is unreachable or the schema is not the expected version |
| `POST /admin/setup` | apply the fixed-table schema |
| `POST /{indexer}/ingest` | a `WireBatch` from a log-fetcher (ADR-0004), for ONE named indexer |
| `POST /{indexer}/ingest/expected-from-block` | where the next batch must start, as one `{context, expectedFromBlock}` per LIVE wire context that named indexer holds |
| `GET /{indexer}/feed` | the RETRACTION-AWARE view over the stored emission stream: `seq`-ordered, `removed` entries included, resumed from an opaque `cursor` the caller holds, `limit` entries at a time |
| `GET /{indexer}/canonical` | the CANONICAL view over the same stream: live entries only, ordered by `(blockNumber, logIndex)`, at or below the caller's REQUIRED `gate`, resumed from an opaque `cursor` whose block hash the server validates |
| `GET /{indexer}/state-moved` | the STATE-MOVED SIGNAL as server-sent events: one `state-moved` frame per block the canonical fold applies (and per reorg it takes back), plus a `progress` frame on connect and whenever the fold moves. Best-effort, nothing held per client, `501` where the host cannot serve it |
| `GET /{indexer}/admin/canonical-generation` | which generation answers reads, every generation this name holds -- each with the opaque `digest` a feed response advertises it by and the `slot` that holds it -- plus what each of the three SLOTS names and everything no slot names (`unslotted`). `ADMIN_TOKEN` |
| `POST /{indexer}/admin/canonical-generation` | MOVE the canonical pointer to `{stream, processor}`: forwards it promotes, BACK it REVERTS, with no re-index and no re-fetch. `ADMIN_TOKEN` |
| `POST /{indexer}/admin/reclaim-generations` | RECLAIM every generation no slot names: its row, its state namespace and its stream where nothing is left folding it. No body. `ADMIN_TOKEN` |

**The indexer NAME is a ROUTE SEGMENT and is never in the envelope.** Carrying it in the payload was considered and rejected: it would make the wire FORMAT carry tenancy, and it would turn a misdirected batch into a payload error rather than a routing one. ADR-0004's envelope and its refusal families are unchanged, and one refusal sits beside them: a name this host was not built with is a `404 unknown-indexer`, never a default to the indexer it does happen to hold.

**The ingest routes are the fetcher's private API and are guarded on the PATH**, read included. Authentication is `Authorization: Bearer <INGEST_TOKEN>`, compared without leaking where two secrets first differ, and it FAILS CLOSED: with no `INGEST_TOKEN` configured the server can authenticate nobody, so every ingestion call is refused with `401`.

**The `/{indexer}/admin/*` routes are the OPERATOR's, guarded the same way at a SECOND credential, `ADMIN_TOKEN`** (ADR-0057). It fails closed identically, and it is deliberately not the ingest token: that one is handed to a log shipper and guards the WRITE path, so letting it also decide which generation answers reads would give a fetcher control-plane authority over the deployment it feeds. The guard runs ahead of the registry lookup, so an unknown name answers `401` to an unauthenticated caller rather than letting one enumerate the names a host was built with. `POST /admin/setup` is host-level and stays unauthenticated; changing that is a decision of its own.

**Moving the pointer is the whole of promotion, and moving it BACK is the whole of a revert.** It is one small write: the generation it names keeps its own state in its own table namespace (ADR-0053) and the stored stream is untouched, so nothing is re-indexed and no log is re-fetched. The route REFUSES a generation this name does not hold (`400 unknown-generation`, naming every one it does) and does NOT require the host to hold a FOLD for the target -- reads resolve the pointer to a namespace, so the generation an operator reverts to answers with no engine at all, which is the ordinary case on a host redeployed with the new processor alone. A host that holds no generation registry answers `501 generations-not-held`: a capability this deployment lacks, not a route that is missing.

**Reclaiming is the operator's answer to a cap that refused, and it never touches a generation a slot names.** A cap REFUSES at its bound and never evicts, so until this verb existed it named what could be deleted and handed over nothing to delete it with. `POST /{indexer}/admin/reclaim-generations` takes every generation NO slot names (ADR-0084's collection rule, which is a refcount rather than a judgement about digests) and leaves `canonical`, `successor` and `predecessor` alone -- the last of those being not canonical right now and exactly the way back from a bad upgrade. It DECLINES, per generation and with the reason, where dropping would leave a fold folding a stream nothing appends to (ADR-0044), and it answers `nothing-to-reclaim` as a SUCCESS that says so rather than reporting work it did not do. It is a VERB an operator runs: nothing sweeps on a timer or at startup, because an automatic reclaim deletes with nobody present. The caps are unchanged by it. `501 reclaim-not-held` where this deployment holds no generations.

**The status codes are the interesting part of the contract.** `409` is the one and only RESUMABLE refusal: it carries `expectedFromBlock`, and a sender's whole recovery is to re-send from there. `400` is a sender that is wrong in a way no block number fixes (a `{source, config}` no live receiver under this name holds, a malformed range, a payload that is not the range it claims). Collapsing the two would make a misconfigured fetcher retry forever against a server that will never accept it.

**`expected-from-block` answers one `{context, expectedFromBlock}` per LIVE wire context**, in a `contexts` list, and never a single pair: a name can hold several at once, and one pair could only have named one of them, silently. A sender finds its own entry by its own `{source, config}` -- `createHttpIngestion` does exactly that, and refuses immediately (non-retryably) when the list holds no entry for it, which is the same fact as the `400` a foreign batch earns, learned before a single log is fetched. A `400 context-mismatch` names EVERY live context as `expected`, rather than picking one.

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

The value is OPAQUE: compare it against the last one you saw, never take it apart. Its composition is ours to change (it is `generationDigestOf` over the stream digest and the fold's identity today, which is the SHA-256 of the processor bundle's bytes where a deployment read one off disk, ADR-0086) and a consumer that parsed it would be depending on something this project expects to replace. It is also stable while the fold is, so comparing it produces no false positives: more logs arriving does not move it.

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

**Both views answer from the CANONICAL generation and only it.** Its stream and its fold are read TOGETHER, once per request, so a response can never pair one generation's stream with another's fold -- and a filter-change successor being fed under the same name is invisible here until the canonical pointer moves. When it does, a cursor for the old stream meets the `400 stream-mismatch` below, which is explicitly not a rewind.

It does need `getIndexer`, because validating a cursor's stream means knowing WHICH stream is served, and the only thing that knows is what the name resolves to. The table cannot answer it: one indexer's rows may span several streams over its life, nothing in them says which is current, and picking one by a heuristic is the plausible wrong answer this design refuses. So a host with no registry answers `501` here for the same reason it does on ingest, and `etherfold serve`, the read tier, does not serve the feed today.

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

The envelope is the server's and the `value` is the host's, untouched. It is an object so that the GENERATION dimension can grow INSIDE it, which it now has: a reporter returns two named slots, `{value?, generations?}`, and the server puts each beside the other without parsing either. `generations` is one entry per generation the host holds, saying which is canonical and how far a rebuilt one has got, and it is carried on the `reported: false` branch too, because a FIRST BUILD has generations and no cursor yet. `etherfold run` and `etherfold index` both fill it; a read tier fills neither, because it owns no store. The envelope is also an object so that a broken reporter is distinguishable from a host that simply has no store: **a reporter that throws, rejects, reports nothing or returns something unserialisable degrades to `reported: false` with a reason** and never fails the request or changes `healthy`, exactly as the reorg counters degrade.

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

## The state-moved stream

`GET /{indexer}/state-moved` tells a remote client that the state moved, over server-sent events, so an app reading from a hosted indexer runs the SAME notification handler as an app indexing in its own browser (ADR-0083). What crosses is `@etherfold/core`'s `StateMoved` serialised as JSON and otherwise untouched, so a reader's whole rule is the same two lines everywhere: **token unchanged, invalidate narrowly using `entities`; token changed, invalidate everything.**

```
event: progress
data: {"lastToBlock":105,"latestBlock":205,"blocksBehindTip":100,"coherence":"…","generation":"…"}

event: state-moved
data: {"kind":"applied","block":106,"coherence":"…","entities":["token"],"generation":"…"}
```

**This package APPLIES NO BLOCKS, so this is a TRANSPORT and never a producer.** The signal is published by the generation container that folds (`ReceivingIndexer.onStateMoved`, `@etherfold/core`), and a route holds an ENTRY rather than a container -- so this route subscribes at `IndexerRegistryEntry.onStateMoved` and adds nothing of its own. A second transport (a `graphql-ws` adapter, a hibernating socket) attaches at that same seam with NO change to the code that publishes. No GraphQL runtime, schema or subscription is here: the signal is the primitive and a subscription is a derivable adapter over it.

**TWO frame kinds, and their difference is the one a tab's port already makes** (ADR-0082). `progress` is a STATE -- where the fold has got to -- so it is sent ON CONNECT and again whenever it moves. `state-moved` is a NOTIFICATION, a thing that HAPPENED, so nothing is ever replayed to a client that missed one: there is nothing held to replay, and replaying would have a reader invalidate for a block it may already have read.

**Progress rides this stream because a reader cannot compute it.** The sync cursor is opaque behind the storage seam (ADR-0027), so "syncing, 100 blocks behind" has to be published by the side that knows, and a second endpoint would be two mechanisms with two failure modes for one question. The figures are `lastToBlock` / `latestBlock` / `blocksBehindTip` -- the vocabulary a tab already binds to a progress bar -- read from the stream's own **coverage claim**, which is written on every batch including one that carried no logs. They are ABSENT rather than zeroed before the first batch, because "nothing folded yet" and "level at block 0" are different claims.

**A connecting client is told the position AND the coherence token at once**, which is how a remote reader converges: it has no store to re-read and no state query surface yet, so it compares the token it holds against the one in force and knows immediately whether it is stale. That is what `IndexerRegistryEntry.coherenceNow` answers, paired with `onStateMoved`.

**Nothing is held per client.** One handler reference per open stream, no client identity, nothing buffered, nothing retried, and a disconnect detaches. A client that missed a notification is repaired by the next one plus the token; one that was cut off is repaired by the `progress` frame it is handed on reconnect. There is deliberately **no heartbeat**: an interval invented here would be the polling interval the signal exists to replace, and no number fits a Node process, a reverse proxy and a CDN at once -- a deployment that needs idle connections held open configures its own edge. (`X-Accel-Buffering: no` is sent for the neighbouring problem: it asks a buffering proxy not to WITHHOLD frames that were written.)

**It REFUSES where it cannot be served, rather than accepting a connection it will never write to.** Two `501`s beside the shared name refusals (`501` no registry, `404` a name this host was not built with) and the `503` an indexer with no canonical generation answers:

- `state-moved-unsupported-runtime` -- the host has not declared `holdsStreamsAcrossRequests`. A block is folded inside an INGEST request while the stream was opened by another, so the runtime has to let one request write into a stream a different one opened. On **Cloudflare Workers it cannot**: an I/O object created in one request handler is unreachable from another, and the remedy is a Durable Object, which is infrastructure a deployment takes on deliberately. `platforms/nodejs` declares it; the Worker host deliberately does not.
- `state-moved-not-published` -- the name resolves to a host holding a bare receiver and no container, which publishes nothing. Absent is a capability statement, exactly as it is for `generations` and `promote`.

**The condition is a capability the HOST declares and never a runtime this package detects**, because it names no runtime at all (asserted by test) and because the failure being prevented is the invisible one: a subscriber registry COMPILES, passes on Node and silently never fires on a Worker, which a reader cannot tell apart from a quiet chain.

**It is a PUBLIC read, like the feed.** `INGEST_TOKEN` guards the routes that can move the cursor; this one moves nothing and reads no rows, and what crosses is a block number, entity NAMES and two opaque digests. A deployment that needs it private puts it behind its own edge.

Note what this is NOT: the **feed**. A feed consumer owns a cursor and reads the sequenced emission stream on its own cadence; a reader here holds no cursor and is told, best-effort, that the state moved.

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
