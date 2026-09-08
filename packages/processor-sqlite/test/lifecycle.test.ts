import {describe, expect, it} from 'vitest';
import {VersionedStateEventProcessor, type SQLProcessor} from '../src/index.js';
import {createTestDB, rows} from './utils/db.js';
import {
	finality,
	freshProcessor,
	lastSync,
	ownerOf,
	processor,
	SOURCE,
	timestampOf,
	transfer,
	type TestABI,
} from './utils/fixtures.js';

// Every processor VARIANT below is annotated `SQLProcessor<TestABI>`. The handler
// map MAPS over the ABI's event names, so `ABI` is not inferrable from an object
// LITERAL: a bare spread of `processor` widens to the `Abi` constraint and the
// handlers it just copied stop matching the resulting index signature.

describe('the sync cursor', () => {
	it('is absent before the first sync, so the core starts fresh', async () => {
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		expect(await p.load(SOURCE, {finality})).toBeUndefined();
	});

	it('survives a restart against the same database, with the state it points at', async () => {
		const db = createTestDB();
		const {p} = await freshProcessor(db);
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100, lastFromBlock: 88}),
		);

		const restarted = new VersionedStateEventProcessor(db, processor);
		const loaded = await restarted.load(SOURCE, {finality});
		expect(loaded?.lastSync.lastToBlock).toBe(100);
		expect(loaded?.lastSync.lastFromBlock).toBe(88);
		expect(loaded?.lastSync.context).toEqual(lastSync().context);
		expect((await loaded?.state.getCurrent<{owner: string}>('token', {id: '1'}))?.owner).toBe('0xalice');
	});

	it('is returned even when the stored context does not match, so the core can clear', async () => {
		// This is the reason the cursor is ONE key rather than one key per context.
		// The core's discard-and-clear branch lives inside `if (loaded)`; a
		// context-keyed table would answer "no row" after a processor upgrade,
		// `load` would return undefined, and the previous processor's entity rows
		// would silently survive into the new run. See `SYNC_CURSOR_KEY`.
		const db = createTestDB();
		const {p} = await freshProcessor(db);
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);

		const v2: SQLProcessor<TestABI> = {...processor, version: '2.0.0'};
		const upgraded = new VersionedStateEventProcessor(db, v2);
		const loaded = await upgraded.load(SOURCE, {finality});
		expect(loaded).toBeDefined();
		expect(loaded!.lastSync.context.processor).not.toBe(upgraded.getVersionHash());

		// ...and the core's response to that mismatch leaves nothing behind
		await upgraded.clear();
		expect(await rows(db, `SELECT * FROM token`)).toEqual([]);
		expect(await upgraded.load(SOURCE, {finality})).toBeUndefined();
	});

	it('survives the BigInt args a real decoded event carries', async () => {
		// Found end-to-end against a real anvil, not by any hand-built stream:
		// `unconfirmedBlocks` holds the actual LogEvents of the reorg window, and a
		// decoded `uint256` arg is a BigInt, which plain JSON.stringify REFUSES to
		// serialize. Every cursor in these tests had an empty unconfirmed window, so
		// the first real Transfer was the first thing to hit it.
		const db = createTestDB();
		const {p} = await freshProcessor(db);
		const unconfirmed = transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 7n});
		await p.process(
			[unconfirmed],
			lastSync({
				latestBlock: 100,
				lastToBlock: 100,
				unconfirmedBlocks: [{number: 100, hash: '0xAAA', events: [unconfirmed]}],
			}),
		);

		const restarted = new VersionedStateEventProcessor(db, processor);
		const loaded = await restarted.load(SOURCE, {finality});
		const arg = (loaded!.lastSync.unconfirmedBlocks[0].events[0] as any).args.id;
		// and it comes back a BigInt, not the string it was stored as: a cursor that
		// round-trips into a different TYPE would silently change what a replayed
		// handler computes.
		expect(arg).toBe(7n);
		expect(typeof arg).toBe('bigint');
	});

	it('is only overwritten, never duplicated', async () => {
		const {db, p} = await freshProcessor();
		await p.process([], lastSync({latestBlock: 100, lastToBlock: 100}));
		await p.process([], lastSync({latestBlock: 101, lastToBlock: 101}));
		// `_cursor` is the STORE's table (an opaque string under a key), not this
		// package's old `_sync`: the cursor moved behind the seam so it could be
		// written in the same transaction as the block it describes. See `src/sync.ts`.
		const stored = await rows<{key: string}>(db, `SELECT "key" FROM _cursor`);
		expect(stored).toHaveLength(1);
	});
});

