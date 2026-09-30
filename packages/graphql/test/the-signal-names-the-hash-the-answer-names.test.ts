import 'fake-indexeddb/auto';
import {connectToIndexerHost, createIndexerState, type IndexerPort} from '@etherfold/browser';
import type {Abi, IndexingSource, StateApplied, StateMoved} from '@etherfold/core';
import {EntityEventProcessor, type EntityProcessor} from '@etherfold/processor-entities';
import {openForWriting, type EntityDeclaration} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {describe, expect, it} from 'vitest';
import {QUERY_ERROR_CODES, type QueryResult} from '../src/index.js';
import {graphqlQueryHandler, workerExecutor} from '../src/worker/index.js';

/**
 * THE SIGNAL AND THE ANSWER NAME ONE HASH (ADR-0083, amended 2026-09-30).
 *
 * An `applied` notification names the hash of the block it applied, and an
 * answer names the hash of the block it was pinned to (`extensions.blockHash`,
 * ADR-0099). The two are only worth carrying if they are the SAME value for the
 * same block: that is what lets a reader pin its re-read to exactly the block it
 * was told about (`block: {hash}`), and match a notification to an answer, or key
 * a cache on it. So this is asked end to end, of a REAL fold over a fake chain,
 * behind a real host with GraphQL injected, through the tab's port: the fold
 * reports, core relays, the port carries it, and the executor answers from the
 * store the fold wrote.
 *
 * The chain serves every hash UPPER-cased, on purpose: the store records its own
 * spelling (lower case, `normalizeBlockHash`), and a signal that passed the
 * chain's spelling through would compare unequal to every answer.
 */

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
const START_BLOCK = 100;
const FINALITY = 3;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text'}};

const processor: EntityProcessor<TestABI> = {
	entities: [TOKEN],
	async onTransfer(state, event) {
		state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
	},
};

const hex = (value: number) => `0x${value.toString(16)}`;
const addressTopic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

/** A block's hash as this chain SERVES it: 32 bytes of hex, upper-cased. */
function servedHash(branch: 'a' | 'b', block: number): string {
	return `0x${(branch + block.toString(16)).padStart(64, '0').toUpperCase()}`;
}

/** One event-bearing block per height up to the tip, and from `forkedFrom` up, a different branch. */
function forkableChain() {
	let tip = START_BLOCK;
	let forkedFrom = Number.POSITIVE_INFINITY;
	const logsUpTo = (to: number) => {
		const logs: unknown[] = [];
		for (let block = START_BLOCK; block <= Math.min(tip, to); block++) {
			const forked = block >= forkedFrom;
			logs.push({
				blockNumber: hex(block),
				blockHash: servedHash(forked ? 'b' : 'a', block),
				transactionIndex: '0x0',
				removed: false,
				address: CONTRACT,
				data: `0x${(forked ? block + 1000 : block).toString(16).padStart(64, '0')}`,
				topics: [TRANSFER_TOPIC, addressTopic(ALICE), addressTopic(forked ? BOB : ALICE)],
				transactionHash: `0x${(forked ? block + 1000 : block).toString(16).padStart(64, '0')}`,
				logIndex: '0x0',
				blockTimestamp: hex(1_700_000_000 + block * 12),
			});
		}
		return logs;
	};
	return {
		get tip() {
			return tip;
		},
		advance() {
			tip += 1;
		},
		forkTip() {
			forkedFrom = tip;
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
						return logsUpTo(to).filter((log) => parseInt((log as {blockNumber: string}).blockNumber, 16) >= from);
					}
				}
				throw new Error(`unexpected method ${args.method}`);
			},
		} as never,
	};
}

async function openWorld() {
	const chain = forkableChain();
	const store = await openForWriting(
		new IndexedDBStateStore([TOKEN], {databaseName: `signal-hash-${Math.random().toString(36).slice(2, 10)}`}),
	);
	const indexer = createIndexerState<TestABI, unknown>({
		createState: () => store,
		createProcessor: (state) => new EntityEventProcessor<TestABI>(state, processor),
		processorIdentity: 'the-signal-names-the-hash-the-answer-names',
	});
	const port: IndexerPort = connectToIndexerHost(indexer.mainThreadHost({query: graphqlQueryHandler()}), {
		watch: false,
	});
	const moved: StateMoved[] = [];
	port.onStateMoved((notification) => moved.push(notification));
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	const executor = workerExecutor(port);

	/** Fold until the fold is level with the chain's tip, then wait for the port to have carried it. */
	const driveToTip = async (): Promise<StateApplied> => {
		for (let round = 0; round < 60; round++) {
			const lastSync = await indexer.indexMore();
			if (lastSync && lastSync.lastToBlock >= chain.tip) break;
		}
		for (let wait = 0; wait < 500; wait++) {
			const last = moved.at(-1);
			if (last?.kind === 'applied' && last.block === chain.tip) return last;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`the port never carried block ${chain.tip}. It carried: ${JSON.stringify(moved)}`);
	};

	return {
		chain,
		moved,
		driveToTip,
		ask: (query: string) => executor({query}) as Promise<QueryResult>,
		close() {
			port.close();
			indexer.dispose();
		},
	};
}

describe('the state-moved signal and a query answer name ONE hash', () => {
	it('names in an applied notification exactly the hash extensions names for an operation answered at that tip', async () => {
		const world = await openWorld();
		try {
			world.chain.advance();
			const applied = await world.driveToTip();
			// the STORE's spelling, not the chain's
			expect(applied.hash).toBe(servedHash('a', applied.block).toLowerCase());

			const answer = await world.ask(`{ token(first: 10) { id owner } }`);
			expect(answer.errors).toBeUndefined();
			// an operation's pin is the tip, and the tip is the block the signal named
			expect(answer.extensions).toMatchObject({block: applied.block, blockHash: applied.hash});
			expect(answer.extensions?.blockHash).toBe(applied.hash);
		} finally {
			world.close();
		}
	});

	it('lets a reader pin its re-read to the signalled hash, and REFUSES that pin once the block is replaced', async () => {
		const world = await openWorld();
		try {
			world.chain.advance();
			const told = await world.driveToTip();
			const pinned = (hash: string) => world.ask(`{ token(block: {hash: "${hash}"}, first: 10) { id owner } }`);

			// pinned to EXACTLY the block it was told about
			const reread = await pinned(told.hash);
			expect(reread.errors).toBeUndefined();

			// the chain replaces that block: the SAME height under a different hash
			world.chain.forkTip();
			const replacement = await world.driveToTip();
			expect(replacement.block).toBe(told.block);
			expect(replacement.hash).not.toBe(told.hash);
			expect((await world.ask(`{ token(first: 10) { id } }`)).extensions?.blockHash).toBe(replacement.hash);

			// a re-read pinned to the block it was told about is REFUSED rather than answered
			// from the replacement, so the reader reads everything again
			const stale = await pinned(told.hash);
			expect(stale.errors?.[0]?.extensions?.code).toBe(QUERY_ERROR_CODES.blockNotRecorded);
		} finally {
			world.close();
		}
	});
});
