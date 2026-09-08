import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {IndexerGeneration} from '../src/indexer.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import {streamDigestOf} from '../src/stream/identity.js';
import type {ExistingStream, IndexingSource, ProvidedStreamConfig, UsedStreamConfig} from '../src/types.js';
import {
	ADDRESS,
	FINALITY,
	fakeChain,
	fakeProcessor,
	idOf,
	indexToTip,
	makeLog,
	memoryStream,
	START_BLOCK,
	type ProcessorStore,
} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// DELETING A STREAM-CONFIG FIELD DOES NOT MOVE THE DIGEST OF A STREAM THAT
// NEVER SET IT
// ---------------------------------------------------------------------------
// The question ADR-0073 turns on: `alwaysFetchTransactions` and
// `alwaysFetchTimestamps` are now both DELETED from `ProvidedStreamConfig`, and
// for every deployment that never SET one that deletion had to be free -- same
// resolved config, same bytes, same digest, so no stream forks and no history is
// re-fetched from the node.
//
// It is free because of a mechanism, and the mechanism is what is asserted here:
// `resolveStreamConfig` drops keys whose value is `undefined`, so an unset flag
// contributes NO KEY to the resolved config, and the digest is taken over that
// config's canonical bytes. A field that puts nothing in the preimage cannot
// take anything out of it when it goes.
//
// This file is INFORMATIVE and deliberately not a gate on the deletion: nothing
// is published (CONTEXT.md, "NOTHING IS PUBLISHED YET") and no consumer is owed
// preservation. It exists so that a from-scratch re-index during the deletion is
// something RECORDED rather than something discovered while debugging, and it
// should be dropped rather than defended if it ever costs more than that.
//
// Two failures are guarded, and only the first is silent: a digest that MOVES
// orphans the stored stream and re-fetches the whole history with no error, and
// a digest that does NOT move when the config really changed hands a generation
// logs fetched under a config that is not its own (which is what
// `streamIdentity.test.ts` covers, and is not re-asserted here).
// ---------------------------------------------------------------------------

const transfer = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'value', type: 'uint256'},
	],
} as const;

/** One contract, one event, from a start block: the shape a deployment has. */
const SOURCE: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [transfer] as unknown as Abi, address: ADDRESS, startBlock: START_BLOCK}],
} as unknown as IndexingSource<Abi>;

/**
 * The digests of that source under the two stream configs a deployment which
 * sets NEITHER flag can have: nothing at all, and a chosen `finality`.
 *
 * ## Why these are LITERALS and must never be recomputed
 *
 * This is the whole point of the file. A test that computes both sides of the
 * comparison passes happily when the digest FUNCTION moves, because both sides
 * move with it -- and the digest function moving is precisely the failure being
 * guarded against, since it re-addresses every stored stream in existence and
 * says nothing while doing it. Recording the bytes is the only assertion that
 * can fail for the right reason.
 *
 * So these values are NOT to be updated to match a new answer. If one of them
 * goes red, the change under review re-indexes every deployment on this shape,
 * and the finding is the red test rather than the new number.
 */
const DIGEST_WITH_NO_CONFIG_AT_ALL = '96c7b55ba8b23635afb9f5622d2ba78f';
const DIGEST_WITH_ONLY_FINALITY_SET = '629df318e950e318c65936713d19f1ec';

describe('the digest of a stream whose config sets NEITHER flag', () => {
	it('is these exact BYTES, recorded rather than recomputed', () => {
		expect(streamDigestOf(SOURCE, resolveStreamConfig(undefined))).toBe(DIGEST_WITH_NO_CONFIG_AT_ALL);
		expect(streamDigestOf(SOURCE, resolveStreamConfig({finality: FINALITY}))).toBe(DIGEST_WITH_ONLY_FINALITY_SET);
	});

	it('is unchanged by the fields being DELETED, because an unset flag is not a KEY in the resolved config', () => {
		// The mechanism, asserted rather than assumed: `resolveStreamConfig` omits
		// a key whose value is `undefined`, so what it returns for a deployment that
		// set neither flag holds `finality` and nothing else.
		expect(Object.keys(resolveStreamConfig(undefined))).toEqual(['finality']);
		expect(Object.keys(resolveStreamConfig({finality: FINALITY}))).toEqual(['finality']);

		// ...and these are those same objects written out by hand -- which is
		// EXACTLY what a `ProvidedStreamConfig` narrowed to `{finality, parse}`
		// resolves to, since a field that is gone and a field that was never set
		// reach the digest preimage identically. Landing on the recorded bytes is
		// therefore the post-deletion digest, computed without needing the deletion.
		const asResolvedAfterTheDeletion: UsedStreamConfig[] = [{finality: 17}, {finality: FINALITY}];
		expect(streamDigestOf(SOURCE, asResolvedAfterTheDeletion[0])).toBe(DIGEST_WITH_NO_CONFIG_AT_ALL);
		expect(streamDigestOf(SOURCE, asResolvedAfterTheDeletion[1])).toBe(DIGEST_WITH_ONLY_FINALITY_SET);
	});
});

