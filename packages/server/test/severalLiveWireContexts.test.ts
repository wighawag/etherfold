import {createClient} from '@libsql/client';
import {
	generationDigestOf,
	openReceivingIndexer,
	sameWireContext,
	serializeWireBatch,
	type GenerationId,
	type LogEvent,
	type ReceivingIndexer,
	type WireBatch,
	type WireContext,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeEach, describe, expect, it} from 'vitest';
import {applySchema, createServer, emissionAppenderFor, generationRegistryPortOnSQL} from '../src/index.js';
import {
	ALICE,
	BOB,
	CONTRACT,
	OTHER_CONTRACT,
	RECONFIGURED_SOURCE,
	SOURCE,
	START_BLOCK,
	STREAM_CONFIG,
	TOKEN,
	transfer,
	type TestABI,
} from './utils/feedHarness.js';

// ---------------------------------------------------------------------------------------------------
// ONE REGISTRY ENTRY HOLDS SEVERAL LIVE WIRE CONTEXTS
// ---------------------------------------------------------------------------------------------------
// A FILTER or CONFIG change makes a NEW STREAM, and therefore a new
// `{source, config}` on the wire. Under one receiver per name a successor on one
// could not receive a single log: its batches met the `400` that is deliberately
// not resumable, so it starved while the incumbent went on being fed.
//
// Now the ROUTE SEGMENT selects the INDEXER and the batch's own `{source,
// config}` selects WHICH RECEIVER inside it. What is asserted here is that seam,
// through the HTTP surface a sender actually meets:
//
//  - both streams are fed, and neither advances the other's cursor;
//  - `expected-from-block` answers one `{context, expectedFromBlock}` per LIVE
//    context, which is what lets a fetcher host later run a loop per context;
//  - the refusal families are UNCHANGED -- `409` is still the one resumable
//    refusal, a context in no receiver is still a `400`, an unknown name is still
//    a `404`;
//  - a context is LIVE while its generation is registered, DERIVED from the
//    registry and never from "a promotion retired the previous one": a superseded
//    generation is retained under the caps, so the pointer moving is not by itself
//    a reason to stop feeding it;
//  - and a FEED consumer sees none of it, because both views answer from the
//    CANONICAL generation's stream and fold, read once per request.
//
// The host below is the real assembly: a `ReceivingIndexer` over the SQL
// generation registry, registered as the entry itself (it answers the entry's two
// questions, so nothing adapts it).
// ---------------------------------------------------------------------------------------------------

const NAME = 'alpha';

/** The fold both streams here run. WHICH stream a generation folds is the half that differs. */
const entityProcessor: EntityProcessor<TestABI> = {
	version: '1.0.0',
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
	async onTransfer(state, event) {
		state.set('token', {id: (event.args as {id: bigint}).id.toString()}, {owner: event.args.to});
	},
};

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * A fold, as the container builds one: its own state FIRST, then the processor
 * over it (ADR-0043).
 *
 * The state here is a DATABASE OF ITS OWN rather than a table namespace inside
 * the shared one, which is the cheapest thing that is honestly per generation.
 * The namespace version is asserted over a real shared handle in
 * `packages/cli/test/aChangedContextCreatesASuccessor.test.ts`; what is under
 * test here is ROUTING, and a fold that reached another's rows would make an
 * assertion about routing mean nothing.
 */
function foldOwningItsOwnState() {
	return {
		createState: () => freshDatabase(),
		createProcessor: (state: RemoteSQL) => new VersionedStateEventProcessor<TestABI>(state, entityProcessor),
	};
}

type Deployment = {
	app: ReturnType<typeof createServer<{INGEST_TOKEN?: string}>>;
	db: RemoteSQL;
	indexer: ReceivingIndexer<TestABI, unknown, RemoteSQL>;
	/** The fold this host opened with: the INCUMBENT, on `SOURCE`'s stream. */
	incumbent: {context: WireContext; generation: GenerationId; processor: VersionedStateEventProcessor<TestABI>};
	/** The filter-change SUCCESSOR, on `RECONFIGURED_SOURCE`'s stream. */
	successor: {context: WireContext; generation: GenerationId; processor: VersionedStateEventProcessor<TestABI>};
};

/**
 * ONE named indexer holding TWO live wire contexts, over one database.
 *
 * The successor is added AFTER the container is open, because that is when it
 * exists: a filter-change successor is created beside a running incumbent, and
 * its context becomes live at that moment.
 */
