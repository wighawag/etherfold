import {describe, expect, it} from 'vitest';
import {
	BlockUnavailableError,
	MemoryStateStore,
	openForReading,
	openForWriting,
	StoreWriterChangedError,
	WRITER_CLAIM_KEY,
	type ReadableStateStore,
	type StateStore,
	type WritableStateStore,
} from '../src/index.js';
import {ACCOUNT, block, owns, TOKEN} from './utils/fixtures.js';

/**
 * THE ABILITY TO MUTATE IS OBTAINED BY CLAIMING, AND IS A FACT OF THE TYPE.
 *
 * `openForWriting` is the one door onto the mutating surface: what it hands back
 * carries a `token`, so a `WritableStateStore` cannot be produced by holding a
 * store and hoping. That is what makes the claim impossible to FORGET, in the
 * same way ADR-0044 makes the stream's one-writer rule structural by handing a
 * follower a read-only stream view rather than asking it to behave.
 *
 * **`pnpm typecheck` is what runs half of this file.** The `@ts-expect-error`
 * lines below FAIL the typecheck if the call they guard starts compiling, which
 * is the only way to assert that a reader cannot write.
 *
 * What is NOT asserted here is the REFUSAL a second writer meets: this store
 * reports `singleWriter: false` honestly (its storage is an instance field, so
 * no second writer can reach it), and a token compared with itself is green,
 * tested and meaningless. That half is asked of the backends that can hold a
 * real claim, by the conformance suite's `a writer claims by opening` chapter.
 */

/** A store the way a host builds one, before anybody has claimed it. */
function built(): MemoryStateStore {
	return new MemoryStateStore([TOKEN, ACCOUNT]);
}

