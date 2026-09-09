import {createClient} from '@libsql/client';
import {
	StreamBuilder,
	sameWireContext,
	serializeWireBatch,
	type Abi,
	type IndexingSource,
	type LogEvent,
	type WireBatch,
	type WireContext,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeAll, describe, expect, it} from 'vitest';
import {createServer, indexerRegistry, singleContextEntry} from '../src/index.js';
import {clearLastError} from '../src/api/status.js';
import {hostRecorderFor} from './utils/hostRecorder.js';

// ---------------------------------------------------------------------------
// THE INGESTION ENDPOINT (ADR-0004), PER NAMED INDEXER (ADR-0036)
// ---------------------------------------------------------------------------
// The HTTP surface where raw logs enter the indexer-server. The rules it
// enforces are the stream-builder's, and they are tested at THAT level in
// `@etherfold/core`. What is tested here is what only this layer can get wrong:
// the status codes a sender steers by, the token that guards the cursor, the
// counters an operator watches, and WHICH named indexer a batch reached.
//
// Every route is namespaced on the indexer NAME (`/{indexer}/ingest`), because a
// host registers the N named indexers it was built with. The name is a ROUTE
// SEGMENT and never a field in the envelope: carrying it in the payload would
// make the wire format carry tenancy, and would turn a misdirected batch into a
// payload error rather than a routing one.
//
// The whole sequence runs against a REAL processor over a REAL local libSQL
// database, because the acceptance the task states is "state and the cursor
// advance together", and a fake processor cannot fail that.
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

type TestABI = typeof abi;

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const ALICE = '0x0000000000000000000000000000000000000011';
const BOB = '0x0000000000000000000000000000000000000022';
const CAROL = '0x0000000000000000000000000000000000000033';
const ZERO = '0x0000000000000000000000000000000000000000';

const START_BLOCK = 100;
const FINALITY = 3;
const TOKEN = 'a-shared-secret';

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

const entityProcessor: EntityProcessor<TestABI> = {
	version: '1.0.0',
	entities: [
		{name: 'token', id: ['id'], fields: {owner: 'text'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

let logCounter = 0;

function transfer(blockNumber: number, blockHash: string, to: string, id: bigint): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
		transactionIndex: 0,
		removed: false,
		address: CONTRACT,
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex: 0,
		extra: undefined,
		eventName: 'Transfer',
		args: {from: ZERO, to, id},
	} as unknown as LogEvent<TestABI>;
}

type TestEnv = {DEV?: string; INGEST_TOKEN?: string};

/** The name every single-indexer case in this file is deployed under. */
const NAME = 'alpha';

type Hosted = {
	builder: StreamBuilder<TestABI, unknown>;
	processor: VersionedStateEventProcessor<TestABI>;
};

type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	db: RemoteSQL;
	builder: StreamBuilder<TestABI, unknown>;
	processor: VersionedStateEventProcessor<TestABI>;
	hosted: Record<string, Hosted>;
};

/**
 * A host built with the named indexers it was told about.
 *
 * `names: null` is the host that hosts NO processor at all -- no registry is
 * injected, which is a different thing from a registry that does not hold the
 * name asked for, and the two answer differently below.
 *
 * Each named indexer gets its OWN database, which is what a name resolves to
 * (ADR-0053): the entry carries the handle, so the routes that act on one named
 * indexer read through it and never through the host's `getDB`.
 */
async function deploy(
	env: TestEnv = {INGEST_TOKEN: TOKEN},
	names: string[] | null = [NAME],
	/** Extra `ServerOptions` a host may set; `maxIngestBytes` is the one exercised below. */
	extra: {maxIngestBytes?: number} = {},
): Promise<Deployment> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	const hosted: Record<string, Hosted> = {};
	const ingestions: Record<string, ReturnType<typeof singleContextEntry>> = {};
	(names ?? []).forEach((name, order) => {
		// the FIRST named indexer folds into the same database the app answers over,
		// which is the ordinary single-indexer deployment; a second one gets its own
		const indexerDB: RemoteSQL = order === 0 ? db : new RemoteLibSQL(createClient({url: ':memory:'}));
		const processor = new VersionedStateEventProcessor<TestABI>(indexerDB, entityProcessor);
		// the recorder is the HOST's, exactly as it is in a deployment: this package
		// counts nothing itself any more (ADR-0050)
		const builder = new StreamBuilder<TestABI, unknown>(processor, SOURCE, {
			stream: {finality: FINALITY},
			recordReorg: hostRecorderFor(indexerDB),
		});
		hosted[name] = {processor, builder};
		ingestions[name] = singleContextEntry(indexerDB, builder);
	});
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => env,
		// the shipped helper, so what a host writes is what is under test here
		...(names === null ? {} : {getIndexer: indexerRegistry(ingestions)}),
		...extra,
	});
	// the fixed tables the counters live in; the entity tables are the store's own
	// and it creates them on its first load
	await app.request('/admin/setup', {method: 'POST'});
	const first = hosted[(names ?? [])[0] as string];
	return {
		app,
		db,
		hosted,
		// the single-indexer cases below read these; a host with no registry has
		// neither, and asks nothing of them
		builder: first?.builder as StreamBuilder<TestABI, unknown>,
		processor: first?.processor as VersionedStateEventProcessor<TestABI>,
	};
}

