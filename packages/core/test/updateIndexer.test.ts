import type {Abi} from 'abitype';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {IndexerGeneration} from '../src/indexer.js';
import {resolveStreamConfig, streamConfigHashOf, wireContextOf} from '../src/internal/engine/utils.js';
import type {IndexingSource, ProvidedStreamConfig, StoredLogEvent} from '../src/types.js';
import {simple_hash} from '../src/utils/hash.js';
import {
	ADDRESS,
	fakeChain,
	fakeProcessor,
	indexToTip,
	makeLog,
	memoryStream,
	START_BLOCK,
} from './utils/streamCacheWorld.js';

/**
 * A RECONFIGURE THAT CHANGED NOTHING COSTS NOTHING.
 *
 * The stream config is compared as a HASH, and the hash has to mean ONE thing.
 * `reinit` stored the digest of the RESOLVED config (`resolveStreamConfig` fills
 * `finality`), while `updateIndexer` digested the config exactly as the caller
 * PASSED it -- so a caller who left `finality` unset, which is the ordinary case
 * the resolver exists for, could never produce a matching hash. The verdict then
 * reported `reason: 'stream-config'`, which invalidates the STREAM half from
 * block 0 as well as the state half, so the fold was thrown away and the whole
 * history was re-fetched from the node for a reconfigure that moved nothing.
 *
 * Every claim here is asserted on the ADR-0034 PAIR -- what was DISCARDED and
 * what was RE-FETCHED -- because neither half can be read off the state: a
 * re-index and a resume land on identical rows.
 *
 * Both worlds are driven, and they say different things. WITH a stream cache the
 * re-fetch lands on the CACHE (the stored stream's own context was written
 * resolved, so it still matches), and what the bug costs is the fold: the state
 * is discarded and re-folded, and the published verdict lies. WITHOUT one there
 * is nothing to rebuild from, so the same discard is a full re-fetch from the
 * node -- which is the outage, and the only world where the RANGES can say so.
 */

const transfer = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
	],
} as const;

/** The member a regenerated ABI gains that no log can depend on: it hashes byte-identically. */
const balanceOf = {
	type: 'function',
	name: 'balanceOf',
	stateMutability: 'view',
	inputs: [{name: 'owner', type: 'address'}],
	outputs: [{name: '', type: 'uint256'}],
} as const;

const sourceWith = (abi: readonly unknown[]): IndexingSource<Abi> => ({
	chainId: '1',
	contracts: [{abi: abi as unknown as Abi, address: ADDRESS, startBlock: START_BLOCK}],
});

const SOURCE = sourceWith([transfer]);
/** The same source after a recompilation added a view function. */
const SOURCE_PLUS_VIEW = sourceWith([transfer, balanceOf]);

/**
 * The tip sits well above `START_BLOCK + finality`, which is what makes
 * "nothing was re-fetched" assertable at all: once the cursor is at the tip
 * every honest range starts inside the reorg window, so a range reaching back to
 * the start block can only be a re-index.
 */
const TIP = 1000;

/** Timestamps ride on the logs, so `alwaysFetchTimestamps` costs the fake chain no call. */
const LOGS: StoredLogEvent[] = [makeLog(100, '0xa100'), makeLog(200, '0xa200'), makeLog(900, '0xa900')].map((log) => ({
	...log,
	blockTimestamp: log.blockNumber,
}));

/**
 * `reinit` builds a fresh `LogEventFetcher`, and a reconfigure goes through it,
 * so the recording fake has to be put back on afterwards or the next fetch would
 * go to a provider that answers no `eth_getLogs`.
 */
function attach(indexer: IndexerGeneration<Abi, string[]>, chain: ReturnType<typeof fakeChain>) {
	(indexer as any).logEventFetcher = chain.fetcher;
}

type WorldOptions = {source?: IndexingSource<Abi>; cache?: boolean};

/** Indexed to the tip, with what the reconfigure has to be judged against recorded. */
async function indexedToTip(stream?: ProvidedStreamConfig, options: WorldOptions = {}) {
	const chain = fakeChain(LOGS, TIP);
	const streamCache = memoryStream();
	const processor = fakeProcessor();
	const indexer = new IndexerGeneration<Abi, string[]>(chain.provider, processor.processor, options.source ?? SOURCE, {
		...(stream ? {stream} : {}),
		...(options.cache === false ? {} : {keepStream: streamCache.keeper}),
		streamWriteRetry: {delaySeconds: 0},
	});
	attach(indexer, chain);
	await indexToTip(indexer);
	return {
		chain,
		streamCache,
		processor,
		indexer,
		before: {
			state: [...processor.state],
			ranges: chain.ranges.length,
			clears: streamCache.clears,
			batches: processor.batches.length,
		},
	};
}

