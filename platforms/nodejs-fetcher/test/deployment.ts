import {serve} from '@hono/node-server';
import {createClient} from '@libsql/client';
import {StreamBuilder, type Abi, type IndexingSource} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {createServer, indexerRegistry, singleContextEntry} from '@etherfold/server';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';

// ---------------------------------------------------------------------------
// A REAL deployment, over a real socket.
// ---------------------------------------------------------------------------
// `@etherfold/fetcher-host` already proves what the shared policy does, driving
// the real receiver in-process. What is left for THIS package to prove is its
// wiring: that a Node process, over real HTTP, with real timers and real
// signals, does the same thing -- and that killing it at the worst possible
// moment costs nothing.
//
// So the receiver here is stood up the way a deployment stands it up: the real
// Hono app on a real port, and the fetcher reaches it through the global
// `fetch`. Only the NODE is fake.
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
const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const ZERO = '0x0000000000000000000000000000000000000000';
export const ALICE = '0x0000000000000000000000000000000000000011';

export const START_BLOCK = 100;
export const FINALITY = 3;
export const TOKEN = 'the-node-fetchers-shared-secret';

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

export function transferLog(blockNumber: number, id: number) {
	return {
		blockNumber: hex(blockNumber),
		blockHash: `0x${blockNumber.toString(16).padStart(8, 'a')}`,
		transactionIndex: '0x0',
		removed: false,
		address: CONTRACT,
		data: `0x${id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC, addressTopic(ZERO), addressTopic(ALICE)],
		transactionHash: `0x${id.toString(16).padStart(64, '0')}`,
		logIndex: '0x0',
		blockTimestamp: hex(1_700_000_000 + blockNumber * 12),
	};
}

export type FakeChain = ReturnType<typeof fakeChain>;

export function fakeChain() {
	let served: ReturnType<typeof transferLog>[] = [];
	let tip = 0;
	let gate: {promise: Promise<void>; open: () => void} | undefined;

	return {
		serve(logs: ReturnType<typeof transferLog>[], latestBlock: number) {
			served = logs;
			tip = latestBlock;
		},
		/** Make the next `eth_getLogs` hang, so a process can be killed with a cycle in flight. */
		hangOnNextFetch(): () => void {
			let open!: () => void;
			const promise = new Promise<void>((resolve) => (open = resolve));
			gate = {promise, open};
			// releases THIS gate whether or not a fetch has reached it yet: going through
			// `gate` would do nothing once the fetch consumed it, leaving the test hanging
			return () => open();
		},
		provider: {
			async request(args: {method: string; params?: any}): Promise<any> {
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

export type RunningReceiver = {
	url: string;
	processor: VersionedStateEventProcessor<TestABI>;
	close: () => Promise<void>;
	transfers: () => Promise<number>;
	ownerOf: (id: string) => Promise<string | undefined>;
};

/** The indexer-server on a real port, with a real processor over a real database. */
export async function startReceiver(): Promise<RunningReceiver> {
	const db: RemoteSQL = new RemoteLibSQL(createClient({url: ':memory:'}));
	const processor = new VersionedStateEventProcessor<TestABI>(db, entityProcessor);
	const builder = new StreamBuilder<TestABI, unknown>(processor, SOURCE, {stream: {finality: FINALITY}});
	const app = createServer<{INGEST_TOKEN?: string}>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: indexerRegistry({[INDEXER]: singleContextEntry(db, builder)}),
	});
	await app.request('/admin/setup', {method: 'POST'});
	// the processor's own tables, which a real host gets when the first batch lands.
	// Done up front here so a test can ASK about state that was never written --
	// "nothing was applied" is the assertion after a refusal, and it should not come
	// back as a missing table.
	await processor.load(SOURCE, builder.streamConfig);

	const server = serve({fetch: app.fetch, port: 0});
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;

	return {
		url: `http://localhost:${port}`,
		processor,
		close: () => new Promise<void>((resolve, reject) => server.close((err?: Error) => (err ? reject(err) : resolve()))),
		transfers: async () =>
			(await processor.state.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0,
		ownerOf: async (id) => (await processor.state.getCurrent<{owner: string}>('token', {id}))?.owner,
	};
}
