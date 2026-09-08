import type {Abi, ExtractAbiEvent, LastSync, LogEvent} from '@etherfold/core';
import {MemoryStateStore} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, type EntityProcessor} from '../src/index.js';
import type {InputValues} from '../src/types.js';

/**
 * ONE handler name can cover TWO wire events, and the type must say so.
 *
 * The claim the retired free-form path's `handlerArgs.test.ts` made, asserted
 * HERE because this package holds the only remaining copy of `InputValues`.
 *
 * An upgraded contract can emit `Transfer(address,address,uint256)` before the
 * upgrade block and `Transfer(address,address,uint256,bytes)` after it. They
 * share a NAME, so `ExtractAbiEventNames` collapses them and the author writes
 * ONE `onTransfer`. Mapped without distributing, the two input lists MERGED with
 * the v2-only field REQUIRED, and a pre-upgrade log handed the author
 * `undefined` through a type promising a value.
 *
 * **`pnpm typecheck` is what runs most of this file.** Each `@ts-expect-error`
 * FAILS the typecheck if the line it guards starts compiling, which is the only
 * way to assert that something is NOT accepted; vitest strips types with esbuild
 * without checking them. What vitest runs is the run-time half: that the
 * narrowing the types now force is the branch a v1 payload actually takes.
 */

/** Type identity, not assignability: a union and a merge are assignable in one direction. */
type IsExactly<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A contract upgraded mid-life: `Transfer` gained a `memo`, so ONE name covers TWO events. */
const upgradedAbi = [
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
	{
		type: 'event',
		name: 'Transfer',
		anonymous: false,
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'id', type: 'uint256'},
			{indexed: false, name: 'memo', type: 'bytes'},
		],
	},
] as const satisfies Abi;
type UpgradedABI = typeof upgradedAbi;

/** The ordinary case: one version, no upgrade, and it must cost nothing. */
const singleVersionAbi = [
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
type SingleVersionABI = typeof singleVersionAbi;

/**
 * The args of a single-version event are the SAME object type they always were,
 * spelled out rather than derived, so a widening (to `any`, to an optional, to a
 * union with `never`) fails here rather than passing silently downstream.
 */
const singleVersionArgsAreUnchanged: IsExactly<
	InputValues<ExtractAbiEvent<SingleVersionABI, 'Transfer'>>,
	{from: `0x${string}`; to: `0x${string}`; id: bigint}
> = true;

/** Two same-named events give a UNION of the two input lists, never their merge. */
const upgradedArgsAreAUnion: IsExactly<
	InputValues<ExtractAbiEvent<UpgradedABI, 'Transfer'>>,
	| {from: `0x${string}`; to: `0x${string}`; id: bigint}
	| {from: `0x${string}`; to: `0x${string}`; id: bigint; memo: `0x${string}`}
> = true;

const ENTITIES = [{name: 'token', id: ['id'], fields: {owner: 'text', memoed: 'integer'}}] as const;

const upgraded: EntityProcessor<UpgradedABI> = {
	version: '1.0.0',
	entities: [...ENTITIES],
	async onTransfer(state, event) {
		// Every version carries these, so they read without narrowing.
		const to: `0x${string}` = event.args.to;
		const id: bigint = event.args.id;

		// @ts-expect-error `memo` is in only ONE of the two `Transfer`s, so an un-narrowed read is a lie: a pre-upgrade log has no memo
		const lie: `0x${string}` = event.args.memo;

		let memoed = 0;
		if ('memo' in event.args) {
			// narrowed to the v2 shape: the version-specific field AND the shared ones
			const memo: `0x${string}` = event.args.memo;
			const stillShared: bigint = event.args.id;
			if (memo.length > 2 && stillShared >= 0n) memoed = 1;
		}

		state.set('token', {id: id.toString()}, {owner: to, memoed});
	},
};

/**
 * The common case, written exactly as `test/utils/fixtures.ts` writes it and
 * compiling exactly as it did. This is the criterion that stops the fix costing
 * the single-version author anything: no narrowing, no cast, no widened field.
 */
const ordinary: EntityProcessor<SingleVersionABI> = {
	version: '1.0.0',
	entities: [...ENTITIES],
	async onTransfer(state, event) {
		const from: `0x${string}` = event.args.from;
		const to: `0x${string}` = event.args.to;
		const id: bigint = event.args.id;

		// @ts-expect-error and the args are still a CLOSED object: a field no version declares is refused
		event.args.memo;

		state.set('token', {id: id.toString()}, {owner: from ? to : to, memoed: 0});
	},
};

let logCounter = 0;
function transfer(blockNumber: number, blockHash: string, args: Record<string, unknown>): LogEvent<UpgradedABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
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
	} as unknown as LogEvent<UpgradedABI>;
}

