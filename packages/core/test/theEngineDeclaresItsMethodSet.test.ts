import type {Abi} from 'abitype';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';
import {IndexerGeneration} from '../src/indexer.js';
import {LogFetcher, type IngestionResponse, type IngestionTarget} from '../src/logFetcher.js';
import {
	declaredMethodsOnly,
	ENGINE_PROVIDER_METHODS,
	isEngineProviderMethod,
	UnexpectedProviderMethodError,
	type MethodDeclaringProvider,
} from '../src/providerSurface.js';
import {StreamBuilder} from '../src/streamBuilder.js';
import type {EventProcessor, IndexingSource, LastSync, LogEvent, WireBatch, WireContext} from '../src/types.js';

// ---------------------------------------------------------------------------
// THE ENGINE DECLARES ITS METHOD SET, AND THIS HOLDS IT TO IT
// ---------------------------------------------------------------------------
// Deleting the enrichment path made ADR-0073's sentence TRUE. Nothing in a
// deletion keeps it true: a future change adding one `eth_getBlockByHash` back
// breaks nothing, returns the right answer, and costs a round trip per block
// against a provider a browser user is rate-limited on (ADR-0002). It would be
// found by a profiler months later, and a test double that happened to answer
// the method would have let it through in the meantime.
//
// So the guard is not a unit test of one function. It is a SUBSET assertion at
// the seam every call goes through -- the engine holds its provider behind
// `declaredMethodsOnly`, which records the method and refuses anything outside
// `ENGINE_PROVIDER_METHODS`. That is what makes it bite across the WHOLE suite:
// a reintroduced call fails wherever it is added, including in the many tests
// here whose provider double would have answered it, rather than only where
// somebody thought to look.
//
// Four things are pinned:
//
//   1. RECORDING -- the wrapper reports what was asked for, and what a real
//      cycle asks for in BOTH deployment shapes of ADR-0003 is a subset of the
//      declared set.
//   2. REFUSAL -- an undeclared method is refused AT the engine's own provider
//      handle, over a node that would happily have answered it; and the one
//      declared method that can read a block is held to the genesis probe,
//      because a block read at a HEIGHT is the per-block cost wearing a
//      different method name.
//   3. ZERO -- the receiving half makes no chain call at all. It has nowhere to
//      put a provider, which is stronger than a count of zero.
//   4. THE CLAIM -- the READMEs name exactly the declared set, so widening the
//      set is a documented act rather than a quiet one.
//
// The list itself lives in ONE place, `ENGINE_PROVIDER_METHODS`, and this file
// deliberately does not restate it: a test carrying its own copy is a second
// source of truth, and the README check below is what pins the content.
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
const GENESIS_HASH = '0x00000000000000000000000000000000000000000000000000000000000genesis'.slice(
	0,
	66,
) as `0x${string}`;

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

const LOGS = [rawLog(101, '0xaaa', 1_700_000_000), rawLog(102, '0xbbb', 1_700_000_012)];

/**
 * A node that answers EVERYTHING, including the calls the engine must not make.
 *
 * Deliberately permissive, and that is the whole design of this fixture: a
 * double that threw on an unknown method would be asserting the guard's job for
 * it, and would pass just as happily with no guard in place. Here a
 * reintroduced call would SUCCEED at the node, so anything that stops it is the
 * wrapper.
 */
function anAccommodatingNode() {
	const answered: string[] = [];
	const provider = {
		async request(args: {method: string; params?: unknown}): Promise<unknown> {
			answered.push(args.method);
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_blockNumber':
					return `0x${LATEST_BLOCK.toString(16)}`;
				case 'eth_getLogs':
					return LOGS;
				case 'eth_getBlockByNumber':
				case 'eth_getBlockByHash':
					return {hash: GENESIS_HASH, timestamp: '0x1', number: '0x0'};
				default:
					return null;
			}
		},
	};
	return {provider: provider as never, answered};
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

function aProcessor(): EventProcessor<TestABI, undefined> {
	return {
		getVersionHash: () => 'proc',
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async () => undefined,
		reset: async () => {},
		clear: async () => {},
	} as unknown as EventProcessor<TestABI, undefined>;
}

