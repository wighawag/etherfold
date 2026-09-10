import {describe, expect, it} from 'vitest';
import {
	BlockNotRetainedError,
	ENTITY_SNAPSHOT_FORMAT,
	MemoryStateStore,
	openSnapshotAware,
	RevertBeyondSnapshotError,
	SnapshotFormatError,
	SnapshotProcessorMismatchError,
	type StateSnapshot,
	type StateStoreBackend,
} from '../src/index.js';
import {ACCOUNT, TOKEN, block, owns} from './utils/fixtures.js';

/**
 * A store that starts from state somebody else computed, and stays honest about
 * the history it never received.
 *
 * The trap these cases exist for is one sentence long: a snapshot of CURRENT
 * rows carries nothing below the block it was taken at, so a store loaded from
 * it cannot answer an as-of read below that block -- and a freshly-migrated
 * store reports `unbounded`, which would be exactly the confident wrong number
 * this whole seam exists to prevent. So every case here is about a boundary:
 * where reads stop being answerable, where a revert stops being possible, and
 * that both boundaries survive the handle being reopened.
 */

const TAKEN_AT = 1_000;

function snapshotAt(number: number, options: Partial<StateSnapshot> = {}): StateSnapshot {
	return {
		format: ENTITY_SNAPSHOT_FORMAT,
		processor: 'proc-v1',
		savedAt: '2026-08-24T00:00:00.000Z',
		takenAt: block(number),
		cursor: {key: 'lastSync', value: `synced-through-${number}`},
		rows: [owns('1', '0xalice', 3), owns('2', '0xbob', 1)],
		...options,
	};
}

async function bootstrapped(inner?: StateStoreBackend, at = TAKEN_AT) {
	const store = await openSnapshotAware(inner ?? new MemoryStateStore([TOKEN, ACCOUNT]));
	await store.migrate();
	await store.bootstrap(snapshotAt(at), {processor: 'proc-v1'});
	return store;
}

describe('installing a snapshot', () => {
	it('lands the rows and the cursor that belongs to them as ONE unit', async () => {
		const store = await bootstrapped();

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 3});
		expect(await store.getCurrent('token', {id: '2'})).toMatchObject({owner: '0xbob'});
		expect(await store.readCursor('lastSync')).toBe(`synced-through-${TAKEN_AT}`);
	});

	it('refuses a snapshot computed by a different processor, naming both versions', async () => {
		const store = await openSnapshotAware(new MemoryStateStore([TOKEN, ACCOUNT]));
		await store.migrate();

		const refusal = await store
			.bootstrap(snapshotAt(TAKEN_AT, {processor: 'proc-v2'}), {processor: 'proc-v1'})
			.catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(SnapshotProcessorMismatchError);
		expect((refusal as SnapshotProcessorMismatchError).message).toContain('proc-v1');
		expect((refusal as SnapshotProcessorMismatchError).message).toContain('proc-v2');
		// and nothing landed: a refused snapshot leaves an empty store empty
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(store.capabilities.retention).toEqual({kind: 'unbounded'});
	});

	it('refuses a format it does not know rather than reading the fields it recognises', async () => {
		const store = await openSnapshotAware(new MemoryStateStore([TOKEN, ACCOUNT]));
		await store.migrate();

		await expect(store.bootstrap(snapshotAt(TAKEN_AT, {format: 99}))).rejects.toBeInstanceOf(SnapshotFormatError);
	});

	it('refuses a snapshot carrying a delete, because a snapshot is the rows that are LIVE', async () => {
		const store = await openSnapshotAware(new MemoryStateStore([TOKEN, ACCOUNT]));
		await store.migrate();

		await expect(
			store.bootstrap(snapshotAt(TAKEN_AT, {rows: [{type: 'delete', entity: 'token', id: {id: '1'}}]})),
		).rejects.toThrow(/delete/);
	});
});

describe('the retention a bootstrapped store reports', () => {
	it('is floored at the snapshot block, never the `unbounded` a fresh store would claim', async () => {
		const fresh = new MemoryStateStore([TOKEN, ACCOUNT]);
		expect(fresh.capabilities.retention).toEqual({kind: 'unbounded'});

		const store = await bootstrapped(fresh);

		// a window of zero blocks behind a tip that IS the snapshot block: the store
		// has exactly one block of history and says so.
		expect(store.capabilities.retention).toEqual({kind: 'window', blocks: 0});
		expect(store.capabilities.asOf).toBe(true);
	});

	it('widens as the store indexes past the snapshot, because that history it DID compute', async () => {
		const store = await bootstrapped();
		await store.applyBlock(block(TAKEN_AT + 5), [owns('1', '0xcarol', 4)]);

		expect(store.capabilities.retention).toEqual({kind: 'window', blocks: 5});
		expect(await store.getAsOf('token', {id: '1'}, TAKEN_AT)).toMatchObject({owner: '0xalice'});
		expect(await store.getAsOf('token', {id: '1'}, TAKEN_AT + 5)).toMatchObject({owner: '0xcarol'});
	});

	it('never claims more than the store underneath it was configured to keep', async () => {
		const windowed = new MemoryStateStore([TOKEN, ACCOUNT], {retention: {blocks: 64}, finalityDepth: 64});
		const store = await bootstrapped(windowed);
		await store.applyBlock(block(TAKEN_AT + 100), [owns('1', '0xcarol', 4)]);

		// 100 blocks of snapshot-derived history, but the store was told to keep 64:
		// the report is the tighter of the two, because both bound the same answer.
		expect(store.capabilities.retention).toEqual({kind: 'window', blocks: 64});
	});

	it('leaves a store that answers no historical read exactly as it found it', async () => {
		const revertOnly = new MemoryStateStore([TOKEN, ACCOUNT], {retention: 'revert-only'});
		const store = await bootstrapped(revertOnly);

		expect(store.capabilities.retention).toEqual({kind: 'revert-only'});
		expect(store.capabilities.asOf).toBe(false);
		await expect(store.getAsOf('token', {id: '1'}, TAKEN_AT)).rejects.toBeInstanceOf(BlockNotRetainedError);
	});
});

