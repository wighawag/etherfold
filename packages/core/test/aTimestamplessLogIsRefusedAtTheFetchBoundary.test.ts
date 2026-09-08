import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {TimestamplessLogError} from '../src/errors.js';
import {IndexerGeneration} from '../src/indexer.js';
import {LogFetcher, type IngestionResponse, type IngestionTarget} from '../src/logFetcher.js';
import type {IndexingSource, LastSync, ProvidedStreamConfig, WireBatch, WireContext} from '../src/types.js';

// ---------------------------------------------------------------------------
// A TIMESTAMPLESS LOG IS REFUSED AT THE FETCH BOUNDARY, NAMING THE NODE
// ---------------------------------------------------------------------------
// `blockTimestamp` on the log is `ethereum/execution-apis#639`, served by geth
// >= 1.16.0, reth, besu, erigon, anvil and `@nomicfoundation/edr >= 0.20.0`. A
// node that does not put it there is REFUSED rather than silently compensated
// for at a cost the operator did not choose (ADR-0073).
//
// Three properties are pinned here, and the last two are the ones a refactor is
// likely to break:
//
//   1. the refusal fires ONE ROUND TRIP IN -- on the answer to `eth_getLogs`,
//      before a range is folded, stored or pushed -- and it names the NODE,
//      because every cause is node-level and each has a different fix;
//   2. it is one refusal in BOTH deployment shapes of ADR-0003, the
//      single-process `IndexerGeneration` and the split `LogFetcher`, because
//      the fetcher is the only side of a split that talks to a chain;
//   3. it is UNCONDITIONAL. It was once skipped while `alwaysFetchTimestamps`
//      was set, because the fallback then resolved the timestamp by fetching
//      the block. That flag and the whole enrichment path are DELETED, so there
//      is nothing left to defer to and no configuration that can quiet it.
//
// What it deliberately does NOT do is replace `blockPointer`'s fold-time
// refusal. A stream can reach a fold without passing a fetcher at all (a seed
// install, a fixture replay), so the two guards see different traffic; the
// non-redundancy is pinned in `@etherfold/processor-entities`
// (`the-two-guards-are-not-redundant.test.ts`).
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
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const START_BLOCK = 100;
const LATEST_BLOCK = 200;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
};

function padded(value: string): string {
	return `0x${value.replace(/^0x/, '').padStart(64, '0')}`;
}

/**
 * A raw `eth_getLogs` result, in the JSON-RPC shape a node really returns, with
 * `blockTimestamp` present or absent exactly as the node decides.
 */
function rawLog(blockNumber: number, blockHash: string, blockTimestamp?: number) {
	return {
		blockNumber: `0x${blockNumber.toString(16)}`,
		blockHash,
		transactionIndex: '0x0',
		removed: false,
		address: CONTRACT,
		data: padded('1'),
		topics: [TRANSFER_TOPIC, padded(ZERO), padded(ZERO)],
		transactionHash: padded(`${blockNumber.toString(16)}0`),
		logIndex: '0x0',
		...(blockTimestamp === undefined ? {} : {blockTimestamp: `0x${blockTimestamp.toString(16)}`}),
	};
}

/**
 * A node answering `eth_getLogs` with exactly the logs it was given, and
 * THROWING on anything else.
 *
 * `eth_getBlockByHash` is deliberately not among the answers: the engine has no
 * path that asks for it any more, so a fallback creeping back in fails here by
 * name rather than by passing quietly on a fake that would have answered.
 */
