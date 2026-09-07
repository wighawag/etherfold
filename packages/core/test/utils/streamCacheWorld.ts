import type {Abi} from 'abitype';
import {IndexerGeneration} from '../../src/indexer.js';
import type {StreamCursorRecord, StreamSegmentPort, StoredSegment} from '../../src/stream/segments.js';
import type {
	ExistingStream,
	IndexingSource,
	LastSync,
	LogEvent,
	StoredLastSync,
	StoredLogEvent,
} from '../../src/types.js';

/**
 * The world the stream-cache tests drive: a fake chain, a stream keeper with the
 * shipped keeper's semantics, and a processor that persists inside `process()`.
 *
 * It lives beside the tests rather than inside them because three files ask the
 * same questions of it (the engine's cache arithmetic, the load path, the reorg
 * shapes) and a second copy of the fake chain is a second definition of what the
 * node was asked for -- which is the only thing several of those assertions can
 * be made against.
 */

export const ADDRESS = '0x0000000000000000000000000000000000000001';
export const START_BLOCK = 100;
export const FINALITY = 3;

export const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: ADDRESS, startBlock: START_BLOCK}],
};

/**
 * A log, as the fake chain serves it and as the stream stores it: the RAW half
 * and nothing else, which is why it is typed as what a keeper takes.
 *
 * These engine tests replace the log fetcher and decode nothing, so a served log
 * and a stored one are the same object here. The tests where the DECODED half is
 * the subject put one on deliberately (`savedStreamIsRawOnly.test.ts`), which is
 * also the only place the difference between the two shapes is observable.
 */
export function makeLog(blockNumber: number, blockHash: string, logIndex = 0): StoredLogEvent {
	return {
		blockNumber,
		blockHash,
		transactionIndex: 0,
		removed: false,
		address: ADDRESS,
		data: '0x',
		topics: [],
		transactionHash: `0x${`${blockHash}${logIndex}`.replace(/[^0-9a-f]/g, '').padStart(64, '0')}`,
		logIndex,
		extra: undefined,
	} as unknown as StoredLogEvent;
}

/**
 * What an event IS, for an assertion that has to tell two copies of one apart.
 *
 * Takes EITHER shape, like the engine's own `emissionMarkOf`, because it reads
 * the raw half alone and is asked about both: what the processor folded is
 * decoded, and what the keeper was handed is not.
 */
export const idOf = (event: LogEvent<Abi> | StoredLogEvent) => `${event.blockHash}:${event.logIndex}`;
/** The same, saying whether it arrived as an application or as a retraction. */
export const shapeOf = (event: LogEvent<Abi> | StoredLogEvent) => `${event.removed ? 'R' : 'A'}:${idOf(event)}`;

/**
 * A chain that serves one branch at a time and records what it was asked for.
 *
 * Mirrors `packages/browser/browser/workload.ts`'s fake chain, minus the ABI:
 * these tests are about the engine's cache arithmetic, so the logs stay raw and
 * the log fetcher is replaced rather than decoding anything. The RANGES are the
 * point: "did this reload re-fetch what the cache already held" is a question
 * about what the node was asked for, and nothing in the resulting state can
 * answer it.
 */
export function fakeChain(logs: (LogEvent<Abi> | StoredLogEvent)[] = [], tip = 105) {
	const ranges: {from: number; to: number}[] = [];
	let served = logs;
	let latest = tip;
	return {
		ranges,
		get tip() {
			return latest;
		},
		serve(newLogs: (LogEvent<Abi> | StoredLogEvent)[], newTip: number) {
			served = newLogs;
			latest = newTip;
		},
		provider: {
			async request(args: {method: string; params?: any}): Promise<any> {
				switch (args.method) {
					case 'eth_chainId':
						return '0x1';
					case 'eth_blockNumber':
						return `0x${latest.toString(16)}`;
				}
				throw new Error(`unexpected method ${args.method}`);
			},
		} as any,
		/** What `logEventFetcher` is replaced with; the range recorder lives here. */
		fetcher: {
			async getLogEvents({fromBlock, toBlock}: {fromBlock: number; toBlock: number}) {
				ranges.push({from: fromBlock, to: toBlock});
				return {
					events: served.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
					toBlockUsed: toBlock,
				};
			},
			reparse: (events: (LogEvent<Abi> | StoredLogEvent)[]) => events.map((event) => ({...event})),
		},
	};
}

