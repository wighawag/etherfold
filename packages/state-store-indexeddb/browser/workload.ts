import type {Abi, LogEvent} from '@etherfold/core';
import type {EntityProcessor} from '@etherfold/processor-entities';
import {applyEventStream} from '@etherfold/processor-entities';
import {openForWriting, type StateStore, type StateStoreBackend} from '@etherfold/state-store';

/**
 * One processor, written once against the seam, run on the server and in a tab.
 *
 * This module is imported by BOTH sides of the browser tests: the Playwright
 * spec runs it in node against `MemoryStateStore`, and the bundled
 * code-under-test runs the SAME object in the browser against
 * `IndexedDBStateStore`. Nothing in it names a backend, which is the property
 * the whole storage seam exists for, and comparing the two results is how "the
 * same processor runs everywhere" becomes a fact rather than a claim.
 *
 * The `Transfer(from, to, id)` fixture is the one the other backends' tests use,
 * so the suites quote the same numbers. `counter` earns its place twice: it
 * makes read-your-writes observable inside a block, and it is the accumulated
 * value that must go back DOWN when the reorg below is reverted.
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

export type TransferABI = typeof abi;

export const processor: EntityProcessor<TransferABI> = {
	version: '1.0.0',
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

const ZERO = '0x0000000000000000000000000000000000000000';

let logCounter = 0;

function transfer(
	blockNumber: number,
	blockHash: string,
	args: {from: string; to: string; id: bigint},
	extra: Partial<LogEvent<TransferABI>> = {},
): LogEvent<TransferABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
		transactionIndex: 0,
		removed: false,
		address: ZERO,
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: 0,
		extra: undefined,
		eventName: 'Transfer',
		args,
		...extra,
	} as unknown as LogEvent<TransferABI>;
}

/**
 * Four blocks of ordinary indexing, a reorg that takes the last one back, and
 * the canonical replacement.
 *
 * The retraction is the shape the engine really emits: an event carrying
 * `removed: true`, which a backend answers by reverting to the fork point. It is
 * deliberately a retraction with NO replacement in the same stream (a block
 * whose logs simply vanished), because that is the case where the accumulated
 * counter has to be OBSERVED going back down rather than being immediately
 * pushed back up by the replacement. Block 102's two transfers in one block are
 * what make read-your-writes load-bearing here.
 */
export function streams(): {
	indexing: LogEvent<TransferABI>[];
	retraction: LogEvent<TransferABI>[];
	replacement: LogEvent<TransferABI>[];
} {
	logCounter = 0;
	const alice = '0x1111111111111111111111111111111111111111';
	const bob = '0x2222222222222222222222222222222222222222';
	const carol = '0x3333333333333333333333333333333333333333';

	const indexing = [
		transfer(100, '0xaa', {from: ZERO, to: alice, id: 1n}),
		transfer(101, '0xbb', {from: alice, to: bob, id: 1n}),
		transfer(102, '0xcc', {from: ZERO, to: carol, id: 2n}),
		transfer(102, '0xcc', {from: carol, to: alice, id: 2n}, {logIndex: 1}),
		transfer(103, '0xdd', {from: bob, to: carol, id: 1n}),
	];

	// block 103 is reorged out, and nothing replaces it yet
	const retraction = [transfer(103, '0xdd', {from: bob, to: carol, id: 1n}, {removed: true})];

	// then a different block arrives at the same height, transferring the OTHER token
	const replacement = [transfer(103, '0xee', {from: alice, to: bob, id: 2n})];

	return {indexing, retraction, replacement};
}

/** Every live row, in a stable order, as the two runs are compared on. */
export async function liveRows(store: StateStore): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for (const id of ['1', '2']) {
		const token = await store.getCurrent<Record<string, unknown>>('token', {id});
		if (token) rows.push({entity: 'token', ...token});
	}
	const counter = await store.getCurrent<Record<string, unknown>>('counter', {name: 'transfers'});
	if (counter) rows.push({entity: 'counter', ...counter});
	return rows;
}

/**
 * Index, then reorg, reporting the state at each step and the counter across
 * the revert.
 *
 * Identical on both sides of the wire, so any difference between what the tab
 * computed and what node computed is the STORE and not the driving code.
 */
export async function runWorkload(store: StateStoreBackend): Promise<{
	afterIndexing: Record<string, unknown>[];
	afterRetraction: Record<string, unknown>[];
	afterReplacement: Record<string, unknown>[];
	counterBefore: unknown;
	counterAfterRetraction: unknown;
	counterAfterReplacement: unknown;
	listing: Record<string, unknown>[];
}> {
	const {indexing, retraction, replacement} = streams();
	const counter = async () => (await store.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value;
	// this harness FOLDS, so it claims the store it was handed: the ability to mutate
	// is obtained by claiming (ADR-0077), and `openForWriting` migrates on the way.
	// The reads below go on using the store itself, which is the same storage.
	const writer = await openForWriting(store);

	await applyEventStream(writer, processor, indexing, undefined);
	const afterIndexing = await liveRows(store);
	const counterBefore = await counter();

	await applyEventStream(writer, processor, retraction, undefined);
	const afterRetraction = await liveRows(store);
	const counterAfterRetraction = await counter();

	await applyEventStream(writer, processor, replacement, undefined);
	const afterReplacement = await liveRows(store);
	const counterAfterReplacement = await counter();

	const listing = (await store.listCurrent<Record<string, unknown>>('token', {id: '1'}, 10)).rows.map((row) => ({
		...row,
	}));

	return {
		afterIndexing,
		afterRetraction,
		afterReplacement,
		counterBefore,
		counterAfterRetraction,
		counterAfterReplacement,
		listing,
	};
}
