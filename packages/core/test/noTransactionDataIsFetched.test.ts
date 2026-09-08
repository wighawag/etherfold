import type {Abi} from 'abitype';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';
import {IndexerGeneration} from '../src/indexer.js';
import {LogFetcher, type IngestionResponse, type IngestionTarget} from '../src/logFetcher.js';
import type {IndexingSource, LastSync, LogEvent, ProvidedStreamConfig, WireBatch, WireContext} from '../src/types.js';

// ---------------------------------------------------------------------------
// NO TRANSACTION DATA IS EVER FETCHED, BY ANY CONFIGURATION, IN EITHER SHAPE
// ---------------------------------------------------------------------------
// `alwaysFetchTransactions` and the `transaction` field it populated are
// DELETED, and there is no replacement (ADR-0073). `from`, `gasUsed` and
// `effectiveGasPrice` are not on a log, no standard proposes putting them
// there, so this was never a fallback awaiting obsolescence: it was a permanent
// second data source, one request per transaction, of exactly the kind the
// README's Caveats tell a processor author not to need.
//
// Two properties are pinned, and they fail differently:
//
//   1. RUNTIME -- neither deployment shape of ADR-0003 makes a per-transaction
//      call. Both are asserted, because the stream config is hashed into the
//      wire identity and the two shapes must honour it identically; a fetcher
//      that quietly kept the calls would cost one round trip per transaction on
//      every range, silently.
//   2. TYPE -- the capability is GONE rather than defaulted off. A flag that
//      still type-checks is a flag someone sets, and a `transaction?` field on
//      the processor-facing event is a field a processor reads and finds
//      undefined for ever. `pnpm typecheck` is what runs that half: each
//      `@ts-expect-error` below FAILS it if the line it guards starts
//      compiling.
//
// The timestamp half of the enrichment is deliberately NOT covered here: it is
// still standing and a later task in this spec removes it.
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
 * Throwing rather than answering is the point: a surviving transaction fetch
 * that was merely never asserted on would pass a test that only counted calls
 * it recognised, and here it fails loudly, naming the method.
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

describe('the single-process indexer fetches no transaction data', () => {
	it('reads logs and nothing per-transaction, and puts no `transaction` on an event', async () => {
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

		expect(eventStream).toHaveLength(2);
		expect([...new Set(calls)].filter((method) => method !== 'eth_blockNumber')).toEqual(['eth_getLogs']);
		// asserted on the KEYS: a `toEqual` against an object ignores an
		// undefined-valued property, so it would pass on an event that still carried
		// the field set to undefined
		for (const event of eventStream) {
			expect(Object.keys(event)).not.toContain('transaction');
		}
	});
});

describe('the split log-fetcher fetches no transaction data either', () => {
	it('pushes the range having made only the log call, and the pushed logs carry no `transaction`', async () => {
		const {provider, calls} = makeNode(LOGS);
		const target = recordingTarget();
		const fetcher = new LogFetcher<TestABI>(provider, SOURCE, target, {stream: {finality: 12}});

		const outcome = await fetcher.fetchAndPush();

		expect(outcome.status).toBe('pushed');
		expect([...new Set(calls)].filter((method) => method !== 'eth_blockNumber')).toEqual([
			'eth_chainId',
			'eth_getLogs',
		]);
		for (const log of target.pushed[0].logs) {
			expect(Object.keys(log)).not.toContain('transaction');
		}
	});
});

describe('the capability is DELETED rather than defaulted off', () => {
	it('has no stream-config flag and no event field, which is what the TYPES say', () => {
		// Deliberately never CALLED: the assertions here are the `@ts-expect-error`
		// comments, and vitest strips types, so running the body would prove nothing.
		function refusals(event: LogEvent<TestABI>) {
			// @ts-expect-error `alwaysFetchTransactions` is GONE from the stream config, with no alias behind it
			const flag: ProvidedStreamConfig = {finality: 12, alwaysFetchTransactions: true};
			// @ts-expect-error and `transaction` is gone from the event a processor sees, with no stub in its place
			const field = event.transaction;
			return [flag, field];
		}
		expect(typeof refusals).toBe('function');
	});

	it('leaves no per-transaction call anywhere in the package', () => {
		// The runtime tests above cover the two shapes that exist TODAY. This one
		// covers the shape someone adds tomorrow: the ENGINE's whole chain-facing
		// surface is `eth_getLogs` for data, `eth_blockNumber` for the tip and
		// `eth_chainId` for the identity guard, and no source file may ask a node
		// about a transaction at all.
		const root = fileURLToPath(new URL('../src/', import.meta.url));
		const offenders = filesUnder(root).filter((file) =>
			/eth_getTransaction|transactionFetcherFor|LogTransactionData|alwaysFetchTransactions/.test(
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