async function post(
	deployment: Deployment,
	batch: unknown,
	headers: Record<string, string> = {},
	name = NAME,
): Promise<Response> {
	return deployment.app.request(`/${name}/ingest`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers},
		body: typeof batch === 'string' ? batch : serializeWireBatch(batch as WireBatch<TestABI>),
	});
}

/**
 * Ask where the next batch must start.
 *
 * A POST for a question, deliberately: answering it can call `processor.clear()`
 * to reconcile a cursor from another source, config or processor version, and a
 * `GET` that writes is a trap for proxies, prefetchers and retrying clients
 * whatever the justification. See the route.
 */
async function expectedFromBlock(deployment: Deployment, name = NAME): Promise<Response> {
	return deployment.app.request(`/${name}/ingest/expected-from-block`, {
		method: 'POST',
		headers: {Authorization: `Bearer ${TOKEN}`},
	});
}

/**
 * Where the next batch must start FOR ONE CONTEXT, out of the list the route
 * answers with.
 *
 * The answer is one `{context, expectedFromBlock}` per LIVE WIRE CONTEXT, so a
 * caller finds its own entry rather than reading a single pair -- which is what
 * a sender does too, and the reason these tests match on the identity instead of
 * taking the first entry.
 */
async function expectedFor(deployment: Deployment, name = NAME, context?: WireContext): Promise<number | undefined> {
	const body = (await (await expectedFromBlock(deployment, name)).json()) as {
		contexts?: {context: WireContext; expectedFromBlock: number}[];
	};
	const mine = context ?? (deployment.hosted[name] as Hosted).builder.context;
	return body.contexts?.find((entry) => sameWireContext(entry.context, mine))?.expectedFromBlock;
}

function batchOf(
	deployment: Deployment,
	fromBlock: number,
	toBlock: number,
	latestBlock: number,
	logs: LogEvent<TestABI>[],
	name = NAME,
): WireBatch<TestABI> {
	return {context: (deployment.hosted[name] as Hosted).builder.context, fromBlock, toBlock, latestBlock, logs};
}

async function ownerOf(deployment: Deployment, id: string, name = NAME): Promise<string | undefined> {
	return (await (deployment.hosted[name] as Hosted).processor.state.getCurrent<{owner: string}>('token', {id}))?.owner;
}

async function transferCount(deployment: Deployment, name = NAME): Promise<number> {
	return (
		(
			await (deployment.hosted[name] as Hosted).processor.state.getCurrent<{value: number}>('counter', {
				name: 'transfers',
			})
		)?.value ?? 0
	);
}

async function statusOf(deployment: Deployment): Promise<any> {
	return (await deployment.app.request('/status')).json();
}

// ---------------------------------------------------------------------------

