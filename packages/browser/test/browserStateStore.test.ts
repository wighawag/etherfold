import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {MemoryStateStore, type EntityDeclaration, type Mutation} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';
import {PatchStateStore} from '@etherfold/state-store-patch';
import {createBrowserStateStore} from '../src/index.js';

/**
 * Where a browser deployment's entity state lives, and what choosing costs.
 *
 * The claim under test is not "IndexedDB works" (that is
 * `@etherfold/state-store-indexeddb`'s own suite, and the shared conformance
 * suite on three engines). It is that the DEFAULT is IndexedDB and that swapping
 * it is a line of configuration which touches no processor: the same
 * declarations, the same handlers, a different store.
 */

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text'}};
const ENTITIES: readonly EntityDeclaration[] = [TOKEN];

function owns(id: string, owner: string): Mutation {
	return {type: 'upsert', entity: 'token', id: {id}, values: {owner}};
}

function block(number: number) {
	return {number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12};
}

let counter = 0;
const freshName = () => `browser-default-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

describe('the browser default', () => {
	it('is IndexedDB when nothing is configured', async () => {
		const store = await createBrowserStateStore(ENTITIES, {databaseName: freshName()});

		expect(store).toBeInstanceOf(IndexedDBStateStore);
	});

	it('comes back migrated, so a host can read from it straight away', async () => {
		const store = await createBrowserStateStore(ENTITIES, {databaseName: freshName()});

		await store.applyBlock(block(100), [owns('1', '0xalice')]);
		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});

	it('keeps everything unless the deployment asks for a window', async () => {
		const unbounded = await createBrowserStateStore(ENTITIES, {databaseName: freshName()});
		const windowed = await createBrowserStateStore(ENTITIES, {
			databaseName: freshName(),
			retention: {blocks: 128},
			finalityDepth: 64,
		});

		expect(unbounded.capabilities).toEqual({retention: {kind: 'unbounded'}, asOf: true, singleWriter: true});
		expect(windowed.capabilities).toEqual({retention: {kind: 'window', blocks: 128}, asOf: true, singleWriter: true});
	});

	it("takes 'revert-only' as well, and reports asOf: false as its docstring says it will", async () => {
		// the setting `BrowserStateStoreConfig.retention` points a browser app at
		// for reorg safety with no history. It is a `retention` VALUE, so it is
		// available on the DEFAULT backend and not only on the light store that is
		// `revert-only` by construction -- and the store says up front that it
		// answers no historical read, which is the whole reason to prefer it to a
		// small window that would refuse them one at a time instead.
		const revertOnly = await createBrowserStateStore(ENTITIES, {
			databaseName: freshName(),
			retention: 'revert-only',
			finalityDepth: 64,
		});

		expect(revertOnly.capabilities).toEqual({retention: {kind: 'revert-only'}, asOf: false, singleWriter: true});
	});

	it('refuses a window below the finality depth where it was configured', async () => {
		// not at the first read it would have answered wrongly
		await expect(
			createBrowserStateStore(ENTITIES, {databaseName: freshName(), retention: {blocks: 32}, finalityDepth: 64}),
		).rejects.toThrow(/finality/i);
	});

	it('names its own database, so two indexers in one origin do not collide', async () => {
		const first = (await createBrowserStateStore(ENTITIES, {databaseName: 'app-a'})) as IndexedDBStateStore;
		const second = (await createBrowserStateStore(ENTITIES, {databaseName: 'app-b'})) as IndexedDBStateStore;

		await first.applyBlock(block(100), [owns('1', '0xalice')]);

		expect(second.databaseName).toBe('app-b');
		expect(await second.getCurrent('token', {id: '1'})).toBeUndefined();
		await first.close();
		await second.close();
	});
});

describe('choosing another backend', () => {
	it('is a factory, and the declarations are all it gets', async () => {
		const store = await createBrowserStateStore(ENTITIES, {
			backend: (declarations) => new PatchStateStore(declarations, {retention: 'revert-only', finalityDepth: 64}),
		});

		expect(store).toBeInstanceOf(PatchStateStore);
		// and it reports ITS capability, not the default's: this backend answers no
		// historical read at all, which a caller learns here rather than from a
		// plausible wrong number later.
		expect(store.capabilities).toMatchObject({retention: {kind: 'revert-only'}, asOf: false});
	});

	it('changes nothing about the declarations or the mutations the processor produces', async () => {
		const mutations = [owns('1', '0xalice')];

		const onIndexedDB = await createBrowserStateStore(ENTITIES, {databaseName: freshName()});
		const onPatches = await createBrowserStateStore(ENTITIES, {
			backend: (declarations) => new PatchStateStore(declarations, {retention: 'revert-only'}),
		});
		const inMemory = await createBrowserStateStore(ENTITIES, {
			backend: (declarations) => new MemoryStateStore(declarations),
		});

		// the same block, the same mutations, three stores that were never told
		// about each other
		for (const store of [onIndexedDB, onPatches, inMemory]) {
			await store.applyBlock(block(100), mutations);
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		}
	});
});