describe('reads below the floor', () => {
	it('are refused with the typed refusal, naming what was asked and what is kept', async () => {
		const store = await bootstrapped();

		const refusal = await store.getAsOf('token', {id: '1'}, TAKEN_AT - 1).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(BlockNotRetainedError);
		expect((refusal as BlockNotRetainedError).requested).toBe(TAKEN_AT - 1);
		expect((refusal as BlockNotRetainedError).retained).toEqual({from: TAKEN_AT, to: TAKEN_AT});
	});

	it('are refused for a listing too, not only for a point read', async () => {
		const store = await bootstrapped();

		await expect(store.listAsOf('token', {id: '1'}, TAKEN_AT - 1, 10)).rejects.toBeInstanceOf(BlockNotRetainedError);
		expect((await store.listAsOf('token', {id: '1'}, TAKEN_AT, 10)).rows).toHaveLength(1);
	});

	it('are answered at the floor itself, which is the block the rows are the state AS OF', async () => {
		const store = await bootstrapped();
		expect(await store.getAsOf('token', {id: '2'}, TAKEN_AT)).toMatchObject({owner: '0xbob'});
	});
});

describe('the floor survives the handle', () => {
	it('is recovered by a second handle over the same storage, rather than reverting to `unbounded`', async () => {
		const inner = new MemoryStateStore([TOKEN, ACCOUNT]);
		await bootstrapped(inner);

		// what a reload does: the storage is still there, the handle is new, and the
		// snapshot origin is read back out of it rather than remembered in a closure.
		const reopened = await openSnapshotAware(inner);

		expect(reopened.snapshotOrigin).toBe(TAKEN_AT);
		expect(reopened.capabilities.retention).toEqual({kind: 'window', blocks: 0});
		await expect(reopened.getAsOf('token', {id: '1'}, TAKEN_AT - 1)).rejects.toBeInstanceOf(BlockNotRetainedError);
	});

	it('is absent on a store nobody bootstrapped, which then passes straight through', async () => {
		const inner = new MemoryStateStore([TOKEN, ACCOUNT]);
		const store = await openSnapshotAware(inner);
		await store.migrate();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);

		expect(store.snapshotOrigin).toBeUndefined();
		expect(store.capabilities).toEqual(inner.capabilities);
		expect(await store.getAsOf('token', {id: '1'}, 10)).toMatchObject({owner: '0xalice'});
	});
});

describe('a reorg that reaches below the snapshot', () => {
	it('is refused loudly, naming the block asked for and the floor', async () => {
		const store = await bootstrapped();
		await store.applyBlock(block(TAKEN_AT + 1), [owns('1', '0xcarol', 4)]);

		const refusal = await store.revertTo(TAKEN_AT - 1).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(RevertBeyondSnapshotError);
		expect((refusal as RevertBeyondSnapshotError).keepUpTo).toBe(TAKEN_AT - 1);
		expect((refusal as RevertBeyondSnapshotError).snapshotOrigin).toBe(TAKEN_AT);
	});

	it('changes nothing, so a host that catches it still holds the state it had', async () => {
		const store = await bootstrapped();
		await store.applyBlock(block(TAKEN_AT + 1), [owns('1', '0xcarol', 4)]);

		await expect(store.revertTo(TAKEN_AT - 1)).rejects.toBeInstanceOf(RevertBeyondSnapshotError);

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol'});
		expect(store.snapshotOrigin).toBe(TAKEN_AT);
	});

	it('is allowed down to the snapshot block itself, which is a block the store holds', async () => {
		const store = await bootstrapped();
		await store.applyBlock(block(TAKEN_AT + 1), [owns('1', '0xcarol', 4)]);

		await store.revertTo(TAKEN_AT);

		expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
	});

	it('is not what a WIPE is: `revertTo(-1)` empties the store and drops the floor with it', async () => {
		// `EntityEventProcessor.reset()` is this call, and it must keep working: the
		// rows are gone, so there is no snapshot-derived history left to be honest
		// about, and the store goes back to claiming what it was configured to keep.
		const store = await bootstrapped();

		await store.revertTo(-1);

		expect(store.snapshotOrigin).toBeUndefined();
		expect(store.capabilities.retention).toEqual({kind: 'unbounded'});
		expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		expect(await store.readCursor('snapshotOrigin')).toBeUndefined();
	});
});