/** What a no-op reconfigure must leave alone, on every axis that can move. */
async function expectNothingMoved(w: Awaited<ReturnType<typeof indexedToTip>>) {
	attach(w.indexer, w.chain);
	await indexToTip(w.indexer);

	// the state was not thrown away and re-folded: not one event was delivered to
	// the processor a second time (the empty batches that move the cursor at the
	// tip are ordinary and say nothing)
	for (const batch of w.processor.batches.slice(w.before.batches)) {
		expect(batch).toEqual([]);
	}
	expect(w.processor.state).toEqual(w.before.state);
	// the cached stream is where it was
	expect(w.streamCache.clears).toBe(w.before.clears);
	// and no block already indexed was asked of the node a second time
	for (const range of w.chain.ranges.slice(w.before.ranges)) {
		expect(range.from).toBeGreaterThan(START_BLOCK);
	}
}

describe('a reconfigure passing an EQUIVALENT but unresolved stream config', () => {
	it('discards nothing and re-fetches nothing', async () => {
		const w = await indexedToTip({});

		const outcome = await w.indexer.updateIndexer({streamConfig: {}});

		expect(outcome.stateDiscarded).toBe(false);
		expect(outcome.sourceInvalidation).toEqual({state: {valid: true}, stream: {valid: true}});
		await expectNothingMoved(w);
	});

	it('re-fetches nothing from the NODE either, where there is no cache to rebuild from', async () => {
		// The outage in full: with no stored stream, the discard has nothing to
		// re-fold from, so every block since the start block is asked of the node
		// again.
		const w = await indexedToTip({}, {cache: false});

		const outcome = await w.indexer.updateIndexer({streamConfig: {}});

		expect(outcome.stateDiscarded).toBe(false);
		await expectNothingMoved(w);
	});

	it('is still a no-op when something else about the reconfigure DID change', async () => {
		// The caller is not re-passing an identical object: the source gained a view
		// function (free, ADR-0034) and the config carries a second field. What is
		// compared is the RESOLVED form, not two objects that happen to be equal.
		const w = await indexedToTip({alwaysFetchTimestamps: true});

		const outcome = await w.indexer.updateIndexer({
			source: SOURCE_PLUS_VIEW,
			streamConfig: {alwaysFetchTimestamps: true},
		});

		expect(outcome.stateDiscarded).toBe(false);
		expect(outcome.sourceInvalidation).toEqual({state: {valid: true}, stream: {valid: true}});
		await expectNothingMoved(w);
	});

	it('reads `{finality: 17}` and an unset `finality` as ONE config, in both directions', async () => {
		// exactly as `streamDigestOf` reads them as one STREAM: the default written
		// out and the default left to the resolver are one deployment
		const unset = await indexedToTip({});
		const spelledOut = await indexedToTip({finality: 17});

		expect((await unset.indexer.updateIndexer({streamConfig: {finality: 17}})).stateDiscarded).toBe(false);
		expect((await spelledOut.indexer.updateIndexer({streamConfig: {}})).stateDiscarded).toBe(false);

		await expectNothingMoved(unset);
		await expectNothingMoved(spelledOut);
	});

	it('leaves the persisted context saying what it always said', async () => {
		// The RESOLVED digest, byte for byte what `reinit` has always stored. Pinned
		// as a literal on both persisted cursors because these bytes are ON DISK:
		// nothing here may re-key a stored stream or a stored state.
		const w = await indexedToTip({});
		expect(w.streamCache.cursor?.context.config).toBe('h10lkzm2');
		expect(w.processor.store.saved?.lastSync.context.config).toBe('h10lkzm2');

		await w.indexer.updateIndexer({streamConfig: {}});
		await expectNothingMoved(w);

		expect(w.streamCache.cursor?.context.config).toBe('h10lkzm2');
		expect(w.processor.store.saved?.lastSync.context.config).toBe('h10lkzm2');
	});
});