/**
 * A stream keeper with the seam's OBSERVABLE semantics, in memory.
 *
 * A save appends to what is stored and moves the cursor, a fetch filters by
 * block, and a clear drops everything -- which is what an `ExistingStream` looks
 * like from the engine's side whether it stores one blob (as the shipped keeper
 * did) or a run of ordinal SEGMENTS (as `keepStreamOnIndexedDB` now does). That
 * is what the engine is asserted against here; the browser suite runs the same
 * shapes through the real keeper on `fake-indexeddb`, and the segmentation rules
 * themselves are pinned in `streamSegments.test.ts`.
 */
export function memoryStream(initial?: {lastSync: StoredLastSync; eventStream: StoredLogEvent[]}) {
	let stored = initial ? (JSON.parse(JSON.stringify(initial)) as typeof initial) : undefined;
	let failWith: (() => Error | undefined) | undefined;
	const writes: {events: StoredLogEvent[]; lastSync: StoredLastSync}[] = [];
	let clears = 0;
	const keeper: ExistingStream<Abi> = {
		fetchFrom: async (_source, fromBlock) =>
			stored
				? {
						eventStream: stored.eventStream.filter((event) => event.blockNumber >= fromBlock),
						lastSync: JSON.parse(JSON.stringify(stored.lastSync)),
					}
				: undefined,
		saveNewEvents: async (_source, {eventStream, lastSync}) => {
			const failure = failWith?.();
			if (failure) {
				throw failure;
			}
			writes.push({events: eventStream.map((event) => ({...event})), lastSync: JSON.parse(JSON.stringify(lastSync))});
			stored = {
				lastSync: JSON.parse(JSON.stringify(lastSync)),
				eventStream: [...(stored?.eventStream ?? []), ...eventStream.map((event) => ({...event}))],
			};
		},
		clear: async () => {
			// clearing nothing is not a clear: a fresh index with a keeper takes
			// `indexer.ts`'s clear-on-absent branch, and counting that would make
			// "the subtree was never cleared" unassertable
			if (stored) {
				clears++;
			}
			stored = undefined;
		},
	};
	return {
		keeper,
		writes,
		get clears() {
			return clears;
		},
		get cursor() {
			return stored?.lastSync;
		},
		get events() {
			return stored?.eventStream ?? [];
		},
		/** Every write fails, until told otherwise. */
		failEvery(error: () => Error) {
			failWith = error;
		},
		/** Exactly one write fails: the transient case. */
		failOnce(error: Error) {
			let done = false;
			failWith = () => {
				if (done) {
					return undefined;
				}
				done = true;
				return error;
			};
		},
		succeed() {
			failWith = undefined;
		},
	};
}

/**
 * A SEGMENT PORT over one `Map`, plus a log of every operation.
 *
 * `commitSegmentWithCursor` reads the stored cursor and applies the helper's
 * decision in one step, which is what an IndexedDB `readwrite` transaction and a
 * SQL transaction both give it for free.
 *
 * Deliberately dumb: it records what it was asked to do and in which order,
 * because "a save allocated its ordinal from the cursor" and "a save scanned the
 * keyspace to find one" produce the same stored bytes and differ only in the
 * calls made. It lives here rather than beside one test because the segmentation
 * rules and the seed INSTALL are both asserted against it, and a second copy
 * would be a second definition of what a keeper does -- which is the only thing
 * either suite's claims can be made against. It ignores the `source` it is
 * handed: one port is one subtree, and the address arithmetic belongs to the
 * shipped keepers and is asserted in `@etherfold/browser`.
 */
export function memorySegmentPort() {
	const rows = new Map<string, unknown>();
	const calls: {op: string; detail?: unknown}[] = [];
	const port: StreamSegmentPort<Abi> = {
		async readCursor() {
			calls.push({op: 'readCursor'});
			return rows.get('cursor') as StreamCursorRecord<Abi> | undefined;
		},
		async readSegments() {
			calls.push({op: 'readSegments'});
			const stored: StoredSegment[] = [];
			for (const [key, value] of rows) {
				if (key === 'cursor') continue;
				stored.push({ordinal: Number(key), value});
			}
			return stored.sort((a, b) => a.ordinal - b.ordinal);
		},
		async commitSegmentWithCursor(_source, allocate) {
			const commit = allocate(rows.get('cursor') as StreamCursorRecord<Abi> | undefined);
			calls.push({op: 'commitSegmentWithCursor', detail: commit && commit.ordinal});
			if (!commit) return;
			rows.set(String(commit.ordinal), commit.segment);
			rows.set('cursor', commit.cursor);
		},
		async writeCursorOnly(_source, next) {
			const record = next(rows.get('cursor') as StreamCursorRecord<Abi> | undefined);
			calls.push({op: 'writeCursorOnly', detail: record !== undefined});
			if (!record) return;
			rows.set('cursor', record);
		},
		async clearSubtree() {
			const removed = rows.size;
			calls.push({op: 'clearSubtree', detail: removed});
			rows.clear();
			return removed;
		},
	};
	return {port, rows, calls};
}