function makeNode(logs: ReturnType<typeof rawLog>[]) {
	const calls: {method: string; params?: any}[] = [];
	const provider = {
		async request(args: {method: string; params?: any}): Promise<any> {
			calls.push({method: args.method, params: args.params});
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_blockNumber':
					return `0x${LATEST_BLOCK.toString(16)}`;
				case 'eth_getLogs':
					return logs;
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	};
	return {provider: provider as any, calls};
}

const passThrough = <T>(p: Promise<T>) => p;

function freshLastSync(): LastSync<TestABI> {
	return {
		context: {source: [{startBlock: START_BLOCK, hash: 'h'}], config: 'cfg', processor: 'proc'},
		latestBlock: 0,
		lastFromBlock: 0,
		lastToBlock: 0,
		unconfirmedBlocks: [],
	};
}

function makeIndexer(provider: any, stream: ProvidedStreamConfig = {}) {
	const processor: any = {
		getVersionHash: () => 'proc',
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async () => undefined,
		reset: async () => {},
		clear: async () => {},
	};
	return new IndexerGeneration<TestABI>(provider, processor, SOURCE, {stream: {finality: 12, ...stream}});
}

/** A receiver that records what it was handed, so "nothing was pushed" is checkable. */
function recordingTarget(): IngestionTarget & {pushed: WireBatch<Abi>[]} {
	const pushed: WireBatch<Abi>[] = [];
	return {
		pushed,
		async expectedFromBlock(_context: WireContext) {
			return {expectedFromBlock: START_BLOCK};
		},
		async send(batch: WireBatch<Abi>): Promise<IngestionResponse> {
			pushed.push(batch);
			return {accepted: true, expectedFromBlock: batch.toBlock + 1, applied: batch.logs.length, retracted: 0};
		},
	};
}

describe('the fetch boundary refuses a log with no readable blockTimestamp', () => {
	it('refuses the fetched range, naming the standard, the minimum EDR and the four causes', async () => {
		const {provider} = makeNode([rawLog(101, '0xaaa'), rawLog(102, '0xbbb')]);
		const indexer = makeIndexer(provider);

		const refusal = await (indexer as any)
			.fetchLogsFromProvider(freshLastSync(), passThrough)
			.then(() => undefined)
			.catch((err: unknown) => err);

		expect(refusal).toBeInstanceOf(TimestamplessLogError);
		const message = (refusal as Error).message;
		// the standard, so the operator can check their node against something
		expect(message).toContain('execution-apis#639');
		// the minimum implementations that serve it, EDR included: the requirement is
		// on the EDR version resolved and never on the Hardhat version (ADR-0073)
		expect(message).toContain('@nomicfoundation/edr >= 0.20.0');
		// the four causes, because they are all node-level and each has its OWN fix,
		// and a message saying only "missing blockTimestamp" sends an operator to the
		// wrong one
		expect(message).toContain('predates');
		expect(message).toContain('override');
		expect(message).toContain('forking');
		expect(message).toContain('rpc_cache');
		// and the block it saw it on, so the claim is checkable against the node
		expect(message).toContain('101');
	});

	it('says waiting will not help, so a fetcher host stops instead of looping', async () => {
		// A node does not grow a `blockTimestamp` while a scheduler waits: the fix is
		// an operator's. `@etherfold/fetcher-host` reads `retryable` STRUCTURALLY to
		// decide `retry` versus `fatal`, and an error without it is retried.
		const {provider} = makeNode([rawLog(101, '0xaaa')]);
		const indexer = makeIndexer(provider);

		const refusal = await (indexer as any)
			.fetchLogsFromProvider(freshLastSync(), passThrough)
			.catch((err: unknown) => err);

		expect((refusal as {retryable: boolean}).retryable).toBe(false);
	});

	it('refuses even when only ONE log of the range is missing one', async () => {
		// A node that supplies the field for some logs and not others is odd, but the
		// stream is only as good as its worst log: one timestampless log is one block
		// that cannot be recorded.
		const {provider} = makeNode([rawLog(101, '0xaaa', 1_700_000_000), rawLog(102, '0xbbb')]);
		const indexer = makeIndexer(provider);

		await expect((indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough)).rejects.toThrow(
			TimestamplessLogError,
		);
	});

	it('refuses a timestamp it cannot READ, exactly as it refuses an absent one', async () => {
		// `parseLogBlockTimestamp` drops anything it cannot read rather than coercing
		// it, so "unreadable" and "absent" arrive here as one outcome -- and neither
		// may become a number, since a wrong timestamp answers confidently about the
		// wrong block for as long as the store lives.
		const {provider} = makeNode([{...rawLog(101, '0xaaa'), blockTimestamp: 'later'} as any]);
		const indexer = makeIndexer(provider);

		await expect((indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough)).rejects.toThrow(
			TimestamplessLogError,
		);
	});

	it('fires UNCONDITIONALLY: no stream config quiets it, not even the deleted flag', async () => {
		// It was once skipped while `alwaysFetchTimestamps` was set, and that condition
		// went with the flag (ADR-0073). The interesting case is a deployment whose
		// config still SPELLS the flag: it is an unrecognised key now, so it buys
		// nothing, and what such an operator must get is the refusal naming their node
		// rather than a silent fallback that no longer exists.
		const legacy = {alwaysFetchTimestamps: true} as unknown as ProvidedStreamConfig;
		for (const stream of [{}, {finality: 0}, legacy] as ProvidedStreamConfig[]) {
			const {provider} = makeNode([rawLog(101, '0xaaa')]);
			const indexer = makeIndexer(provider, stream);

			await expect((indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough)).rejects.toThrow(
				TimestamplessLogError,
			);
		}
	});

	it('has no flag to set: `alwaysFetchTimestamps` is GONE from the stream config', () => {
		// Deliberately never CALLED: the assertion is the `@ts-expect-error`, and
		// vitest strips types, so running the body would prove nothing. `pnpm
		// typecheck` is what runs this half, and it FAILS if the line starts
		// compiling again.
		function refusal() {
			// @ts-expect-error the flag is DELETED, with no alias and no deprecated stub behind it
			const config: ProvidedStreamConfig = {finality: 12, alwaysFetchTimestamps: true};
			return config;
		}
		expect(typeof refusal).toBe('function');
	});

	it('leaves a node that serves the field entirely alone: no new call, no new failure', async () => {
		const {provider, calls} = makeNode([rawLog(101, '0xaaa', 1_700_000_000), rawLog(102, '0xbbb', 1_700_000_012)]);
		const indexer = makeIndexer(provider);

		const {eventStream} = await (indexer as any).fetchLogsFromProvider(freshLastSync(), passThrough);

		expect(eventStream.map((event: any) => event.blockTimestamp)).toEqual([1_700_000_000, 1_700_000_012]);
		expect(calls.map((call) => call.method).filter((method) => method !== 'eth_blockNumber')).toEqual(['eth_getLogs']);
	});
});

describe('the split shape refuses on the same rule', () => {
	it('refuses BEFORE pushing, so the receiver is never handed a range it cannot fold', async () => {
		const {provider} = makeNode([rawLog(101, '0xaaa')]);
		const target = recordingTarget();
		const fetcher = new LogFetcher<TestABI>(provider, SOURCE, target, {stream: {finality: 12}});

		await expect(fetcher.fetchAndPush()).rejects.toThrow(TimestamplessLogError);
		expect(target.pushed).toEqual([]);
	});

	it('pushes as it always did when the node serves the field', async () => {
		const {provider} = makeNode([rawLog(101, '0xaaa', 1_700_000_000)]);
		const target = recordingTarget();
		const fetcher = new LogFetcher<TestABI>(provider, SOURCE, target, {stream: {finality: 12}});

		const outcome = await fetcher.fetchAndPush();

		expect(outcome.status).toBe('pushed');
		expect(target.pushed[0].logs.map((log: any) => log.blockTimestamp)).toEqual([1_700_000_000]);
	});
});