describe('opening a store for writing', () => {
	it('hands back a writable store carrying the token it claimed with', async () => {
		const writable = await openForWriting(built());

		expect(typeof writable.token).toBe('string');
		expect(writable.token.length).toBeGreaterThan(0);
	});

	it('migrates on the way, so a host has one call rather than two', async () => {
		// the same reason `openSnapshotAware` migrates: claiming is a WRITE, and a
		// store that has not been migrated has nothing to write to.
		const writable = await openForWriting(built());

		await writable.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		expect(await writable.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});

	it('is IDEMPOTENT per store instance: a second open is the SAME claim', async () => {
		// the shipped generation pattern hands ONE store instance to EVERY
		// generation (`createState: () => store`), so a second open has to be the
		// claim the first one made. Minting a fresh claim here would have building a
		// successor invalidate the canonical generation, and the guard would refuse
		// the process against ITSELF.
		const store = built();
		const first = await openForWriting(store);
		const second = await openForWriting(store);

		expect(second).toBe(first);
		expect(second.token).toBe(first.token);
	});

	it('is idempotent when the two opens race, rather than claiming twice', async () => {
		const store = built();
		const [first, second] = await Promise.all([openForWriting(store), openForWriting(store)]);

		expect(second).toBe(first);
	});

	it('returns the same claim when handed a store it already opened', async () => {
		const store = built();
		const writable = await openForWriting(store);

		expect(await openForWriting(writable)).toBe(writable);
	});

	it('lets two generations built over ONE store instance both write', async () => {
		// the documented `createState: () => store` shape, which is what makes a
		// second writer reachable INSIDE one tab: both generations claim, and both
		// must go on writing, because it is one writer holding one storage.
		const store = built();
		const canonical = await openForWriting(store);
		const successor = await openForWriting(store);

		await canonical.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		await successor.applyBlock(block(101), [owns('1', '0xbob', 2)]);
		await canonical.applyBlock(block(102), [owns('1', '0xcarol', 3)]);

		expect(await successor.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
	});

	it('leaves the cursor port exactly as it found it', async () => {
		// the claim is performed through the one seam verb that is a guaranteed
		// no-op -- clearing a key nothing ever wrote -- so opening for writing
		// changes no byte a caller can observe.
		const store = built();
		await store.migrate();
		await store.writeCursor('lastSync', '{"lastToBlock":100}');

		await openForWriting(store);

		expect(await store.readCursor('lastSync')).toBe('{"lastToBlock":100}');
		expect(await store.readCursor(WRITER_CLAIM_KEY)).toBeUndefined();
	});

	it('carries the whole mutating surface, so a writer needs nothing else', async () => {
		const writable = await openForWriting(built());

		await writable.applyBlock(block(100), [owns('1', '0xalice', 1)], {key: 'lastSync', value: 'at 100'});
		await writable.applyBlock(block(101), [owns('1', '0xbob', 2)]);
		await writable.writeCursor('lastSync', 'at 101');
		await writable.prune();
		await writable.revertTo(100);
		await writable.clearCursor('lastSync');

		expect(await writable.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		expect(await writable.readCursor('lastSync')).toBeUndefined();
	});

	it('reports what the store underneath reports, because it is the same store', async () => {
		const store = built();
		const writable = await openForWriting(store);

		expect(writable.capabilities).toEqual(store.capabilities);
		expect(writable.declarations).toBe(store.declarations);
		expect(await writable.readRetentionEnforcement()).toEqual(await store.readRetentionEnforcement());
	});
});

describe('opening a store for reading', () => {
	it('answers every read the store answers', async () => {
		const store = built();
		const writable = await openForWriting(store);
		await writable.applyBlock(block(100), [owns('1', '0xalice', 1)]);
		await writable.writeCursor('lastSync', 'at 100');

		const readable = openForReading(store);

		expect(await readable.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		expect((await readable.listCurrent('token', {id: '1'}, 10)).rows.length).toBe(1);
		expect(await readable.readCursor('lastSync')).toBe('at 100');
		expect(readable.capabilities).toEqual(store.capabilities);
	});

	it('does not SWALLOW a write, because there is no write to swallow', async () => {
		// `readOnlyStream` (ADR-0044) makes its writes no-ops, for a reason that
		// does not apply here: that seam's save is driven by the indexing loop, so
		// there is nowhere to not call it from. Here the caller holds the handle,
		// so the type is the whole guard and nothing is quietly discarded.
		const store = built();
		const readable = openForReading(store);

		expect(readable).toBe(store);
	});
});

describe('what a writer that LOST is told', () => {
	it('is not a read this store cannot answer', () => {
		// The `BlockUnavailableError` family is a fact about the STORE that a caller
		// answers by re-pinning or widening retention (ADR-0015, ADR-0019). This is the
		// WRITE path, and the mutation did not happen: the remedy is to stop writing and
		// become a reader, which no retention setting reaches. `RevertBeyondSnapshotError`
		// is kept out of that family on exactly this ground, and so is this.
		const refusal = new StoreWriterChangedError('applyBlock');

		expect(refusal).toBeInstanceOf(Error);
		expect(refusal).not.toBeInstanceOf(BlockUnavailableError);
		expect(refusal.name).toBe('StoreWriterChangedError');
		// the name is what a consumer across a package boundary recognises it by, where
		// a bundled app can hold two copies of this module and `instanceof` would miss.
		expect(refusal.operation).toBe('applyBlock');
	});
});

describe('the shape a reader holds', () => {
	it('does not compile a mutation through the readable type', () => {
		// Deliberately never CALLED: the assertions here are the `@ts-expect-error`
		// comments, which `pnpm typecheck` evaluates. Vitest strips types, so
		// running the body would only mutate a store nobody reads.
		function refusals(readable: ReadableStateStore, writable: WritableStateStore, seam: StateStore) {
			// @ts-expect-error a reader cannot apply a block: the ability to mutate is obtained by claiming
			readable.applyBlock(block(100), []);
			// @ts-expect-error nor move a cursor, which is how a position goes BACKWARDS silently
			readable.writeCursor('lastSync', 'at 100');
			// @ts-expect-error nor forget one
			readable.clearCursor('lastSync');
			// @ts-expect-error nor roll the state back under whoever holds the store
			readable.revertTo(100);
			// @ts-expect-error nor delete against a floor computed from a tip another writer moved
			readable.prune();

			// @ts-expect-error and a store that merely EXISTS is not a claim: the token cannot be forgotten
			const forged: WritableStateStore = seam;

			// the reads, on the other hand, are exactly the store's
			void readable.getCurrent('token', {id: '1'});
			void readable.getAsOf('token', {id: '1'}, 100);
			void readable.listCurrent('token', {id: '1'}, 10);
			void readable.listAsOf('token', {id: '1'}, 100, 10);
			void readable.readCursor('lastSync');
			void readable.readRetentionEnforcement();
			void readable.migrate();
			void readable.capabilities;
			void readable.declarations;
			// and a WRITER reads too: demoting to a reader is narrowing, never reopening
			void writable.getCurrent('token', {id: '1'});
			void openForReading(writable);
			void forged;
		}

		expect(typeof refusals).toBe('function');
	});
});