async function deploy(): Promise<Deployment> {
	const db = freshDatabase();
	await applySchema(db);
	const indexer = (await openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, NAME),
		source: SOURCE,
		stream: STREAM_CONFIG,
		appendEmissions: emissionAppenderFor(db, NAME),
		generation: foldOwningItsOwnState(),
	})) as ReceivingIndexer<TestABI, unknown, RemoteSQL>;
	const successor = await indexer.add({source: RECONFIGURED_SOURCE, ...foldOwningItsOwnState()});

	const app = createServer<{INGEST_TOKEN?: string}>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		// the container IS the entry: it answers `liveIngestions` and
		// `canonicalGeneration`, which is the whole of what the routes ask a name for
		getIndexer: (_c, name) => (name === NAME ? indexer : undefined),
	});

	return {
		app,
		db,
		indexer,
		incumbent: {
			context: indexer.ingestion.context,
			generation: indexer.generation,
			processor: indexer.processor as VersionedStateEventProcessor<TestABI>,
		},
		successor: {
			context: successor.ingestion.context,
			generation: {stream: successor.record.stream, processor: successor.record.processor},
			processor: successor.processor as VersionedStateEventProcessor<TestABI>,
		},
	};
}

async function post(deployment: Deployment, batch: WireBatch<TestABI>, name = NAME): Promise<Response> {
	return deployment.app.request(`/${name}/ingest`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
		body: serializeWireBatch(batch),
	});
}

async function askWhereToStart(
	deployment: Deployment,
	name = NAME,
): Promise<{status: number; contexts: {context: WireContext; expectedFromBlock: number}[]}> {
	const res = await deployment.app.request(`/${name}/ingest/expected-from-block`, {
		method: 'POST',
		headers: {Authorization: `Bearer ${TOKEN}`},
	});
	const body = (await res.json()) as {contexts?: {context: WireContext; expectedFromBlock: number}[]};
	return {status: res.status, contexts: body.contexts ?? []};
}

/** Where the next batch must start for ONE context, as a sender finds its own entry. */
async function expectedFor(deployment: Deployment, context: WireContext): Promise<number | undefined> {
	const {contexts} = await askWhereToStart(deployment);
	return contexts.find((entry) => sameWireContext(entry.context, context))?.expectedFromBlock;
}

function batchFor(
	context: WireContext,
	over: {fromBlock: number; toBlock: number; latestBlock: number; logs?: LogEvent<TestABI>[]},
): WireBatch<TestABI> {
	return {
		context,
		fromBlock: over.fromBlock,
		toBlock: over.toBlock,
		latestBlock: over.latestBlock,
		logs: over.logs ?? [],
	};
}

/** What one fold concluded, read through its own store. */
async function ownerOf(processor: VersionedStateEventProcessor<TestABI>, id: string): Promise<string | undefined> {
	return (await processor.state.getCurrent<{owner: string}>('token', {id}))?.owner;
}

let deployment: Deployment;

beforeEach(async () => {
	deployment = await deploy();
});

