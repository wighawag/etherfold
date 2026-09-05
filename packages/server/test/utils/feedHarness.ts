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
import {expect} from 'vitest';
import {createServer, emissionAppenderFor, indexerRegistry} from '../../src/index.js';

// ---------------------------------------------------------------------------
// THE FIXTURE BOTH VIEWS ARE ASSERTED THROUGH
// ---------------------------------------------------------------------------
// One deployment builder, one real ingest push, one batch helper -- shared,
// because ADR-0006's two views read ONE table and an assertion about either is
// only worth something if it was reached the way a batch actually arrives:
// through `/{indexer}/ingest`, so the stream-builder derives its own reorgs and
// stores what it folded. A second copy of this harness in the second view's file
// would be a second definition of what "a reorg" means in a test, and the two
// would drift.
//
// The APPENDER is the host's, exactly as it is in a deployment: the route writes
// nothing any more, and a fold is stored by whoever owns the store (ADR-0052).
// So this harness supplies one per named indexer, closed over the NAME it
// registered that indexer under -- which is the same value the route segment
// carries, and the reason the rows below are unchanged by the move.
// ---------------------------------------------------------------------------

export const abi = [
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

export type TestABI = typeof abi;

export const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
/** A DIFFERENT fetch filter, and therefore a different STREAM. */
export const OTHER_CONTRACT = '0x0000000000000000000000000000000000000077' as const;
export const ALICE = '0x0000000000000000000000000000000000000011';
export const BOB = '0x0000000000000000000000000000000000000022';
export const CAROL = '0x0000000000000000000000000000000000000033';
export const ZERO = '0x0000000000000000000000000000000000000000';

export const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

export const START_BLOCK = 100;
export const FINALITY = 3;
export const TOKEN = 'a-shared-secret';

export const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

/** Byte-identical to `SOURCE`: the same STREAM under a different NAME. */
export const IDENTICAL_SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

/** Another address, so `streamDigestOf` moves: this is a new stream, not a fork. */
export const RECONFIGURED_SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: OTHER_CONTRACT, startBlock: START_BLOCK}],
};

export const STREAM_CONFIG = {finality: FINALITY};

export const STREAM_DIGEST = streamDigestOf(SOURCE, resolveStreamConfig(STREAM_CONFIG));
export const RECONFIGURED_DIGEST = streamDigestOf(RECONFIGURED_SOURCE, resolveStreamConfig(STREAM_CONFIG));

/**
 * The FOLD, at a version the caller may move.
 *
 * The version is a parameter because a PROCESSOR CHANGE over an unchanged stream
 * is a thing the feed has to be asserted across: the same logs, a different fold,
 * which is the one case no cursor check can detect. `getVersionHash` is the
 * version plus the declarations, so bumping this and leaving the entities alone
 * is the narrowest way to say "the same data, folded by something else".
 */
function entityProcessorAt(version: string): EntityProcessor<TestABI> {
	return {
		version,
		entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
		async onTransfer(state, event) {
			state.set('token', {id: (event.args as {id: bigint}).id.toString()}, {owner: event.args.to});
		},
	};
}

/** What every deployment folds with unless it says otherwise. */
export const PROCESSOR_VERSION = '1.0.0';

let logCounter = 0;

