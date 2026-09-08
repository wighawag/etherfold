import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {GenesisBlockNotServedError, GenesisCheckUnavailableError, GenesisHashMismatchError} from '../src/errors.js';
import {IndexerGeneration} from '../src/indexer.js';
import type {EventProcessor, IndexingSource} from '../src/types.js';

// ---------------------------------------------------------------------------
// THE GENESIS CHECK ASKS FOR BLOCK 0, NOT THE `earliest` TAG
// ---------------------------------------------------------------------------
// The load path verifies chain identity twice: `eth_chainId`, and then -- when
// the source declares one -- the GENESIS HASH, which is the stronger of the two
// because two chains can share a chain id and cannot share a genesis block.
//
// It used to ask for the block tag `earliest`, which is not genesis: the tag
// means the lowest block the CLIENT HAS. A pruned node and a chain that has had
// a regenesis both answer it with a real block whose hash is not the genesis
// hash, so the check refused to start against a healthy node on the RIGHT
// chain, saying it was connected to a DIFFERENT one. That is what the first
// test here pins, with a node that answers the two spellings differently.
//
// The rest pin the separation the fix rests on: a wrong chain, a node that will
// not serve the block, and a request that never completed are THREE conditions
// with three different remedies (fix your configuration, point at a node that
// has genesis or skip the check, wait and retry), so none of them may be
// reported in another's wording.
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
const START_BLOCK = 100;

const GENESIS_HASH = `0x${'11'.repeat(32)}` as const;
/** What a pruned node's LOWEST BLOCK hashes to: a real block, and not genesis. */
const PRUNED_FROM_HASH = `0x${'22'.repeat(32)}` as const;
/** What a node on another chain answers block 0 with. */
const OTHER_CHAIN_GENESIS_HASH = `0x${'33'.repeat(32)}` as const;

const SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: CONTRACT, startBlock: START_BLOCK}],
	genesisHash: GENESIS_HASH,
};

type BlockAnswer = {hash: string} | null;

/**
 * A node that answers the two spellings of "the bottom of the chain"
 * DIFFERENTLY, which is the whole point: on a node that has genesis they agree
 * and no test could tell the two questions apart.
 */
function aNode(answers: {earliest: BlockAnswer | (() => never); zero: BlockAnswer | (() => never)}) {
	const asked: unknown[] = [];
	const provider = {
		async request(args: {method: string; params?: unknown}): Promise<unknown> {
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_blockNumber':
					return '0xc8';
				case 'eth_getLogs':
					return [];
				case 'eth_getBlockByNumber': {
					const tag = (args.params as [string, boolean])[0];
					asked.push(tag);
					const answer = tag === 'earliest' ? answers.earliest : answers.zero;
					return typeof answer === 'function' ? answer() : answer;
				}
				default:
					return null;
			}
		},
	};
	return {provider: provider as never, asked};
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

/**
 * The error a refused load rejected with, typed, so the assertions below read
 * its FIELDS rather than only its prose.
 */
async function refusalFrom<E>(load: Promise<unknown>): Promise<E> {
	return load.then(
		() => {
			throw new Error('the load resolved, and this case must be refused');
		},
		(error: unknown) => error as E,
	);
}

function anIndexer(provider: never, config: {skipGenesisCheck?: boolean} = {}) {
	return new IndexerGeneration<TestABI>(provider, aProcessor() as never, SOURCE, {
		stream: {finality: 12},
		...config,
	});
}

describe('a node whose lowest available block is not genesis', () => {
	it('loads, because the check asks for block 0 and not for what the node happens to keep', async () => {
		// A pruned node, or a chain that has had a regenesis: `earliest` is the
		// bottom of THIS NODE'S history, `0x0` is the bottom of the CHAIN.
		const {provider, asked} = aNode({earliest: {hash: PRUNED_FROM_HASH}, zero: {hash: GENESIS_HASH}});

		await expect(anIndexer(provider).load()).resolves.toBeTruthy();

		// and it asked the only question that means genesis
		expect(asked).toEqual(['0x0']);
	});
});

describe('a genuine genesis mismatch still refuses', () => {
	it('names both the expected hash and the received one', async () => {
		const {provider} = aNode({earliest: {hash: GENESIS_HASH}, zero: {hash: OTHER_CHAIN_GENESIS_HASH}});

		const load = anIndexer(provider).load();

		await expect(load).rejects.toBeInstanceOf(GenesisHashMismatchError);
		const error = await refusalFrom<GenesisHashMismatchError>(load);
		expect(error.expectedGenesisHash).toBe(GENESIS_HASH);
		expect(error.receivedGenesisHash).toBe(OTHER_CHAIN_GENESIS_HASH);
		expect(error.message).toContain(GENESIS_HASH);
		expect(error.message).toContain(OTHER_CHAIN_GENESIS_HASH);
		// no amount of waiting moves a node onto another chain
		expect(error.retryable).toBe(false);
	});
});

describe('a node that will not serve block 0 says the check could not be MADE', () => {
	it('is not reported as a wrong chain', async () => {
		const {provider} = aNode({earliest: {hash: PRUNED_FROM_HASH}, zero: null});

		const load = anIndexer(provider).load();

		await expect(load).rejects.toBeInstanceOf(GenesisBlockNotServedError);
		const error = await refusalFrom<GenesisBlockNotServedError>(load);
		// the distinction the whole task turns on: this is an availability fact
		// about the NODE, and borrowing the mismatch's wording is what sent an
		// operator hunting for a configuration error that was not there
		expect(error.message).not.toMatch(/different chain|another chain|wrong chain/i);
		expect(error.message).toMatch(/skipGenesisCheck/);
		// and it is a MISMATCH to nobody: the two are different classes
		expect(error).not.toBeInstanceOf(GenesisHashMismatchError);
	});
});

describe('a request that fails outright is not a verdict about the chain', () => {
	it('is retryable, carries what the node said, and is neither of the other two', async () => {
		const rpcFailure = new Error('429 rate limited');
		const {provider} = aNode({
			earliest: {hash: GENESIS_HASH},
			zero: () => {
				throw rpcFailure;
			},
		});

		const load = anIndexer(provider).load();

		await expect(load).rejects.toBeInstanceOf(GenesisCheckUnavailableError);
		const error = await refusalFrom<GenesisCheckUnavailableError>(load);
		expect(error).not.toBeInstanceOf(GenesisHashMismatchError);
		expect(error).not.toBeInstanceOf(GenesisBlockNotServedError);
		// a flaky endpoint at startup is the common case, and a caller waits it out
		expect(error.retryable).toBe(true);
		expect(error.cause).toBe(rpcFailure);
		expect(error.message).not.toMatch(/different chain|another chain|wrong chain/i);
		expect(error.message).toContain('429 rate limited');
	});
});

describe('the escape hatch', () => {
	it('asks the node nothing at all when `skipGenesisCheck` is set', async () => {
		const {provider, asked} = aNode({earliest: {hash: PRUNED_FROM_HASH}, zero: {hash: OTHER_CHAIN_GENESIS_HASH}});

		await expect(anIndexer(provider, {skipGenesisCheck: true}).load()).resolves.toBeTruthy();

		expect(asked).toEqual([]);
	});
});
