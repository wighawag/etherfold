import {createClient} from '@libsql/client';
import {
	StreamBuilder,
	resolveStreamConfig,
	serializeWireBatch,
	streamDigestOf,
	type Abi,
	type IndexingSource,
	type LogEvent,
	type WireBatch,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeEach, describe, expect, it} from 'vitest';
import {createServer, emissionAppenderFor, indexerRegistry, applySchema} from '../src/index.js';
import {schemaStatements} from '../src/schema.js';
import {clearLastError} from '../src/api/status.js';

// ---------------------------------------------------------------------------
// THE STORED EMISSION STREAM (ADR-0006)
// ---------------------------------------------------------------------------
// The append-only log the FOLD writes: every emission it produced, retractions
// INCLUDED, superseded rows FLAGGED rather than deleted.
//
// Every row here arrives through a real `/{indexer}/ingest` push, exactly as
// before, and every assertion about which rows land is UNCHANGED by the move of
// the write out of the route (ADR-0052) -- which is the point: the split shape's
// stored stream is what it always was, and the appender the harness supplies is
// bound to the same name the route segment carries.
//
// What is under test here is the part a schema cannot be sloppy about, which is
// the KEY. Every row carries two discriminators, both structurally part of every
// read and write:
//
//  - the INDEXER NAME, which is the route segment and the tenancy unit
//    (ADR-0036), so two named indexers with byte-identical sources share a
//    database and share no rows;
//  - the STREAM, whose value is the WIDE digest `streamDigestOf` builds and
//    never the wire context's 32-bit whole-source hash. A decode-only source
//    change moves the wire hash and leaves this one alone, which is the whole
//    reason it is this one: keyed on the wire hash, a regenerated ABI would
//    orphan every row already stored.
//
// The fold's own rules (which retraction is derived, and when) are the
// stream-builder's and are tested in `@etherfold/core`. What is tested here is
// what only this layer can get wrong: which rows land, under which key, with
// which flags, and whether the columns a later API depends on exist.
// ---------------------------------------------------------------------------

const abi = [
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'id', type: 'uint256'},
		],
	},
] as const satisfies Abi;

/**
 * The SAME stream, decoded differently: a `view` function appended and the
 * non-indexed parameter renamed.
 *
 * Neither touches the fetch filter -- `topic0` hashes types and not names, and a
 * function is not indexed at all -- so `streamDigestOf` must not move. The wire
 * context's per-entry `hash` does move, which is exactly why the two must not be
 * interchangeable here.
 */
const abiDecodeOnlyChange = [
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'tokenId', type: 'uint256'},
		],
	},
	{
		type: 'function',
		name: 'totalSupply',
		stateMutability: 'view',
		inputs: [],
		outputs: [{name: '', type: 'uint256'}],
	},
] as const satisfies Abi;

type TestABI = typeof abi;

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const ALICE = '0x0000000000000000000000000000000000000011';
const BOB = '0x0000000000000000000000000000000000000022';
const CAROL = '0x0000000000000000000000000000000000000033';
const ZERO = '0x0000000000000000000000000000000000000000';

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

const START_BLOCK = 100;
const FINALITY = 3;
const TOKEN = 'a-shared-secret';

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

/** Byte-identical to `SOURCE`, which is the point of the isolation case. */
const IDENTICAL_SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

const DECODE_ONLY_SOURCE = {
	chainId: '1',
	contracts: [{abi: abiDecodeOnlyChange, address: CONTRACT, startBlock: START_BLOCK}],
} as unknown as IndexingSource<TestABI>;

const STREAM_CONFIG = {finality: FINALITY};

/** What the `stream` column must hold, computed the way core computes it. */
const STREAM_DIGEST = streamDigestOf(SOURCE, resolveStreamConfig(STREAM_CONFIG));

const entityProcessor: EntityProcessor<TestABI> = {
	version: '1.0.0',
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
	async onTransfer(state, event) {
		state.set('token', {id: (event.args as {id: bigint}).id.toString()}, {owner: event.args.to});
	},
};

