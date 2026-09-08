import type {Abi} from 'abitype';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
	IngestionRefusedError,
	IngestionUnavailableError,
	SuspectedTruncationError,
	UnexpectedChainError,
	WireContextMismatchError,
} from '../src/errors.js';
import {createHttpIngestion} from '../src/ingestClient.js';
import {LogFetcher, type IngestionResponse, type IngestionTarget} from '../src/logFetcher.js';
import type {IndexingSource, WireBatch, WireContext} from '../src/types.js';
import {simple_hash} from '../src/utils/hash.js';

// ---------------------------------------------------------------------------
// THE SENDING SIDE OF THE WIRE (ADR-0003, ADR-0004)
// ---------------------------------------------------------------------------
// `LogFetcher` is the half of a split deployment that talks to the chain and
// holds nothing. What is asserted here is what only this side can get wrong:
//
//   1. it starts where the RECEIVER says, never where it last thought it was,
//      and a `409` puts it back on track inside one cycle;
//   2. it never delivers a partial range, whether the node announces the
//      truncation or applies it silently. This is the one that deletes state;
//   3. it ships no reorg information at all, and no `removed` marker;
//   4. it tells the two refusal families apart, so a misconfiguration is
//      surfaced instead of retried forever.
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

const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const ZERO = '0x0000000000000000000000000000000000000000';
const START_BLOCK = 100;
const FINALITY = 3;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

// the ABI-encoded topic of Transfer(address,address,uint256), as viem encodes it
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function padded(value: string): string {
	return `0x${value.replace(/^0x/, '').padStart(64, '0')}`;
}

/**
 * A raw `eth_getLogs` result, in the JSON-RPC shape a node really returns.
 *
 * `blockTimestamp` is on it, as it is on every node the engine supports since
 * `execution-apis#639`: a fetched range holding a log without one is refused at
 * the fetch boundary (ADR-0073). A node that predates the change is modelled by
 * `makeChain({servesTimestamps: false})`, which is what the
 * `alwaysFetchTimestamps` fallback below exists for.
 */
function rawLog(blockNumber: number, blockHash: string, id: number, logIndex = 0, to = ZERO) {
	return {
		blockNumber: `0x${blockNumber.toString(16)}`,
		blockHash,
		blockTimestamp: `0x${(1_700_000_000 + blockNumber * 12).toString(16)}`,
		transactionIndex: '0x0',
		removed: false,
		address: CONTRACT,
		data: padded(id.toString(16)),
		topics: [TRANSFER_TOPIC, padded(ZERO), padded(to)],
		transactionHash: padded(`${blockNumber.toString(16)}${logIndex}`),
		logIndex: `0x${logIndex.toString(16)}`,
	};
}

type ChainOptions = {
	chainId?: string;
	latestBlock: number;
	/** every log the chain holds, by block number */
	logsPerBlock?: {[blockNumber: number]: ReturnType<typeof rawLog>[]};
	blockTimestamps?: {[blockHash: string]: number};
	/** A node PREDATING `execution-apis#639`, which serves no `blockTimestamp` on a log. */
	servesTimestamps?: boolean;
	/** called on every eth_getLogs; return a substitute behaviour to simulate a node's limits */
	onGetLogs?: (range: {
		fromBlock: number;
		toBlock: number;
		call: number;
	}) => {kind: 'error'; error: any} | {kind: 'truncate'; upTo: number} | undefined;
};