function makeIndexer(provider: never, source: IndexingSource<TestABI> = SOURCE) {
	return new IndexerGeneration<TestABI>(provider, aProcessor() as never, source, {stream: {finality: 12}});
}

/** The engine's OWN provider handle: the guarded one, which is what every call inside goes through. */
function providerHeldBy(indexer: unknown): MethodDeclaringProvider {
	return (indexer as {provider: MethodDeclaringProvider}).provider;
}

/** A receiver that records what it was handed, so a fetch cycle can be driven to completion. */
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

/** Every method the engine asked for that the declared set does not cover. */
function undeclared(requested: ReadonlySet<string>): string[] {
	return [...requested].filter((method) => !isEngineProviderMethod(method));
}

describe('what the engine asks for is a subset of what it declares', () => {
	it('records the single-process cycle, and the record is inside the declared set', async () => {
		const {provider} = anAccommodatingNode();
		const indexer = makeIndexer(provider);
		await indexer.load();
		await indexer.indexMore();

		const requested = providerHeldBy(indexer).methodsRequested;
		// THE assertion: a subset, not a list this file keeps its own copy of.
		expect(undeclared(requested)).toEqual([]);
		// and it is not vacuous -- a cycle really did talk to the node
		expect(requested.has('eth_getLogs')).toBe(true);
		expect(requested.has('eth_blockNumber')).toBe(true);
		expect(requested.has('eth_chainId')).toBe(true);
	});

	it('records the genesis probe as the identity read it is, once, at load', async () => {
		const {provider} = anAccommodatingNode();
		const indexer = makeIndexer(provider, {...SOURCE, genesisHash: GENESIS_HASH});
		await indexer.load();

		const requested = providerHeldBy(indexer).methodsRequested;
		expect(undeclared(requested)).toEqual([]);
		// the fourth method is DECLARED rather than exempted, and this is the one
		// caller of it: a source that declares a `genesisHash` gets it checked
		expect(requested.has('eth_getBlockByNumber')).toBe(true);
	});

	it('records the split log-fetcher, where every chain call in a split deployment is', async () => {
		const {provider} = anAccommodatingNode();
		const target = recordingTarget();
		const fetcher = new LogFetcher<TestABI>(provider, SOURCE, target, {stream: {finality: 12}});

		const outcome = await fetcher.fetchAndPush();

		expect(outcome.status).toBe('pushed');
		const requested = (fetcher as unknown as {provider: MethodDeclaringProvider}).provider.methodsRequested;
		expect(undeclared(requested)).toEqual([]);
		expect(requested.has('eth_getLogs')).toBe(true);
	});
});

describe('a reintroduced per-block call is refused where it is added', () => {
	it('refuses `eth_getBlockByHash` at the provider handle the engine holds, over a node that would have answered it', async () => {
		const {provider, answered} = anAccommodatingNode();
		const indexer = makeIndexer(provider);
		await indexer.load();

		// This is what tomorrow's enrichment path would do: reach the provider the
		// engine holds and ask for the block a log names. The node underneath answers
		// that method (see `anAccommodatingNode`), so nothing but the wrapper stops it.
		const reintroduced = providerHeldBy(indexer).request({
			method: 'eth_getBlockByHash',
			params: ['0xaaa', false],
		} as never);

		await expect(reintroduced).rejects.toBeInstanceOf(UnexpectedProviderMethodError);
		await expect(reintroduced).rejects.toThrow(/eth_getBlockByHash/);
		// and it never reached the node
		expect(answered).not.toContain('eth_getBlockByHash');
		// the attempt IS recorded, because what the engine asked for is the fact a
		// reader of this record wants, refused or not
		expect(providerHeldBy(indexer).methodsRequested.has('eth_getBlockByHash')).toBe(true);
	});

	it('holds the block read to the genesis probe, because a height is a per-block cost', async () => {
		const {provider} = anAccommodatingNode();
		const guarded = declaredMethodsOnly(provider);

		// the identity read: one fixed question, once per load. BOTH spellings of the
		// chain's first block, because `the-genesis-check-asks-for-block-zero-not-the-earliest-tag`
		// replaces the tag with the number and that fix must not have to edit this guard.
		await expect(
			guarded.request({method: 'eth_getBlockByNumber', params: ['earliest', false]} as never),
		).resolves.toBeTruthy();
		await expect(
			guarded.request({method: 'eth_getBlockByNumber', params: ['0x0', false]} as never),
		).resolves.toBeTruthy();

		// the same METHOD at a height is the deleted enrichment path under another
		// name, and the declared set would not catch it on the name alone
		await expect(
			guarded.request({method: 'eth_getBlockByNumber', params: ['0x65', false]} as never),
		).rejects.toBeInstanceOf(UnexpectedProviderMethodError);
	});

	it('wraps a guarded provider once, so a reconfigure does not stack guards', () => {
		const {provider} = anAccommodatingNode();
		const guarded = declaredMethodsOnly(provider);
		expect(declaredMethodsOnly(guarded)).toBe(guarded);
	});
});

