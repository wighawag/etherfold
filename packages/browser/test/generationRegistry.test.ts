import 'fake-indexeddb/auto';
import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import {get, keys as allKeys, set} from 'idb-keyval';
import {
	GenerationCapReachedError,
	GenerationIsCanonicalError,
	resolveStreamConfig,
	streamDigestOf,
	type GenerationId,
	type StoredLastSync,
	type StoredLogEvent,
} from '@etherfold/core';
import type {EntityDeclaration, Mutation} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {
	BROWSER_GENERATION_CAPS,
	generationAddress,
	keepStreamOnIndexedDB,
	openGenerationRegistryOnIndexedDB,
	streamAddress,
	streamSubtree,
} from '../src/index.js';
import {SOURCE, SOURCE_V2, type TestABI} from '../browser/workload.js';

/**
 * THE GENERATION REGISTRY, where it becomes KEYS AND BYTES.
 *
 * The rules are asserted against the core (`@etherfold/core`'s
 * `generationRegistry.test.ts`, over a memory port); what is asserted HERE is
 * the substrate: that the records sit at a hierarchical address beside the
 * streams, that the sweep of unregistered subtrees runs ON OPEN and reaches
 * exactly the placeholder-era case that creates it, that a live stream and
 * another indexer NAME's stream are untouched by it, and that a real state store
 * really goes when its generation is deleted.
 *
 * NO INDEXER RUNS in this file. That is the point of the split the task made:
 * every one of these operations is bookkeeping, and a bookkeeping mistake is
 * what silently costs a re-index later.
 */

