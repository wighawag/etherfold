import {describe, expect, it} from 'vitest';
import {VersionedStateEventProcessor} from '../src/index.js';
import {createTestDB, RecordingSQL, rows, sqlOf} from './utils/db.js';
import {freshProcessor, lastSync, processor, SOURCE, finality, transfer, type TestABI} from './utils/fixtures.js';

// This processor is now a CALLER of the store, and the store's write contract has
// sharp edges that exist to make caller bugs loud. These tests pin that this
// caller respects them, because the whole value of a loud failure is lost if the
// caller reaches it by accident in production instead of here.

describe('one block is one batch', () => {
	it('sends each block as exactly one batch, block row and mutations together', async () => {
		const db = new RecordingSQL(createTestDB());
		const {p} = await freshProcessor(db);
		db.batches.length = 0; // drop the migration batches

		await p.process(
			[
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(100, '0xA', {from: '0x0', to: '0xzoe', id: 2n}),
				transfer(101, '0xB', {from: '0xalice', to: '0xbob', id: 1n}),
			],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		);

		// two blocks -> two apply batches, plus the cursor write
		const applyBatches = db.batches.filter((batch) => batch.some((s) => sqlOf(s).includes('INSERT INTO _blocks')));
		expect(applyBatches).toHaveLength(2);
		for (const batch of applyBatches) {
			// the block row leads the WORK of the batch; ahead of it may sit the
			// writer's claim, and behind everything the read-back that says the claim
			// still holds (ADR-0075). Both are part of the same one transaction.
			expect(sqlOf(batch[0])).toMatch(/INSERT INTO (_blocks|_writer)/);
			expect(batch.length).toBeGreaterThan(1);
		}
	});

	it('coalesces repeated writes to one key within a block, leaving no zero-width version', async () => {
		const {db, p} = await freshProcessor();
		await p.process(
			[
				transfer(100, '0xA', {from: '0x0', to: '0xalice', id: 1n}),
				transfer(100, '0xA', {from: '0xalice', to: '0xbob', id: 1n}),
				transfer(100, '0xA', {from: '0xbob', to: '0xcarol', id: 1n}),
			],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		// three events touching token 1, but one version: a row with _lower = _upper
		// would be invisible to every as-of predicate and pure waste.
		const versions = await rows<{owner: string}>(db, `SELECT owner FROM token WHERE id = ?`, '1');
		expect(versions).toHaveLength(1);
		expect(versions[0].owner).toBe('0xcarol');
	});
});

describe('replay after a revert cannot re-apply a recorded block', () => {
	it('re-applies a reorged height because the revert removed its block row first', async () => {
		const {db, p} = await freshProcessor();
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		// same HEIGHT, new hash: the block row for 100 must be gone before the new
		// one is inserted, or this is a primary-key violation.
		await p.process(
			[
				transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {removed: true}),
				transfer(100, '0xBBB', {from: '0x0', to: '0xcarol', id: 1n}),
			],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		const blocks = await rows<{number: number; hash: string}>(db, `SELECT number, hash FROM _blocks`);
		expect(blocks).toEqual([{number: 100, hash: '0xbbb'}]);
	});

	it('keeps two hashes at one height apart, so the collision is loud instead of merged', async () => {
		// The core dedupes blocks by HASH and warns that two hashes can share a height
		// in a merged fetch (`indexer.ts`), so grouping by height here would silently
		// fold two different blocks into one and apply a mixture of both branches
		// under one block row. Grouping by hash instead makes them two blocks, and two
		// blocks at one height is a primary-key violation the moment it is attempted.
		const {p} = await freshProcessor();
		await expect(
			p.process(
				[
					transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}),
					transfer(100, '0xBBB', {from: '0x0', to: '0xbob', id: 2n}),
				],
				lastSync({latestBlock: 100, lastToBlock: 100}),
			),
		).rejects.toThrow();
	});

	it('still raises loudly when the SAME block is genuinely applied twice', async () => {
		const {p} = await freshProcessor();
		const stream = [transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})];
		await p.process(stream, lastSync({latestBlock: 100, lastToBlock: 100}));
		// No retraction, so no revert: this is the caller bug the plain INSERT
		// exists to catch, and it must not be softened into an upsert here.
		await expect(p.process(stream, lastSync({latestBlock: 100, lastToBlock: 100}))).rejects.toThrow();
	});
});

describe('below-finality events', () => {
	it('are applied through the same write path, with no separate branch', async () => {
		const db = new RecordingSQL(createTestDB());
		const {p} = await freshProcessor(db);
		db.batches.length = 0;

		// latestBlock - lastToBlock > finality: the in-memory path calls this
		// `willNotChange` and stops recording reverse-patches for it.
		await p.process(
			[transfer(10, '0x10', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 1000, lastToBlock: 1000}),
		);

		const applyBatches = db.batches.filter((batch) => batch.some((s) => sqlOf(s).includes('INSERT INTO _blocks')));
		expect(applyBatches).toHaveLength(1);
		expect((await p.state.getAsOf<{owner: string}>('token', {id: '1'}, 10))?.owner).toBe('0xalice');
	});

	it('are never retracted, because the engine stops emitting retractions for them', async () => {
		// This is the contract's real content and it is the ENGINE's half: past the
		// finality window a block leaves `unconfirmedBlocks`, so no `removed: true`
		// can be emitted for it (pinned in core/test/utils.test.ts,
		// "does not track blocks as unconfirmed when they are older than the
		// finality window"). This processor therefore never sees one.
		//
		// Where the two paths differ is what WOULD happen if one arrived: the
		// in-memory path throws, having discarded the reverse-patches, while this
		// one would revert successfully, because in a versioned store the history
		// IS the state and nothing is ever discarded. That is a strictly wider
		// capability on a stream the engine does not produce, not a divergence in
		// observable state, and it is exactly the revisit ADR-0001 anticipated.
		const {p} = await freshProcessor();
		await p.process(
			[transfer(10, '0x10', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 1000, lastToBlock: 1000}),
		);
		await expect(
			p.process(
				[transfer(10, '0x10', {from: '0x0', to: '0xalice', id: 1n}, {removed: true})],
				lastSync({latestBlock: 1000, lastToBlock: 1000}),
			),
		).resolves.toBeDefined();
		expect(await p.state.getCurrent('token', {id: '1'})).toBeUndefined();
	});
});

describe('process before load', () => {
	it('refuses, because finality is not known yet', async () => {
		const p = new VersionedStateEventProcessor<TestABI>(createTestDB(), processor);
		await expect(
			p.process([transfer(100, '0xA', {from: '0x0', to: '0xa', id: 1n})], lastSync({latestBlock: 100})),
		).rejects.toThrow(/finality not set/);
		// and it works once loaded, so the guard is about ordering and nothing else
		await p.load(SOURCE, {finality});
		await expect(
			p.process([transfer(100, '0xA', {from: '0x0', to: '0xa', id: 1n})], lastSync({latestBlock: 100})),
		).resolves.toBeDefined();
	});
});
