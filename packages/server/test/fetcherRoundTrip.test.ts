import {createClient} from '@libsql/client';
import {
	createHttpIngestion,
	IndexerGeneration,
	IngestionRefusedError,
	LogFetcher,
	StreamBuilder,
	type Abi,
	type IndexingSource,
	type IngestionResponse,
	type IngestionTarget,
	type WireBatch,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeAll, describe, expect, it} from 'vitest';
import {createServer, indexerRegistry, singleContextEntry} from '../src/index.js';
import {clearLastError} from '../src/api/status.js';
import {hostRecorderFor} from './utils/hostRecorder.js';

// ---------------------------------------------------------------------------
// THE WHOLE WIRE, END TO END (ADR-0003, ADR-0004)
// ---------------------------------------------------------------------------
// `ingest.test.ts` drives the receiving side with hand-built batches, which is
// the right way to pin what THAT layer decides. This file removes the hand: a
// real `LogFetcher` reads a fake chain over EIP-1193 and pushes through the real
// HTTP client, into the real Hono app, into a real `StreamBuilder` over a real
// `VersionedStateEventProcessor` on a real local libSQL database. Nothing
// between the two halves is a stub except the node itself.
//
// It exists because the two halves were built by different tasks against a
// written contract, and every interesting property of that contract is a
// property of the PAIR:
//
//   - the fetcher holds no cursor, so its first act is to ask, and a `409`
//     after a restart or a race is a correction rather than an error;
//   - no reorg information crosses, so a reorg the fetcher is oblivious to is
//     still concluded, correctly, by the receiver;
//   - and the pair must land where a single process lands. That is the
//     equivalent of the stream-builder's own `derives the SAME stream the
//     engine derives`: a split deployment is a deployment change, not a
//     different indexer.
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

/** `Transfer(address,address,uint256)`, which is what this ABI's event hashes to. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const ALICE = '0x0000000000000000000000000000000000000011';
const BOB = '0x0000000000000000000000000000000000000022';
const CAROL = '0x0000000000000000000000000000000000000033';
const ZERO = '0x0000000000000000000000000000000000000000';

const START_BLOCK = 100;
const FINALITY = 3;
const TOKEN = 'a-shared-secret';
const ENDPOINT = 'http://indexer.test';
/**
 * The NAMED INDEXER both halves are deployed with.
 *
 * It is configuration on each half and a ROUTE SEGMENT between them, and it is
 * NOT in the envelope: the assertion that nothing but `{context, fromBlock,
 * toBlock, latestBlock, logs}` crosses is what pins that.
 */
const INDEXER = 'alpha';

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

// ---------------------------------------------------------------------------
// the chain, as a node really answers
// ---------------------------------------------------------------------------

function hex(value: number): string {
	return `0x${value.toString(16)}`;
}