describe('one named indexer, several live wire contexts', () => {
	it('answers one {context, expectedFromBlock} per LIVE context, not a single pair', async () => {
		const asked = await askWhereToStart(deployment);

		expect(asked.status).toBe(200);
		expect(asked.contexts).toEqual([
			{context: deployment.incumbent.context, expectedFromBlock: START_BLOCK},
			{context: deployment.successor.context, expectedFromBlock: START_BLOCK},
		]);
		// two ADDRESSES, not one repeated: a filter change is a different stream
		expect(deployment.incumbent.context).not.toEqual(deployment.successor.context);
	});

	it('feeds each stream from its own batches, and neither advances the other\u2019s cursor', async () => {
		const toIncumbent = await post(
			deployment,
			batchFor(deployment.incumbent.context, {
				fromBlock: 100,
				toBlock: 105,
				latestBlock: 105,
				logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)],
			}),
		);
		expect(toIncumbent.status).toBe(200);
		expect(await expectedFor(deployment, deployment.incumbent.context)).toBe(102);
		// the successor was NOT moved by its neighbour's batch
		expect(await expectedFor(deployment, deployment.successor.context)).toBe(START_BLOCK);

		const toSuccessor = await post(
			deployment,
			batchFor(deployment.successor.context, {
				fromBlock: 100,
				toBlock: 110,
				latestBlock: 110,
				logs: [transfer(108, '0xa108', BOB, 2n, 0, OTHER_CONTRACT)],
			}),
		);
		expect(toSuccessor.status).toBe(200);
		expect(await expectedFor(deployment, deployment.successor.context)).toBe(107);
		expect(await expectedFor(deployment, deployment.incumbent.context)).toBe(102);

		// and each fold holds ITS OWN logs and nothing of the other's
		expect(await ownerOf(deployment.incumbent.processor, '1')).toBe(ALICE);
		expect(await ownerOf(deployment.incumbent.processor, '2')).toBeUndefined();
		expect(await ownerOf(deployment.successor.processor, '2')).toBe(BOB);
		expect(await ownerOf(deployment.successor.processor, '1')).toBeUndefined();
	});

	it('still corrects ONE sender with the 409 that names its own expected block', async () => {
		await post(
			deployment,
			batchFor(deployment.incumbent.context, {
				fromBlock: 100,
				toBlock: 105,
				latestBlock: 105,
				logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)],
			}),
		);

		// the lost-acknowledgement case, unchanged by there being a second context:
		// the cursor is still the idempotency key, and `409` is still the one
		// resumable refusal
		const resent = await post(
			deployment,
			batchFor(deployment.incumbent.context, {fromBlock: 100, toBlock: 105, latestBlock: 105}),
		);
		expect(resent.status).toBe(409);
		expect(await resent.json()).toMatchObject({error: 'unexpected-fromBlock', expectedFromBlock: 102});

		// re-sending from where it was told lands, and the other context is untouched
		const corrected = await post(
			deployment,
			batchFor(deployment.incumbent.context, {fromBlock: 102, toBlock: 108, latestBlock: 108}),
		);
		expect(corrected.status).toBe(200);
		expect(await expectedFor(deployment, deployment.successor.context)).toBe(START_BLOCK);
	});

	it('refuses a context in NEITHER receiver with the ordinary 400, naming every live one', async () => {
		const foreign: WireContext = {source: deployment.incumbent.context.source, config: 'someone-elses'};
		const res = await post(deployment, batchFor(foreign, {fromBlock: 100, toBlock: 105, latestBlock: 105}));

		expect(res.status).toBe(400);
		const body = (await res.json()) as {error: string; expected: WireContext[]; expectedFromBlock?: number};
		expect(body.error).toBe('context-mismatch');
		// NAMED rather than chosen: every live context, exactly as a cap refusal
		// names every deletable generation
		expect(body.expected).toEqual([deployment.incumbent.context, deployment.successor.context]);
		// and NOT the 409 a sender auto-recovers from: no block number makes it right
		expect(body.expectedFromBlock).toBeUndefined();
		// nothing moved
		expect(await expectedFor(deployment, deployment.incumbent.context)).toBe(START_BLOCK);
		expect(await expectedFor(deployment, deployment.successor.context)).toBe(START_BLOCK);
	});

	it('still refuses a name this host was not built with, rather than reaching one of these contexts', async () => {
		const pushed = await post(
			deployment,
			batchFor(deployment.incumbent.context, {fromBlock: 100, toBlock: 105, latestBlock: 105}),
			'beta',
		);
		expect(pushed.status).toBe(404);
		expect((await pushed.json()).error).toBe('unknown-indexer');

		const asked = await askWhereToStart(deployment, 'beta');
		expect(asked.status).toBe(404);
		// and neither context received anything
		expect(await expectedFor(deployment, deployment.incumbent.context)).toBe(START_BLOCK);
		expect(await expectedFor(deployment, deployment.successor.context)).toBe(START_BLOCK);
	});
});