/**
 * A provider that answers the ONE call a `load()` legitimately makes and THROWS
 * on every other, recording what it was asked.
 *
 * Enforcing "no node in the loop" this way rather than counting calls afterwards
 * is the technique the seam spike used, and it is better for the reason it is
 * used here: a call that should not happen fails AT the call, naming the method,
 * instead of showing up as a number at the end of a test that has already done
 * the wrong thing.
 */
export function nodeRefusingProvider(chainId = '1') {
	const calls: string[] = [];
	return {
		calls,
		provider: {
			async request({method}: {method: string; params?: unknown}): Promise<unknown> {
				calls.push(method);
				if (method === 'eth_chainId') {
					return `0x${Number(chainId).toString(16)}`;
				}
				throw new Error(`THE NODE WAS CALLED: ${method}`);
			},
		} as any,
	};
}

/** Where a processor's state and cursor survive an indexer instance. */
export type ProcessorStore = {saved?: {lastSync: LastSync<Abi>; state: string[]}};

/**
 * A processor that persists inside `process()`, exactly as the real ones do.
 *
 * That is what makes "the tab died between the two writes" reachable: a
 * `process` that never returns never writes its cursor, so a fresh indexer over
 * the same stores comes up with the state BEHIND the stream.
 */
export function fakeProcessor(store: ProcessorStore = {}, options: {persist?: boolean} = {}) {
	const persist = options.persist !== false;
	let state: string[] = [];
	const batches: LogEvent<Abi>[][] = [];
	let throwing = false;
	const processor: any = {
		getVersionHash: () => 'proc',
		getCodeFingerprint: () => undefined,
		load: async () => {
			if (!persist || !store.saved) {
				return undefined;
			}
			state = [...store.saved.state];
			return {lastSync: JSON.parse(JSON.stringify(store.saved.lastSync)), state};
		},
		process: async (list: LogEvent<Abi>[], lastSync: LastSync<Abi>) => {
			if (throwing) {
				throw new Error('processor blew up');
			}
			batches.push(list.map((event) => ({...event})));
			for (const event of list) {
				if (event.removed) {
					const at = state.lastIndexOf(idOf(event));
					if (at >= 0) {
						state.splice(at, 1);
					}
				} else {
					state.push(idOf(event));
				}
			}
			store.saved = {lastSync: JSON.parse(JSON.stringify(lastSync)), state: [...state]};
			return state;
		},
		reset: async () => {
			state = [];
			store.saved = undefined;
		},
		clear: async () => {
			state = [];
			store.saved = undefined;
		},
	};
	return {
		processor,
		batches,
		store,
		get state() {
			return state;
		},
		throwOnProcess(value: boolean) {
			throwing = value;
		},
	};
}

export type StreamWriteRetry = {maxConsecutiveFailures?: number; delaySeconds?: number};

export function makeIndexer(
	chain: ReturnType<typeof fakeChain>,
	processor: any,
	keepStream?: ExistingStream<Abi>,
	streamWriteRetry: StreamWriteRetry = {delaySeconds: 0},
) {
	const indexer = new IndexerGeneration<Abi, string[]>(chain.provider, processor, SOURCE, {
		stream: {finality: FINALITY},
		...(keepStream ? {keepStream} : {}),
		streamWriteRetry,
	});
	(indexer as any).logEventFetcher = chain.fetcher;
	return indexer;
}

/**
 * Drive to the tip the way every driver in this repo does, with a bound so a
 * spin is a red line rather than a hang.
 */
export async function indexToTip(indexer: IndexerGeneration<Abi, string[]>, maxRounds = 30): Promise<number> {
	let rounds = 0;
	let lastSync = await indexer.indexMore();
	while (lastSync.lastToBlock < lastSync.latestBlock) {
		if (rounds++ >= maxRounds) {
			throw new Error(`did not reach the tip in ${maxRounds} rounds (lastToBlock ${lastSync.lastToBlock})`);
		}
		lastSync = await indexer.indexMore();
	}
	return rounds;
}

/** Branch A: three blocks carrying logs, the tip just above them. */
export const BRANCH_A = [
	makeLog(100, '0xa100', 0),
	makeLog(100, '0xa100', 1),
	makeLog(102, '0xa102'),
	makeLog(104, '0xa104'),
];
export const BRANCH_A_TIP = 105;

/** The same chain after a reorg at 104: same 100 and 102, a DIFFERENT 104. */
export const BRANCH_B = [BRANCH_A[0], BRANCH_A[1], BRANCH_A[2], makeLog(104, '0xb104')];
export const BRANCH_B_TIP = 106;