function addressTopic(address: string): string {
	return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

type RawLog = {
	blockNumber: string;
	blockHash: string;
	transactionIndex: string;
	removed: boolean;
	address: string;
	data: string;
	topics: string[];
	transactionHash: string;
	logIndex: string;
	blockTimestamp: string;
};

let logCounter = 0;

function transferLog(blockNumber: number, blockHash: string, to: string, id: bigint, logIndex = 0): RawLog {
	logCounter++;
	return {
		blockNumber: hex(blockNumber),
		blockHash,
		transactionIndex: '0x0',
		removed: false,
		address: CONTRACT,
		data: `0x${id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC, addressTopic(ZERO), addressTopic(to)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: hex(logIndex),
		blockTimestamp: hex(1_700_000_000 + blockNumber * 12),
	};
}

/** A node serving one branch at a time. The ONLY thing here that is not real. */
function fakeChain() {
	let served: RawLog[] = [];
	let tip = 0;
	return {
		serve(logs: RawLog[], latestBlock: number) {
			served = logs;
			tip = latestBlock;
		},
		get tip() {
			return tip;
		},
		provider: {
			async request(args: {method: string; params?: any}): Promise<any> {
				switch (args.method) {
					case 'eth_chainId':
						return hex(Number(SOURCE.chainId));
					case 'eth_blockNumber':
						return hex(tip);
					case 'eth_getLogs': {
						const from = parseInt(args.params[0].fromBlock.slice(2), 16);
						const to = parseInt(args.params[0].toBlock.slice(2), 16);
						return served.filter((log) => {
							const blockNumber = parseInt(log.blockNumber.slice(2), 16);
							return blockNumber >= from && blockNumber <= to;
						});
					}
				}
				throw new Error(`unexpected method ${args.method}`);
			},
		} as any,
	};
}

/**
 * The chain before the reorg. Blocks 101 and 104 sit below the finality window
 * at every tip used here, so they are confirmed and cannot be retracted; block
 * 116 is inside it when the fork lands, which is the only reason a reorg is
 * detectable at all -- the receiver sees a replacement solely because the
 * fetcher was told to re-deliver that window.
 */
const BRANCH_A = [
	transferLog(101, '0xa101', ALICE, 1n),
	transferLog(104, '0xa104', BOB, 2n),
	transferLog(116, '0xa116', CAROL, 3n),
];
/** The same chain with a different block 116: token 3 was never minted there. */
const BRANCH_B = [BRANCH_A[0], BRANCH_A[1], transferLog(116, '0xb116', ALICE, 4n)];

// ---------------------------------------------------------------------------
// the deployment
// ---------------------------------------------------------------------------

type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	builder: StreamBuilder<TestABI, unknown>;
	processor: VersionedStateEventProcessor<TestABI>;
};

type TestEnv = {DEV?: string; INGEST_TOKEN?: string};

async function deployReceiver(): Promise<Deployment> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	const processor = new VersionedStateEventProcessor<TestABI>(db, entityProcessor);
	// the recorder is the HOST's, exactly as it is in a deployment: this package
	// counts nothing itself any more (ADR-0050)
	const builder = new StreamBuilder<TestABI, unknown>(processor, SOURCE, {
		stream: {finality: FINALITY},
		recordReorg: hostRecorderFor(db),
	});
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		// the registry a host is built with: one name here, over the database that
		// name owns, and every other name refused
		getIndexer: indexerRegistry({[INDEXER]: singleContextEntry(db, builder)}),
	});
	await app.request('/admin/setup', {method: 'POST'});
	return {app, builder, processor};
}

/**
 * The real HTTP client, pointed at the app's own request handler.
 *
 * No socket, and no mock either: `serializeWireBatch`, the bearer header, the
 * status-code mapping and the routes are all the shipped ones. What is skipped
 * is the network, which is the one part neither package owns.
 */
function ingestionFor(deployment: Deployment, spy?: {batches: WireBatch<Abi>[]}): IngestionTarget {
	const http = createHttpIngestion({
		endpoint: ENDPOINT,
		indexer: INDEXER,
		token: TOKEN,
		fetch: (url, init) => deployment.app.request(url, init as RequestInit),
	});
	if (!spy) return http;
	return {
		// the asker's own context travels through, because the receiver may hold
		// several live ones and only the sender knows which of them it is
		expectedFromBlock: (context) => http.expectedFromBlock(context),
		async send(batch): Promise<IngestionResponse> {
			spy.batches.push(batch);
			return http.send(batch);
		},
	};
}

function fetcherFor(chain: ReturnType<typeof fakeChain>, target: IngestionTarget): LogFetcher<TestABI> {
	return new LogFetcher<TestABI>(chain.provider, SOURCE, target, {
		stream: {finality: FINALITY},
		retry: {wait: async () => {}},
	});
}

/** Run cycles until the fetcher has delivered everything up to the tip it can see. */
async function pump(fetcher: LogFetcher<TestABI>, maxCycles = 5): Promise<void> {
	for (let cycle = 0; cycle < maxCycles; cycle++) {
		const outcome = await fetcher.fetchAndPush();
		if (outcome.status === 'up-to-date') return;
		if (outcome.status === 'pushed' && outcome.toBlock === outcome.latestBlock) return;
	}
	throw new Error(`the fetcher did not catch up within ${maxCycles} cycles`);
}

async function ownerOf(deployment: Deployment, id: string): Promise<string | undefined> {
	return (await deployment.processor.state.getCurrent<{owner: string}>('token', {id}))?.owner;
}

async function transferCount(deployment: Deployment): Promise<number> {
	return (await deployment.processor.state.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0;
}

// ---------------------------------------------------------------------------

describe('a stateless fetcher against the real receiver', () => {
	let chain: ReturnType<typeof fakeChain>;
	let deployment: Deployment;
	let fetcher: LogFetcher<TestABI>;
	const spy = {batches: [] as WireBatch<Abi>[]};

	beforeAll(async () => {
		clearLastError();
		chain = fakeChain();
		deployment = await deployReceiver();
		fetcher = fetcherFor(chain, ingestionFor(deployment, spy));
	});

	it('asks where to start before its first fetch, having no cursor to consult', async () => {
		chain.serve(BRANCH_A, 110);

		const outcome = await fetcher.fetchAndPush();

		expect(outcome).toMatchObject({status: 'pushed', fromBlock: START_BLOCK, toBlock: 110, latestBlock: 110});
		expect(await ownerOf(deployment, '1')).toBe(ALICE);
		expect(await ownerOf(deployment, '2')).toBe(BOB);
		expect(await transferCount(deployment)).toBe(2);
	});

	it('follows the cursor the receiver hands back, re-scanning the unconfirmed window', async () => {
		chain.serve(BRANCH_A, 114);

		const outcome = await fetcher.fetchAndPush();

		// 110 - finality(3) = 107, so the top of the last range is re-delivered. That
		// re-delivery is the entire reorg-detection mechanism, and it is the receiver
		// that asked for it, not something this side decided to do.
		expect(outcome).toMatchObject({status: 'pushed', fromBlock: 107, toBlock: 114, corrections: 0});
		// re-delivered, not re-applied: the cursor is the idempotency key
		expect(await transferCount(deployment)).toBe(2);
	});

	it('is corrected by a 409 when another fetcher moved the cursor, with no operator involved', async () => {
		// a second, redundant fetcher: allowed precisely because neither holds state
		const other = fetcherFor(chain, ingestionFor(deployment));
		chain.serve(BRANCH_A, 118);
		await other.fetchAndPush();
		expect(await ownerOf(deployment, '3')).toBe(CAROL);

		// the first fetcher's hint is now stale, which is the lost-acknowledgement
		// case and the restart case in one
		const outcome = await fetcher.fetchAndPush();

		expect(outcome).toMatchObject({status: 'pushed', corrections: 1});
		expect(outcome.status === 'pushed' && outcome.fromBlock).toBe(115); // 118 - 3
		// the corrected re-send covers block 116 again and applies it exactly once
		expect(await transferCount(deployment)).toBe(3);
	});

	it('lets the RECEIVER conclude a reorg from raw ranges it knows nothing about', async () => {
		chain.serve(BRANCH_B, 119);

		const outcome = await fetcher.fetchAndPush();

		expect(outcome).toMatchObject({
			status: 'pushed',
			// derived on the other side, reported back: the fetcher computed nothing
			reorg: {cause: 'contradiction', blockNumber: 116, blockHash: '0xa116'},
			retracted: 1,
			applied: 1,
		});
		expect(await ownerOf(deployment, '1')).toBe(ALICE); // below the fork, untouched
		expect(await ownerOf(deployment, '3')).toBeUndefined(); // the dead branch's mint is gone
		expect(await ownerOf(deployment, '4')).toBe(ALICE);
		expect(await transferCount(deployment)).toBe(3);
	});

	it('never put any reorg information on the wire to begin with', async () => {
		expect(spy.batches.length).toBeGreaterThan(3);
		for (const batch of spy.batches) {
			expect(Object.keys(batch).sort()).toEqual(['context', 'fromBlock', 'latestBlock', 'logs', 'toBlock']);
			expect(batch.logs.every((log: any) => log.removed === false)).toBe(true);
			// and every payload IS the range it claims
			for (const log of batch.logs as any[]) {
				expect(log.blockNumber).toBeGreaterThanOrEqual(batch.fromBlock);
				expect(log.blockNumber).toBeLessThanOrEqual(batch.toBlock);
			}
		}
	});

	it('counts the reorg on /status, from the range the fetcher pushed', async () => {
		const status = await (await deployment.app.request('/status')).json();
		expect(status.reorgs).toMatchObject({contradiction: 1, absence: 0});
		expect(status.healthy).toBe(true);
	});
});

describe('a restarted fetcher', () => {
	it('resumes from the receiver alone, carrying nothing across the restart', async () => {
		const chain = fakeChain();
		const deployment = await deployReceiver();
		chain.serve(BRANCH_A, 110);
		await fetcherFor(chain, ingestionFor(deployment)).fetchAndPush();

		// killed and replaced: a new instance, a new provider connection, no state
		chain.serve(BRANCH_A, 116);
		const restarted = fetcherFor(chain, ingestionFor(deployment));
		expect(restarted.cursorHint).toBeUndefined();
		const outcome = await restarted.fetchAndPush();

		expect(outcome).toMatchObject({status: 'pushed', fromBlock: 107, corrections: 0});
		expect(await transferCount(deployment)).toBe(3);
		expect(await ownerOf(deployment, '3')).toBe(CAROL);
	});
});

describe('a misconfigured fetcher', () => {
	it('is refused with a 400 family error it must not retry, when it indexes something else', async () => {
		const chain = fakeChain();
		const deployment = await deployReceiver();
		chain.serve(BRANCH_A, 110);

		// same source, DIFFERENT stream config: a different indexer, by identity
		const foreign = new LogFetcher<TestABI>(chain.provider, SOURCE, ingestionFor(deployment), {
			stream: {finality: FINALITY + 1},
			retry: {wait: async () => {}},
		});

		// It never gets as far as a batch: the ASK names the asker, the receiver
		// answers with the live wire contexts it holds under the name, and this
		// fetcher's is not among them. Same refusal FAMILY as the `400` a foreign
		// batch earns -- not retryable, no block number makes it right -- learned one
		// round trip earlier and before a single log is fetched.
		const failure = await foreign.fetchAndPush().catch((err) => err);
		expect(failure).toBeInstanceOf(IngestionRefusedError);
		expect(failure.retryable).toBe(false);
		expect(failure.code).toBe('context-mismatch');
		expect(await transferCount(deployment)).toBe(0);
	});

	it('is refused with a 404 it must not retry either, when it pushes to a name this host does not have', async () => {
		// the same fetcher, the same source, the same secret: only the NAME is one this
		// host was not built with. It is a ROUTING refusal rather than a payload one,
		// which is exactly what carrying the name in the envelope would have cost.
		const chain = fakeChain();
		const deployment = await deployReceiver();
		chain.serve(BRANCH_A, 110);
		const elsewhere = createHttpIngestion({
			endpoint: ENDPOINT,
			indexer: 'beta',
			token: TOKEN,
			fetch: (url, init) => deployment.app.request(url, init as RequestInit),
		});

		const failure = await fetcherFor(chain, elsewhere)
			.fetchAndPush()
			.catch((err) => err);

		expect(failure).toBeInstanceOf(IngestionRefusedError);
		expect(failure.status).toBe(404);
		expect(failure.retryable).toBe(false);
		expect(failure.message).toMatch(/no named indexer called "beta"/);
		// and nothing reached the receiver this host DOES hold: its cursor is where it
		// started, which is the assertion the store cannot make (nothing ever opened it)
		expect(await deployment.builder.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('is refused with a 401 that names the variable, when its token is wrong', async () => {
		const chain = fakeChain();
		const deployment = await deployReceiver();
		chain.serve(BRANCH_A, 110);
		const wrongToken = createHttpIngestion({
			endpoint: ENDPOINT,
			indexer: INDEXER,
			token: 'not-the-token',
			fetch: (url, init) => deployment.app.request(url, init as RequestInit),
		});

		const failure = await fetcherFor(chain, wrongToken)
			.fetchAndPush()
			.catch((err) => err);

		expect(failure).toBeInstanceOf(IngestionRefusedError);
		expect(failure.status).toBe(401);
		expect(failure.message).toMatch(/INGEST_TOKEN/);
		// and the credential itself is nowhere in what an operator will read
		expect(failure.message).not.toContain('not-the-token');
	});
});

// ---------------------------------------------------------------------------
// the property the split exists to preserve
// ---------------------------------------------------------------------------

describe('the split deployment lands where a single process lands', () => {
	it('reaches the same state from the same chain, reorg included', async () => {
		const splitChain = fakeChain();
		const receiver = await deployReceiver();
		const fetcher = fetcherFor(splitChain, ingestionFor(receiver));

		const singleChain = fakeChain();
		const singleDb: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
		const single = new VersionedStateEventProcessor<TestABI>(singleDb, entityProcessor);
		const indexer = new IndexerGeneration<TestABI, unknown>(singleChain.provider, single, SOURCE, {
			stream: {finality: FINALITY},
		});
		await indexer.load();

		// the same three chain states, in the same order, to both shapes
		for (const [logs, tip] of [
			[BRANCH_A, 110],
			[BRANCH_A, 118],
			[BRANCH_B, 119],
		] as const) {
			splitChain.serve(logs as RawLog[], tip);
			singleChain.serve(logs as RawLog[], tip);
			await pump(fetcher);
			await indexer.indexMore();
		}

		const snapshotOf = async (read: (id: string) => Promise<{owner: string} | undefined>) => {
			const state: Record<string, unknown> = {};
			for (const id of ['1', '2', '3', '4']) {
				state[`token/${id}`] = (await read(id))?.owner;
			}
			return state;
		};

		const viaWire = await snapshotOf((id) => receiver.processor.state.getCurrent<{owner: string}>('token', {id}));
		const viaEngine = await snapshotOf((id) => single.state.getCurrent<{owner: string}>('token', {id}));

		expect(viaWire).toEqual(viaEngine);
		// and it is not two empty states agreeing with each other
		expect(viaWire).toMatchObject({'token/1': ALICE, 'token/3': undefined, 'token/4': ALICE});
	});
});