describe('a live context has a LIFETIME, and the registry is what says so', () => {
	it('stops being live when its generation is DELETED, and a batch for it is then the ordinary 400', async () => {
		await post(
			deployment,
			batchFor(deployment.successor.context, {
				fromBlock: 100,
				toBlock: 110,
				latestBlock: 110,
				logs: [transfer(108, '0xa108', BOB, 2n, 0, OTHER_CONTRACT)],
			}),
		);
		expect(await expectedFor(deployment, deployment.successor.context)).toBe(107);

		// the successor is dropped: its generation goes and, since it was the last
		// one on its stream, the stream is REAPED with it
		const deletion = await deployment.indexer.registry.deleteGeneration(deployment.successor.generation);
		expect(deletion.reaped).toBe(deployment.successor.generation.stream);

		const asked = await askWhereToStart(deployment);
		expect(asked.contexts).toEqual([{context: deployment.incumbent.context, expectedFromBlock: START_BLOCK}]);

		const res = await post(
			deployment,
			batchFor(deployment.successor.context, {fromBlock: 107, toBlock: 112, latestBlock: 112}),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('context-mismatch');
		// the incumbent is untouched by its neighbour's departure
		expect(await expectedFor(deployment, deployment.incumbent.context)).toBe(START_BLOCK);
	});

	it('does NOT stop being live because the pointer moved: a retained generation is still fed', async () => {
		// the promotion. Under this spec the superseded generation is RETAINED rather
		// than dropped, so being no longer canonical is not by itself a reason to stop
		// feeding a context -- and the live set is DERIVED from the registry, so what
		// that rule should be is a policy input rather than a rewrite of this routing.
		await deployment.indexer.registry.moveCanonicalTo(deployment.successor.generation);

		const asked = await askWhereToStart(deployment);
		expect(asked.contexts.map((entry) => entry.context)).toEqual([
			deployment.incumbent.context,
			deployment.successor.context,
		]);

		const res = await post(
			deployment,
			batchFor(deployment.incumbent.context, {
				fromBlock: 100,
				toBlock: 105,
				latestBlock: 105,
				logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)],
			}),
		);
		expect(res.status).toBe(200);
		expect(await ownerOf(deployment.incumbent.processor, '1')).toBe(ALICE);
	});
});

describe('the feed answers from the CANONICAL generation alone', () => {
	/** Both views, as a consumer reads them. */
	async function readViews(name = NAME) {
		const feed = await deployment.app.request(`/${name}/feed`);
		const canonical = await deployment.app.request(`/${name}/canonical?gate=1000`);
		return {
			feed: (await feed.json()) as {
				stream: string;
				generation: string;
				entries: {blockNumber: number}[];
				cursor: string;
			},
			canonical: (await canonical.json()) as {stream: string; generation: string; entries: {blockNumber: number}[]},
		};
	}

	beforeEach(async () => {
		// both streams are fed, and both are stored: each is the only generation on
		// its own stream, so each is its own stream's writer (ADR-0044)
		await post(
			deployment,
			batchFor(deployment.incumbent.context, {
				fromBlock: 100,
				toBlock: 105,
				latestBlock: 105,
				logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)],
			}),
		);
		await post(
			deployment,
			batchFor(deployment.successor.context, {
				fromBlock: 100,
				toBlock: 110,
				latestBlock: 110,
				logs: [transfer(108, '0xa108', BOB, 2n, 0, OTHER_CONTRACT)],
			}),
		);
	});

	it('serves the canonical generation\u2019s stream and advertises its fold, with a successor being fed beside it', async () => {
		const {feed, canonical} = await readViews();

		for (const view of [feed, canonical]) {
			expect(view.stream).toBe(deployment.incumbent.generation.stream);
			expect(view.generation).toBe(generationDigestOf(deployment.incumbent.generation));
			// the successor's logs are on ANOTHER stream and a consumer sees none of
			// them: the block it emitted at is simply not here
			expect(view.entries.map((entry) => entry.blockNumber)).toEqual([101]);
		}
	});

	it('follows the pointer when it moves, and refuses the old cursor as a stream it no longer serves', async () => {
		const before = await readViews();

		await deployment.indexer.registry.moveCanonicalTo(deployment.successor.generation);
		const after = await readViews();

		expect(after.feed.stream).toBe(deployment.successor.generation.stream);
		expect(after.feed.generation).toBe(generationDigestOf(deployment.successor.generation));
		expect(after.feed.entries.map((entry) => entry.blockNumber)).toEqual([108]);
		expect(after.canonical.stream).toBe(after.feed.stream);
		// ONE read per request: the two views agree, and neither pairs one
		// generation's stream with another's fold
		expect(after.canonical.generation).toBe(after.feed.generation);

		// the cursor a consumer held is a position in a stream this indexer no longer
		// serves, which is the existing refusal and explicitly NOT a rewind
		const stale = await deployment.app.request(`/${NAME}/feed?cursor=${encodeURIComponent(before.feed.cursor)}`);
		expect(stale.status).toBe(400);
		const body = (await stale.json()) as {error: string; stream: string; generation: string};
		expect(body.error).toBe('stream-mismatch');
		expect(body.stream).toBe(after.feed.stream);
		expect(body.generation).toBe(after.feed.generation);
	});
});