describe('the full ingestion sequence: apply, re-send, gap, mismatch, reorg', () => {
	let deployment: Deployment;

	beforeAll(async () => {
		clearLastError();
		deployment = await deploy();
	});

	it('tells a sender where to start before anything has been indexed', async () => {
		const res = await expectedFromBlock(deployment);
		expect(res.status).toBe(200);
		// ONE PAIR PER LIVE WIRE CONTEXT. This host holds one fold, so the list holds
		// one entry -- and a sender finds itself in it by its own `{source, config}`
		// rather than by trusting a single pair to be its own.
		expect(await res.json()).toEqual({
			success: true,
			contexts: [{context: deployment.builder.context, expectedFromBlock: START_BLOCK}],
		});
	});

	it('applies a batch starting exactly there, advancing state and the cursor together', async () => {
		const res = await post(
			deployment,
			batchOf(deployment, 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n), transfer(104, '0xa104', BOB, 2n)]),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			success: true,
			applied: 2,
			retracted: 0,
			// the next batch re-scans the unconfirmed window: latestBlock - finality
			expectedFromBlock: 102,
		});
		expect(await ownerOf(deployment, '1')).toBe(ALICE);
		expect(await ownerOf(deployment, '2')).toBe(BOB);
		expect(await transferCount(deployment)).toBe(2);
	});

	it('rejects a re-sent batch with 409 and the value it expects, applying nothing', async () => {
		// the lost-acknowledgement case. The cursor IS the idempotency key: this is
		// what makes at-least-once on the wire exactly-once in effect.
		const res = await post(
			deployment,
			batchOf(deployment, 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n), transfer(104, '0xa104', BOB, 2n)]),
		);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			success: false,
			error: 'unexpected-fromBlock',
			expectedFromBlock: 102,
			receivedFromBlock: 100,
		});
		// nothing double-applied
		expect(await transferCount(deployment)).toBe(2);
	});

	it('rejects a batch that skips ahead, with the same correction', async () => {
		const res = await post(deployment, batchOf(deployment, 106, 110, 110, [transfer(107, '0xa107', CAROL, 9n)]));

		expect(res.status).toBe(409);
		expect((await res.json()).expectedFromBlock).toBe(102);
		expect(await ownerOf(deployment, '9')).toBeUndefined();
		expect(await transferCount(deployment)).toBe(2);
	});

	it('rejects a batch belonging to another {source, config}, distinctly from a cursor correction', async () => {
		const foreign = {
			...batchOf(deployment, 102, 106, 106, [transfer(105, '0xa105', CAROL, 9n)]),
			context: {source: deployment.builder.context.source, config: 'someone-elses'},
		};
		const res = await post(deployment, foreign);

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('context-mismatch');
		// and it NAMES every live context under the name rather than picking one to
		// call "expected", exactly as a cap refusal names every deletable generation
		expect(body.expected).toEqual([deployment.builder.context]);
		// NOT the 409 a sender auto-recovers from: no block number makes this right
		expect(body.expectedFromBlock).toBeUndefined();
		expect(await ownerOf(deployment, '9')).toBeUndefined();
	});

	it('rejects a payload that is not the range it claims', async () => {
		const res = await post(deployment, batchOf(deployment, 102, 106, 106, [transfer(120, '0xa120', CAROL, 9n)]));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('invalid-batch');
	});

	it('derives a hash-replacement reorg itself, from raw logs with no reorg fields on the wire', async () => {
		const res = await post(deployment, batchOf(deployment, 102, 106, 106, [transfer(104, '0xb104', CAROL, 3n)]));

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			success: true,
			applied: 1,
			retracted: 1,
			reorg: {cause: 'contradiction', blockNumber: 104, blockHash: '0xa104'},
			expectedFromBlock: 103,
		});
		expect(await ownerOf(deployment, '1')).toBe(ALICE); // block 101 is below the fork
		expect(await ownerOf(deployment, '2')).toBeUndefined(); // the dead branch's mint is gone
		expect(await ownerOf(deployment, '3')).toBe(CAROL);
		expect(await transferCount(deployment)).toBe(2);
	});

	it('counts a contradiction-driven revert as such, and reports it', async () => {
		const status = await statusOf(deployment);
		expect(status.reorgs).toMatchObject({contradiction: 1, absence: 0});
		expect(status.reorgs.last).toMatchObject({cause: 'contradiction', blockNumber: 104});
	});

	it('surfaces an absence-driven revert DISTINCTLY, because absence is an inference', async () => {
		// block 104 simply is not in the re-fetched range any more. That is
		// indistinguishable from a sender that under-delivered it, so it must not be
		// folded into the same line as a hash contradiction.
		const res = await post(deployment, batchOf(deployment, 103, 108, 108, []));

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			applied: 0,
			retracted: 1,
			reorg: {cause: 'absence', blockNumber: 104, blockHash: '0xb104'},
		});
		expect(await ownerOf(deployment, '3')).toBeUndefined();
		expect(await transferCount(deployment)).toBe(1);
	});

	it('counts the dangerous kind separately, so a RATE of it is visible', async () => {
		const status = await statusOf(deployment);
		expect(status.reorgs).toMatchObject({absence: 1, contradiction: 1});
		expect(status.reorgs.last).toMatchObject({cause: 'absence', blockNumber: 104});
		// and the server is still healthy: an absence-driven revert is a signal, not a fault
		expect(status.healthy).toBe(true);
	});

	it('ends with the cursor the last accepted batch left, and no other', async () => {
		expect(await expectedFor(deployment)).toBe(105);
	});
});

// ---------------------------------------------------------------------------
// THE NAME IS A ROUTE SEGMENT, AND THE UNNAMESPACED PAIR IS GONE
// ---------------------------------------------------------------------------

