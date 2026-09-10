import {BlockNotRetainedError, BlockUnavailableError} from '@etherfold/state-store';
import type {RemoteSQL} from 'remote-sql';
import {describe, expect, it} from 'vitest';
import {NoSuchBlockError, VersionedStateStore, type EntityDeclaration} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {TOKEN, block, owns} from './utils/fixtures.js';

/** A shipped store configured with a window, which it now enforces on both halves. */
function windowed(blocks = 60, declarations: EntityDeclaration[] = [TOKEN]) {
	return new VersionedStateStore(createTestDB(), declarations, {retention: {blocks}, finalityDepth: blocks});
}

/**
 * A backend states what it can do BEFORE anyone asks it a question, which is the
 * difference between discovering a missing capability at startup and discovering
 * it from a wrong number in production.
 *
 * That a claim is HONOURED -- answering inside a window, refusing outside it,
 * refusing everything when the store keeps history for revert alone -- is
 * asserted against every backend by `@etherfold/state-store-conformance` (see
 * `conformance.test.ts`), which reads the report and tests behaviour against it.
 * What is asserted here is what only this package can say: WHICH claim it makes
 * and why, what it does with a retention setting a deployment writes, and how
 * the refusal behaves on the surfaces that are this backend's own (the
 * whole-table query and the hash and timestamp address axes).
 */
describe('declared capabilities', () => {
	it('are readable before migrate and before any read', () => {
		const store = new VersionedStateStore(createTestDB(), [TOKEN]);
		expect(store.capabilities).toEqual({retention: {kind: 'unbounded'}, asOf: true, singleWriter: true});
	});

	it('default to `unbounded`, which keeps everything and prunes nothing', async () => {
		const store = new VersionedStateStore(createTestDB(), [TOKEN]);
		await store.migrate();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_000_000), [owns('1', '0xbob', 2)]);
		await store.prune();

		// a million blocks later, and after a prune, the first version is still
		// readable: nothing was ever asked to be dropped.
		expect(store.capabilities.retention).toEqual({kind: 'unbounded'});
		expect(await store.getAsOf<{owner: string}>('token', {id: '1'}, 10)).toMatchObject({owner: '0xalice'});
	});
});

describe('a retention setting a deployment writes', () => {
	it('is validated where it is written, not at the first read it would break', () => {
		expect(
			() => new VersionedStateStore(createTestDB(), [TOKEN], {retention: {blocks: 32}, finalityDepth: 64}),
		).toThrow(/32[\s\S]*64|64[\s\S]*32/);
	});

	it('is REPORTED, because this store enforces the window it was given', async () => {
		const store = new VersionedStateStore(createTestDB(), [TOKEN], {retention: {blocks: 128}, finalityDepth: 64});
		await store.migrate();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_000_000), [owns('1', '0xbob', 2)]);

		expect(store.capabilities.retention).toEqual({kind: 'window', blocks: 128});
		// refused on read whether or not the host has pruned yet: the report is about
		// what a caller may rely on, and it must never promise history that is gone.
		await expect(store.getAsOf('token', {id: '1'}, 10)).rejects.toBeInstanceOf(BlockNotRetainedError);
	});

	it('refuses a duration on the way in', () => {
		expect(() => new VersionedStateStore(createTestDB(), [TOKEN], {retention: {seconds: 3600} as never})).toThrow(
			/block/i,
		);
	});
});

describe('a store set to `revert-only`', () => {
	function revertOnly(db: RemoteSQL = createTestDB(), declarations: EntityDeclaration[] = [TOKEN]) {
		return new VersionedStateStore(db, declarations, {retention: 'revert-only'});
	}

	it('reports that it answers no as-of read', () => {
		expect(revertOnly().capabilities).toEqual({retention: {kind: 'revert-only'}, asOf: false, singleWriter: true});
	});

	it("refuses on the read surfaces that are this backend's own, not only at the seam", async () => {
		const store = revertOnly();
		await store.migrate();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(20), [owns('1', '0xbob', 2)]);

		await expect(store.queryAsOf('token', 10)).rejects.toBeInstanceOf(BlockNotRetainedError);
		// including through the hash axis, which resolves perfectly well
		await expect(store.getAsOf('token', {id: '1'}, {hash: block(10).hash})).rejects.toBeInstanceOf(
			BlockNotRetainedError,
		);
		// and the tip is still readable, through the read that is honestly about the tip
		expect(await store.getCurrent<{owner: string}>('token', {id: '1'})).toMatchObject({owner: '0xbob'});
	});
});

describe('a store that claims a window', () => {
	it('refuses a whole-table query outside the window too', async () => {
		const store = windowed();
		await store.migrate();
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);

		await expect(store.queryAsOf('token', 10)).rejects.toBeInstanceOf(BlockNotRetainedError);
		expect(await store.queryAsOf('token', 999)).toEqual([]);
	});

	it('refuses on the address axes as well, after they resolve', async () => {
		const store = windowed();
		await store.migrate();
		await store.applyBlock(block(10), [owns('1', '0xalice', 1)]);
		await store.applyBlock(block(1_000), [owns('1', '0xbob', 2)]);

		// a hash that resolves fine, to a block whose history is no longer retained:
		// two different pieces of news, so two different errors of one family.
		await expect(store.getAsOf('token', {id: '1'}, {hash: block(10).hash})).rejects.toBeInstanceOf(
			BlockNotRetainedError,
		);
		await expect(store.getAsOf('token', {id: '1'}, {hash: '0xdeadbeef'})).rejects.toBeInstanceOf(NoSuchBlockError);
	});
});

describe('the refusals are one family', () => {
	it('so a caller can catch "my historical read did not happen" once', async () => {
		const store = windowed();
		await store.migrate();
		await store.applyBlock(block(1_000), [owns('1', '0xalice', 1)]);

		for (const address of [10, {hash: '0xdeadbeef'}]) {
			const error = await store.getAsOf('token', {id: '1'}, address).catch((e) => e);
			expect(error, JSON.stringify(address)).toBeInstanceOf(BlockUnavailableError);
		}
	});
});
