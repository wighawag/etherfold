import 'fake-indexeddb/auto';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {get, keys as allKeys, set} from 'idb-keyval';
import {
	resolveStreamConfig,
	streamDigestOf,
	STREAM_DIGEST_LENGTH,
	type Abi,
	type IndexingSource,
	type StoredLastSync,
	type StoredLogEvent,
	type UsedStreamConfig,
} from '@etherfold/core';
import {createBrowserStateStore, createIndexerState, keepStreamOnIndexedDB, streamAddress} from '../src/index.js';
import {
	entityProcessorOver,
	fakeChain,
	FINALITY,
	indexToTip,
	processor,
	SOURCE,
	SOURCE_REDEPLOYED_SAME_ABI,
	SOURCE_RENAMED_PARAMETER,
	SOURCE_V2,
	START_BLOCK,
	type TestABI,
	streamOf,
} from '../browser/workload.js';
import type {EntityStateView} from '@etherfold/processor-entities';

/**
 * THE STREAM'S IDENTITY, where it becomes an ADDRESS.
 *
 * The digest itself is asserted against the core (`@etherfold/core`'s
 * `streamIdentity.test.ts`); what is asserted HERE is that the real digest
 * OCCUPIES the level `the-stream-appends-in-segments-on-indexeddb` left as a
 * placeholder, that the `<indexer-name>` level above it is untouched, and that
 * the identity the keeper addresses by is the one the INDEXER resolved rather
 * than a default it kept to itself.
 *
 * The two failures are not symmetric and both are silent. A digest that moves
 * when it should not forks a stream, re-fetches the whole history and orphans
 * the old subtree. A digest that does NOT move when it should hands a generation
 * logs fetched under a filter or a config that is not its own.
 */