// ---------------------------------------------------------------------------
// The same claim where it is actually load-bearing: a stored stream, addressed
// by its digest, read back through the ordinary load path.
// ---------------------------------------------------------------------------

/**
 * Stream keepers that ADDRESS by the stream digest, one memory subtree each.
 *
 * The keeper the engine tests usually take (`memoryStream`) holds exactly one
 * stream and serves it whatever it is asked for, so a FORK is invisible through
 * it: a moved digest would read back the same events. This one takes the
 * resolved config through `setStreamConfig`, exactly as `keepStreamOnIndexedDB`
 * does, so "the reload landed on the stream it wrote" is a question the test can
 * ask -- and a fork shows up as a SECOND subtree with the first one orphaned
 * beside it rather than as a passing assertion.
 */
function digestAddressedStreams() {
	const subtrees = new Map<string, ReturnType<typeof memoryStream>>();
	let streamConfig: UsedStreamConfig = resolveStreamConfig(undefined);
	const at = (source: IndexingSource<Abi>) => {
		const digest = streamDigestOf(source, streamConfig);
		const existing = subtrees.get(digest);
		if (existing) {
			return existing;
		}
		const created = memoryStream();
		subtrees.set(digest, created);
		return created;
	};
	const keeper: ExistingStream<Abi> = {
		fetchFrom: (source, fromBlock) => at(source).keeper.fetchFrom(source, fromBlock),
		saveNewEvents: (source, stream) => at(source).keeper.saveNewEvents(source, stream),
		clear: (source) => at(source).keeper.clear(source),
		setStreamConfig: (next) => {
			streamConfig = next;
		},
	};
	return {
		keeper,
		subtrees,
		/** The digests that actually HOLD a stream, which is what a fork adds to. */
		occupied: () => [...subtrees].filter(([, subtree]) => subtree.cursor !== undefined).map(([digest]) => digest),
	};
}

/**
 * The engine over that keeper: `makeIndexer`'s wiring with the stream config
 * left to the caller, since the config is the variable this file moves.
 */
function indexerOver(
	chain: ReturnType<typeof fakeChain>,
	processor: unknown,
	keepStream: ExistingStream<Abi>,
	stream: ProvidedStreamConfig,
) {
	const indexer = new IndexerGeneration<Abi, string[]>(chain.provider, processor as never, SOURCE, {
		stream,
		keepStream,
		streamWriteRetry: {delaySeconds: 0},
	});
	(indexer as unknown as {logEventFetcher: unknown}).logEventFetcher = chain.fetcher;
	return indexer;
}

const LOGS = [makeLog(100, '0xa100'), makeLog(102, '0xa102'), makeLog(104, '0xa104')];
const TIP = 200;

describe('a stored stream written under a config that sets NEITHER flag', () => {
	it('loads back with NO FORK and NO CLEAR, and re-fetches nothing', async () => {
		const streams = digestAddressedStreams();
		const store: ProcessorStore = {};

		const chain = fakeChain([...LOGS], TIP);
		const first = fakeProcessor(store);
		const indexer = indexerOver(chain, first.processor, streams.keeper, {finality: FINALITY});
		await indexer.load();
		await indexToTip(indexer);

		// it wrote under the recorded address, which is the one a build with the two
		// fields deleted resolves to as well
		expect(streams.occupied()).toEqual([DIGEST_WITH_ONLY_FINALITY_SET]);
		const stored = streams.subtrees.get(DIGEST_WITH_ONLY_FINALITY_SET)!;
		expect(stored.events.map(idOf)).toEqual(LOGS.map(idOf));

		// a fresh engine over the same two stores, on the config a deployment that
		// set neither flag has before AND after the deletion
		const reloadChain = fakeChain([...LOGS], TIP);
		const reloaded = fakeProcessor(store);
		const again = indexerOver(reloadChain, reloaded.processor, streams.keeper, {finality: FINALITY});
		const lastSync = await again.load();

		// the load asked the node for nothing at all: the stream was adopted, not
		// re-fetched, and the state came up where it left off
		expect(reloadChain.ranges).toHaveLength(0);
		expect(lastSync.lastToBlock).toBe(TIP);
		expect(reloaded.state).toEqual(LOGS.map(idOf));

		// no fork: still ONE occupied subtree, still that one, and it was not
		// cleared and not rewritten
		expect(streams.occupied()).toEqual([DIGEST_WITH_ONLY_FINALITY_SET]);
		expect(stored.clears).toBe(0);
		expect(stored.events.map(idOf)).toEqual(LOGS.map(idOf));

		// and indexing on never goes back below the start block either
		await indexToTip(again);
		expect(streams.occupied()).toEqual([DIGEST_WITH_ONLY_FINALITY_SET]);
		expect(stored.clears).toBe(0);
		for (const range of reloadChain.ranges) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}
	});
});
