import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {UnexpectedChainError} from '../src/errors.js';
import {IndexerGeneration} from '../src/indexer.js';
import {ADDRESS, fakeChain, fakeProcessor, FINALITY, makeLog, SOURCE, START_BLOCK} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// A CHAIN-IDENTITY REFUSAL NAMES THE CHAIN IT EXPECTED AND THE ONE IT GOT
// ---------------------------------------------------------------------------
// One condition -- this provider is not on the chain this source indexes -- is
// detected at five points across the two deployment shapes, and ADR-0081 has
// them converge on ONE refusal type so that an operator reads one refusal
// rather than a spelling per call site. The engine's three used to be bare
// `Error`s nobody could catch by type, and the per-cycle one said only "chainId
// changed after fetch", which does not say which chain anything is on.
//
// Two of the engine's three are pinned here: the LOAD path, which asks before a
// single log is fetched, and the RECONFIGURE path, which compares a newly
// supplied provider against the previous context. The third, the per-cycle
// check after the fetch, is pinned where the guard's other properties are, in
// `follower.test.ts` ("a provider that changes chain mid-cycle").
//
// What is asserted is the TYPE and the presence of BOTH ids, never the
// sentence, so the wording can improve without a test rewrite. The one clause
// that IS asserted is a negative: the fetcher's "nothing is pushed, the
// receiver makes no chain calls" is a claim about a receiver, and the engine
// has none -- a refusal that asserts consequences its own path does not have is
// the thing this file exists to stop coming back.
// ---------------------------------------------------------------------------

/** A source on chain 1, as every fixture in the engine suite indexes. */
const SOURCE_ON_CHAIN_1 = SOURCE;
/** The same source, declared against a chain no provider here serves. */
const SOURCE_ON_CHAIN_137: typeof SOURCE = {
	...SOURCE,
	chainId: '137',
};

const TIP = 1000;
const LOGS = [makeLog(100, '0xa100')];

/** A provider that answers every method the engine may ask, on the chain given. */
function providerOnChain(chainIdAsHex: string, tip = TIP) {
	return {
		async request(args: {method: string; params?: unknown}): Promise<unknown> {
			switch (args.method) {
				case 'eth_chainId':
					return chainIdAsHex;
				case 'eth_blockNumber':
					return `0x${tip.toString(16)}`;
				case 'eth_getLogs':
					return [];
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as never;
}

/** The refusal a rejected call carried, or `undefined` if it did not refuse at all. */
function refusalFrom(call: Promise<unknown>): Promise<any> {
	return call.then(
		() => undefined,
		(error) => error,
	);
}

function indexerOn(provider: ReturnType<typeof providerOnChain>, source = SOURCE_ON_CHAIN_1) {
	const processor = fakeProcessor();
	const indexer = new IndexerGeneration<Abi, string[]>(provider, processor.processor, source, {
		stream: {finality: FINALITY},
	});
	return {indexer, processor};
}

/** What the fetcher path says and the engine paths may not: there is no receiver here. */
function expectsNoClaimAboutAReceiver(message: string) {
	expect(message).not.toMatch(/receiver/i);
	expect(message).not.toMatch(/pushed/i);
}

describe('the LOAD path, handed a provider on the wrong chain from the start', () => {
	it('refuses by TYPE, naming the chain the source indexes and the chain that answered', async () => {
		const {indexer} = indexerOn(providerOnChain('0x89'));

		const error = await refusalFrom(indexer.load());

		expect(error).toBeInstanceOf(UnexpectedChainError);
		expect(error).toMatchObject({expectedChainId: '1', actualChainId: '137', retryable: false});
		// both sides of the mismatch are in the sentence too, so the refusal is
		// actionable from a log line with no debugger attached
		expect(error.message).toMatch(/\b1\b/);
		expect(error.message).toMatch(/\b137\b/);
	});

	it('claims nothing about a receiver, because the in-process engine has none', async () => {
		const {indexer} = indexerOn(providerOnChain('0x89'));

		const error = await refusalFrom(indexer.load());

		expectsNoClaimAboutAReceiver(error.message);
		// what it says instead is what an operator on THIS path can act on
		expect(error.message).toMatch(/load/i);
	});

	it('still loads when the provider is on the chain the source names', async () => {
		// not vacuous: the same harness, one digit apart, gets through the check
		const {indexer} = indexerOn(providerOnChain('0x1'));

		await expect(indexer.load()).resolves.toBeTruthy();
	});
});

describe('the RECONFIGURE path, handed a provider on a different chain', () => {
	/** Loaded and indexed on chain 1, which is what the new provider is compared against. */
	async function loadedOnChain1() {
		const chain = fakeChain(LOGS, TIP);
		const processor = fakeProcessor();
		const indexer = new IndexerGeneration<Abi, string[]>(chain.provider, processor.processor, SOURCE_ON_CHAIN_1, {
			stream: {finality: FINALITY},
		});
		(indexer as any).logEventFetcher = chain.fetcher;
		await indexer.load();
		return {indexer, processor, chain};
	}

	it('refuses by TYPE, naming the previous context\u2019s chain and the new provider\u2019s', async () => {
		const {indexer} = await loadedOnChain1();

		const error = await refusalFrom(indexer.updateIndexer({provider: providerOnChain('0x89')}));

		expect(error).toBeInstanceOf(UnexpectedChainError);
		expect(error).toMatchObject({expectedChainId: '1', actualChainId: '137', retryable: false});
		expect(error.message).toMatch(/\b1\b/);
		expect(error.message).toMatch(/\b137\b/);
	});

	it('claims nothing about a receiver either, and says what a caller can do instead', async () => {
		const {indexer} = await loadedOnChain1();

		const error = await refusalFrom(indexer.updateIndexer({provider: providerOnChain('0x89')}));

		expectsNoClaimAboutAReceiver(error.message);
		// the remedy the old prose carried, kept: a provider on another chain needs a
		// source for that chain, and passing one is what resets the state
		expect(error.message).toMatch(/source/i);
	});

	it('accepts a new provider on the SAME chain', async () => {
		const {indexer} = await loadedOnChain1();

		await expect(indexer.updateIndexer({provider: providerOnChain('0x1')})).resolves.toMatchObject({
			stateDiscarded: false,
		});
	});

	it('does not ask the question at all when the new source resets the indexer anyway', async () => {
		// The check guards a CONTINUATION: a reconfigure whose source is invalid over
		// what is already indexed discards that state, so a provider on another chain
		// is exactly what the caller is telling the indexer about.
		const {indexer} = await loadedOnChain1();

		const outcome = await indexer.updateIndexer({
			provider: providerOnChain('0x89'),
			source: {
				...SOURCE_ON_CHAIN_137,
				contracts: [{abi: [] as unknown as Abi, address: ADDRESS, startBlock: START_BLOCK - 1}],
			},
		});

		expect(outcome.stateDiscarded).toBe(true);
	});
});

describe('the fetcher path keeps the message it had', () => {
	it('still says nothing is pushed and why the receiver could not catch it', () => {
		// The other side of the same type: this deployment DOES have a receiver, and
		// the clause is true there. `@etherfold/fetcher-host` classifies refusals by
		// `retryable` read structurally, so the per-path wording cannot move a
		// refusal from one side of that classification to the other -- but the
		// constructor is public API and this pins that it takes what it always took.
		const error = new UnexpectedChainError('1', '137', 'after');

		expect(error.message).toContain('checked after fetching');
		expect(error.message).toContain('the receiver makes no chain calls');
		expect(error.retryable).toBe(false);
		expect(new UnexpectedChainError('1', '137', 'before').message).toContain('checked before fetching');
	});
});
