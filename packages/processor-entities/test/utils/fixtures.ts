import type {Abi, LastSync, LogEvent} from '@etherfold/core';
import type {EntityProcessor} from '../../src/index.js';

/**
 * One processor, written ONCE against the seam and against nothing else.
 *
 * The same `Transfer(from, to, id)` fixture the SQLite paths use, so the three
 * suites can quote the same numbers. `counter` earns its place beyond mirroring:
 * it is what makes read-your-writes observable, since an increment must see the
 * value an earlier event in the SAME block wrote.
 */
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

export const processor: EntityProcessor<TestABI> = {
	entities: [
		{name: 'token', id: ['id'], fields: {owner: 'text', transferCount: 'integer'}},
		{name: 'counter', id: ['name'], fields: {value: 'integer'}},
	],
	async onTransfer(state, event) {
		const id = event.args.id.toString();
		const token = await state.get<{transferCount: number}>('token', {id});
		state.set('token', {id}, {owner: event.args.to, transferCount: (token?.transferCount ?? 0) + 1});

		const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
		state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + 1});
	},
};

export function timestampOf(blockNumber: number): number {
	return 1_700_000_000 + blockNumber * 12;
}

/** The identity the core validates when it decides whether to adopt stored state. */
export const CONTEXT = {source: [{startBlock: 0, hash: 'h'}], config: 'cfg', processor: 'proc'};

export function lastSync(over: Partial<LastSync<TestABI>> = {}): LastSync<TestABI> {
	return {
		context: CONTEXT,
		latestBlock: 0,
		lastFromBlock: 0,
		lastToBlock: 0,
		unconfirmedBlocks: [],
		...over,
	};
}

export const finality = 12;

export const SOURCE = {
	chainId: '1',
	contracts: [{abi, address: '0x0000000000000000000000000000000000000000'}],
} as any;

let logCounter = 0;

/** A Transfer log in the parsed shape a processor sees. */
export function transfer(
	blockNumber: number,
	blockHash: string,
	args: {from: string; to: string; id: bigint},
	extra: Partial<LogEvent<TestABI>> = {},
): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		blockTimestamp: timestampOf(blockNumber),
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000000',
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex: 0,
		extra: undefined,
		eventName: 'Transfer',
		args,
		...(extra as any),
	} as unknown as LogEvent<TestABI>;
}