describe('several named indexers on one host', () => {
	it('answers per name, each from its own receiver', async () => {
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, ['alpha', 'beta']);

		for (const name of ['alpha', 'beta']) {
			const res = await expectedFromBlock(deployment, name);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				success: true,
				contexts: [{context: (deployment.hosted[name] as Hosted).builder.context, expectedFromBlock: START_BLOCK}],
			});
		}
	});

	it('cannot see each other\u2019s batches: a push to one leaves the other exactly where it was', async () => {
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, ['alpha', 'beta']);
		// each named indexer's store is opened by its first request, so ask both where
		// they start before anything is pushed: that is also the baseline the assertions
		// below are against
		for (const name of ['alpha', 'beta']) {
			expect(await expectedFor(deployment, name)).toBe(START_BLOCK);
		}

		const pushed = await post(
			deployment,
			batchOf(deployment, 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n)], 'alpha'),
			{},
			'alpha',
		);
		expect(pushed.status).toBe(200);

		expect(await ownerOf(deployment, '1', 'alpha')).toBe(ALICE);
		expect(await ownerOf(deployment, '1', 'beta')).toBeUndefined();
		expect(await transferCount(deployment, 'beta')).toBe(0);
		// and the cursor, which is the thing a sender steers by, moved for one only
		expect(await expectedFor(deployment, 'alpha')).toBe(102);
		expect(await expectedFor(deployment, 'beta')).toBe(START_BLOCK);
	});

	it('routes on the SEGMENT and never on the envelope, so a misdirected batch is refused', async () => {
		// the same `{source, config}` a sibling accepts, posted to the wrong name. The
		// SEGMENT chose beta, and no live wire context beta holds claims this payload, so
		// it is refused as a foreign context. Nothing in the payload could have
		// redirected it to the name that would have taken it.
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, ['alpha', 'beta']);
		const forBeta = new StreamBuilder<TestABI, unknown>((deployment.hosted['beta'] as Hosted).processor, SOURCE, {
			stream: {finality: FINALITY + 1},
		});
		const res = await post(
			deployment,
			{...batchOf(deployment, 100, 105, 105, [], 'beta'), context: forBeta.context},
			{},
			'beta',
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('context-mismatch');
	});

	it('refuses a name this host was not built with, rather than defaulting to one it was', async () => {
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, ['alpha', 'beta']);
		expect(await expectedFor(deployment, 'alpha')).toBe(START_BLOCK);

		const asked = await expectedFromBlock(deployment, 'gamma');
		expect(asked.status).toBe(404);
		expect((await asked.json()).error).toBe('unknown-indexer');

		const pushed = await post(deployment, batchOf(deployment, 100, 105, 105, [], 'alpha'), {}, 'gamma');
		expect(pushed.status).toBe(404);
		// and it went nowhere: the name it was NOT sent to did not receive it either
		expect(await transferCount(deployment, 'alpha')).toBe(0);
	});

	it('guards an unknown name too, so the registry cannot be probed without the token', async () => {
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, ['alpha', 'beta']);
		const res = await deployment.app.request('/gamma/ingest/expected-from-block', {method: 'POST'});
		expect(res.status).toBe(401);
	});
});

describe('the unnamespaced routes', () => {
	it('no longer answer, so the old surface is GONE rather than left live beside the new one', async () => {
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, ['alpha']);

		for (const path of ['/ingest', '/ingest/expected-from-block']) {
			const res = await deployment.app.request(path, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
				body: serializeWireBatch(batchOf(deployment, 100, 105, 105, [])),
			});
			expect(res.status).toBe(404);
		}
		// nothing was applied by an old caller that never noticed
		expect(await deployment.builder.expectedFromBlock()).toBe(START_BLOCK);
	});
});

