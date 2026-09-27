import {
	BlockNotRetainedError,
	openSnapshotAware,
	readSnapshot,
	type EntityDeclaration,
	type Mutation,
} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {produceStateSnapshot, VersionedStateStore} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {ACCOUNT, TOKEN, block, burn, owns} from './utils/fixtures.js';

/**
 * The PRODUCER half of a published snapshot (ADR-0095): every row live as of a
 * block, read out of a real database by this backend's own query, and written as
 * a format-2 document.
 *
 * The round trip through a real fold and every backend is
 * `@etherfold/processor-entities`' `snapshot-round-trip.test.ts`; what is here is
 * what only this backend can be asked: the read itself, its paging and its
 * namespace, and which block a cut points at.
 */

const SEALED: EntityDeclaration = {name: 'sealed', id: ['id'], fields: {payload: 'blob'}};

async function folded(options: {namespace?: string} = {}) {
	const db = createTestDB();
	const store = new VersionedStateStore(db, [TOKEN, ACCOUNT, SEALED], {tableNamespace: options.namespace});
	await store.migrate();
	await store.applyBlock(block(100), [owns('1', '0xalice', 1), owns('2', '0xbob', 1), owns('3', '0xcarol', 1)]);
	await store.applyBlock(block(105), [owns('1', '0xdave', 2), burn('2')]);
	await store.applyBlock(block(110), [
		owns('4', '0xerin', 1),
		{type: 'upsert', entity: 'sealed', id: {id: 's'}, values: {payload: new Uint8Array([1, 2, 255])}},
	]);
	await store.applyBlock(block(120), [owns('1', '0xfrank', 3)]);
	return {db, store};
}

async function all(rows: AsyncIterable<Mutation>): Promise<Mutation[]> {
	const out: Mutation[] = [];
	for await (const row of rows) out.push(row);
	return out;
}

describe('every row live as of a block', () => {
	it('is the as-of state, deleted rows absent, as the upserts that reproduce it', async () => {
		const {store} = await folded();

		const rows = await all(store.liveRowsAsOf(112));

		expect(rows).toEqual([
			{type: 'upsert', entity: 'token', id: {id: '3'}, values: {owner: '0xcarol', transferCount: 1}},
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xdave', transferCount: 2}},
			{type: 'upsert', entity: 'token', id: {id: '4'}, values: {owner: '0xerin', transferCount: 1}},
			// a blob comes back as bytes, as the seam's other backends hold one
			{type: 'upsert', entity: 'sealed', id: {id: 's'}, values: {payload: new Uint8Array([1, 2, 255])}},
		]);
	});

	it('reads the same rows a page at a time, whatever the page', async () => {
		const {store} = await folded();

		const whole = await all(store.liveRowsAsOf(112));
		for (const pageSize of [1, 2, 3]) {
			expect(await all(store.liveRowsAsOf(112, {pageSize}))).toEqual(whole);
		}
	});

	it('reads its OWN generation, and nothing of a sibling folded into the same database', async () => {
		const db = createTestDB();
		const left = new VersionedStateStore(db, [TOKEN], {tableNamespace: 'left'});
		const right = new VersionedStateStore(db, [TOKEN], {tableNamespace: 'right'});
		await left.migrate();
		await right.migrate();
		await left.applyBlock(block(10), [owns('1', '0xleft', 1)]);
		await right.applyBlock(block(10), [owns('1', '0xright', 1), owns('2', '0xright', 1)]);

		expect(await all(left.liveRowsAsOf(10))).toEqual([
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xleft', transferCount: 1}},
		]);
		expect(await all(right.liveRowsAsOf(10))).toHaveLength(2);
	});

	it('refuses a block outside what the store retains, as every as-of read does', async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN], {retention: 'revert-only'});
		await store.migrate();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);

		await expect(all(store.liveRowsAsOf(10))).rejects.toBeInstanceOf(BlockNotRetainedError);
	});
});

describe('producing a snapshot', () => {
	it('points at the highest RECORDED block at or below the cut, whose rows are the rows as of the cut', async () => {
		const {store} = await folded();

		const {head} = await produceStateSnapshot(store, {
			at: 117,
			processor: 'proc-v1',
			cursor: {key: 'lastSync', value: 'at-117'},
			savedAt: '2026-09-27T00:00:00.000Z',
		});

		expect(head).toEqual({
			format: 2,
			processor: 'proc-v1',
			savedAt: '2026-09-27T00:00:00.000Z',
			takenAt: block(110),
			floor: 110,
			cursor: {key: 'lastSync', value: 'at-117'},
		});
	});

	it('writes a document whose head is the head it returned, and whose floor is those rows', async () => {
		const {store} = await folded();
		const produced = await produceStateSnapshot(store, {at: 112, processor: 'proc-v1'});

		const reader = await readSnapshot(produced.document);
		const blocks = [];
		for await (const read of reader.blocks()) blocks.push(read);

		expect(reader.head).toEqual(produced.head);
		expect(blocks).toEqual([{block: block(110), mutations: await all(store.liveRowsAsOf(112)), last: true}]);
	});

	it('installs into a fresh store of this backend, answering as the source did as of the cut', async () => {
		const {store: source} = await folded();
		const {document} = await produceStateSnapshot(source, {
			at: 112,
			processor: 'proc-v1',
			cursor: {key: 'lastSync', value: 'at-112'},
		});
		const target = await openSnapshotAware(new VersionedStateStore(createTestDB(), [TOKEN, ACCOUNT, SEALED]));

		await target.bootstrap(document, {processor: 'proc-v1'});

		for (const id of ['1', '2', '3', '4']) {
			expect(await target.getCurrent('token', {id})).toEqual(await source.getAsOf('token', {id}, 112).then(declared));
		}
		expect(await target.readCursor('lastSync')).toBe('at-112');
		expect(target.snapshotOrigin).toBe(110);
	});

	it('refuses a cut below every recorded block: there is no state to take there', async () => {
		const {store} = await folded();

		await expect(produceStateSnapshot(store, {at: 99, processor: 'proc-v1'})).rejects.toThrow(/folded nothing/);
	});
});

/** A stored row minus the version columns, or `undefined`: what a fresh store holds for it. */
function declared<T extends Record<string, unknown>>(row: T | undefined): Record<string, unknown> | undefined {
	if (!row) return undefined;
	const {_rowid, _lower, _upper, ...rest} = row as Record<string, unknown>;
	return expect.objectContaining(rest) as unknown as Record<string, unknown>;
}