function makeChain(options: ChainOptions) {
	const calls: {method: string; params?: any}[] = [];
	const ranges: {fromBlock: number; toBlock: number}[] = [];
	let getLogsCalls = 0;
	const state = {
		latestBlock: options.latestBlock,
		chainId: options.chainId ?? '1',
		logsPerBlock: options.logsPerBlock ?? {},
	};

	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			calls.push({method: args.method, params: args.params});
			switch (args.method) {
				case 'eth_chainId':
					return `0x${parseInt(state.chainId, 10).toString(16)}`;
				case 'eth_blockNumber':
					return `0x${state.latestBlock.toString(16)}`;
				case 'eth_getBlockByHash': {
					const hash = args.params[0] as string;
					const timestamp = options.blockTimestamps?.[hash];
					if (timestamp === undefined) throw new Error(`unexpected eth_getBlockByHash for ${hash}`);
					return {hash, timestamp: `0x${timestamp.toString(16)}`};
				}
				case 'eth_getLogs': {
					getLogsCalls++;
					const filter = args.params[0];
					const fromBlock = parseInt(filter.fromBlock.slice(2), 16);
					const toBlock = parseInt(filter.toBlock.slice(2), 16);
					ranges.push({fromBlock, toBlock});
					const behaviour = options.onGetLogs?.({fromBlock, toBlock, call: getLogsCalls});
					if (behaviour?.kind === 'error') {
						throw behaviour.error;
					}
					const upTo = behaviour?.kind === 'truncate' ? behaviour.upTo : toBlock;
					const result = [];
					for (let block = fromBlock; block <= upTo; block++) {
						result.push(...(state.logsPerBlock[block] ?? []));
					}
					if (options.servesTimestamps === false) {
						return result.map(({blockTimestamp: _blockTimestamp, ...log}) => log);
					}
					return result;
				}
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	};

	return {provider: provider as any, calls, ranges, state};
}

/**
 * A receiver, as the fetcher sees it, whose cursor moves the way the real one
 * does.
 *
 * It re-implements nothing about reorgs -- there is nothing to re-implement,
 * because the fetcher never sends any -- and it records every batch, so that a
 * test can assert what CROSSED rather than what the fetcher believed.
 */
function fakeReceiver(options: {expectedFromBlock: number; context: WireContext; finality?: number}) {
	const finality = options.finality ?? FINALITY;
	const received: WireBatch<Abi>[] = [];
	const asks: number[] = [];
	let expected = options.expectedFromBlock;
	let sends = 0;

	const target: IngestionTarget = {
		async expectedFromBlock() {
			asks.push(expected);
			return {expectedFromBlock: expected, context: options.context};
		},
		async send(batch): Promise<IngestionResponse> {
			sends++;
			if (batch.fromBlock !== expected) {
				return {accepted: false, expectedFromBlock: expected};
			}
			received.push(batch);
			expected = Math.max(Math.min(batch.toBlock + 1, batch.latestBlock - finality), 0);
			return {accepted: true, expectedFromBlock: expected, applied: batch.logs.length, retracted: 0};
		},
	};

	return {
		target,
		received,
		asks,
		get sends() {
			return sends;
		},
		get expected() {
			return expected;
		},
		set expected(value: number) {
			expected = value;
		},
	};
}

function fetcherOn(
	provider: any,
	target: IngestionTarget,
	config: ConstructorParameters<typeof LogFetcher<TestABI>>[3] = {},
) {
	return new LogFetcher<TestABI>(provider, SOURCE, target, {
		stream: {finality: FINALITY},
		// no waiting in tests: the policy is asserted by counting attempts
		retry: {wait: async () => {}},
		...config,
	});
}

const CONTEXT: WireContext = {
	source: [{startBlock: 0, hash: simple_hash(SOURCE)}],
	config: simple_hash({finality: FINALITY}),
};

// ---------------------------------------------------------------------------