let logCounter = 0;

function transfer(blockNumber: number, blockHash: string, to: string, id: bigint, logIndex = 0): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
		transactionIndex: 0,
		removed: false,
		address: CONTRACT,
		data: `0x${id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC0, pad(ZERO), pad(to)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: ZERO, to, id},
	} as unknown as LogEvent<TestABI>;
}

function pad(address: string): `0x${string}` {
	return `0x${address.slice(2).padStart(64, '0')}` as `0x${string}`;
}

type TestEnv = {DEV?: string; INGEST_TOKEN?: string};

type Hosted = {builder: StreamBuilder<TestABI, unknown>};

type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	db: RemoteSQL;
	hosted: Record<string, Hosted>;
};

/**
 * A host built with several named indexers over ONE database.
 *
 * ONE database on purpose, and this is the difference from `ingest.test.ts`,
 * where each name gets its own: partitioning what several tenants STORE is this
 * table's job, and a test that handed them separate databases would prove
 * nothing about the discriminator that does it.
 */
async function deploy(sources: Record<string, IndexingSource<TestABI>>): Promise<Deployment> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	const hosted: Record<string, Hosted> = {};
	const ingestions: Record<string, StreamBuilder<TestABI, unknown>> = {};
	for (const [name, source] of Object.entries(sources)) {
		// each named indexer folds its STATE into its own entity tables; the emission
		// table is the one they share, which is what the name column partitions
		const processor = new VersionedStateEventProcessor<TestABI>(
			new RemoteLibSQL(createClient({url: ':memory:'})),
			entityProcessor,
		);
		// the APPENDER is the host's, closed over the name this indexer is registered
		// under and bound to the shared database: the route is a caller of the fold and
		// writes nothing itself (ADR-0052)
		const builder = new StreamBuilder<TestABI, unknown>(processor, source, {
			stream: STREAM_CONFIG,
			appendEmissions: emissionAppenderFor(db, name),
		});
		hosted[name] = {builder};
		ingestions[name] = builder;
	}
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: indexerRegistry(ingestions),
	});
	await app.request('/admin/setup', {method: 'POST'});
	return {app, db, hosted};
}

async function post(deployment: Deployment, name: string, batch: WireBatch<TestABI>): Promise<Response> {
	return deployment.app.request(`/${name}/ingest`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
		body: serializeWireBatch(batch),
	});
}

function batchOf(
	deployment: Deployment,
	name: string,
	fromBlock: number,
	toBlock: number,
	latestBlock: number,
	logs: LogEvent<TestABI>[],
): WireBatch<TestABI> {
	return {context: (deployment.hosted[name] as Hosted).builder.context, fromBlock, toBlock, latestBlock, logs};
}

type Row = {
	indexer: string;
	stream: string;
	seq: number;
	removed: number;
	alive: number;
	blockNumber: number;
	blockHash: string;
	logIndex: number;
	transactionHash: string;
	transactionIndex: number;
	blockTimestamp: number | null;
	address: string;
	topic0: string | null;
	topic1: string | null;
	topic2: string | null;
	topic3: string | null;
	data: string;
};

/** Every row of the table, in `seq` order, which is the order the feed will read. */
async function rowsOf(db: RemoteSQL, indexer?: string): Promise<Row[]> {
	const statement = indexer
		? db.prepare(`SELECT * FROM _emissions WHERE indexer = ?1 ORDER BY seq`).bind(indexer)
		: db.prepare(`SELECT * FROM _emissions ORDER BY indexer, seq`);
	return (await statement.all<Row>()).results;
}

// ---------------------------------------------------------------------------

describe('a batch appends its emissions, retractions included, under both discriminators', () => {
	let deployment: Deployment;

	beforeEach(async () => {
		clearLastError();
		deployment = await deploy({alpha: SOURCE});
	});

	it('appends one row per emitted log, keyed on the indexer name and the stream digest', async () => {
		const res = await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 105, 105, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(104, '0xa104', BOB, 2n),
			]),
		);
		expect(res.status).toBe(200);

		const rows = await rowsOf(deployment.db);
		expect(rows.map((row) => [row.seq, row.blockNumber, row.removed, row.alive])).toEqual([
			[1, 101, 0, 1],
			[2, 104, 0, 1],
		]);
		// both discriminators on EVERY row, never defaulted and never omitted
		expect(rows.every((row) => row.indexer === 'alpha')).toBe(true);
		expect(rows.every((row) => row.stream === STREAM_DIGEST)).toBe(true);
	});

	it('carries the raw log the node reported: address, topics, data and the block coordinates', async () => {
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 105, 105, [transfer(101, '0xa101', ALICE, 7n)]));

		const [row] = await rowsOf(deployment.db);
		expect(row).toMatchObject({
			address: CONTRACT,
			topic0: TRANSFER_TOPIC0,
			topic1: pad(ZERO),
			topic2: pad(ALICE),
			// a Transfer has three topics, so the fourth is absent rather than empty
			topic3: null,
			blockHash: '0xa101',
			logIndex: 0,
			transactionIndex: 0,
			blockTimestamp: 1_700_000_000 + 101 * 12,
		});
		expect(row?.data).toBe(`0x${7n.toString(16).padStart(64, '0')}`);
	});

	it('allocates seq monotonically across batches, never restarting', async () => {
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n)]));
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 102, 110, 110, [transfer(108, '0xa108', BOB, 2n)]));

		expect((await rowsOf(deployment.db)).map((row) => row.seq)).toEqual([1, 2]);
	});

	it('writes nothing for a REFUSED batch, so a cursor correction leaves no row behind', async () => {
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n)]));
		// a re-send: the cursor IS the idempotency key, so this is a 409
		const res = await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n)]),
		);

		expect(res.status).toBe(409);
		expect(await rowsOf(deployment.db)).toHaveLength(1);
	});
});

describe('a reorg FLAGS the superseded rows and deletes nothing', () => {
	let deployment: Deployment;

	beforeEach(async () => {
		clearLastError();
		deployment = await deploy({alpha: SOURCE});
		await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 100, 105, 105, [
				transfer(101, '0xa101', ALICE, 1n),
				transfer(104, '0xa104', BOB, 2n),
			]),
		);
	});

	it('keeps the retracted row, appends its retraction, and flags both dead', async () => {
		// block 104 is replaced: the same height now carries 0xb104
		const res = await post(
			deployment,
			'alpha',
			batchOf(deployment, 'alpha', 102, 106, 106, [transfer(104, '0xb104', CAROL, 3n)]),
		);
		expect(res.status).toBe(200);

		const rows = await rowsOf(deployment.db);
		expect(rows.map((row) => [row.seq, row.blockNumber, row.blockHash, row.removed, row.alive])).toEqual([
			// the block below the fork is untouched and still canonical
			[1, 101, '0xa101', 0, 1],
			// THE POINT: the superseded row is STILL HERE, flagged rather than deleted
			[2, 104, '0xa104', 0, 0],
			// its retraction, appended at the ORIGINAL block, and never canonical itself
			[3, 104, '0xa104', 1, 0],
			// the replacement
			[4, 104, '0xb104', 0, 1],
		]);
	});

	it('leaves the canonical view as exactly the alive rows', async () => {
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 102, 106, 106, [transfer(104, '0xb104', CAROL, 3n)]));

		const canonical = (
			await deployment.db
				.prepare(
					`SELECT blockNumber, blockHash FROM _emissions
					 WHERE indexer = ?1 AND stream = ?2 AND alive = 1 AND blockNumber <= ?3
					 ORDER BY blockNumber, logIndex`,
				)
				.bind('alpha', STREAM_DIGEST, 106)
				.all<{blockNumber: number; blockHash: string}>()
		).results;

		expect(canonical).toEqual([
			{blockNumber: 101, blockHash: '0xa101'},
			{blockNumber: 104, blockHash: '0xb104'},
		]);
	});
});

describe('the stream column is the WIDE digest, not the wire identity', () => {
	it('holds streamDigestOf, and a value the wire context does not carry', async () => {
		const deployment = await deploy({alpha: SOURCE});
		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n)]));

		const [row] = await rowsOf(deployment.db);
		const context = (deployment.hosted['alpha'] as Hosted).builder.context;

		expect(row?.stream).toBe(STREAM_DIGEST);
		// not the config hash, and not any of the per-entry source hashes: the wire's
		// identity is a 32-bit CHANGE DETECTOR between two halves of a deployment
		// (ADR-0034), and a collision there would be one indexer adopting another's
		// logs
		expect(row?.stream).not.toBe(context.config);
		for (const entry of context.source) {
			expect(row?.stream).not.toBe(entry.hash);
			expect(row?.stream).not.toBe(entry.streamHash);
			expect(row?.stream).not.toBe(entry.legacyHash);
		}
	});

	it('does not move on a DECODE-ONLY source change, so the stored history is not orphaned', async () => {
		// the ABI gained a view function and renamed a non-indexed parameter: the wire
		// context moves, the fetch filter does not
		expect(streamDigestOf(DECODE_ONLY_SOURCE, resolveStreamConfig(STREAM_CONFIG))).toBe(STREAM_DIGEST);

		const before = await deploy({alpha: SOURCE});
		await post(before, 'alpha', batchOf(before, 'alpha', 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n)]));

		// the same host, redeployed against the regenerated ABI, over the SAME database
		const processor = new VersionedStateEventProcessor<TestABI>(
			new RemoteLibSQL(createClient({url: ':memory:'})),
			entityProcessor,
		);
		const builder = new StreamBuilder<TestABI, unknown>(processor, DECODE_ONLY_SOURCE, {
			stream: STREAM_CONFIG,
			appendEmissions: emissionAppenderFor(before.db, 'alpha'),
		});
		const after: Deployment = {
			app: createServer<TestEnv>({
				getDB: () => before.db,
				getEnv: () => ({INGEST_TOKEN: TOKEN}),
				getIndexer: indexerRegistry({alpha: builder}),
			}),
			db: before.db,
			hosted: {alpha: {builder}},
		};

		// the wire identity DID move, which is what makes this a real case
		expect(builder.context.source).not.toEqual((before.hosted['alpha'] as Hosted).builder.context.source);

		await post(after, 'alpha', batchOf(after, 'alpha', 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n)]));

		const rows = await rowsOf(before.db);
		// ONE stream, and the seq CONTINUED rather than a second history starting
		expect(new Set(rows.map((row) => row.stream))).toEqual(new Set([STREAM_DIGEST]));
		expect(rows.map((row) => row.seq)).toEqual([1, 2]);
	});
});

describe('two named indexers with identical sources are isolated by the name column', () => {
	it('partitions the rows, and neither read can reach the other', async () => {
		const deployment = await deploy({alpha: SOURCE, beta: IDENTICAL_SOURCE});

		await post(deployment, 'alpha', batchOf(deployment, 'alpha', 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n)]));
		await post(
			deployment,
			'beta',
			batchOf(deployment, 'beta', 100, 105, 105, [
				transfer(102, '0xb102', BOB, 2n),
				transfer(103, '0xb103', CAROL, 3n),
			]),
		);

		const alpha = await rowsOf(deployment.db, 'alpha');
		const beta = await rowsOf(deployment.db, 'beta');

		expect(alpha.map((row) => row.blockNumber)).toEqual([101]);
		expect(beta.map((row) => row.blockNumber)).toEqual([102, 103]);
		// the SAME stream: identical sources, so the digest cannot tell them apart and
		// the NAME is the only thing that does
		expect(new Set([...alpha, ...beta].map((row) => row.stream))).toEqual(new Set([STREAM_DIGEST]));
		// and each name's seq is its own, so neither tenant's writes put holes in the
		// other's cursor space
		expect(alpha.map((row) => row.seq)).toEqual([1]);
		expect(beta.map((row) => row.seq)).toEqual([1, 2]);
	});
});

describe('the columns a later log API depends on, and the ONE index over them', () => {
	async function indexesOf(db: RemoteSQL): Promise<{name: string; columns: string[]; partial: boolean}[]> {
		const list = (await db.prepare(`PRAGMA index_list('_emissions')`).all<{name: string; partial: number}>()).results;
		const indexes = [];
		for (const entry of list) {
			const info = (await db.prepare(`PRAGMA index_info('${entry.name}')`).all<{seqno: number; name: string}>())
				.results;
			indexes.push({
				name: entry.name,
				columns: [...info].sort((a, b) => a.seqno - b.seqno).map((column) => column.name),
				partial: entry.partial === 1,
			});
		}
		return indexes;
	}

	it('indexes (address, topic0, blockNumber) once, under the two discriminators', async () => {
		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		await applySchema(db);

		const indexes = await indexesOf(db);
		const byAddress = indexes.filter((index) => index.columns.includes('address'));

		expect(byAddress).toHaveLength(1);
		// the DECIDED shape (`work/specs/proposed/node-log-api.md`), led by the two
		// discriminators, because a read that could omit one would range-scan another
		// tenant's rows
		expect(byAddress[0]?.columns).toEqual(['indexer', 'stream', 'address', 'topic0', 'blockNumber']);
	});

	it('leaves topic1..topic3 UNINDEXED, so there are not five indexes', async () => {
		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		await applySchema(db);

		const indexed = new Set((await indexesOf(db)).flatMap((index) => index.columns));
		expect(indexed.has('topic0')).toBe(true);
		for (const topic of ['topic1', 'topic2', 'topic3']) {
			expect(indexed.has(topic)).toBe(false);
		}
	});

	it('gives the canonical view its PARTIAL index on alive', async () => {
		const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		await applySchema(db);

		const partial = (await indexesOf(db)).filter((index) => index.partial);
		expect(partial).toHaveLength(1);
		expect(partial[0]?.columns).toEqual(['indexer', 'stream', 'blockNumber', 'logIndex']);
	});
});

describe('the table is in the FIXED schema, so both application paths produce it', () => {
	/** Every table and index of a database, as SQLite itself describes them. */
	async function schemaOf(db: RemoteSQL): Promise<{type: string; name: string; sql: string | null}[]> {
		return (
			await db
				.prepare(
					`SELECT type, name, sql FROM sqlite_master
					 WHERE tbl_name = '_emissions' ORDER BY type, name`,
				)
				.all<{type: string; name: string; sql: string | null}>()
		).results;
	}

	it('the D1 migration path and applySchema land on the same database', async () => {
		// WRANGLER runs the .sql file and calls nothing of ours, so the DDL has to be
		// IN the file rather than in the TypeScript that applies it. This runs the file
		// the way wrangler does, and compares against the path Node takes.
		const {default: sql} = await import('../src/schema/ts/db.sql.js');
		const migrated: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		for (const statement of sql
			.replace(/--[^\n]*/g, '')
			.split(';')
			.map((s) => s.trim())
			.filter((s) => s.length > 0)) {
			await migrated.prepare(statement).all();
		}

		const applied: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		await applySchema(applied);

		const fromMigration = await schemaOf(migrated);
		expect(fromMigration.some((entry) => entry.type === 'table' && entry.name === '_emissions')).toBe(true);
		expect(fromMigration).toEqual(await schemaOf(applied));
	});

	it('is static SQL and not dynamic DDL: the statements come from db.sql', () => {
		const ddl = schemaStatements.filter((statement) => statement.includes('_emissions'));
		expect(ddl.some((statement) => /CREATE TABLE IF NOT EXISTS _emissions/.test(statement))).toBe(true);
		expect(ddl.filter((statement) => /CREATE INDEX/.test(statement))).toHaveLength(2);
	});
});