describe('the endpoint requires authentication', () => {
	it('refuses an unauthenticated caller, and the cursor does not move', async () => {
		const deployment = await deploy();
		const batch = batchOf(deployment, 100, 105, 105, [transfer(101, '0xa101', ALICE, 1n)]);

		const res = await deployment.app.request(`/${NAME}/ingest`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: serializeWireBatch(batch),
		});

		expect(res.status).toBe(401);
		expect((await res.json()).error).toBe('unauthorized');
		expect(await deployment.builder.expectedFromBlock()).toBe(START_BLOCK);
		expect(await ownerOf(deployment, '1')).toBeUndefined();
	});

	it('refuses the wrong token', async () => {
		const deployment = await deploy();
		const res = await post(deployment, batchOf(deployment, 100, 105, 105, []), {
			Authorization: `Bearer not-the-token`,
		});
		expect(res.status).toBe(401);
		expect(await deployment.builder.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('refuses everyone when no token is configured, rather than letting everyone in', async () => {
		// fail CLOSED. The old server generated a key and printed it to stdout,
		// which is a server that is "secured" by a line in a log file.
		const deployment = await deploy({});
		const res = await post(deployment, batchOf(deployment, 100, 105, 105, []));
		expect(res.status).toBe(401);
		expect((await res.json()).message).toMatch(/INGEST_TOKEN/);
		expect(await deployment.builder.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('guards the cursor READ as well, since it is the fetcher-facing surface', async () => {
		const deployment = await deploy();
		expect((await deployment.app.request(`/${NAME}/ingest/expected-from-block`, {method: 'POST'})).status).toBe(401);
	});
});

describe('a server hosting no processor', () => {
	// no registry at all, which is NOT the same as a registry without the name:
	// this host has no ingestion CAPABILITY, and says so under every name
	it('says so instead of pretending to have a cursor', async () => {
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, null);

		const get = await expectedFromBlock(deployment);
		expect(get.status).toBe(501);
		expect((await get.json()).error).toBe('ingestion-not-configured');

		const posted = await deployment.app.request(`/${NAME}/ingest`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
			body: '{}',
		});
		expect(posted.status).toBe(501);
	});

	it('still refuses an unauthenticated caller first, so the absence is not a probe', async () => {
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, null);
		expect((await deployment.app.request(`/${NAME}/ingest/expected-from-block`, {method: 'POST'})).status).toBe(401);
	});
});

describe('the body must be a batch', () => {
	it('rejects a body that is not JSON', async () => {
		const deployment = await deploy();
		const res = await post(deployment, 'not json at all');
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('invalid-json');
	});

	it('carries BigInt event arguments across intact', async () => {
		const deployment = await deploy();
		const id = 2n ** 200n;
		const res = await post(deployment, batchOf(deployment, 100, 105, 105, [transfer(101, '0xa101', ALICE, id)]));
		expect(res.status).toBe(200);
		expect(await ownerOf(deployment, id.toString())).toBe(ALICE);
	});
});

// ---------------------------------------------------------------------------
// THE BYTE CEILING (`maxIngestBytes`)
// ---------------------------------------------------------------------------
// A batch is bounded by BLOCK RANGE and by EVENT COUNT, and neither is a bound in
// bytes: the size of a decoded batch is not known until it is built, so an ABI
// with large `bytes` arguments defeats a count at any setting. Without a stated
// ceiling a receiver read the whole body into memory before it could check
// anything about it, and the limit was whatever its runtime happened to die at.
//
// The ceiling is OPTIONAL and has no default, because only a host knows one: a
// Worker has a request limit, a Node process does not.
describe('a batch larger than this receiver accepts', () => {
	it('is refused with 413 naming the limit, and nothing is folded', async () => {
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, [NAME], {maxIngestBytes: 200});

		const res = await post(deployment, batchOf(deployment, 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));

		expect(res.status).toBe(413);
		const body = (await res.json()) as {error: string; limit: number; size: number; message: string};
		expect(body.error).toBe('batch-too-large');
		// the ceiling is STATED, so a sender learns it instead of bisecting against it
		expect(body.limit).toBe(200);
		expect(body.size).toBeGreaterThan(200);
		// and it says what to do: a SMALLER RANGE from the same block, never a partial one
		expect(body.message).toMatch(/same fromBlock/i);

		// Nothing was read or folded, shown by the RECOVERY the message prescribes
		// actually working: the receiver still expects the SAME fromBlock, so re-sending
		// the range smaller lands. (A moved cursor would answer 409 here instead, and an
		// applied batch would have created the entity tables.)
		const smaller = await post(deployment, batchOf(deployment, 100, 100, 110, []));
		expect(smaller.status).toBe(200);
	});

	it('is NOT a 409, because a sender must not skip the range it failed to deliver', async () => {
		// 409 is the one resumable refusal and means "re-send from THIS block". A batch
		// that is merely too big starts exactly where the receiver expects, so answering
		// 409 would hand back an expectation the sender has already met and it would
		// advance past the range it never delivered.
		const deployment = await deploy({INGEST_TOKEN: TOKEN}, [NAME], {maxIngestBytes: 200});
		const res = await post(deployment, batchOf(deployment, 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));
		expect(res.status).not.toBe(409);
	});

	it('accepts the same batch when the host states no ceiling, which is the default', async () => {
		const deployment = await deploy();
		const res = await post(deployment, batchOf(deployment, 100, 110, 110, [transfer(101, '0xa101', ALICE, 1n)]));
		expect(res.status).toBe(200);
	});
});