describe('a fetch cycle', () => {
	it('asks the receiver where to start, and pushes the range it names', async () => {
		const chain = makeChain({
			latestBlock: 110,
			logsPerBlock: {101: [rawLog(101, '0xa101', 1)], 104: [rawLog(104, '0xa104', 2)]},
		});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});
		const fetcher = fetcherOn(chain.provider, receiver.target);

		const outcome = await fetcher.fetchAndPush();

		expect(receiver.asks).toEqual([START_BLOCK]);
		expect(outcome).toMatchObject({status: 'pushed', fromBlock: 100, toBlock: 110, latestBlock: 110, logs: 2});
		expect(receiver.received).toHaveLength(1);
		expect(receiver.received[0].logs.map((l: any) => l.blockNumber)).toEqual([101, 104]);
	});

	it('decodes the events it ships, since the receiver holds no decoder of its own', async () => {
		const chain = makeChain({latestBlock: 110, logsPerBlock: {101: [rawLog(101, '0xa101', 7, 0, CONTRACT)]}});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});

		await fetcherOn(chain.provider, receiver.target).fetchAndPush();

		const log = receiver.received[0].logs[0] as any;
		expect(log.eventName).toBe('Transfer');
		expect(log.args.id).toBe(7n);
		// the original bytes ride along too: ADR-0006's stored stream will want them
		expect(log.data).toBe(padded('7'));
		expect(log.topics).toHaveLength(3);
	});

	it('says up-to-date rather than inventing a range when the cursor is above the tip', async () => {
		const chain = makeChain({latestBlock: 100});
		const receiver = fakeReceiver({expectedFromBlock: 150, context: CONTEXT});

		const outcome = await fetcherOn(chain.provider, receiver.target).fetchAndPush();

		expect(outcome).toEqual({status: 'up-to-date', expectedFromBlock: 150, latestBlock: 100});
		expect(receiver.received).toHaveLength(0);
	});

	it('re-fetches the unconfirmed window every round, because that is how the receiver sees a reorg', async () => {
		const chain = makeChain({latestBlock: 110, logsPerBlock: {104: [rawLog(104, '0xa104', 1)]}});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});
		const fetcher = fetcherOn(chain.provider, receiver.target);

		await fetcher.fetchAndPush();
		chain.state.latestBlock = 115;
		await fetcher.fetchAndPush();

		// 110 - finality(3) = 107, NOT 111: the window is re-delivered, not skipped
		expect(receiver.received.map((b) => [b.fromBlock, b.toBlock])).toEqual([
			[100, 110],
			[107, 115],
		]);
	});
});

describe('the fetcher holds no cursor of its own', () => {
	it('asks once and then follows what the receiver hands back', async () => {
		const chain = makeChain({latestBlock: 110});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});
		const fetcher = fetcherOn(chain.provider, receiver.target);

		await fetcher.fetchAndPush();
		chain.state.latestBlock = 120;
		await fetcher.fetchAndPush();

		// one ask, ever: the acknowledgement carries the next cursor, so a second
		// round-trip would be asking for a number it was just told
		expect(receiver.asks).toEqual([START_BLOCK]);
		expect(receiver.received.map((b) => b.fromBlock)).toEqual([100, 107]);
	});

	it('resumes correctly after a restart with nothing carried over', async () => {
		const chain = makeChain({latestBlock: 110});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});

		await fetcherOn(chain.provider, receiver.target).fetchAndPush();

		// a brand new instance: this is a process restart, and it holds nothing
		chain.state.latestBlock = 120;
		const restarted = fetcherOn(chain.provider, receiver.target);
		expect(restarted.cursorHint).toBeUndefined();
		const outcome = await restarted.fetchAndPush();

		expect(outcome).toMatchObject({status: 'pushed', fromBlock: 107, corrections: 0});
		expect(receiver.asks).toEqual([START_BLOCK, 107]);
	});

	it('takes a 409 as a correction, not an error, and re-sends from the block named', async () => {
		const chain = makeChain({latestBlock: 110, logsPerBlock: {108: [rawLog(108, '0xa108', 1)]}});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});
		const fetcher = fetcherOn(chain.provider, receiver.target);

		// somebody else pushed while this fetcher was holding a stale hint
		await fetcher.fetchAndPush();
		receiver.expected = 105;
		chain.state.latestBlock = 112;

		const outcome = await fetcher.fetchAndPush();

		expect(outcome).toMatchObject({status: 'pushed', fromBlock: 105, corrections: 1});
		// the refused batch left nothing behind: only the corrected one was accepted
		expect(receiver.received.map((b) => b.fromBlock)).toEqual([100, 105]);
		// and no operator was involved: no ask, just the 409
		expect(receiver.asks).toEqual([START_BLOCK]);
	});

	it('yields to another sender rather than spinning when corrections never settle', async () => {
		const chain = makeChain({latestBlock: 110});
		// a receiver whose cursor moves under us on every send: two fetchers racing,
		// so every correction is stale by the time it is acted on
		let expected = START_BLOCK;
		const moving: IngestionTarget = {
			async expectedFromBlock() {
				return {expectedFromBlock: expected, context: CONTEXT};
			},
			async send() {
				expected++;
				return {accepted: false, expectedFromBlock: expected};
			},
		};

		const outcome = await fetcherOn(chain.provider, moving, {maxCorrectionsPerCycle: 2}).fetchAndPush();

		// it reports what it DID (gave up after N corrections), not a diagnosis of the
		// other side it has no way to make
		expect(outcome).toMatchObject({status: 'yielded', corrections: 3});
	});

	it('drops its hint when a push fails, so the next cycle asks instead of guessing', async () => {
		const chain = makeChain({latestBlock: 110});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});
		let failing = true;
		const flaky: IngestionTarget = {
			expectedFromBlock: receiver.target.expectedFromBlock,
			async send(batch) {
				if (failing) throw new IngestionUnavailableError('the server is restarting', 503);
				return receiver.target.send(batch);
			},
		};
		const fetcher = fetcherOn(chain.provider, flaky, {retry: {attempts: 2, wait: async () => {}}});

		await expect(fetcher.fetchAndPush()).rejects.toBeInstanceOf(IngestionUnavailableError);
		expect(fetcher.cursorHint).toBeUndefined();

		// the batch may in fact have been applied before the acknowledgement was lost,
		// so the honest next move is to ask, and the receiver decides
		failing = false;
		await fetcher.fetchAndPush();
		expect(receiver.asks).toEqual([START_BLOCK, START_BLOCK]);
	});
});