export function transfer(
	blockNumber: number,
	blockHash: string,
	to: string,
	id: bigint,
	logIndex = 0,
	address: string = CONTRACT,
): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
		transactionIndex: 0,
		removed: false,
		address,
		data: `0x${id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC0, pad(ZERO), pad(to)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: ZERO, to, id},
	} as unknown as LogEvent<TestABI>;
}

export function pad(address: string): `0x${string}` {
	return `0x${address.slice(2).padStart(64, '0')}` as `0x${string}`;
}

export type TestEnv = {DEV?: string; INGEST_TOKEN?: string};

type Hosted = {builder: StreamBuilder<TestABI, unknown>};

export type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	db: RemoteSQL;
	hosted: Record<string, Hosted>;
};

/**
 * A host built with several named indexers over ONE database.
 *
 * `processorVersion` is what a REDEPLOY moves: passing the same `db` and a
 * different version is a host restarted with a new fold over the stream it
 * already stored, which is exactly the change the emission table is keyed
 * independently of (ADR-0006).
 */
export async function deploy(
	sources: Record<string, IndexingSource<TestABI>>,
	db?: RemoteSQL,
	options: {processorVersion?: string} = {},
): Promise<Deployment> {
	const database: RemoteSQL = db ?? new RemoteLibSQL(createClient({url: ':memory:'}));
	const hosted: Record<string, Hosted> = {};
	const ingestions: Record<string, StreamBuilder<TestABI, unknown>> = {};
	for (const [name, source] of Object.entries(sources)) {
		const processor = new VersionedStateEventProcessor<TestABI>(
			new RemoteLibSQL(createClient({url: ':memory:'})),
			entityProcessorAt(options.processorVersion ?? PROCESSOR_VERSION),
		);
		const builder = new StreamBuilder<TestABI, unknown>(processor, source, {
			stream: STREAM_CONFIG,
			appendEmissions: emissionAppenderFor(database, name),
		});
		hosted[name] = {builder};
		ingestions[name] = builder;
	}
	const app = createServer<TestEnv>({
		getDB: () => database,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: indexerRegistry(ingestions),
	});
	await app.request('/admin/setup', {method: 'POST'});
	return {app, db: database, hosted};
}

/**
 * Push a batch, and REFUSE to carry on if it was not accepted.
 *
 * Every batch in these files is meant to land: a `409` correction here would
 * leave the table short and make a feed assertion fail somewhere far away,
 * describing the wrong problem.
 */
export async function post(deployment: Deployment, name: string, batch: WireBatch<TestABI>): Promise<void> {
	const res = await deployment.app.request(`/${name}/ingest`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
		body: serializeWireBatch(batch),
	});
	expect(res.status, `pushing to ${name}: ${await res.clone().text()}`).toBe(200);
}

/**
 * Read the RETRACTION-AWARE feed, as a consumer does.
 *
 * Here rather than in each suite for the same reason `deploy` and `post` are: two
 * files asserting one route through two hand-written readers is two ideas of what
 * that route's query string is. Generic in the body so each suite keeps its own
 * idea of what it expects back.
 */
export async function readFeed<Body>(
	deployment: Deployment,
	name: string,
	query: {cursor?: string; limit?: number | string} = {},
): Promise<{status: number; body: Body; text: string}> {
	return request(deployment, `/${name}/feed`, query);
}

/**
 * FOLLOW the retraction-aware feed to its end, one page at a time, exactly as a
 * consumer does: hold the cursor, do arithmetic on nothing.
 *
 * Here rather than in one suite because two files now assert that a consumer
 * REACHES THE END -- the feed's own suite over a stream with holes punched into
 * it, and the compaction suite over the holes a real compaction left -- and two
 * hand-written loops would be two ideas of what following means. Generic in the
 * entry so each suite keeps its own idea of what an entry holds.
 *
 * The guard is what makes a STALL fail as a test rather than hang as one.
 */
export async function followFeed<Entry>(
	deployment: Deployment,
	name: string,
	limit: number,
): Promise<{entries: Entry[]; pages: number; cursor: string}> {
	const entries: Entry[] = [];
	let cursor: string | undefined;
	let pages = 0;
	for (let guard = 0; guard < 50; guard++) {
		const page = await readFeed<{entries: Entry[]; cursor: string; hasMore: boolean}>(deployment, name, {
			...(cursor === undefined ? {} : {cursor}),
			limit,
		});
		expect(page.status, page.text).toBe(200);
		pages++;
		entries.push(...page.body.entries);
		// the caller holds the cursor and nothing else: no arithmetic on a position
		cursor = page.body.cursor;
		if (!page.body.hasMore) return {entries, pages, cursor};
	}
	throw new Error(`the feed never reported itself caught up: it stalled or repeated`);
}

/** Read the CANONICAL view. Its `gate` is required by the route, never defaulted here. */
export async function readCanonical<Body>(
	deployment: Deployment,
	name: string,
	query: {gate?: number | string; cursor?: string; limit?: number | string} = {},
): Promise<{status: number; body: Body; text: string}> {
	return request(deployment, `/${name}/canonical`, query);
}

async function request<Body>(
	deployment: Deployment,
	path: string,
	query: {gate?: number | string; cursor?: string; limit?: number | string},
): Promise<{status: number; body: Body; text: string}> {
	const params = new URLSearchParams();
	if (query.gate !== undefined) params.set('gate', String(query.gate));
	if (query.cursor !== undefined) params.set('cursor', query.cursor);
	if (query.limit !== undefined) params.set('limit', String(query.limit));
	const suffix = params.toString() ? `?${params.toString()}` : '';
	const res = await deployment.app.request(`${path}${suffix}`);
	const text = await res.text();
	return {status: res.status, body: JSON.parse(text) as Body, text};
}

export function batchOf(
	deployment: Deployment,
	name: string,
	fromBlock: number,
	toBlock: number,
	latestBlock: number,
	logs: LogEvent<TestABI>[],
): WireBatch<TestABI> {
	return {context: (deployment.hosted[name] as Hosted).builder.context, fromBlock, toBlock, latestBlock, logs};
}

/**
 * A stream carrying a REAL reorg, driven through `/{indexer}/ingest`.
 *
 * Batch one indexes 101, 103, 104 and 105. Batch two re-scans from 102 (which is
 * where the stream-builder says the next batch must start, `lastToBlock -
 * finality`) and reports a DIFFERENT hash at 103, so the fold concludes a
 * contradiction there and retracts 103, 104 and 105 before applying the new
 * branch. The fork block is therefore 103, and a consumer that had reached 105
 * must go back to it.
 *
 * Here rather than in the canonical view's suite because a REORG is the thing
 * this harness exists to define once: a second file writing its own would be a
 * second idea of what a reorg is, and the two would drift.
 */
export async function indexedThroughBlock105(): Promise<Deployment> {
	const deployment = await deploy({alpha: SOURCE});
	await post(
		deployment,
		'alpha',
		batchOf(deployment, 'alpha', 100, 105, 105, [
			transfer(101, '0xa101', ALICE, 1n),
			transfer(103, '0xa103', BOB, 2n),
			transfer(104, '0xa104', CAROL, 3n),
			transfer(105, '0xa105', ALICE, 4n),
		]),
	);
	return deployment;
}

/** The second batch of that fixture: block 103 comes back with another hash. */
export async function reorgAt103(deployment: Deployment): Promise<void> {
	await post(
		deployment,
		'alpha',
		batchOf(deployment, 'alpha', 102, 106, 106, [
			transfer(103, '0xb103', CAROL, 13n),
			transfer(104, '0xb104', ALICE, 14n),
			transfer(106, '0xb106', BOB, 16n),
		]),
	);
}
