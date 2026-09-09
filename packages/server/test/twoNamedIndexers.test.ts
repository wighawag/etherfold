import {createClient} from '@libsql/client';
import {
	GenerationCapReachedError,
	openReceivingIndexer,
	sameWireContext,
	serializeWireBatch,
	type IndexingSource,
	type LogEvent,
	type ReceivingIndexer,
	type WireBatch,
	type WireContext,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeEach, describe, expect, it} from 'vitest';
import {
	applySchema,
	createServer,
	emissionAppenderFor,
	generationRegistryPortOnSQL,
	indexerEntryOn,
	readReorgCounters,
	storedEmissionReplaySource,
} from '../src/index.js';
import {hostRecorderFor} from './utils/hostRecorder.js';
import {
	abi,
	ALICE,
	BOB,
	CAROL,
	CONTRACT,
	FINALITY,
	IDENTICAL_SOURCE,
	RECONFIGURED_SOURCE,
	SOURCE,
	START_BLOCK,
	STREAM_CONFIG,
	TOKEN,
	transfer,
	type TestABI,
} from './utils/feedHarness.js';

// ---------------------------------------------------------------------------------------------------
// TWO NAMED INDEXERS ON ONE HOST NEVER TOUCH EACH OTHER'S DATA
// ---------------------------------------------------------------------------------------------------
// A NAMED INDEXER is the multi-tenancy unit (ADR-0036) and it is a DATABASE
// (ADR-0053): a host registering several gives each one its own, so no query,
// prefix scan or cap in one can ever reach another's rows. This file is the
// GUARD for that claim, and it is written to FAIL LOUDLY if any discriminator is
// ever forgotten:
//
//  - the two indexers have IDENTICAL sources, contracts, stream config and
//    processor, so `streamDigestOf` cannot tell them apart and neither can a
//    wire context. The NAME and the DATABASE it resolves to are the only things
//    that do -- which is exactly when defaulting to "the database this host has"
//    would look plausible;
//  - the host's OWN handle (`getDB`, which is right for `/status` and
//    `/admin/setup` and knows no name) is a THIRD database holding neither
//    indexer's rows. A route acting on one named indexer that reached for it
//    would answer with nothing at all rather than with something that happens to
//    look right.
//
// It is asserted END TO END, at every seam the claim rests on: the ROUTES (both
// feed views and both ingest routes), the STORE (a read of the fold's own
// state), the STORED STREAM (`_emissions` under each name) and the REGISTRY (the
// generations each holds, its canonical pointer and its caps).
//
// The delete is the other half of the claim: deleting everything in one named
// indexer is a DROP of its database, with no filter to forget, and the other is
// still COMPLETE and READABLE afterwards -- asserted by READING it, never by
// listing tables.
// ---------------------------------------------------------------------------------------------------

/** The two names this host is built with. Everything else about them is identical. */
const ALPHA = 'alpha';
const BETA = 'beta';

/**
 * The bound each named indexer states, and the SAME one for both: a cap that
 * refuses in one only is a fact about WHOSE registry counted, not about whose
 * number was smaller.
 */
const CAPS = {maxGenerations: 2, maxStreams: 2};

/** A third filter, so a third stream: what a named indexer at its cap is asked for. */
const THIRD_CONTRACT = '0x0000000000000000000000000000000000000055' as const;
const THIRD_SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: THIRD_CONTRACT, startBlock: START_BLOCK}],
};

/** The fold BOTH named indexers run, byte for byte. */
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
 * The fold a named indexer OPENS with, folding into the named indexer's OWN
 * DATABASE -- the shape `etherfold index` has, where one handle carries the fixed
 * tables, the stored stream and the state at once.
 *
 * That is what makes the delete below a real claim: everything this name holds,
 * including what its canonical generation answers from, goes with the one
 * database.
 *
 * `createProcessor` hands the state back because the SQLite flavour is both the
 * store owner and the processor over it; the two steps still happen in ADR-0043's
 * order.
 */
function openingFoldIn(db: RemoteSQL) {
	return {
		createState: () => new VersionedStateEventProcessor<TestABI>(db, entityProcessor, {finalityDepth: FINALITY}),
		createProcessor: (state: VersionedStateEventProcessor<TestABI>) => state,
	};
}

/**
 * A SUCCESSOR's fold, whose state here is a handle of its own.
 *
 * ADR-0053 puts a successor's state in a TABLE NAMESPACE inside the SAME
 * database, and that form is asserted over a real shared handle in
 * `packages/cli/test/aChangedContextCreatesASuccessor.test.ts`. It is not
 * reachable through `VersionedStateEventProcessor`, whose options carry no
 * namespace (`the-sqlite-processor-convenience-cannot-take-a-table-namespace`),
 * and it is not what THIS file is the guard for: a successor here exists to be
 * COUNTED by a cap and RECORDED in a registry, and both of those live in the
 * named indexer's own database either way.
 */