describe('a partial range is never pushed', () => {
	it('lowers toBlock when the provider announces a result cap, and pushes the whole of what is left', async () => {
		const capError = Object.assign(
			new Error('query returned more than 10000 results. Try with this block range [0x64, 0x69].'),
			{
				code: -32005,
			},
		);
		const logsPerBlock: {[block: number]: any[]} = {};
		for (let block = 100; block <= 130; block++) {
			logsPerBlock[block] = [rawLog(block, `0x${block.toString(16)}`, block)];
		}
		const chain = makeChain({
			latestBlock: 130,
			logsPerBlock,
			onGetLogs: ({toBlock}) => (toBlock > 105 ? {kind: 'error', error: capError} : undefined),
		});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});

		const outcome = await fetcherOn(chain.provider, receiver.target).fetchAndPush();

		expect(outcome).toMatchObject({status: 'pushed', fromBlock: 100});
		const batch = receiver.received[0];
		// the range SHRANK...
		expect(batch.toBlock).toBeLessThan(130);
		expect(batch.latestBlock).toBe(130);
		// ...and holds every log the chain has in the range it claims. This is the
		// invariant the receiver cannot check for itself and reads a gap in as a reorg.
		const expectedBlocks = [];
		for (let block = batch.fromBlock; block <= batch.toBlock; block++) expectedBlocks.push(block);
		expect(batch.logs.map((l: any) => l.blockNumber)).toEqual(expectedBlocks);
	});

	it('treats a silent truncation as suspect rather than as an answer, and shrinks until it is believable', async () => {
		// The dangerous provider: no error, just exactly the cap back. A fetcher that
		// believed it would deliver a range missing everything above `upTo`.
		const CAP = 5;
		const logsPerBlock: {[block: number]: any[]} = {};
		for (let block = 100; block <= 130; block++) {
			logsPerBlock[block] = [rawLog(block, `0x${block.toString(16)}`, block)];
		}
		const chain = makeChain({
			latestBlock: 130,
			logsPerBlock,
			onGetLogs: ({fromBlock, toBlock}) =>
				toBlock - fromBlock + 1 > CAP ? {kind: 'truncate', upTo: fromBlock + CAP - 1} : undefined,
		});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});

		const outcome = await fetcherOn(chain.provider, receiver.target, {suspectResultCount: CAP}).fetchAndPush();

		expect(outcome.status).toBe('pushed');
		const batch = receiver.received[0];
		expect(batch.logs.length).toBeLessThan(CAP);
		const expectedBlocks = [];
		for (let block = batch.fromBlock; block <= batch.toBlock; block++) expectedBlocks.push(block);
		expect(batch.logs.map((l: any) => l.blockNumber)).toEqual(expectedBlocks);
	});

	it('refuses to push at all when a single block still lands exactly on the cap', async () => {
		// nothing left to halve, and no way to tell a complete answer from a capped
		// one. Stopping is the only move that cannot delete state.
		const CAP = 4;
		const chain = makeChain({
			latestBlock: 130,
			logsPerBlock: {
				100: [
					rawLog(100, '0xa100', 1, 0),
					rawLog(100, '0xa100', 2, 1),
					rawLog(100, '0xa100', 3, 2),
					rawLog(100, '0xa100', 4, 3),
				],
			},
			onGetLogs: ({fromBlock, toBlock}) => (toBlock > fromBlock ? {kind: 'truncate', upTo: fromBlock} : undefined),
		});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});

		await expect(
			fetcherOn(chain.provider, receiver.target, {suspectResultCount: CAP}).fetchAndPush(),
		).rejects.toBeInstanceOf(SuspectedTruncationError);

		expect(receiver.received).toHaveLength(0);
		expect(receiver.sends).toBe(0);
	});
});

