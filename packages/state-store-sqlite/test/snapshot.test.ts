import {
	BlockNotRetainedError,
	openSnapshotAware,
	readSnapshot,
	RevertBeyondSnapshotError,
	type EntityDeclaration,
	type Mutation,
} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {
	HistoryNotRetainedError,
	produceStateSnapshot,
	VersionedStateStore,
	type SnapshotHistory,
} from '../src/index.js';
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

describe('a snapshot that carries the history it was asked for', () => {
	/** Every block the fold recorded, and one height between each pair, around the cut. */
	const HEIGHTS = [100, 102, 105, 107, 110, 115, 117];

	async function blocksOf(document: ReadableStream<Uint8Array>) {
		const reader = await readSnapshot(document);
		const blocks = [];
		for await (const read of reader.blocks()) blocks.push(read);
		return {head: reader.head, blocks};
	}

	it('puts the floor at the cut for `none`, N blocks below it for a depth, and at the start for `all`', async () => {
		const {store} = await folded();
		const floorOf = async (history: SnapshotHistory) =>
			(await produceStateSnapshot(store, {at: 117, processor: 'proc-v1', history})).head.floor;

		expect(await floorOf('none')).toBe(110);
		// 117 - 7 = 110, a recorded block
		expect(await floorOf(7)).toBe(110);
		// 117 - 10 = 107 carries no logs: the floor is the highest recorded block at or below it,
		// whose rows ARE the rows as of 107, exactly as the cut's pointer is chosen (ADR-0095)
		expect(await floorOf(10)).toBe(105);
		// a depth reaching below the first block the generation recorded is clamped there
		expect(await floorOf(1_000)).toBe(100);
		expect(await floorOf('all')).toBe(100);
		// a depth of 0 is `none`
		expect(await floorOf(0)).toBe(110);
	});

	it('writes the rows live at the floor, then what every later block CHANGED, up to the cut', async () => {
		const {store} = await folded();

		const {head, blocks} = await blocksOf(
			(await produceStateSnapshot(store, {at: 120, processor: 'p', history: 'all'})).document,
		);

		expect(head).toMatchObject({floor: 100, takenAt: block(120)});
		expect(blocks).toEqual([
			{block: block(100), mutations: await all(store.liveRowsAsOf(100)), last: false},
			{
				block: block(105),
				mutations: [
					{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xdave', transferCount: 2}},
					{type: 'delete', entity: 'token', id: {id: '2'}},
				],
				last: false,
			},
			{
				block: block(110),
				mutations: [
					{type: 'upsert', entity: 'token', id: {id: '4'}, values: {owner: '0xerin', transferCount: 1}},
					{type: 'upsert', entity: 'sealed', id: {id: 's'}, values: {payload: new Uint8Array([1, 2, 255])}},
				],
				last: false,
			},
			{
				block: block(120),
				mutations: [{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xfrank', transferCount: 3}}],
				last: true,
			},
		]);
	});

	it("writes a block's NET change when it touched one id several times", async () => {
		const db = createTestDB();
		const store = new VersionedStateStore(db, [TOKEN, ACCOUNT, SEALED]);
		await store.migrate();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1), owns('2', '0xbob', 1)]);
		await store.applyBlock(block(11), [
			// written twice: the block's change is the LAST value
			owns('1', '0xcarol', 2),
			owns('1', '0xdave', 3),
			// born and burned in the same block: no change at all
			owns('9', '0xghost', 1),
			burn('9'),
			// rewritten then burned: a delete
			owns('2', '0xerin', 2),
			burn('2'),
		]);

		const {blocks} = await blocksOf((await produceStateSnapshot(store, {at: 11, processor: 'p', history: 1})).document);

		expect(blocks[1]!.mutations).toEqual([
			{type: 'upsert', entity: 'token', id: {id: '1'}, values: {owner: '0xdave', transferCount: 3}},
			{type: 'delete', entity: 'token', id: {id: '2'}},
		]);
	});

	for (const history of ['none', 10, 'all'] as const) {
		it(`installs (history ${history}) into a store that answers as of every block from its floor as the source does`, async () => {
			const {store: source} = await folded();
			const {head, document} = await produceStateSnapshot(source, {
				at: 117,
				processor: 'proc-v1',
				history,
				cursor: {key: 'lastSync', value: 'at-117'},
			});
			const target = await openSnapshotAware(new VersionedStateStore(createTestDB(), [TOKEN, ACCOUNT, SEALED]));

			await target.bootstrap(document, {processor: 'proc-v1'});

			expect(target.snapshotOrigin).toBe(head.floor);
			for (const at of HEIGHTS.filter((height) => height >= head.floor)) {
				for (const id of ['1', '2', '3', '4']) {
					expect(await target.getAsOf('token', {id}, at), `token ${id} as of ${at}`).toEqual(
						await source.getAsOf('token', {id}, at).then(declared),
					);
				}
			}
			await expect(target.getAsOf('token', {id: '1'}, head.floor - 1)).rejects.toBeInstanceOf(BlockNotRetainedError);
			expect(await target.readCursor('lastSync')).toBe('at-117');
		});
	}

	it('lets the installed store revert inside its history and re-apply to the same state, and refuses under it', async () => {
		const {store: source} = await folded();
		const {document} = await produceStateSnapshot(source, {at: 120, processor: 'proc-v1', history: 'all'});
		const inner = new VersionedStateStore(createTestDB(), [TOKEN, ACCOUNT, SEALED]);
		const target = await openSnapshotAware(inner);
		await target.bootstrap(document, {processor: 'proc-v1'});
		const before = await all(inner.liveRowsAsOf(120));

		await target.revertTo(104);
		expect(await target.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		await target.applyBlock(block(105), [owns('1', '0xdave', 2), burn('2')]);
		await target.applyBlock(block(110), [
			owns('4', '0xerin', 1),
			{type: 'upsert', entity: 'sealed', id: {id: 's'}, values: {payload: new Uint8Array([1, 2, 255])}},
		]);
		await target.applyBlock(block(120), [owns('1', '0xfrank', 3)]);

		expect(await all(inner.liveRowsAsOf(120))).toEqual(before);
		await expect(target.revertTo(99)).rejects.toBeInstanceOf(RevertBeyondSnapshotError);
	});

	it('refuses a depth reaching below what the database retains, naming both numbers, rather than shortening it', async () => {
		const db = createTestDB();
		const writer = new VersionedStateStore(db, [TOKEN], {retention: {blocks: 10}, finalityDepth: 5});
		await writer.migrate();
		await writer.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		await writer.applyBlock(block(110), [owns('1', '0xbob', 2)]);
		await writer.applyBlock(block(130), [owns('1', '0xcarol', 3)]);
		// the prune a `--retention 10` deployment schedules: versions closed at or below 120 are gone
		expect((await writer.prune()).floor).toBe(120);
		// ...and a publisher opens the SAME database with no retention of its own
		const reader = new VersionedStateStore(db, [TOKEN]);

		const refusal = await produceStateSnapshot(reader, {at: 130, processor: 'p', history: 15}).catch(
			(error: unknown) => error,
		);
		expect(refusal).toBeInstanceOf(HistoryNotRetainedError);
		expect(refusal).toMatchObject({requested: 115, retainedFrom: 120});
		expect(String((refusal as Error).message)).toMatch(/115/);
		expect(String((refusal as Error).message)).toMatch(/120/);
		await expect(produceStateSnapshot(reader, {at: 130, processor: 'p', history: 'all'})).rejects.toBeInstanceOf(
			HistoryNotRetainedError,
		);

		// within what it retains, the same database publishes
		const {head} = await produceStateSnapshot(reader, {at: 130, processor: 'p', history: 10});
		expect(head.floor).toBe(110);
	});

	it('refuses a depth that is not a whole number of blocks', async () => {
		const {store} = await folded();

		for (const history of [-1, 1.5, Number.NaN]) {
			await expect(produceStateSnapshot(store, {at: 117, processor: 'p', history})).rejects.toThrow(/whole number/);
		}
	});
});

/** A stored row minus the version columns, or `undefined`: what a fresh store holds for it. */
function declared<T extends Record<string, unknown>>(row: T | undefined): Record<string, unknown> | undefined {
	if (!row) return undefined;
	const {_rowid, _lower, _upper, ...rest} = row as Record<string, unknown>;
	return expect.objectContaining(rest) as unknown as Record<string, unknown>;
}
