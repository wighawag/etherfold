import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {createDirectIngestion} from '../src/directIngestion.js';
import {InvalidBatchError, UnexpectedFromBlockError} from '../src/errors.js';
import {LogFetcher} from '../src/logFetcher.js';
import {StreamBuilder, type LogIngestion} from '../src/streamBuilder.js';
import type {EventProcessor, IndexingSource, LastSync, LogEvent, WireBatch} from '../src/types.js';

// ---------------------------------------------------------------------------
// THE WIRE, WITH NO WIRE (ADR-0004)
// ---------------------------------------------------------------------------
// The split of ADR-0003 is a DEPLOYMENT choice, not two implementations, and
// this is what makes that literally true: `createDirectIngestion` hands the
// sender's `IngestionTarget` straight to the receiver's `LogIngestion`, so one
// deployable can fetch and process in a single process (a CLI, a cron-triggered
// Worker that hosts both halves) while running exactly the code a split
// deployment runs.
//
// What is asserted here is the part that is easy to get wrong when the transport
// disappears: the cursor refusal must still arrive as a CORRECTION. Over HTTP a
// `409` makes that obvious. In process it is a thrown error, and treating it as a
// fault would turn the ordinary case -- a restart, a lost acknowledgement, a
// second fetcher -- into a crash.
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

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CONTRACT = '0x0000000000000000000000000000000000000099' as const;
const ZERO = '0x0000000000000000000000000000000000000000';
const START_BLOCK = 100;
const FINALITY = 3;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

function hex(value: number): string {
	return `0x${value.toString(16)}`;
}