describe('no reorg information crosses the wire', () => {
	it('re-delivers the replaced blocks as raw logs and leaves the conclusion to the receiver', async () => {
		// block 108 is inside the unconfirmed window the next round re-scans
		// (tip 110 - finality 3 = 107), which is the only reason a reorg there is ever seen
		const chain = makeChain({latestBlock: 110, logsPerBlock: {108: [rawLog(108, '0xa108', 1)]}});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});
		const fetcher = fetcherOn(chain.provider, receiver.target);

		await fetcher.fetchAndPush();
		// the chain reorgs: block 108 now has a different hash and a different log
		chain.state.logsPerBlock[108] = [rawLog(108, '0xb108', 9)];
		chain.state.latestBlock = 112;
		await fetcher.fetchAndPush();

		const second = receiver.received[1];
		expect(second.logs.map((l: any) => l.blockHash)).toEqual(['0xb108']);
		// nothing marked removed, and no window: the envelope has five keys and no more
		expect(second.logs.every((l: any) => l.removed === false)).toBe(true);
		expect(Object.keys(second).sort()).toEqual(['context', 'fromBlock', 'latestBlock', 'logs', 'toBlock']);
		expect((second as any).unconfirmedBlocks).toBeUndefined();
	});
});

describe('the two refusal families are told apart', () => {
	it('surfaces a 400-family refusal immediately instead of retrying it', async () => {
		const chain = makeChain({latestBlock: 110});
		let attempts = 0;
		const refusing: IngestionTarget = {
			async expectedFromBlock() {
				return {expectedFromBlock: START_BLOCK, context: CONTEXT};
			},
			async send() {
				attempts++;
				throw new IngestionRefusedError(400, 'context-mismatch', 'this batch is for another {source, config}');
			},
		};

		await expect(fetcherOn(chain.provider, refusing).fetchAndPush()).rejects.toBeInstanceOf(IngestionRefusedError);
		// exactly once: no block number makes it right, so retrying is a busy loop
		// against a server that will never accept it
		expect(attempts).toBe(1);
	});

	it('retries an unavailable receiver with backoff and gives up after a bounded number of attempts', async () => {
		const chain = makeChain({latestBlock: 110});
		const waits: number[] = [];
		let attempts = 0;
		const down: IngestionTarget = {
			async expectedFromBlock() {
				return {expectedFromBlock: START_BLOCK, context: CONTEXT};
			},
			async send() {
				attempts++;
				throw new IngestionUnavailableError('bad gateway', 502);
			},
		};

		await expect(
			fetcherOn(chain.provider, down, {
				retry: {
					attempts: 3,
					initialDelayMs: 10,
					wait: async (ms) => {
						waits.push(ms);
					},
				},
			}).fetchAndPush(),
		).rejects.toBeInstanceOf(IngestionUnavailableError);

		expect(attempts).toBe(3);
		expect(waits).toEqual([10, 20]);
	});

	it('retries a transient provider failure and then succeeds', async () => {
		let failures = 0;
		const chain = makeChain({
			latestBlock: 110,
			logsPerBlock: {101: [rawLog(101, '0xa101', 1)]},
			onGetLogs: () => {
				if (failures < 2) {
					failures++;
					return {kind: 'error', error: Object.assign(new Error('socket hang up'), {code: -32000})};
				}
				return undefined;
			},
		});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});

		const outcome = await fetcherOn(chain.provider, receiver.target).fetchAndPush();

		expect(outcome.status).toBe('pushed');
		expect(receiver.received[0].logs).toHaveLength(1);
	});

	it('surfaces a provider that never recovers, after a bounded number of attempts, having backed off between them', async () => {
		const chain = makeChain({
			latestBlock: 110,
			onGetLogs: () => ({kind: 'error', error: new Error('the node is gone')}),
		});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});
		const waits: number[] = [];

		await expect(
			fetcherOn(chain.provider, receiver.target, {
				retry: {
					attempts: 3,
					initialDelayMs: 10,
					wait: async (ms) => {
						waits.push(ms);
					},
				},
				fetch: {numRetry: 1},
			}).fetchAndPush(),
		).rejects.toThrow(/the node is gone/);
		// the PROVIDER path backs off too, not only the receiver path: same policy,
		// asserted on both sides of the cycle rather than assumed to be shared
		expect(waits).toEqual([10, 20]);
		expect(receiver.sends).toBe(0);
	});

	it('does not retry a deterministic failure of its own, whatever its shape', async () => {
		// the classifier reads the error's own `retryable`, so a refusal added to
		// errors.ts cannot be silently retried by a list that forgot about it
		const chain = makeChain({latestBlock: 110});
		const waits: number[] = [];
		let asks = 0;
		const broken: IngestionTarget = {
			async expectedFromBlock() {
				asks++;
				throw new SuspectedTruncationError(100, 10000);
			},
			async send() {
				throw new Error('never reached');
			},
		};

		await expect(
			fetcherOn(chain.provider, broken, {
				retry: {
					attempts: 4,
					wait: async (ms) => {
						waits.push(ms);
					},
				},
			}).fetchAndPush(),
		).rejects.toBeInstanceOf(SuspectedTruncationError);
		expect(asks).toBe(1);
		expect(waits).toEqual([]);
	});
});

