import type {Abi, LastSync, LogEvent} from '@etherfold/core';
import type {RemoteSQL} from 'remote-sql';
import {VersionedStateEventProcessor, type SQLProcessor} from '../../src/index.js';
import {createTestDB} from './db.js';

/**
 * The fixture the retired in-memory path's `reorg.test.ts` used, ported to
 * versioned rows: one `Transfer(from, to, id)` event, an owner per token, and a
 * global transfer counter.
 *
 * The in-memory state there was `{owners: {[id]: string}, transferCount: number}`.
 * Here `owners` is the `token` table and `transferCount` is a single row in
 * `counter`, so every assertion in the ported tests quotes the SAME numbers that
 * path quoted.
 *
 * `counter` also carries its weight beyond mirroring. It is an entity that the
 * reorged block touches while `token` may not, and vice versa, so it exercises
 * "reverting restores prior state for entities untouched by the reorged block"
 * and read-your-writes within a block (an increment must see the value an
 * earlier event in the same block wrote).
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

export const processor: SQLProcessor<TestABI> = {
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

/** Deterministic and monotonic, so the time axis is assertable. */
export function timestampOf(blockNumber: number): number {
	return 1_700_000_000 + blockNumber * 12;
}

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

/**
 * A loaded processor over a fresh in-memory database.
 *
 * `load` must precede `process` (it sets `finality` and runs the migration),
 * exactly as in the in-memory fixture. `event.blockTimestamp` comes off the LOG
 * and there is no configuration that fetches one (ADR-0073), so the stream
 * config here is `finality` and nothing else.
 */
export async function freshProcessor(db: RemoteSQL = createTestDB()): Promise<{
	db: RemoteSQL;
	p: VersionedStateEventProcessor<TestABI>;
}> {
	const p = new VersionedStateEventProcessor<TestABI>(db, processor);
	await p.load(SOURCE, {finality});
	return {db, p};
}

/** `state.owners[id]`, in the in-memory fixture's terms. */
export async function ownerOf(p: VersionedStateEventProcessor<TestABI>, id: string): Promise<string | undefined> {
	return (await p.state.getCurrent<{owner: string}>('token', {id}))?.owner;
}

/** `state.transferCount`, in the in-memory fixture's terms. */
export async function transferCount(p: VersionedStateEventProcessor<TestABI>): Promise<number> {
	return (await p.state.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value ?? 0;
}