let counter = 0;
const freshName = () => `registry-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_CONFIG = resolveStreamConfig(undefined);
const DIGEST = streamDigestOf(SOURCE, DEFAULT_CONFIG);
const DIGEST_V2 = streamDigestOf(SOURCE_V2, DEFAULT_CONFIG);
const PROC_A = 'processor-a';
const PROC_B = 'processor-b';

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text'}};
const owns = (id: string, owner: string): Mutation => ({type: 'upsert', entity: 'token', id: {id}, values: {owner}});
const block = (number: number) => ({number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12});

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

/** Every stream key under one indexer name, whatever stream it belongs to. */
const streamKeysUnder = async (name: string) =>
	(await allKeys()).filter((key) => Array.isArray(key) && key[0] === 'stream' && key[1] === name) as IDBValidKey[][];

/** The digests that still have a subtree under one name. */
const digestsUnder = async (name: string) =>
	[...new Set((await streamKeysUnder(name)).map((key) => key[2] as string))].sort();

/** A registry whose state stores are a set this test can look into. */
function registryOver(name: string, caps?: {maxGenerations?: number; maxStreams?: number}) {
	const dropped: GenerationId[] = [];
	return {
		dropped,
		open: () =>
			openGenerationRegistryOnIndexedDB(name, {
				caps,
				dropState: async (id) => {
					dropped.push(id);
				},
			}),
	};
}

/** What the placeholder period wrote, byte for byte, under a dead digest. */
async function writePlaceholderSubtree(name: string, digest = `chain-${SOURCE.chainId}`) {
	const subtree = streamSubtree(name, digest);
	await set(subtree.segment(0), {events: [event(100)]});
	await set(subtree.cursor, {
		context: cursorAt(100, 100).context,
		latestBlock: 100,
		lastFromBlock: 100,
		lastToBlock: 100,
		startBlock: 100,
		nextOrdinal: 1,
	});
}

describe('the registry keeps its records beside the streams, hierarchically', () => {
	it('addresses a generation by its stream digest and its processor, as two key ELEMENTS', async () => {
		const name = freshName();
		const registry = await registryOver(name).open();

		const created = await registry.create({stream: DIGEST, processor: PROC_A});

		const address = generationAddress(name);
		expect(await get(address.entry(created))).toEqual(created);
		expect(address.entry(created)).toEqual(['generation', name, 'entry', DIGEST, PROC_A]);
		// the pointer is ONE record, and it carries the identity alone
		expect(await get(address.canonical)).toEqual({stream: DIGEST, processor: PROC_A});
	});

	it('holds two generations of one stream, and reads back exactly what it wrote', async () => {
		const name = freshName();
		const registry = await registryOver(name).open();
		await registry.create({stream: DIGEST, processor: PROC_A});
		await registry.create({stream: DIGEST, processor: PROC_B});

		const reopened = await registryOver(name).open();

		expect((await reopened.list()).map((record) => record.processor)).toEqual([PROC_A, PROC_B]);
		expect(await reopened.streams()).toEqual([DIGEST]);
		expect((await reopened.canonical())?.processor).toBe(PROC_A);
	});

	it('holds ONE canonical pointer PER INDEXER, and one name’s move is not another’s', async () => {
		const mine = freshName();
		const theirs = freshName();
		const here = await registryOver(mine).open();
		const there = await registryOver(theirs).open();
		await here.create({stream: DIGEST, processor: PROC_A});
		const next = await here.create({stream: DIGEST, processor: PROC_B});
		await there.create({stream: DIGEST, processor: PROC_A});

		await here.moveCanonicalTo(next);

		expect((await here.canonical())?.processor).toBe(PROC_B);
		expect((await there.canonical())?.processor).toBe(PROC_A);
		expect(await there.list()).toHaveLength(1);
	});
});

describe('the canonical pointer moves forward and BACK, over real state stores', () => {
	it('restores the previous generation\u2019s answers EXACTLY, with no re-indexing and no fetch', async () => {
		const name = freshName();
		const blueDb = freshName();
		const greenDb = freshName();
		const blueStore = new IndexedDBStateStore([TOKEN], {databaseName: blueDb});
		const greenStore = new IndexedDBStateStore([TOKEN], {databaseName: greenDb});
		await blueStore.migrate();
		await greenStore.migrate();
		// two folds over ONE stream: the old processor and the new one
		await blueStore.applyBlock(block(100), [owns('1', '0xalice')]);
		await greenStore.applyBlock(block(100), [owns('1', '0xbob')]);

		const registry = await registryOver(name).open();
		const blue = await registry.create({stream: DIGEST, processor: PROC_A});
		const green = await registry.create({stream: DIGEST, processor: PROC_B});
		const stores = new Map([
			[PROC_A, blueStore],
			[PROC_B, greenStore],
		]);
		const readThroughPointer = async () => {
			const canonical = (await registry.canonical()) as {processor: string};
			return (await stores.get(canonical.processor)!.getCurrent<{owner: string}>('token', {id: '1'}))?.owner;
		};

		expect(await readThroughPointer()).toBe('0xalice');
		await registry.moveCanonicalTo(green);
		expect(await readThroughPointer()).toBe('0xbob');

		// and BACK: story 4, the whole reason a superseded generation is kept
		await registry.moveCanonicalTo(blue);
		expect(await readThroughPointer()).toBe('0xalice');
		// exactly, and as of any block it could answer before -- nothing was
		// rebuilt, because a revert is one small record write and the state store it
		// names was never touched
		expect(await blueStore.getAsOf('token', {id: '1'}, 100)).toMatchObject({owner: '0xalice'});
		expect(await greenStore.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob'});
	});
});

describe('the browser caps', () => {
	it('default to two generations and two streams, and REFUSE rather than evict', async () => {
		expect(BROWSER_GENERATION_CAPS).toEqual({maxGenerations: 2, maxStreams: 2});
		const name = freshName();
		const world = registryOver(name);
		const registry = await world.open();
		const blue = await registry.create({stream: DIGEST, processor: PROC_A});
		const green = await registry.create({stream: DIGEST, processor: PROC_B});

		const refusal = (await registry.create({stream: DIGEST_V2, processor: PROC_A}).catch((e: unknown) => e)) as
			| GenerationCapReachedError
			| undefined;

		expect(refusal).toBeInstanceOf(GenerationCapReachedError);
		expect(refusal?.cap).toBe('maxGenerations');
		// nothing was evicted: both generations are still registered, still
		// readable, and the pointer still names the one that answers
		expect(await registry.list()).toEqual([blue, green]);
		expect(await registry.canonical()).toEqual(blue);
		expect(world.dropped).toEqual([]);
		expect(await get(generationAddress(name).entry(green))).toEqual(green);
	});

	it('never consults navigator.storage.estimate(), which measured 6.45 GB of headroom while writes failed', async () => {
		// the RUNTIME half: a full exercise with the API in place and instrumented
		const estimate = vi.fn(async () => ({quota: 6_450_000_000, usage: 0}));
		const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
		Object.defineProperty(globalThis, 'navigator', {value: {storage: {estimate}}, configurable: true});
		try {
			const name = freshName();
			const registry = await registryOver(name).open();
			const blue = await registry.create({stream: DIGEST, processor: PROC_A});
			const green = await registry.create({stream: DIGEST, processor: PROC_B});
			await registry.moveCanonicalTo(green);
			await registry.deleteGeneration(blue);
			await expect(registry.create({stream: DIGEST_V2, processor: PROC_A})).resolves.toBeDefined();
			expect(estimate).not.toHaveBeenCalled();
		} finally {
			if (before) {
				Object.defineProperty(globalThis, 'navigator', before);
			} else {
				delete (globalThis as {navigator?: unknown}).navigator;
			}
		}

		// and the SOURCE half, because a cap derived from it on a path no test
		// happens to walk is the same wrong cap. WebKit does not implement it,
		// `quota` varies four-fold between engines, and it did not reflect the quota
		// actually in force.
		for (const source of [
			new URL('../src/storage/generation/OnIndexedDB.ts', import.meta.url),
			new URL('../../core/src/generation/registry.ts', import.meta.url),
		]) {
			const code = readFileSync(source, 'utf-8')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/\/\/.*$/gm, '');
			expect(code).not.toMatch(/navigator|estimate\s*\(/);
		}
	});
});

describe('deleting a generation drops a REAL state store, and reaps the stream with the last one', () => {
	it('leaves the stream where another generation still folds it', async () => {
		const name = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(name);
		const world = registryOver(name);
		const registry = await world.open();
		const blue = await registry.create({stream: DIGEST, processor: PROC_A});
		const green = await registry.create({stream: DIGEST, processor: PROC_B});
		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});
		await registry.moveCanonicalTo(green);

		const report = await registry.deleteGeneration(blue);

		expect(report.reaped).toBeUndefined();
		expect(world.dropped).toEqual([{stream: DIGEST, processor: PROC_A}]);
		// the stream the surviving generation folds is untouched, whole
		expect((await keeper.fetchFrom(SOURCE, 100))?.eventStream).toHaveLength(1);
		expect(await get(generationAddress(name).entry(blue))).toBeUndefined();
	});

	it('reaps the stream keyspace when the last generation on it goes', async () => {
		const name = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(name);
		const store = new IndexedDBStateStore([TOKEN], {databaseName: freshName()});
		await store.migrate();
		await store.applyBlock(block(200), [owns('1', '0xalice')]);

		// what a host's `dropState` really is on the IndexedDB default: close the
		// connection, then delete the database the generation folded into
		const registry = await openGenerationRegistryOnIndexedDB(name, {
			dropState: async () => {
				await store.close();
				await new Promise<void>((resolve, reject) => {
					const request = indexedDB.deleteDatabase(store.databaseName);
					request.onsuccess = () => resolve();
					request.onerror = () => reject(request.error);
				});
			},
		});
		await registry.create({stream: DIGEST, processor: PROC_A});
		const onV2 = await registry.create({stream: DIGEST_V2, processor: PROC_A});
		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});
		await keeper.saveNewEvents(SOURCE_V2 as never, {eventStream: [event(200)], lastSync: cursorAt(200, 200)});

		const report = await registry.deleteGeneration(onV2);

		expect(report.reaped).toBe(DIGEST_V2);
		// deleting a stream is dropping its keyspace, and that is cheap only
		// because streams are self-contained
		expect(await digestsUnder(name)).toEqual([DIGEST]);
		expect((await keeper.fetchFrom(SOURCE, 100))?.eventStream).toHaveLength(1);
		// and the state store really went: a fresh handle on that database reads
		// nothing back
		const reopened = new IndexedDBStateStore([TOKEN], {databaseName: store.databaseName});
		await reopened.migrate();
		expect(await reopened.getCurrent('token', {id: '1'})).toBeUndefined();
	});

	it('refuses to delete the canonical generation or its stream', async () => {
		const name = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(name);
		const world = registryOver(name);
		const registry = await world.open();
		const blue = await registry.create({stream: DIGEST, processor: PROC_A});
		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});

		await expect(registry.deleteGeneration(blue)).rejects.toThrow(GenerationIsCanonicalError);
		await expect(registry.deleteStream(DIGEST)).rejects.toThrow(GenerationIsCanonicalError);
		expect(world.dropped).toEqual([]);
		expect((await keeper.fetchFrom(SOURCE, 100))?.eventStream).toHaveLength(1);
	});
});

describe('the unregistered-subtree sweep, on registry OPEN', () => {
	it('collects a placeholder-era subtree and leaves every live stream alone', async () => {
		const name = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(name);
		const registry = await registryOver(name).open();
		await registry.create({stream: DIGEST, processor: PROC_A});
		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});
		// what the segmented-stream work left behind: unreachable, counted against
		// no cap, and beyond the reach of ordinary reaping, because reaping fires
		// when a stream's last GENERATION goes and this one has none
		await writePlaceholderSubtree(name);
		expect(await digestsUnder(name)).toEqual([DIGEST, `chain-${SOURCE.chainId}`].sort());

		const reopened = await registryOver(name).open();

		expect(reopened.swept).toEqual([`chain-${SOURCE.chainId}`]);
		expect(await digestsUnder(name)).toEqual([DIGEST]);
		// the live stream is whole: its segments AND its cursor
		expect((await keeper.fetchFrom(SOURCE, 100))?.eventStream).toHaveLength(1);
		expect(await get(streamAddress(name, SOURCE, DEFAULT_CONFIG).cursor)).toBeDefined();
	});

	it('is keyed on "the registry does not know this digest", so it collects any orphan', async () => {
		const name = freshName();
		const registry = await registryOver(name).open();
		await registry.create({stream: DIGEST, processor: PROC_A});
		await writePlaceholderSubtree(name, `chain-${SOURCE.chainId}`);
		await writePlaceholderSubtree(name, 'ffffffffffffffffffffffffffffffff');

		const reopened = await registryOver(name).open();

		// a placeholder and an orphan from some later redefinition of the digest
		// rule are the same case, because the CLAIM is what is checked
		expect([...reopened.swept].sort()).toEqual([`chain-${SOURCE.chainId}`, 'ffffffffffffffffffffffffffffffff'].sort());
		expect(await digestsUnder(name)).toEqual([]);
	});

	it('NEVER touches another indexer NAME\u2019s subtree, even under the same digest', async () => {
		const mine = freshName();
		const theirs = freshName();
		const registry = await registryOver(mine).open();
		await registry.create({stream: DIGEST, processor: PROC_A});
		// the SAME orphan digest under both names: one indexer's bookkeeping says
		// nothing about another's, and the address level above the digest is what
		// keeps them apart
		await writePlaceholderSubtree(mine);
		await writePlaceholderSubtree(theirs);
		await writePlaceholderSubtree(theirs, DIGEST);

		const reopened = await registryOver(mine).open();

		expect(reopened.swept).toEqual([`chain-${SOURCE.chainId}`]);
		expect(await digestsUnder(theirs)).toEqual([DIGEST, `chain-${SOURCE.chainId}`].sort());
	});

	it('is IDEMPOTENT, and a second open drops nothing', async () => {
		const name = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(name);
		const registry = await registryOver(name).open();
		await registry.create({stream: DIGEST, processor: PROC_A});
		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});
		await writePlaceholderSubtree(name);
		await registryOver(name).open();

		const third = await registryOver(name).open();

		expect(third.swept).toEqual([]);
		expect(await digestsUnder(name)).toEqual([DIGEST]);
		expect((await keeper.fetchFrom(SOURCE, 100))?.eventStream).toHaveLength(1);
	});

	it('leaves the registry\u2019s OWN records alone: they are not a stream subtree', async () => {
		const name = freshName();
		const registry = await registryOver(name).open();
		const blue = await registry.create({stream: DIGEST, processor: PROC_A});
		await writePlaceholderSubtree(name);

		const reopened = await registryOver(name).open();

		expect(reopened.swept).toHaveLength(1);
		expect(await get(generationAddress(name).entry(blue))).toEqual(blue);
		expect(await get(generationAddress(name).canonical)).toEqual({stream: DIGEST, processor: PROC_A});
	});
});