describe('what only this side can check', () => {
	it('refuses to fetch from a provider serving another chain', async () => {
		const chain = makeChain({latestBlock: 110, chainId: '137'});
		const receiver = fakeReceiver({expectedFromBlock: START_BLOCK, context: CONTEXT});

		await expect(fetcherOn(chain.provider, receiver.target).fetchAndPush()).rejects.toBeInstanceOf(
			UnexpectedChainError,
		);
		expect(receiver.sends).toBe(0);
	});

	it('refuses a receiver that indexes something else, before fetching a single log', async () => {
		const chain = makeChain({latestBlock: 110});
		const foreign = fakeReceiver({
			expectedFromBlock: START_BLOCK,
			context: {source: CONTEXT.source, config: 'someone-elses'},
		});

		await expect(fetcherOn(chain.provider, foreign.target).fetchAndPush()).rejects.toBeInstanceOf(
			WireContextMismatchError,
		);
		expect(chain.calls.filter((c) => c.method === 'eth_getLogs')).toHaveLength(0);
	});

	it('pays for the timestamps its stream config promises, since the receiver cannot', async () => {
		const chain = makeChain({
			latestBlock: 110,
			logsPerBlock: {101: [rawLog(101, '0xa101', 1)]},
			// the node the fallback exists for: it predates the change, so the timestamp
			// comes back from `eth_getBlockByHash` or not at all
			servesTimestamps: false,
			blockTimestamps: {'0xa101': 1_700_000_000},
		});
		// the receiver runs the SAME stream config, so the identity matches
		const withTimestamps = {finality: FINALITY, alwaysFetchTimestamps: true};
		const receiver = fakeReceiver({
			expectedFromBlock: START_BLOCK,
			context: {source: CONTEXT.source, config: simple_hash(withTimestamps)},
		});
		const fetcher = new LogFetcher<TestABI>(chain.provider, SOURCE, receiver.target, {
			stream: withTimestamps,
			retry: {wait: async () => {}},
		});

		await fetcher.fetchAndPush();

		expect((receiver.received[0].logs[0] as any).blockTimestamp).toBe(1_700_000_000);
		// and the identity reflects the config it is honouring, so a receiver
		// configured without it refuses the batch rather than storing events that
		// silently lack a field
		expect(fetcher.context.config).toBe(simple_hash(withTimestamps));
		expect(fetcher.context.config).not.toBe(CONTEXT.config);
	});
});