let counter = 0;
const freshName = () => `identity-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_CONFIG = resolveStreamConfig(undefined);
/** A config that genuinely MOVED: a second stream, addressed separately. */
const WITH_OTHER_FINALITY = resolveStreamConfig({finality: 64});

const digestFor = <ABI extends Abi>(source: IndexingSource<ABI>, streamConfig: UsedStreamConfig = DEFAULT_CONFIG) =>
	streamDigestOf(source, streamConfig);
const addressFor = (
	name: string,
	source: IndexingSource<Abi> = SOURCE as unknown as IndexingSource<Abi>,
	streamConfig: UsedStreamConfig = DEFAULT_CONFIG,
) => streamAddress(name, source, streamConfig);

function event(blockNumber: number, logIndex = 0): StoredLogEvent {
	return {
		blockNumber,
		logIndex,
		removed: false,
		blockHash: `0x${blockNumber.toString(16)}`,
		transactionHash: `0x${blockNumber.toString(16)}-${logIndex}`,
	} as unknown as StoredLogEvent;
}

function cursorAt(lastFromBlock: number, lastToBlock: number): StoredLastSync {
	return {
		context: {source: [{startBlock: 0, hash: 'src'}], config: 'cfg', processor: 'proc'},
		latestBlock: lastToBlock,
		lastFromBlock,
		lastToBlock,
		unconfirmedBlocks: [],
	} as unknown as StoredLastSync;
}

/** Every array key written under one indexer name, whatever stream it belongs to. */
const keysUnder = async (name: string) =>
	(await allKeys()).filter((key) => Array.isArray(key) && key[1] === name) as IDBValidKey[][];

describe('the real digest occupies the level the placeholder held', () => {
	it('is a fixed-length digest of the filter and the config, with the NAME level untouched', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});

		const written = await keysUnder(tag);
		expect(written).toHaveLength(2);
		for (const key of written) {
			expect(key).toHaveLength(4);
			expect(key[0]).toBe('stream');
			// the caller-supplied discriminator, exactly as it was handed over
			expect(key[1]).toBe(tag);
			expect(key[2]).toBe(digestFor(SOURCE));
			expect(key[2]).toMatch(/^[0-9a-f]{32}$/);
			expect(key[2]).toHaveLength(STREAM_DIGEST_LENGTH);
		}
		// and it is no longer derived from `chainId`: that is INSIDE the digest,
		// through the block-0 skeleton entry
		expect(written[0][2]).not.toBe(`chain-${SOURCE.chainId}`);
	});

	it('takes the digest from the core and computes NO second one of its own', () => {
		// A keeper with its own copy would have to agree with the core's BYTE FOR
		// BYTE; where it did not, one stream would sit at two addresses and the
		// symptom would be a re-fetch of the whole history rather than an error.
		const keeper = readFileSync(new URL('../src/storage/stream/OnIndexedDB.ts', import.meta.url), 'utf-8');
		expect(keeper).toMatch(/streamDigestOf,?\n/);
		expect(keeper.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).not.toMatch(/sha256|simple_hash/);
	});

	it('is the same address for a source object that is new but says the same thing', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});

		expect(streamOf(await keeper.fetchFrom(SOURCE_REDEPLOYED_SAME_ABI, 100)).eventStream).toHaveLength(1);
		expect(await keysUnder(tag)).toHaveLength(2);
	});
});

describe('what moves the address and what does not', () => {
	it('resolves a DECODE-ONLY change to the SAME stream, so nothing is re-fetched', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100), event(101)], lastSync: cursorAt(100, 101)});

		// a renamed non-indexed parameter moves every entry's `hash` and no entry's
		// `streamHash`: the cached logs are still exactly the right logs
		expect(digestFor(SOURCE_RENAMED_PARAMETER)).toBe(digestFor(SOURCE));
		const stored = streamOf(await keeper.fetchFrom(SOURCE_RENAMED_PARAMETER as never, 100));
		expect(stored.eventStream.map((e) => e.blockNumber)).toEqual([100, 101]);
		expect(await keysUnder(tag)).toHaveLength(2);
	});

	it('resolves a FILTER change to a DIFFERENT stream, leaving the old one intact', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100), event(101)], lastSync: cursorAt(100, 101)});

		// `SOURCE_V2` adds an event, which GROWS the topic set
		expect(digestFor(SOURCE_V2)).not.toBe(digestFor(SOURCE));
		expect(await keeper.fetchFrom(SOURCE_V2 as never, 100)).toEqual({status: 'absent'});

		// nothing migrated and nothing was rewritten: the old stream is still there
		// and still readable under its own filter
		expect(streamOf(await keeper.fetchFrom(SOURCE, 100)).eventStream).toHaveLength(2);
	});

	it('resolves a STREAM-CONFIG change to a different stream, leaving the old one intact', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100), event(101)], lastSync: cursorAt(100, 101)});

		// the stream CONFIG decides what is STORED as much as the filter does, so
		// keyed on the filter alone a generation would adopt logs the verdict has
		// declared invalid -- and the only remedy, clearing, destroys what the live
		// generation answers from
		keeper.setStreamConfig(WITH_OTHER_FINALITY);
		expect(await keeper.fetchFrom(SOURCE, 100)).toEqual({status: 'absent'});
		await keeper.saveNewEvents(SOURCE, {eventStream: [event(200)], lastSync: cursorAt(200, 200)});
		expect(streamOf(await keeper.fetchFrom(SOURCE, 200)).eventStream.map((e) => e.blockNumber)).toEqual([200]);

		// two subtrees under one name, and the first is untouched
		const digests = new Set((await keysUnder(tag)).map((key) => key[2]));
		expect(digests).toEqual(new Set([digestFor(SOURCE), digestFor(SOURCE, WITH_OTHER_FINALITY)]));
		keeper.setStreamConfig(DEFAULT_CONFIG);
		expect(streamOf(await keeper.fetchFrom(SOURCE, 100)).eventStream.map((e) => e.blockNumber)).toEqual([100, 101]);
	});

	it('keeps two indexer NAMES and two CHAINS apart, as the address level always did', async () => {
		const tag = freshName();
		const other = freshName();
		const mine = keepStreamOnIndexedDB<TestABI>(tag);
		const theirs = keepStreamOnIndexedDB<TestABI>(other);
		const otherChain = {...SOURCE, chainId: '10'};

		await mine.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});
		await mine.saveNewEvents(otherChain, {eventStream: [event(500)], lastSync: cursorAt(500, 500)});
		await theirs.saveNewEvents(SOURCE, {eventStream: [event(700)], lastSync: cursorAt(700, 700)});

		// the chain is inside the DIGEST (the block-0 skeleton entry hashes
		// `chainId` and `genesisHash`), and the name is the level above it
		expect(digestFor(otherChain)).not.toBe(digestFor(SOURCE));
		const under = await keysUnder(tag);
		expect(new Set(under.map((key) => key[1]))).toEqual(new Set([tag]));
		expect(new Set(under.map((key) => key[2]))).toEqual(new Set([digestFor(SOURCE), digestFor(otherChain)]));

		await mine.clear(SOURCE);
		expect(await mine.fetchFrom(SOURCE, 100)).toEqual({status: 'absent'});
		expect(streamOf(await mine.fetchFrom(otherChain, 500)).eventStream.map((e) => e.blockNumber)).toEqual([500]);
		expect(streamOf(await theirs.fetchFrom(SOURCE, 700)).eventStream.map((e) => e.blockNumber)).toEqual([700]);
	});
});

describe('a placeholder-era subtree', () => {
	it('is simply UNREACHABLE: nothing migrates it, adopts it or deletes it', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);
		const placeholder = ['stream', tag, `chain-${SOURCE.chainId}`] as const;

		// what the placeholder period wrote, byte for byte
		await set([...placeholder, 0], {events: [event(100)]});
		await set([...placeholder, 'cursor'], {
			context: cursorAt(100, 100).context,
			latestBlock: 100,
			lastFromBlock: 100,
			lastToBlock: 100,
			startBlock: 100,
			nextOrdinal: 1,
		});

		// the stream resolves elsewhere, so it is absent rather than adopted
		expect(await keeper.fetchFrom(SOURCE, 100)).toEqual({status: 'absent'});
		await keeper.saveNewEvents(SOURCE, {eventStream: [event(300)], lastSync: cursorAt(300, 300)});
		await keeper.clear(SOURCE);

		// and its DISPOSAL is not this level's: it belongs to the sweep in the
		// generation registry, which is the only place that knows which digests are
		// registered
		expect(await get([...placeholder, 0])).toEqual({events: [event(100)]});
		expect(await get([...placeholder, 'cursor'])).toBeDefined();
	});
});

describe('the identity the keeper addresses by is the INDEXER\u2019s', () => {
	it('is the RESOLVED stream config the indexer is running, not a default the keeper kept', async () => {
		const tag = freshName();
		const chain = fakeChain();
		const store = await createBrowserStateStore(processor.entities, {databaseName: freshName()});
		const streamConfig = {finality: FINALITY};
		const indexer = createIndexerState<TestABI, EntityStateView>(
			{
				createState: () => store,
				createProcessor: (state) => entityProcessorOver(state, processor),
			},
			{keepStream: keepStreamOnIndexedDB<TestABI>(tag) as never},
		);

		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: streamConfig}});
		await indexToTip(indexer);

		// the address the keeper actually wrote under is the one the filter AND the
		// running config resolve to. Without the config reaching the keeper this
		// assertion is the one that fails, and everything else here still passes.
		const written = await keysUnder(tag);
		expect(written.length).toBeGreaterThan(0);
		const digest = digestFor(SOURCE, resolveStreamConfig(streamConfig));
		expect(digest).not.toBe(digestFor(SOURCE));
		for (const key of written) {
			expect(key[2]).toBe(digest);
		}
		expect(await get(addressFor(tag, SOURCE, resolveStreamConfig(streamConfig)).cursor)).toBeDefined();
		expect(await get(addressFor(tag).cursor)).toBeUndefined();

		indexer.dispose();
	});

	it('follows a RECONFIGURE onto the new stream, leaving the old one where it is', async () => {
		const tag = freshName();
		const chain = fakeChain();
		const store = await createBrowserStateStore(processor.entities, {databaseName: freshName()});
		const indexer = createIndexerState<TestABI, EntityStateView>(
			{
				createState: () => store,
				createProcessor: (state) => entityProcessorOver(state, processor),
			},
			{keepStream: keepStreamOnIndexedDB<TestABI>(tag) as never},
		);

		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		await indexToTip(indexer);
		const first = resolveStreamConfig({finality: FINALITY});
		expect(await get(addressFor(tag, SOURCE, first).cursor)).toBeDefined();

		await indexer.updateIndexer({streamConfig: {finality: FINALITY + 1}});
		await indexToTip(indexer);

		const second = resolveStreamConfig({finality: FINALITY + 1});
		expect(await get(addressFor(tag, SOURCE, second).cursor)).toBeDefined();
		// the stream the previous config was fetched under is still on disk, whole:
		// a reconfigure is not an outage, and this is the half of it the address
		// level carries
		const kept = await get<{events: unknown[]}>(addressFor(tag, SOURCE, first).segment(0));
		expect(kept?.events.length).toBeGreaterThan(0);
		expect(await get(addressFor(tag, SOURCE, first).cursor)).toBeDefined();

		indexer.dispose();
	});
});

describe('the start block the stream keeps is unaffected', () => {
	it('still refuses a stream that does not reach back to what was asked for', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(500)], lastSync: cursorAt(500, 500)});

		// its OWN verdict since ADR-0069, and no longer a clear: nothing is wrong with
		// this stream, it simply opens above what was asked for, and the caller decides
		expect(await keeper.fetchFrom(SOURCE, START_BLOCK)).toEqual({status: 'does-not-reach-back', startBlock: 500});
		expect(streamOf(await keeper.fetchFrom(SOURCE, 500)).eventStream).toHaveLength(1);
	});
});