describe('a reconfigure whose stream config GENUINELY moved', () => {
	for (const [what, streamConfig] of [
		['alwaysFetchTimestamps', {alwaysFetchTimestamps: true}],
		['alwaysFetchTransactions', {alwaysFetchTransactions: true}],
		['parse.filters', {parse: {filters: {Transfer: [[ADDRESS as `0x${string}`]]}}}],
		['an explicitly different finality', {finality: 5}],
	] as [string, ProvidedStreamConfig][]) {
		it(`still invalidates BOTH halves from block 0 (${what})`, async () => {
			const w = await indexedToTip({});

			const outcome = await w.indexer.updateIndexer({streamConfig});

			const bothHalves = {valid: false, invalidFromBlock: 0, reason: 'stream-config'};
			expect(outcome.sourceInvalidation).toEqual({state: bothHalves, stream: bothHalves});
			expect(outcome.stateDiscarded).toBe(true);
		});
	}

	it('clears the cached stream and re-fetches from the start block', async () => {
		const w = await indexedToTip({});

		await w.indexer.updateIndexer({streamConfig: {alwaysFetchTimestamps: true}});
		attach(w.indexer, w.chain);
		await indexToTip(w.indexer);

		expect(w.streamCache.clears).toBeGreaterThan(w.before.clears);
		expect(w.chain.ranges.slice(w.before.ranges)[0].from).toBe(START_BLOCK);
		// and the rebuild lands on the same rows, which is exactly why the ranges
		// above are the assertion that matters
		expect(w.processor.state).toEqual(w.before.state);
	});
});

// ---------------------------------------------------------------------------
// THE STEP EXISTS ONCE, AND A COMMENT WOULD NOT HOLD IT SHUT
// ---------------------------------------------------------------------------
// The defect was not a wrong hash, it was TWO expressions computing one value.
// Correcting the second one leaves the shape that produced it, so the guard is
// structural: the resolve-then-hash step is one function, and nothing else in
// the package hashes a config at all.
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

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

const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the resolve-then-hash step', () => {
	it('is the ONLY site in the package that hashes a stream config', () => {
		// `simple_hash` applied to anything whose name says "config": the shape the
		// two call sites had, and the shape a third caller would reach for.
		const hashingAConfig = filesUnder(SRC)
			.filter((file) => /simple_hash\(\s*[^)]*[Cc]onfig/.test(withoutComments(readFileSync(file, 'utf-8'))))
			.map((file) => file.slice(SRC.length));

		expect(hashingAConfig).toEqual(['internal/engine/utils.ts']);
	});

	it('is what BOTH verbs go through, and neither hashes anything of its own', () => {
		const code = withoutComments(readFileSync(join(SRC, 'indexer.ts'), 'utf-8'));

		expect(code).not.toMatch(/simple_hash/);
		// `reinit` and `updateIndexer`, one call each
		expect(code.match(/streamConfigHashOf\(/g)).toHaveLength(2);
	});

	it('resolves before it hashes, so an unset default and the default written out are one digest', () => {
		expect(streamConfigHashOf(undefined)).toBe(streamConfigHashOf({}));
		expect(streamConfigHashOf({})).toBe(streamConfigHashOf({finality: 17}));
		expect(streamConfigHashOf({alwaysFetchTimestamps: true})).toBe(
			streamConfigHashOf({finality: 17, alwaysFetchTimestamps: true}),
		);
		// and a config that genuinely moved is still a different digest
		expect(streamConfigHashOf({finality: 5})).not.toBe(streamConfigHashOf({}));
		expect(streamConfigHashOf({alwaysFetchTimestamps: true})).not.toBe(streamConfigHashOf({}));
	});

	it('is IDEMPOTENT over the resolve, so the wire identity keeps the bytes it always had', () => {
		// The wire's `config` is a `UsedStreamConfig` already, so routing it through
		// here must not move one byte: the two halves of a split deployment compare
		// these digests and a batch under a digest neither side can read is refused.
		for (const provided of [undefined, {}, {finality: 17}, {finality: 5}, {alwaysFetchTimestamps: true}] as (
			| ProvidedStreamConfig
			| undefined
		)[]) {
			const resolved = resolveStreamConfig(provided);
			expect(streamConfigHashOf(provided)).toBe(streamConfigHashOf(resolved));
			expect(streamConfigHashOf(provided)).toBe(simple_hash(resolved));
			expect(wireContextOf(SOURCE, resolved).config).toBe(streamConfigHashOf(provided));
		}
	});

	it('leaves `simple_hash` and the shared `canonical_form` byte-for-byte where they were', () => {
		// These bytes are PERSISTED and the wide stream digest shares the
		// canonicalisation, so they are pinned as literals rather than as a property.
		expect(simple_hash({finality: 17})).toBe('h10lkzm2');
		expect(simple_hash({})).toBe('h28y');
		expect(simple_hash({finality: 17, alwaysFetchTimestamps: true})).toBe('ht6tzx8');
	});
});