describe('the HTTP transport, on the answers a server should not give', () => {
	// the round-trip test covers what a CORRECT server answers; these are the ones
	// that only appear when something else is on the other end of the URL
	function clientOver(answer: {status: number; body?: unknown; text?: string}) {
		const calls: string[] = [];
		const target = createHttpIngestion({
			endpoint: 'http://indexer.test/',
			// the NAMED INDEXER, which is a ROUTE SEGMENT and never a field in the batch:
			// the envelope asserted below is unchanged by it
			indexer: 'alpha',
			token: 'the-secret',
			fetch: (url) => {
				calls.push(url);
				return new Response(answer.text ?? JSON.stringify(answer.body ?? {}), {status: answer.status});
			},
		});
		return {target, calls};
	}

	const batch = {
		context: CONTEXT,
		fromBlock: 100,
		toBlock: 110,
		latestBlock: 110,
		logs: [],
	} as unknown as WireBatch<Abi>;

	it('refuses an ACCEPTANCE that does not say where the next batch starts', async () => {
		// the sender caches this number and reports it: taken unchecked, an undefined
		// here would surface as a wrong cursor somewhere else entirely
		const {target} = clientOver({status: 200, body: {success: true, applied: 2}});
		await expect(target.send(batch)).rejects.toBeInstanceOf(IngestionRefusedError);
	});

	it('refuses a 409 that names no block, since there is nothing to re-send from', async () => {
		const {target} = clientOver({status: 409, body: {success: false, error: 'unexpected-fromBlock'}});
		await expect(target.send(batch)).rejects.toBeInstanceOf(IngestionRefusedError);
	});

	it('reads a 409 that does name one as a correction rather than an error', async () => {
		const {target} = clientOver({status: 409, body: {success: false, expectedFromBlock: 107}});
		await expect(target.send(batch)).resolves.toEqual({accepted: false, expectedFromBlock: 107});
	});

	it('treats a 5xx as retryable and a 4xx as not, which is the whole retry policy', async () => {
		const down = clientOver({status: 502, text: '<html>bad gateway</html>'});
		const refused = clientOver({status: 400, body: {error: 'invalid-batch', message: 'nope'}});

		await expect(down.target.send(batch)).rejects.toMatchObject({retryable: true});
		await expect(refused.target.send(batch)).rejects.toMatchObject({retryable: false});
	});

	it('never puts the token in what an operator reads', async () => {
		const {target} = clientOver({status: 401, body: {error: 'unauthorized', message: 'expected a bearer token'}});
		const failure = await target.send(batch).catch((err) => err);
		expect(failure.message).not.toContain('the-secret');
		expect(failure.status).toBe(401);
	});

	it('asks the POST route, not a GET, because answering it can write', async () => {
		const {target, calls} = clientOver({
			status: 200,
			body: {success: true, contexts: [{context: CONTEXT, expectedFromBlock: 100}]},
		});
		await target.expectedFromBlock(CONTEXT);
		// namespaced on the indexer NAME, and the trailing slash on the endpoint did
		// not become a double slash
		expect(calls).toEqual(['http://indexer.test/alpha/ingest/expected-from-block']);
	});

	it('picks ITS OWN entry out of the contexts a name serves, and refuses one that holds none', async () => {
		// a receiver holding SEVERAL live wire contexts answers one pair per context;
		// the sender knows which of them it is and takes that one
		const another: WireContext = {source: CONTEXT.source, config: 'someone-elses'};
		const {target} = clientOver({
			status: 200,
			body: {
				success: true,
				contexts: [
					{context: another, expectedFromBlock: 900},
					{context: CONTEXT, expectedFromBlock: 100},
				],
			},
		});
		await expect(target.expectedFromBlock(CONTEXT)).resolves.toEqual({expectedFromBlock: 100, context: CONTEXT});

		// and a list with no entry for this sender is a MISCONFIGURATION, refused at
		// once rather than retried: no block number makes it right
		const {target: elsewhere} = clientOver({
			status: 200,
			body: {success: true, contexts: [{context: another, expectedFromBlock: 900}]},
		});
		const refusal = await elsewhere.expectedFromBlock(CONTEXT).catch((err) => err);
		expect(refusal).toBeInstanceOf(IngestionRefusedError);
		expect(refusal.retryable).toBe(false);
		expect(refusal.code).toBe('context-mismatch');
	});

	it('refuses an answer that carries no contexts list at all', async () => {
		// the shape a pre-widening server answered with. Taken unchecked, `undefined`
		// would be cached as this sender's whole idea of where it is next time
		const {target} = clientOver({status: 200, body: {success: true, expectedFromBlock: 100}});
		await expect(target.expectedFromBlock(CONTEXT)).rejects.toBeInstanceOf(IngestionRefusedError);
	});

	it('refuses to be built without a name, rather than posting to a path that addresses nobody', () => {
		// a host registers the names it was built with and defaults none (ADR-0036), so
		// a sender with no name has nothing to address and is refused where the
		// deployment is configured rather than at the first push
		expect(() =>
			createHttpIngestion({
				endpoint: 'http://indexer.test',
				indexer: '  ',
				token: 'the-secret',
				fetch: () => new Response(),
			}),
		).toThrow(/never defaulted/);
	});

	it('posts to the name it was given, escaping it into the one segment the server matches', async () => {
		const calls: string[] = [];
		const target = createHttpIngestion({
			endpoint: 'http://indexer.test',
			indexer: 'a name/with a slash',
			token: 'the-secret',
			fetch: (url) => {
				calls.push(url);
				return new Response(JSON.stringify({success: true, contexts: [{context: CONTEXT, expectedFromBlock: 100}]}), {
					status: 200,
				});
			},
		});
		await target.expectedFromBlock(CONTEXT);
		expect(calls).toEqual(['http://indexer.test/a%20name%2Fwith%20a%20slash/ingest/expected-from-block']);
	});
});