describe('getVersionHash', () => {
	it('changes when the processor version changes', () => {
		const v2: SQLProcessor<TestABI> = {...processor, version: '2.0.0'};
		const a = new VersionedStateEventProcessor(createTestDB(), processor);
		const b = new VersionedStateEventProcessor(createTestDB(), v2);
		expect(a.getVersionHash()).not.toBe(b.getVersionHash());
	});

	it('changes when the entity SCHEMA changes, even at the same version', () => {
		// The schema is part of what the stored rows MEAN. A renamed field at an
		// unchanged version would otherwise let the core adopt rows whose columns
		// no longer say what the handlers now assume.
		const renamedField: SQLProcessor<TestABI> = {
			...processor,
			entities: [{name: 'token', id: ['id'], fields: {holder: 'text'}}, processor.entities[1]],
		};
		const a = new VersionedStateEventProcessor(createTestDB(), processor);
		const b = new VersionedStateEventProcessor(createTestDB(), renamedField);
		expect(a.getVersionHash()).not.toBe(b.getVersionHash());
	});

	it('is stable across instances of the same processor', () => {
		const a = new VersionedStateEventProcessor(createTestDB(), processor);
		const b = new VersionedStateEventProcessor(createTestDB(), processor);
		expect(a.getVersionHash()).toBe(b.getVersionHash());
	});
});

describe('reset and clear', () => {
	it('wipe state, history and the cursor together', async () => {
		const {db, p} = await freshProcessor();
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		await p.reset();

		expect(await ownerOf(p, '1')).toBeUndefined();
		expect(await rows(db, `SELECT * FROM token`)).toEqual([]);
		expect(await rows(db, `SELECT * FROM counter`)).toEqual([]);
		expect(await rows(db, `SELECT * FROM _blocks`)).toEqual([]);
		expect(await rows(db, `SELECT * FROM _cursor`)).toEqual([]);
		// no history is left behind either: a wiped store cannot time-travel
		expect(await p.state.getAsOf('token', {id: '1'}, 100)).toBeUndefined();
	});

	it('leave the database usable, so indexing can start again from scratch', async () => {
		const {p} = await freshProcessor();
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		await p.clear();
		// the SAME block may be applied again: the revert removed its block row
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xzoe', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		expect(await ownerOf(p, '1')).toBe('0xzoe');
	});
});

describe('the blockTimestamp requirement', () => {
	it('loads on a stream config of nothing but `finality`, because the log carries the time', async () => {
		// Nodes implementing execution-apis#639 put `blockTimestamp` on the log, and
		// there is no longer any flag that could buy one otherwise: the fallback that
		// fetched the block is deleted (ADR-0073). So the time axis is never something
		// a deployment has to opt into here.
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		await expect(p.load(SOURCE, {finality})).resolves.toBeUndefined();
	});

	it('records the timestamp straight off the log, with no extra fetch', async () => {
		const {db, p} = await freshProcessor();
		await p.process(
			[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n})],
			lastSync({latestBlock: 100, lastToBlock: 100}),
		);
		const [block] = await rows<{timestamp: number}>(db, `SELECT timestamp FROM _blocks`);
		expect(block.timestamp).toBe(timestampOf(100));
	});

	it('refuses a block whose events carry no timestamp, rather than guessing', async () => {
		// The one guarantee that survives everywhere: a block is never recorded on a
		// guess. A zero would not fail, it would answer confidently about the wrong
		// block forever, and the read side has no way to tell a caller it was lied to.
		const p = new VersionedStateEventProcessor(createTestDB(), processor);
		await p.load(SOURCE, {finality});
		await expect(
			p.process(
				[transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}, {blockTimestamp: undefined} as any)],
				lastSync({latestBlock: 100, lastToBlock: 100}),
			),
		).rejects.toThrow(/no blockTimestamp/);
	});
});
