import {createClient} from '@libsql/client';
import {StreamBuilder, type Abi, type FetchLike, type IndexingSource, type WireBatch} from '@etherfold/core';
import {createServer, indexerRegistry, singleContextEntry} from '@etherfold/server';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';

// ---------------------------------------------------------------------------
// A REAL receiver and a fake chain, following packages/server/test/fetcherRoundTrip.test.ts.
// ---------------------------------------------------------------------------
// The only thing simulated here is the NODE. The receiver is the real Hono app
// over a real `StreamBuilder` over a real processor on a real local libSQL
// database, reached through the real HTTP client. That matters more for these
// tests than for core's, because what is under test is a host's REACTION to what
// the receiver says -- a `409` after a restart, a refusal it must not retry --
// and a mock receiver would be a mock of exactly the thing being tested.
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

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
export const ALICE = '0x0000000000000000000000000000000000000011';
export const BOB = '0x0000000000000000000000000000000000000022';
export const CAROL = '0x0000000000000000000000000000000000000033';
const ZERO = '0x0000000000000000000000000000000000000000';

export const START_BLOCK = 100;
export const FINALITY = 3;
export const TOKEN = 'a-shared-secret-nothing-may-log';
export const ENDPOINT = 'http://indexer.test';

/**
 * The NAMED INDEXER both halves are deployed with: configuration on each side,
 * a ROUTE SEGMENT between them (`/{indexer}/ingest`), and never a field in the
 * envelope (ADR-0036).
 */
export const INDEXER = 'alpha';

export const SOURCE: IndexingSource<TestABI> = {
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

function hex(value: number): string {
	return `0x${value.toString(16)}`;
}

function addressTopic(address: string): string {
	return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

export type RawLog = {
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

export function transferLog(blockNumber: number, blockHash: string, to: string, id: bigint, logIndex = 0): RawLog {
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

export type FakeChain = ReturnType<typeof fakeChain>;

/**
 * A node serving one branch at a time, with two knobs the round-trip test does
 * not need: it can be made to HANG on `eth_getLogs` (so a host can be killed
 * mid-cycle, in flight, rather than between cycles) and it counts its calls.
 */
export function fakeChain() {
	let served: RawLog[] = [];
	let tip = 0;
	let gate: {promise: Promise<void>; open: () => void} | undefined;
	const calls: string[] = [];

	return {
		serve(logs: RawLog[], latestBlock: number) {
			served = logs;
			tip = latestBlock;
		},
		get tip() {
			return tip;
		},
		get calls() {
			return calls;
		},
		/** Make the next `eth_getLogs` hang until the returned function is called. */
		hangOnNextFetch(): () => void {
			let open!: () => void;
			const promise = new Promise<void>((resolve) => (open = resolve));
			gate = {promise, open};
			// the returned function releases THIS gate whether or not a fetch has reached
			// it yet: releasing through `gate` would silently do nothing once the fetch
			// consumed it, and leave the test hanging on the promise it is waiting for
			return () => open();
		},
		provider: {
			async request(args: {method: string; params?: any}): Promise<any> {
				calls.push(args.method);
				switch (args.method) {
					case 'eth_chainId':
						return hex(Number(SOURCE.chainId));
					case 'eth_blockNumber':
						return hex(tip);
					case 'eth_getLogs': {
						if (gate) {
							const waiting = gate;
							gate = undefined;
							await waiting.promise;
						}
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

/** The chain before the reorg: block 116 sits inside the finality window when the fork lands. */
export const BRANCH_A = [
	transferLog(101, '0xa101', ALICE, 1n),
	transferLog(104, '0xa104', BOB, 2n),
	transferLog(116, '0xa116', CAROL, 3n),
];
/** The same chain with a different block 116: token 3 was never minted there. */
export const BRANCH_B = [BRANCH_A[0], BRANCH_A[1], transferLog(116, '0xb116', ALICE, 4n)];

export type Receiver = {
	app: ReturnType<typeof createServer<TestEnv>>;
	processor: VersionedStateEventProcessor<TestABI>;
	/**
	 * The stream-builder itself, which is what a COMBINED host is handed through
	 * `createDirectIngestion` instead of a URL and a token.
	 */
	builder: StreamBuilder<TestABI, unknown>;
	/** The in-process `fetch` a host is configured with. No socket, no mock. */
	fetch: FetchLike;
	requests: {path: string; status: number}[];
};

type TestEnv = {DEV?: string; INGEST_TOKEN?: string};

export async function deployReceiver(): Promise<Receiver> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	const processor = new VersionedStateEventProcessor<TestABI>(db, entityProcessor);
	const builder = new StreamBuilder<TestABI, unknown>(processor, SOURCE, {stream: {finality: FINALITY}});
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: indexerRegistry({[INDEXER]: singleContextEntry(db, builder)}),
	});
	await app.request('/admin/setup', {method: 'POST'});
	const requests: {path: string; status: number}[] = [];
	return {
		app,
		processor,
		builder,
		requests,
		fetch: async (url, init) => {
			const response = await app.request(url, init as RequestInit);
			requests.push({path: new URL(url, 'http://indexer.test').pathname, status: response.status});
			return response;
		},
	};
}

export async function ownerOf(receiver: Receiver, id: string): Promise<string | undefined> {
	return (await receiver.processor.state.getCurrent<{owner: string}>('token', {id}))?.owner;
}

export async function transferCount(receiver: Receiver): Promise<number> {
	return (await receiver.processor.state.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0;
}

/** Every batch a host pushed, for assertions about what crossed the wire. */
export function recordBatches(): {batches: WireBatch<Abi>[]} {
	return {batches: []};
}