/**
 * Two acceptance criteria of `agnostic-log-fetcher` are properties of the SOURCE
 * rather than of any run: it names no host, and it holds no cursor, no
 * unconfirmed window and no reorg logic. Both are the kind of thing that stays
 * true right up until somebody adds a convenience, and neither fails a
 * behavioural test when it stops being true -- a fetcher that quietly persisted
 * a cursor would pass every test above.
 *
 * So they are read off the files, in the same spirit as the server's
 * `platformAgnostic.test.ts`.
 */
describe('the sending side names no host and keeps no state', () => {
	const here = fileURLToPath(new URL('.', import.meta.url));
	// every module on the SENDING path, not only the two written for it: the shared
	// ones are as able to hold a cursor or name a runtime as the new ones, and the
	// criterion is about what a fetcher deployment runs
	const sources = [
		'../src/logFetcher.ts',
		'../src/ingestClient.ts',
		'../src/directIngestion.ts',
		'../src/internal/utils/retry.ts',
		'../src/internal/engine/enrich.ts',
		'../src/internal/engine/RangeLogFetcher.ts',
	].map((path) => ({
		path,
		// COMMENTS STRIPPED, because what is asserted is what the code DOES. These
		// files explain at length why the cursor and the reorg derivation live on the
		// other side, and a scan that matched prose would forbid the very sentences
		// that make the boundary reviewable.
		text: readFileSync(`${here}${path}`, 'utf-8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:])\/\/.*$/gm, '$1'),
	}));

	it('reads the files it claims to be checking, and still has code left after stripping comments', () => {
		expect(sources.every((source) => source.text.length > 500)).toBe(true);
		expect(sources.every((source) => source.text.includes('export'))).toBe(true);
	});

	for (const {pattern, why} of [
		{pattern: /from ['"]node:/, why: 'a Node built-in'},
		{pattern: /from ['"]@cloudflare\//, why: 'a Cloudflare type package'},
		{pattern: /\bsetInterval\b/, why: "a scheduler (WHEN a cycle runs is the host adapter's business)"},
		{pattern: /\blocalStorage\b|\bindexedDB\b|\bwriteFile\b/, why: 'a place to persist a cursor'},
		{pattern: /generateStreamToAppend|unconfirmedBlocks/, why: 'reorg derivation, which belongs to the receiver'},
		{pattern: /\blastSync\b|\bgetFromBlock\b|\bLastSync\b/, why: 'the cursor itself, which the receiver owns'},
	]) {
		it(`names no ${why}`, () => {
			expect(sources.filter((source) => pattern.test(source.text)).map((source) => source.path)).toEqual([]);
		});
	}

	it('marks no log as removed, anywhere on the sending path', () => {
		// the receiver REFUSES a batch containing one, and a sender that shipped
		// retractions would be holding the reorg logic ADR-0004 puts on one side only
		expect(sources.filter((source) => /removed:\s*true/.test(source.text))).toEqual([]);
	});
});