function foldBeside() {
	const db = freshDatabase();
	return openingFoldIn(db);
}

/** ONE named indexer: its NAME, its DATABASE, and the container holding its generations. */
type Tenant = {
	name: string;
	db: RemoteSQL;
	indexer: ReceivingIndexer<TestABI, unknown, VersionedStateEventProcessor<TestABI>>;
};

async function openTenant(name: string, source: IndexingSource<TestABI>): Promise<Tenant> {
	// a DATABASE OF ITS OWN, with the fixed tables applied to it: the emission
	// stream, the coverage claim, the reorg counters and the generation registry
	// this name owns all live here and nowhere else
	const db = freshDatabase();
	await applySchema(db);
	const indexer = (await openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, name),
		caps: CAPS,
		source,
		stream: STREAM_CONFIG,
		recordReorg: hostRecorderFor(db),
		appendEmissions: emissionAppenderFor(db, name),
		replay: storedEmissionReplaySource(db, name),
		generation: openingFoldIn(db),
	})) as ReceivingIndexer<TestABI, unknown, VersionedStateEventProcessor<TestABI>>;
	return {name, db, indexer};
}

type TestEnv = {DEV?: string; INGEST_TOKEN?: string};

type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	/** The HOST's own handle: `/status` and `/admin/setup`, and NEITHER tenant's rows. */
	hostDB: RemoteSQL;
	alpha: Tenant;
	beta: Tenant;
};

/**
 * ONE HOST, TWO NAMED INDEXERS, THREE DATABASES.
 *
 * The registry resolves a NAME to what that name holds AND to the database it
 * holds it in, which is the whole of this task: `getDB` answers per REQUEST and
 * knows no name, so it is right for the host-level surfaces and wrong for
 * anything keyed on a tenant.
 */
async function deploy(): Promise<Deployment> {
	const hostDB = freshDatabase();
	const alpha = await openTenant(ALPHA, SOURCE);
	// IDENTICAL: the same chain, the same contract, the same start block, the same
	// stream config and the same processor
	const beta = await openTenant(BETA, IDENTICAL_SOURCE);
	const tenants: Record<string, Tenant> = {[ALPHA]: alpha, [BETA]: beta};

	const app = createServer<TestEnv>({
		getDB: () => hostDB,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: (_c, name) => {
			const tenant = tenants[name];
			return tenant ? indexerEntryOn(tenant.db, tenant.indexer) : undefined;
		},
	});
	// the host-level surface, on the host's own handle
	await app.request('/admin/setup', {method: 'POST'});
	return {app, hostDB, alpha, beta};
}

let deployment: Deployment;

beforeEach(async () => {
	deployment = await deploy();
});

// ---------------------------------------------------------------------------------------------------

async function post(tenant: Tenant, batch: WireBatch<TestABI>): Promise<Response> {
	return deployment.app.request(`/${tenant.name}/ingest`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
		body: serializeWireBatch(batch),
	});
}

function batchFor(
	tenant: Tenant,
	over: {fromBlock: number; toBlock: number; latestBlock: number; logs?: LogEvent<TestABI>[]},
): WireBatch<TestABI> {
	return {
		context: tenant.indexer.ingestion.context,
		fromBlock: over.fromBlock,
		toBlock: over.toBlock,
		latestBlock: over.latestBlock,
		logs: over.logs ?? [],
	};
}

/**
 * Where the next batch must start, as a SENDER reads it off the route: by
 * finding its OWN `{source, config}` in the list, never by taking the first
 * entry, because a name holding a successor answers one pair per live context.
 */
async function expectedFor(tenant: Tenant): Promise<number | undefined> {
	const res = await deployment.app.request(`/${tenant.name}/ingest/expected-from-block`, {
		method: 'POST',
		headers: {Authorization: `Bearer ${TOKEN}`},
	});
	const body = (await res.json()) as {contexts?: {context: WireContext; expectedFromBlock: number}[]};
	const mine = tenant.indexer.ingestion.context;
	return body.contexts?.find((entry) => sameWireContext(entry.context, mine))?.expectedFromBlock;
}

type FeedBody = {stream: string; generation: string; entries: {blockNumber: number}[]; cursor: string};

/** BOTH views, as a consumer reads them: the retraction-aware feed and the canonical one. */
async function readViews(name: string): Promise<{feed: FeedBody; canonical: FeedBody; status: number}> {
	const feed = await deployment.app.request(`/${name}/feed`);
	const canonical = await deployment.app.request(`/${name}/canonical?gate=1000`);
	return {
		feed: (await feed.json()) as FeedBody,
		canonical: (await canonical.json()) as FeedBody,
		status: feed.status === canonical.status ? feed.status : -1,
	};
}

