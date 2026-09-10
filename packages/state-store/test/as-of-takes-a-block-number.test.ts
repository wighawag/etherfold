import {describe, expect, it} from 'vitest';
import {
	BlockNotRetainedError,
	BlockUnavailableError,
	InvalidBlockNumberError,
	MemoryStateStore,
	assertBlockNumber,
	assertRetained,
	isBlockNumber,
	type StateStoreCapabilities,
} from '../src/index.js';
import {TOKEN, block, owns} from './utils/fixtures.js';

/**
 * The guard that makes "as of WHAT" a question with only two answers.
 *
 * A historical read has exactly two honest outcomes: the row that was live then,
 * or a refusal saying the store cannot answer about that block. `undefined` is a
 * third thing and it means something else entirely -- the block is fine and the
 * entity was absent from it -- so an `at` that is not a block number at all must
 * never reach the version predicate, where it would compare unequal to every
 * range and come back as an ordinary absence.
 *
 * The check lives at the seam, next to `assertRetained` and inside it, because
 * every backend whose `getAsOf` takes a NUMBER already routes through that one
 * call. A backend with an addressing layer above it (`@etherfold/state-store-sqlite`
 * takes a height, a `{hash}` or a `{timestamp}`) resolves first and hands a
 * resolved number down, so the guard constrains it exactly as much as it should:
 * not at all.
 */

const unbounded: StateStoreCapabilities = {retention: {kind: 'unbounded'}, asOf: true, singleWriter: false};
const revertOnly: StateStoreCapabilities = {retention: {kind: 'revert-only'}, asOf: false, singleWriter: false};

describe('what counts as a block number', () => {
	it('is a whole, non-negative number and nothing else', () => {
		for (const at of [0, 1, 18_000_123]) expect(isBlockNumber(at), JSON.stringify(at)).toBe(true);
		for (const at of ['100', 1.5, -1, Number.NaN, null, undefined, {hash: '0x64'}, {number: 100}, 100n]) {
			expect(isBlockNumber(at), JSON.stringify(String(at))).toBe(false);
		}
	});

	it('is refused as a caller BUG rather than as a state of the store', () => {
		// deliberately OUTSIDE the `BlockUnavailableError` family. That family says
		// "this store cannot answer about that block", which a caller answers by
		// widening retention or re-pinning; this says the argument is not a block,
		// which is answered by fixing the call.
		const error = new InvalidBlockNumberError({hash: '0x64'});
		expect(error).toBeInstanceOf(TypeError);
		expect(error).not.toBeInstanceOf(BlockUnavailableError);
		expect(error.received).toEqual({hash: '0x64'});
	});
});

describe('the seam refuses an `at` that is not a block number', () => {
	it('throws before it asks what the store retains', async () => {
		expect(() => assertBlockNumber({hash: '0x64'})).toThrow(InvalidBlockNumberError);
		await expect(assertRetained(unbounded, '100' as never, () => 1_000)).rejects.toBeInstanceOf(
			InvalidBlockNumberError,
		);
	});

	it('says so even where every historical read is refused anyway', async () => {
		// a revert-only store refuses everything, but WHICH refusal it gives still
		// matters: a caller told "not retained" would go widening its retention.
		const error = await assertRetained(revertOnly, {hash: '0x64'} as never, () => 1_000).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(InvalidBlockNumberError);
		expect(error).not.toBeInstanceOf(BlockNotRetainedError);
	});

	it('lets an ordinary block number through untouched', async () => {
		await expect(assertRetained(unbounded, 100, () => 1_000)).resolves.toBeUndefined();
	});
});

describe('every backend inherits the guard through the one call it already makes', () => {
	it('refuses a hash handed to a store with no addressing layer, rather than answering `undefined`', async () => {
		// the observation this closes: `assertRetained` passed, the version
		// predicate compared an object against block numbers, matched nothing, and
		// the read came back as an ordinary "the token was absent then".
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xalice', 1)]);

		await expect(store.getAsOf('token', {id: '1'}, {hash: '0x64'} as never)).rejects.toBeInstanceOf(
			InvalidBlockNumberError,
		);
		await expect(store.listAsOf('token', {id: '1'}, {hash: '0x64'} as never, 10)).rejects.toBeInstanceOf(
			InvalidBlockNumberError,
		);
	});

	it('still answers `undefined` for a block that is real and an entity that was not', async () => {
		const store = new MemoryStateStore([TOKEN]);
		await store.migrate();
		await store.applyBlock(block(100), [owns('1', '0xalice', 1)]);

		expect(await store.getAsOf('token', {id: 'never-minted'}, 100)).toBeUndefined();
	});
});