describe('the receiving half of a split deployment makes zero chain calls', () => {
	it('has nowhere to put a provider, and folds a whole batch without one', async () => {
		// ZERO by construction rather than by counting: there is no parameter to
		// hand a node to, so the receiving half cannot make a call to get wrong.
		function refusal() {
			// @ts-expect-error the receiving half is chain-free: there is no provider to give it
			return new StreamBuilder<TestABI>(aProcessor() as never, SOURCE, {stream: {finality: 12}, provider: {}});
		}
		expect(typeof refusal).toBe('function');

		const processed: LogEvent<TestABI>[][] = [];
		const processor = {
			...aProcessor(),
			process: async (eventStream: LogEvent<TestABI>[]) => {
				processed.push(eventStream);
				return undefined;
			},
		};
		const builder = new StreamBuilder<TestABI>(processor as never, SOURCE, {stream: {finality: 12}});

		// A node the receiver could reach for if it had anywhere to keep one. It is
		// never handed over, and its record stays empty: the timestamps that crossed
		// the wire are the only ones this half will ever have (ADR-0003).
		const {provider} = anAccommodatingNode();
		const unusedNode = declaredMethodsOnly(provider);

		const outcome = await builder.receive({
			context: builder.context,
			fromBlock: START_BLOCK,
			toBlock: 105,
			latestBlock: LATEST_BLOCK,
			logs: [],
		});

		// the fold ran: a receiver advances its cursor over a range it was handed,
		// having asked nobody anything
		expect(processed.length).toBeGreaterThan(0);
		expect(outcome.expectedFromBlock).toBeGreaterThan(START_BLOCK);
		expect([...unusedNode.methodsRequested]).toEqual([]);
	});
});

describe('the README states the declared set, exactly', () => {
	// The claim is the reason the set exists, so a set that widened without the
	// claim widening is a README asserting something false. Both directions are
	// checked, which is what makes "quietly declare a fifth method to make a test
	// pass" impossible: the fifth has to be written down where a user reads it.
	const READMES = ['../README.md', '../../../README.md'];

	for (const readme of READMES) {
		it(`names every declared method and no other, in ${readme}`, () => {
			const text = readFileSync(fileURLToPath(new URL(readme, import.meta.url)), 'utf-8');
			const claim = providerSurfaceClaimIn(text, readme);
			const named = new Set(claim.match(/eth_[A-Za-z]+/g) ?? []);
			expect([...named].sort()).toEqual([...ENGINE_PROVIDER_METHODS].sort());
		});
	}
});

/**
 * The paragraph a README makes its provider-surface claim in.
 *
 * Anchored by an HTML comment rather than located by searching for method names,
 * so the check is against the SENTENCE somebody wrote on purpose: prose
 * elsewhere in the file is free, and the anchor tells the next editor that this
 * paragraph is held to the code.
 */
function providerSurfaceClaimIn(text: string, where: string): string {
	const anchor = text.indexOf('<!-- provider-surface:');
	if (anchor === -1) {
		throw new Error(
			`${where} carries no provider-surface anchor: the claim ADR-0073 makes checkable has been removed rather than updated`,
		);
	}
	const afterAnchor = text.slice(text.indexOf('-->', anchor) + 3);
	const claim = afterAnchor.split(/\n\s*\n/).find((paragraph) => paragraph.trim().length > 0);
	if (!claim) {
		throw new Error(`${where} has a provider-surface anchor with no claim under it`);
	}
	return claim;
}