/** What ONE named indexer's fold concluded, read through its own store. */
async function ownerOf(tenant: Tenant, id: string): Promise<string | undefined> {
	const processor = tenant.indexer.processor as VersionedStateEventProcessor<TestABI>;
	return (await processor.state.getCurrent<{owner: string}>('token', {id}))?.owner;
}

/**
 * DELETE EVERYTHING in one named indexer, the way its database is deleted: every
 * table goes, and NOT ONE STATEMENT CARRIES A DISCRIMINATOR.
 *
 * That is the cheap, complete operation ADR-0053 buys: no `WHERE indexer = ?`
 * anywhere, so there is no filter for a later reader or a later writer to
 * forget.
 */
async function deleteEverythingIn(db: RemoteSQL): Promise<number> {
	const tables = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
		.all<{name: string}>();
	await db.batch(tables.results.map((row) => db.prepare(`DROP TABLE "${row.name}"`)));
	return tables.results.length;
}

/** Fill both, with DIFFERENT logs, so anything reaching across is visible rather than plausible. */
async function feedBoth(): Promise<void> {
	expect(
		(
			await post(
				deployment.alpha,
				batchFor(deployment.alpha, {
					fromBlock: 100,
					toBlock: 105,
					latestBlock: 105,
					logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)],
				}),
			)
		).status,
	).toBe(200);
	expect(
		(
			await post(
				deployment.beta,
				batchFor(deployment.beta, {
					fromBlock: 100,
					toBlock: 108,
					latestBlock: 108,
					logs: [transfer(106, '0xb106', BOB, 2n, 0, CONTRACT), transfer(107, '0xb107', CAROL, 3n, 0, CONTRACT)],
				}),
			)
		).status,
	).toBe(200);
}

// ---------------------------------------------------------------------------------------------------

describe('two named indexers on one host, identical in everything but their name', () => {
	it('index ONE stream identity, so nothing but the name and its database tells them apart', async () => {
		expect(deployment.beta.indexer.streamDigest).toBe(deployment.alpha.indexer.streamDigest);
		// and a batch could not name one either: the wire context is the same value
		expect(deployment.beta.indexer.ingestion.context).toEqual(deployment.alpha.indexer.ingestion.context);
		// which is what makes every assertion below a real claim rather than a
		// coincidence of two digests
		expect(deployment.alpha.db).not.toBe(deployment.beta.db);
	});

	it('are fed independently: the state, the cursor and the stored stream stay in their own database', async () => {
		await feedBoth();

		// THE STORE: each fold holds its own logs and nothing of the other's
		expect(await ownerOf(deployment.alpha, '1')).toBe(ALICE);
		expect(await ownerOf(deployment.alpha, '2')).toBeUndefined();
		expect(await ownerOf(deployment.alpha, '3')).toBeUndefined();
		expect(await ownerOf(deployment.beta, '2')).toBe(BOB);
		expect(await ownerOf(deployment.beta, '3')).toBe(CAROL);
		expect(await ownerOf(deployment.beta, '1')).toBeUndefined();

		// THE CURSOR, which is what a sender steers by
		expect(await expectedFor(deployment.alpha)).toBe(102);
		expect(await expectedFor(deployment.beta)).toBe(105);

		// THE STORED STREAM, through BOTH views, over the handle each NAME owns
		const alpha = await readViews(ALPHA);
		const beta = await readViews(BETA);
		expect(alpha.status).toBe(200);
		expect(beta.status).toBe(200);
		expect(alpha.feed.entries.map((entry) => entry.blockNumber)).toEqual([101]);
		expect(alpha.canonical.entries.map((entry) => entry.blockNumber)).toEqual([101]);
		expect(beta.feed.entries.map((entry) => entry.blockNumber)).toEqual([106, 107]);
		expect(beta.canonical.entries.map((entry) => entry.blockNumber)).toEqual([106, 107]);
		// the same STREAM under both names, which is the point: the rows are apart
		// because the DATABASE is, and not because the digests differ
		expect(beta.feed.stream).toBe(alpha.feed.stream);
		expect(beta.feed.generation).toBe(alpha.feed.generation);
	});

	it('count their own reorgs, and the other stays at zero', async () => {
		await feedBoth();
		// block 106 comes back under another hash, so beta's fold concludes a
		// contradiction and counts it -- in beta's `_meta`, which is beta's database
		const reorged = await post(
			deployment.beta,
			batchFor(deployment.beta, {
				fromBlock: 105,
				toBlock: 110,
				latestBlock: 110,
				logs: [transfer(106, '0xc106', BOB, 4n, 0, CONTRACT)],
			}),
		);
		expect(reorged.status).toBe(200);
		expect(await reorged.json()).toMatchObject({reorg: {cause: 'contradiction', blockNumber: 106}});

		expect(await readReorgCounters(deployment.beta.db)).toMatchObject({absence: 0, contradiction: 1});
		expect(await readReorgCounters(deployment.alpha.db)).toMatchObject({absence: 0, contradiction: 0});
	});

	it('hold their generations in their OWN registry, and a cap refuses in that one only', async () => {
		// alpha reaches its bound: a filter-change successor beside the incumbent is
		// two generations on two streams, which is exactly `CAPS`
		await deployment.alpha.indexer.add({source: RECONFIGURED_SOURCE, ...foldBeside()});
		expect((await deployment.alpha.indexer.generations()).length).toBe(2);
		// beta counted none of that: its registry is rows in its own database
		expect((await deployment.beta.indexer.generations()).length).toBe(1);

		await expect(deployment.alpha.indexer.add({source: THIRD_SOURCE, ...foldBeside()})).rejects.toBeInstanceOf(
			GenerationCapReachedError,
		);

		// the SAME fold, at the same caps, under the other name: accepted, because
		// the cap is counted over the registry that name owns
		const added = await deployment.beta.indexer.add({source: THIRD_SOURCE, ...foldBeside()});
		expect(added.record.stream).toBeTruthy();
		expect((await deployment.beta.indexer.generations()).length).toBe(2);
		// and alpha's refusal left alpha where it was
		expect((await deployment.alpha.indexer.generations()).length).toBe(2);
	});
});