const CONTEXT = {source: [{startBlock: 0, hash: 'h'}], config: 'cfg', processor: 'proc'};
function lastSync(over: Partial<LastSync<UpgradedABI>> = {}): LastSync<UpgradedABI> {
	return {
		context: CONTEXT,
		latestBlock: 0,
		lastFromBlock: 0,
		lastToBlock: 0,
		unconfirmedBlocks: [],
		...over,
	};
}

const SOURCE = {
	chainId: '1',
	contracts: [{abi: upgradedAbi, address: '0x0000000000000000000000000000000000000000'}],
} as any;

describe('a handler covering two versions of one event', () => {
	it('takes the un-memoed branch for a pre-upgrade log and the memoed one after', async () => {
		const store = new MemoryStateStore([...ENTITIES]);
		const p = new EntityEventProcessor<UpgradedABI>(store, upgraded);
		await p.load(SOURCE, {finality: 12});

		await p.process(
			[
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(101, '0xB', {from: '0x0', to: '0xbob', id: 2n, memo: '0xdeadbeef'}),
			],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);

		expect([
			await store.getCurrent<{memoed: number}>('token', {id: '1'}),
			await store.getCurrent<{memoed: number}>('token', {id: '2'}),
		]).toMatchObject([{memoed: 0}, {memoed: 1}]);
	});

	it('holds the two type claims the compiler checked', () => {
		// The value of these constants is uninteresting; that they were ASSIGNABLE
		// at all is the assertion, and `pnpm typecheck` is what made it.
		expect([singleVersionArgsAreUnchanged, upgradedArgsAreAUnion]).toEqual([true, true]);
		expect(typeof ordinary.onTransfer).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// A LOG THIS ABI COULD NOT PARSE STILL REACHES THE AUTHOR
// ---------------------------------------------------------------------------
// `handleUnparsedEvent` is part of the authoring contract (`EntityProcessor`),
// and the entity path is the only shipped path that can call it. It is how an
// author sees a log whose topic matched the filter but whose payload this ABI
// could not decode -- an upgraded contract, a mis-declared event, a log the
// fetch filter admitted on purpose (`an-event-is-never-silently-dropped-from-the-fetch-filter`).
// Without it the event is simply skipped, which is the one outcome the fetch
// filter's whole design exists to avoid.
// ---------------------------------------------------------------------------

/** A log carrying a decode failure, which is what the fetcher hands over when parsing fails. */
function unparsed(blockNumber: number, blockHash: string): LogEvent<UpgradedABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash,
		blockTimestamp: 1_700_000_000 + blockNumber * 12,
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000000',
		data: '0xnotdecodable',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: 0,
		extra: undefined,
		decodeError: 'parsing did not return any results',
	} as unknown as LogEvent<UpgradedABI>;
}

describe('an event this ABI could not parse', () => {
	it('is handed to `handleUnparsedEvent`, not silently skipped', async () => {
		const seen: {block: number; error: string}[] = [];
		const withHandler = {
			...upgraded,
			handleUnparsedEvent(_state: unknown, event: {blockNumber: number; decodeError: string}) {
				seen.push({block: event.blockNumber, error: event.decodeError});
			},
		} as unknown as typeof upgraded;

		const store = new MemoryStateStore([...ENTITIES]);
		const p = new EntityEventProcessor<UpgradedABI>(store, withHandler);
		await p.load(SOURCE, {finality: 12});

		await p.process(
			[unparsed(100, '0xA'), transfer(101, '0xB', {from: '0x0', to: '0xbob', id: 2n})],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);

		expect(seen).toEqual([{block: 100, error: 'parsing did not return any results'}]);
		// and the parsable event in the same batch was still applied
		expect(await store.getCurrent<{memoed: number}>('token', {id: '2'})).toBeDefined();
	});

	it('costs nothing when the author declares no handler, and the batch still applies', async () => {
		const store = new MemoryStateStore([...ENTITIES]);
		const p = new EntityEventProcessor<UpgradedABI>(store, upgraded);
		await p.load(SOURCE, {finality: 12});

		await p.process(
			[unparsed(100, '0xA'), transfer(101, '0xB', {from: '0x0', to: '0xbob', id: 2n})],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);

		expect(await store.getCurrent<{memoed: number}>('token', {id: '2'})).toBeDefined();
	});
});
