import {describe, expect, it, vi} from 'vitest';
import type {Abi} from 'abitype';
import {degradingStream} from '../src/stream/degrading.js';
import type {ExistingStream, IndexingSource, StoredLastSync, StoredLogEvent, UsedStreamConfig} from '../src/types.js';

/**
 * A STREAM THAT CANNOT BE READ COSTS A RE-INDEX, NEVER THE INDEXER.
 *
 * The load path calls `fetchFrom` and `clear` with no `try`/`catch` anywhere
 * above them, so a keeper that raises from either does not degrade a cache: it
 * makes `load()` reject, for good, on every reload, for a LOCAL CACHE whose
 * correct recovery is to throw the bytes away and index again. That is the
 * outage story 12 exists to prevent.
 *
 * The rule already existed for the damage a keeper can DETECT (a gap, an
 * unparseable segment: cleared, absent reported, nothing thrown). This is the
 * same rule for the damage it cannot -- a substrate that is simply gone.
 *
 * `saveNewEvents` is deliberately NOT covered by it. See the last case.
 */

const SOURCE: IndexingSource<Abi> = {chainId: '1', contracts: []};

function cursor(lastFromBlock: number, lastToBlock: number): StoredLastSync {
	return {
		context: {source: [{startBlock: 0, hash: 'src'}], config: 'cfg', processor: 'proc'},
		latestBlock: lastToBlock,
		lastFromBlock,
		lastToBlock,
		unconfirmedBlocks: [],
	} as unknown as StoredLastSync;
}

function event(blockNumber: number): StoredLogEvent {
	return {blockNumber, logIndex: 0, removed: false} as unknown as StoredLogEvent;
}

/** The `named-logs` channel this package logs on, silenced and recorded. */
async function captureLogs() {
	const {logs} = await import('named-logs');
	const namedLogger = logs('@etherfold/core');
	const messages: string[] = [];
	const record = (...args: unknown[]) => {
		messages.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
	};
	const spies = [
		vi.spyOn(namedLogger, 'error').mockImplementation(record),
		vi.spyOn(namedLogger, 'info').mockImplementation(record),
	];
	return {messages, restore: () => spies.forEach((spy) => spy.mockRestore())};
}

/** A keeper whose substrate is gone: every operation raises. */
function unusableStream(): ExistingStream<Abi> {
	const gone = () => {
		throw new Error('the store is unavailable');
	};
	return {
		fetchFrom: gone,
		saveNewEvents: gone,
		clear: gone,
	} as unknown as ExistingStream<Abi>;
}

describe('an unusable stream reports ABSENT rather than raising', () => {
	it('answers `undefined` from `fetchFrom`, which is what a full re-index is asked for by', async () => {
		const logged = await captureLogs();
		const stream = degradingStream<Abi>(unusableStream());

		await expect(stream.fetchFrom(SOURCE, 100)).resolves.toBeUndefined();

		// absent is the SAME answer a never-written stream gives, which is exactly why
		// it is the safe one: the load path already knows what to do with it
		expect(logged.messages.some((message) => message.includes('re-index'))).toBe(true);
		logged.restore();
	});

	it('answers `undefined` when the keeper REJECTS rather than throwing synchronously', async () => {
		const logged = await captureLogs();
		const stream = degradingStream<Abi>({
			fetchFrom: () => Promise.reject(new Error('the store is unavailable')),
			saveNewEvents: async () => undefined,
			clear: async () => undefined,
		});

		await expect(stream.fetchFrom(SOURCE, 100)).resolves.toBeUndefined();
		logged.restore();
	});

	it('lets `clear` settle, because the load path clears on every shape it cannot use', async () => {
		const logged = await captureLogs();
		const stream = degradingStream<Abi>(unusableStream());

		// `fetchFrom` reporting absent is what MAKES the caller clear, so a raising
		// `clear` would put the outage back one line further down
		await expect(stream.clear(SOURCE)).resolves.toBeUndefined();
		logged.restore();
	});

	it('does not touch a healthy keeper: the same values, the same calls', async () => {
		const healthy: ExistingStream<Abi> = {
			fetchFrom: async () => ({eventStream: [event(100)], lastSync: cursor(100, 100)}),
			saveNewEvents: vi.fn(async () => undefined),
			clear: vi.fn(async () => undefined),
		};
		const stream = degradingStream<Abi>(healthy);

		expect((await stream.fetchFrom(SOURCE, 100))?.eventStream.map((e) => e.blockNumber)).toEqual([100]);
		await stream.saveNewEvents(SOURCE, {eventStream: [event(101)], lastSync: cursor(101, 101)});
		await stream.clear(SOURCE);
		expect(healthy.saveNewEvents).toHaveBeenCalledTimes(1);
		expect(healthy.clear).toHaveBeenCalledTimes(1);
	});

	it('forwards `setStreamConfig`, which is the stream\u2019s IDENTITY and not a write to it', async () => {
		const told: UsedStreamConfig[] = [];
		const stream = degradingStream<Abi>({
			fetchFrom: async () => undefined,
			saveNewEvents: async () => undefined,
			clear: async () => undefined,
			setStreamConfig: (streamConfig) => told.push(streamConfig),
		});

		stream.setStreamConfig?.({finality: 12} as UsedStreamConfig);
		expect(told).toHaveLength(1);
		// a keeper that addresses nothing has none, and none is invented for it
		expect(degradingStream<Abi>(unusableStream()).setStreamConfig).toBeUndefined();
	});
});

describe('a failed WRITE is passed through, deliberately', () => {
	it('rejects from `saveNewEvents`, because the engine acts on that failure', async () => {
		const logged = await captureLogs();
		const stream = degradingStream<Abi>(unusableStream());

		// `promiseToSave` CATCHES this one, counts it, paces the retry and FREEZES the
		// cache after too many -- and until it does, it does not process the batch. A
		// swallowed write failure would report success to that caller, so the state
		// would advance past events the stream never received: a HOLE, which nothing
		// downstream can detect. The read path has no such caller, which is the whole
		// asymmetry.
		await expect(stream.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursor(100, 100)})).rejects.toThrow(
			/unavailable/,
		);
		logged.restore();
	});
});