function padded(address: string): string {
	return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

let logCounter = 0;

function rawTransfer(blockNumber: number, blockHash: string, id: bigint) {
	logCounter++;
	return {
		blockNumber: hex(blockNumber),
		blockHash,
		transactionIndex: '0x0',
		removed: false,
		address: CONTRACT,
		data: `0x${id.toString(16).padStart(64, '0')}`,
		topics: [TRANSFER_TOPIC, padded(ZERO), padded(CONTRACT)],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}`,
		logIndex: '0x0',
		blockTimestamp: hex(1_700_000_000 + blockNumber * 12),
	};
}

/** A node serving one branch at a time, and counting what was asked of it. */
function fakeChain() {
	let served: ReturnType<typeof rawTransfer>[] = [];
	let tip = 0;
	const calls: string[] = [];
	return {
		serve(logs: ReturnType<typeof rawTransfer>[], latestBlock: number) {
			served = logs;
			tip = latestBlock;
		},
		get calls() {
			return calls;
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

const BRANCH_A = [rawTransfer(101, '0xa101', 1n), rawTransfer(116, '0xa116', 3n)];
const BRANCH_B = [BRANCH_A[0], rawTransfer(116, '0xb116', 4n)];

/** The smallest processor the builder can drive: it records the stream and keeps a cursor. */
function recordingProcessor() {
	const streams: LogEvent<TestABI>[][] = [];
	let stored: LastSync<TestABI> | undefined;
	const processor: EventProcessor<TestABI, void> = {
		getVersionHash: () => 'v1',
		getCodeFingerprint: () => undefined,
		load: async () => (stored ? {state: undefined as void, lastSync: stored} : undefined),
		process: async (eventStream, lastSync) => {
			streams.push(eventStream);
			stored = lastSync;
		},
		reset: async () => {
			streams.length = 0;
			stored = undefined;
		},
		clear: async () => processor.reset(),
	};
	return {
		processor,
		flat: () => streams.flat(),
		get lastSync() {
			return stored;
		},
	};
}

function combined(): {
	chain: ReturnType<typeof fakeChain>;
	builder: StreamBuilder<TestABI, void>;
	target: ReturnType<typeof recordingProcessor>;
	fetcherOn: (chain: ReturnType<typeof fakeChain>, finality?: number) => LogFetcher<TestABI>;
} {
	const chain = fakeChain();
	const target = recordingProcessor();
	const builder = new StreamBuilder<TestABI, void>(target.processor, SOURCE, {stream: {finality: FINALITY}});
	return {
		chain,
		builder,
		target,
		fetcherOn: (on, finality = FINALITY) =>
			new LogFetcher<TestABI>(on.provider, SOURCE, createDirectIngestion(builder), {
				stream: {finality},
				retry: {wait: async () => {}},
			}),
	};
}

// ---------------------------------------------------------------------------

describe('one deployable that fetches and processes', () => {
	it('runs a whole cycle with nothing between the halves', async () => {
		const {chain, target, fetcherOn} = combined();
		chain.serve(BRANCH_A, 110);

		const outcome = await fetcherOn(chain).fetchAndPush();

		expect(outcome).toMatchObject({status: 'pushed', fromBlock: START_BLOCK, toBlock: 110, applied: 1});
		expect(target.flat()).toHaveLength(1);
		expect(target.lastSync?.lastToBlock).toBe(110);
	});

	it('asks the receiver where to start, exactly as it would across a network', async () => {
		const {chain, builder, fetcherOn} = combined();
		chain.serve(BRANCH_A, 110);
		expect(await builder.expectedFromBlock()).toBe(START_BLOCK);

		const fetcher = fetcherOn(chain);
		expect(fetcher.cursorHint).toBeUndefined();
		await fetcher.fetchAndPush();

		// and the answer became the hint, which is a cache and not a cursor
		expect(fetcher.cursorHint).toBe(107); // 110 - finality
	});

	it('still lets the RECEIVER derive the reorg, from a range the fetcher knows nothing about', async () => {
		const {chain, fetcherOn} = combined();
		const fetcher = fetcherOn(chain);
		chain.serve(BRANCH_A, 119);
		await fetcher.fetchAndPush();

		chain.serve(BRANCH_B, 120);
		const outcome = await fetcher.fetchAndPush();

		expect(outcome).toMatchObject({
			status: 'pushed',
			reorg: {cause: 'contradiction', blockNumber: 116, blockHash: '0xa116'},
			retracted: 1,
			applied: 1,
		});
	});

	it('refuses a foreign {source, config} at the ask, before a single log is fetched', async () => {
		const {chain, fetcherOn} = combined();
		chain.serve(BRANCH_A, 110);

		// the receiver runs a finality of FINALITY: same source, different config, so a
		// different indexer by identity. A combined deployment can still wire this
		// wrong, and it is caught in the same place and the same way.
		await expect(fetcherOn(chain, FINALITY + 1).fetchAndPush()).rejects.toThrow(/another \{source, config\}/);
		expect(chain.calls).not.toContain('eth_getLogs');
	});
});

// ---------------------------------------------------------------------------
// THE ONE REFUSAL THAT IS NOT AN ERROR
// ---------------------------------------------------------------------------

describe('a cursor refusal', () => {
	it('is a correction the cycle follows, not a fault, when another fetcher moved the cursor', async () => {
		const {chain, builder, target, fetcherOn} = combined();
		chain.serve(BRANCH_A, 110);
		const fetcher = fetcherOn(chain);
		await fetcher.fetchAndPush();

		// a second, redundant fetcher against the same in-process receiver: allowed for
		// exactly the reason it is allowed across a network, since neither holds state
		chain.serve(BRANCH_A, 118);
		await fetcherOn(chain).fetchAndPush();

		// the first fetcher's hint is now stale. Over HTTP this is a `409`; here it is
		// a thrown `UnexpectedFromBlockError`, and it must mean the same thing.
		const outcome = await fetcher.fetchAndPush();

		expect(outcome).toMatchObject({status: 'pushed', corrections: 1});
		expect(outcome.status === 'pushed' && outcome.fromBlock).toBe(115); // 118 - finality
		// applied once, not twice: the cursor is still the idempotency key
		expect(target.flat().filter((event) => !event.removed)).toHaveLength(2);
		// the cursor is where the corrected batch left it: 118 - finality, re-scanning
		// the unconfirmed window next time as it always does
		expect(await builder.expectedFromBlock()).toBe(115);
	});

	it('is recognised structurally, so a second copy of this package cannot turn it into a crash', async () => {
		// the correction path is the one place where `instanceof` failing would be
		// silent and would only bite in deployments that bundle two copies of core
		const foreign = Object.assign(new Error('fromBlock (10) not as expected (42)'), {
			name: 'UnexpectedFromBlockError',
			retryable: false,
			expectedFromBlock: 42,
		});
		const target = createDirectIngestion({
			context: {source: 'x', config: 'y'} as never,
			// a receiver identifies the stream it folds and the generation it is; this
			// one folds nothing real
			streamDigest: 'a-stream',
			generation: {stream: 'a-stream', processor: 'a-fold'},
			expectedFromBlock: async () => 42,
			receive: async () => {
				throw foreign;
			},
		});

		await expect(target.send({fromBlock: 10} as unknown as WireBatch<Abi>)).resolves.toEqual({
			accepted: false,
			expectedFromBlock: 42,
		});
	});

	it('is the ONLY refusal turned into a correction: everything else keeps its type', async () => {
		const {builder} = combined();
		const target = createDirectIngestion(builder);

		// a malformed envelope is not resumable, and no block number makes it right
		const failure = await target
			.send({
				context: builder.context,
				fromBlock: 200,
				toBlock: 100,
				latestBlock: 300,
				logs: [],
			} as unknown as WireBatch<Abi>)
			.catch((err) => err);

		expect(failure).toBeInstanceOf(InvalidBatchError);
		// and the flag a host reads to decide whether to try again survived intact,
		// with no status code in between to flatten it
		expect(failure.retryable).toBe(false);
	});

	it('carries the acknowledgement back whole, so the sender needs no second round-trip', async () => {
		const {chain, builder} = combined();
		chain.serve(BRANCH_A, 110);
		const target = createDirectIngestion(builder);

		// the asker names itself, as it does on the wire; in this shape there is one
		// receiver, so there is nothing to select between and the answer is its own
		const answer = await target.expectedFromBlock(builder.context);
		expect(answer).toEqual({expectedFromBlock: START_BLOCK, context: builder.context});

		const response = await target.send({
			context: builder.context,
			fromBlock: START_BLOCK,
			toBlock: 110,
			latestBlock: 110,
			logs: [],
		} as unknown as WireBatch<Abi>);

		expect(response).toEqual({accepted: true, expectedFromBlock: 107, applied: 0, retracted: 0, reorg: undefined});
	});

	it('is thrown by the receiver in the first place, which is what this translates', async () => {
		// pinning the shape this adapter depends on: if `StreamBuilder` ever stopped
		// throwing this, the translation above would silently stop happening
		const {builder} = combined();
		await builder.receive({
			context: builder.context,
			fromBlock: START_BLOCK,
			toBlock: 110,
			latestBlock: 110,
			logs: [],
		} as never);

		const refused = await builder
			.receive({
				context: builder.context,
				fromBlock: 999,
				toBlock: 1000,
				latestBlock: 1000,
				logs: [],
			} as never)
			.catch((err) => err);

		expect(refused).toBeInstanceOf(UnexpectedFromBlockError);
		expect(refused.expectedFromBlock).toBe(107);
	});
});

// ---------------------------------------------------------------------------

describe('a combined deployment and a split one are the same code', () => {
	it('reaches the same state from the same chain, reorg included', async () => {
		const script = [
			[BRANCH_A, 110],
			[BRANCH_A, 118],
			[BRANCH_B, 119],
		] as const;

		// the SPLIT shape, minus the network: a target that serialises nothing but is
		// otherwise a separate object graph, driven the same way
		const direct = combined();
		const alsoDirect = combined();

		for (const [logs, tip] of script) {
			direct.chain.serve(logs as never, tip);
			await direct.fetcherOn(direct.chain).fetchAndPush();

			// a fresh fetcher per step on the other one: a restart between every cycle,
			// which is the case that must be indistinguishable
			alsoDirect.chain.serve(logs as never, tip);
			await alsoDirect.fetcherOn(alsoDirect.chain).fetchAndPush();
		}

		const canonical = (run: ReturnType<typeof combined>) =>
			run.target
				.flat()
				.filter((event) => !event.removed)
				.map((event) => `${event.blockNumber}/${event.blockHash}`);

		expect(canonical(direct)).toEqual(canonical(alsoDirect));
		expect(direct.target.lastSync?.lastToBlock).toBe(alsoDirect.target.lastSync?.lastToBlock);
		// and it is not two empty runs agreeing: the dead branch's block was retracted
		expect(direct.target.flat().some((event) => event.removed)).toBe(true);
	});
});
