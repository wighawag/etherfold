import type {Abi} from 'abitype';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';
import {IndexerGeneration} from '../src/indexer.js';
import {LogFetcher, type IngestionResponse, type IngestionTarget} from '../src/logFetcher.js';
import type {IndexingSource, LastSync, LogEvent, WireBatch, WireContext} from '../src/types.js';

// ---------------------------------------------------------------------------
// NO BLOCK TIMESTAMP IS EVER FETCHED, BY ANY CONFIGURATION, IN EITHER SHAPE
// ---------------------------------------------------------------------------
// `alwaysFetchTimestamps` and the whole `enrichEvents` path under it are
// DELETED (ADR-0073). Unlike the transaction half this is a SWAP rather than a
// removal: the time axis survives, unconditionally and for free, because the
// node puts `blockTimestamp` on the log (`execution-apis#639`, and
// `@nomicfoundation/edr >= 0.20.0` closed the last holdout). What went is the
// machinery that compensated for its absence at one `eth_getBlockByHash` per
// event-bearing block, issued in a `for` loop unless the provider advertised
// `eth_batch`, at a cost the operator did not choose.
//
// Three properties are pinned, and they fail differently:
//
//   1. RUNTIME -- neither deployment shape of ADR-0003 makes a per-block call,
//      and both still deliver the timestamp. Both are asserted, because the
//      stream config is hashed into the wire identity and the two shapes must
//      honour it identically; the receiving half makes no chain call at all, so
//      a timestamp it was not handed is a timestamp nothing can recover.
//   2. TYPE -- the fallback is GONE rather than defaulted off, which
//      `aTimestamplessLogIsRefusedAtTheFetchBoundary.test.ts` states with a
//      `@ts-expect-error` on `ProvidedStreamConfig`.
//   3. STRUCTURAL -- no source file in the package names the deleted machinery
//      or asks a node about a block. That covers the shape someone adds
//      tomorrow: a per-block cost reappears as a vague slowdown rather than as
//      a failure, so a test double that answered the method would let it back
//      in unnoticed.
//
// What must NOT go with it is the READING path: `parseLogBlockTimestamp`, its
// hex/decimal tolerance, and `blockTimestamp?: number` staying optional on the
// event type. `blockTimestampFromLog.test.ts` holds that line.
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

/** A raw `eth_getLogs` result, in the JSON-RPC shape a node really returns. */
function rawLog(blockNumber: number, blockHash: string, blockTimestamp: number) {
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
		blockTimestamp: `0x${blockTimestamp.toString(16)}`,
	};
}

/**
 * A node that answers the three calls the engine is allowed to make and THROWS
 * on anything else.
 *
 * Throwing rather than answering is the point: a surviving block fetch that was
 * merely never asserted on would pass a test that only counted the calls it
 * recognised, and here it fails loudly, naming the method.
 */
function makeNode(logs: ReturnType<typeof rawLog>[]) {
	const calls: string[] = [];
	const provider = {
		async request(args: {method: string; params?: unknown}): Promise<unknown> {
			calls.push(args.method);
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
	return {provider: provider as never, calls};
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

function makeIndexer(provider: never) {
	const processor = {
		getVersionHash: () => 'proc',
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async () => undefined,
		reset: async () => {},
		clear: async () => {},
	};
	return new IndexerGeneration<TestABI>(provider, processor as never, SOURCE, {stream: {finality: 12}});
}

/** A receiver that records what it was handed, so the pushed events are checkable. */
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

const LOGS = [rawLog(101, '0xaaa', 1_700_000_000), rawLog(102, '0xbbb', 1_700_000_012)];

describe('the single-process indexer fetches no block data', () => {
	it('reads the timestamps off the logs, making only the log call', async () => {
		const {provider, calls} = makeNode(LOGS);
		const indexer = makeIndexer(provider);

		const {eventStream} = await (
			indexer as unknown as {
				fetchLogsFromProvider(
					lastSync: LastSync<TestABI>,
					uc: typeof passThrough,
				): Promise<{eventStream: LogEvent<TestABI>[]}>;
			}
		).fetchLogsFromProvider(freshLastSync(), passThrough);

		// the SWAP, not a removal: the axis is still populated, and for free
		expect(eventStream.map((event) => event.blockTimestamp)).toEqual([1_700_000_000, 1_700_000_012]);
		expect([...new Set(calls)].filter((method) => method !== 'eth_blockNumber')).toEqual(['eth_getLogs']);
	});
});

describe('the split log-fetcher fetches no block data either', () => {
	it('pushes the range having made only the log call, with the timestamps on the logs', async () => {
		const {provider, calls} = makeNode(LOGS);
		const target = recordingTarget();
		const fetcher = new LogFetcher<TestABI>(provider, SOURCE, target, {stream: {finality: 12}});

		const outcome = await fetcher.fetchAndPush();

		expect(outcome.status).toBe('pushed');
		expect([...new Set(calls)].filter((method) => method !== 'eth_blockNumber')).toEqual([
			'eth_chainId',
			'eth_getLogs',
		]);
		// the receiving half makes no chain call at all (ADR-0003), so what crossed
		// the wire is the only timestamp it will ever have
		expect(target.pushed[0].logs.map((log) => (log as {blockTimestamp?: number}).blockTimestamp)).toEqual([
			1_700_000_000, 1_700_000_012,
		]);
	});
});

describe('the enrichment path is deleted rather than left standing with no caller', () => {
	it('leaves no per-block call and none of its machinery anywhere in the package', () => {
		// The ENGINE's whole chain-facing surface is `eth_getLogs` for data,
		// `eth_blockNumber` for the tip and `eth_chainId` for the identity guard. A
		// fetcher kept alive with no caller would still be an `eth_getBlockByHash`
		// call site in a published package, and the next person to need a timestamp
		// would wire it back up rather than notice it was deleted on purpose. The
		// timestamp CACHE goes with it, in both spellings: it existed only to stop the
		// re-scanned reorg window being re-fetched, and a field that arrives on the log
		// costs nothing to have again.
		const root = fileURLToPath(new URL('../src/', import.meta.url));
		const offenders = filesUnder(root).filter((file) =>
			/eth_getBlockByHash|eth_batch|enrichEvents|blockFetcherFor|[Bb]lockTimestampCache|alwaysFetchTimestamps/.test(
				readFileSync(file, 'utf-8'),
			),
		);
		expect(offenders.map((file) => file.slice(root.length))).toEqual([]);
	});
});

/** Every `.ts` under a directory, in a stable order. */
function filesUnder(directory: string): string[] {
	return readdirSync(directory, {withFileTypes: true})
		.sort((a, b) => (a.name < b.name ? -1 : 1))
		.flatMap((entry) =>
			entry.isDirectory()
				? filesUnder(join(directory, entry.name, '/'))
				: entry.name.endsWith('.ts')
					? [join(directory, entry.name)]
					: [],
		);
}