describe('deleting everything in one named indexer', () => {
	it('is a DROP with no discriminator, and the other stays COMPLETE and READABLE', async () => {
		await feedBoth();
		await deployment.alpha.indexer.add({source: RECONFIGURED_SOURCE, ...foldBeside()});
		const before = await readViews(ALPHA);

		const dropped = await deleteEverythingIn(deployment.beta.db);
		expect(dropped).toBeGreaterThan(0);

		// READS after the delete, and not a table listing: the fold, both views, the
		// cursor, the counters and the registry all answer exactly what they did
		expect(await ownerOf(deployment.alpha, '1')).toBe(ALICE);
		expect(await expectedFor(deployment.alpha)).toBe(102);
		const after = await readViews(ALPHA);
		expect(after.status).toBe(200);
		expect(after.feed.entries).toEqual(before.feed.entries);
		expect(after.canonical.entries).toEqual(before.canonical.entries);
		expect(after.feed.stream).toBe(before.feed.stream);
		expect(after.feed.generation).toBe(before.feed.generation);
		expect(await readReorgCounters(deployment.alpha.db)).toMatchObject({absence: 0, contradiction: 0});
		expect((await deployment.alpha.indexer.generations()).length).toBe(2);
		expect(await deployment.alpha.indexer.canonicalGeneration()).toEqual(deployment.alpha.indexer.generation);

		// and the deleted one is GONE rather than emptied: nothing of it is left to
		// be read back through the name it was registered under
		const gone = await deployment.app.request(`/${BETA}/feed`);
		expect(gone.status).not.toBe(200);
	});
});

describe('the host-level surfaces and the refusals are unchanged by tenancy', () => {
	it('answers /status and /admin/setup over the HOST handle, which is neither tenant`s', async () => {
		const status = await deployment.app.request('/status');
		expect(status.status).toBe(200);
		expect((await status.json()).healthy).toBe(true);

		const setup = await deployment.app.request('/admin/setup', {method: 'POST'});
		expect(setup.status).toBe(200);
	});

	it('still refuses a name this host was not built with with a 404, on ingest and on both views', async () => {
		const pushed = await deployment.app.request(`/gamma/ingest`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
			body: serializeWireBatch(batchFor(deployment.alpha, {fromBlock: 100, toBlock: 105, latestBlock: 105})),
		});
		expect(pushed.status).toBe(404);
		expect((await pushed.json()).error).toBe('unknown-indexer');

		for (const path of ['/gamma/feed', '/gamma/canonical?gate=1000']) {
			const res = await deployment.app.request(path);
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe('unknown-indexer');
		}
	});

	it('still answers 501 under every name on a host built with no registry at all', async () => {
		const readTier = createServer<TestEnv>({
			getDB: () => deployment.hostDB,
			getEnv: () => ({INGEST_TOKEN: TOKEN}),
		});

		for (const path of [`/${ALPHA}/feed`, `/${ALPHA}/canonical?gate=1000`]) {
			const res = await readTier.request(path);
			expect(res.status).toBe(501);
			expect((await res.json()).error).toBe('ingestion-not-configured');
		}
		const pushed = await readTier.request(`/${ALPHA}/ingest`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
			body: '{}',
		});
		expect(pushed.status).toBe(501);
	});
});
