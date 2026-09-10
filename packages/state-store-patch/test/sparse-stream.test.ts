import {
	createMutationContext,
	type BlockPointer,
	type EntityDeclaration,
	type StateStore,
	type StateStoreBackend,
} from '@etherfold/state-store';
import {beforeEach, describe, expect, it} from 'vitest';
import {PatchStateStore, RevertBeyondPatchHistoryError} from '../src/index.js';

/**
 * The case this backend exists for, on the stream shape it will actually meet.
 *
 * A dense fixture (consecutive block numbers) makes this store look like a
 * time machine: `work/notes/findings/sqlite-in-the-browser.md` replayed
 * backwards on one and matched the recorded state at every depth to 64, on four
 * runtimes. A real contract does not produce one. On the launched stratagems
 * game on Base, event-bearing blocks are median **429 blocks apart**, and
 * history here is pruned by BLOCK-NUMBER distance from the tip, so at a finality
 * depth of 64 exactly ONE block's reversals survive: the tip's.
 *
 * So the stream below is sparse, at that measured median, and the three facts
 * asserted are the whole capability: backwards replay is CORRECT wherever the
 * patches exist, a revert inside the finality depth still reverses a counter
 * DOWN after a prune, and a revert deeper than the surviving patches is REFUSED
 * rather than approximated.
 */

/** The measured median gap between event-bearing blocks on the real stream. */
const SPARSE_GAP = 429;
const FINALITY = 64;
/** The block the real capture was reverted to in the finding; nothing else rests on it. */
const START = 13_364_821;

const ENTITIES: readonly EntityDeclaration[] = [
	{name: 'player', id: ['address'], fields: {computedPoints: 'integer'}},
	{name: 'token', id: ['id'], fields: {owner: 'text'}},
];

/** The event-bearing blocks of a sparse stream: far apart, in the store's own units. */
function sparseBlock(index: number): BlockPointer {
	const number = START + index * SPARSE_GAP;
	return {number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 2};
}

/**
 * The read-then-add-then-write accumulator, applied as one block.
 *
 * Written through the mutation context rather than as a literal mutation
 * because that is the shape of the canonical reorg bug: the next value is a
 * function of what the store currently reports, so a revert that leaves the old
 * value standing keeps points a reorged-out block awarded.
 */
async function award(store: StateStoreBackend, at: BlockPointer, address: string, points: number): Promise<void> {
	const {state, mutations} = createMutationContext(store);
	const player = await state.get<{computedPoints: number | null}>('player', {address});
	state.set('player', {address}, {computedPoints: (player?.computedPoints ?? 0) + points});
	state.set('token', {id: String(at.number)}, {owner: address});
	await store.applyBlock(at, mutations());
}

async function pointsOf(store: StateStore, address: string): Promise<number | undefined> {
	const player = await store.getCurrent<{computedPoints: number}>('player', {address});
	return player?.computedPoints;
}

describe('a sparse stream, pruned at the finality depth', () => {
	let store: PatchStateStore;

	beforeEach(async () => {
		store = new PatchStateStore(ENTITIES, {retention: 'revert-only', finalityDepth: FINALITY});
		await store.migrate();
		for (let index = 0; index < 4; index++) {
			await award(store, sparseBlock(index), '0xevil', 6);
		}
	});

	it('keeps exactly ONE block of reversals, the tip, because the gap dwarfs the depth', async () => {
		await store.prune();

		// 429 apart against a finality of 64: every earlier event-bearing block is
		// already out of reach by block NUMBER, which is why this backend
		// advertises `revert-only` rather than a window. No tuning returns it.
		expect(store.retainedReversals()).toEqual([sparseBlock(3).number]);
	});

	it('reverses to the FULL finality depth, with the accumulated counter going back DOWN', async () => {
		await store.prune();

		// the deepest revert the declared depth promises: `tip - finalityDepth`
		await store.revertTo(sparseBlock(3).number - FINALITY);

		// 18, not 24. The one assertion this store would be worth writing for.
		expect(await pointsOf(store, '0xevil')).toBe(18);
		expect(await store.getCurrent('token', {id: String(sparseBlock(3).number)})).toBeUndefined();
		expect(await store.getCurrent('token', {id: String(sparseBlock(2).number)})).toMatchObject({owner: '0xevil'});
	});

	it('REFUSES a revert whose reverse patches have been pruned, and changes nothing', async () => {
		await store.prune();

		const error = await store.revertTo(sparseBlock(1).number).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RevertBeyondPatchHistoryError);
		// only the tip's reversals survived the prune, so the block below it is the
		// one that cannot be undone; the tip itself could have been.
		expect((error as RevertBeyondPatchHistoryError).missing).toEqual([sparseBlock(2).number]);
		expect((error as RevertBeyondPatchHistoryError).deepest).toBe(sparseBlock(2).number);
		// the refusal is atomic: a half-reverted state would be exactly the
		// plausible wrong answer this whole design refuses to produce.
		expect(await pointsOf(store, '0xevil')).toBe(24);
		expect(await store.getCurrent('token', {id: String(sparseBlock(3).number)})).toMatchObject({owner: '0xevil'});
	});

	it('names the depth it could not reach, so the message is actionable rather than "failed"', async () => {
		await store.prune();

		await expect(store.revertTo(START)).rejects.toThrow(/finality depth of 64/);
		await expect(store.revertTo(START)).rejects.toThrow(/re-?index/i);
	});
});

describe('a sparse stream nobody has pruned', () => {
	it('replays backwards correctly at every depth, which is what the patches are', async () => {
		// The capability is withdrawn by SPARSITY, not by cost or by correctness:
		// where the reversals still exist, backwards replay reproduces the recorded
		// state exactly (verified at every depth to 64 on four runtimes in the
		// finding). A host that never prunes keeps them all, and this is that.
		const store = new PatchStateStore(ENTITIES);
		await store.migrate();

		const recorded: Record<string, unknown>[] = [];
		for (let index = 0; index < 6; index++) {
			await award(store, sparseBlock(index), '0xevil', 6);
			recorded.push({points: await pointsOf(store, '0xevil'), last: sparseBlock(index).number});
		}

		for (let depth = 1; depth <= 5; depth++) {
			const replay = new PatchStateStore(ENTITIES);
			await replay.migrate();
			for (let index = 0; index < 6; index++) await award(replay, sparseBlock(index), '0xevil', 6);

			await replay.revertTo(sparseBlock(5 - depth).number);

			const expected = recorded[5 - depth];
			expect(await pointsOf(replay, '0xevil'), `depth ${depth}`).toBe(expected.points);
			expect(await replay.getCurrent('token', {id: String(expected.last)}), `depth ${depth}`).toMatchObject({
				owner: '0xevil',
			});
			expect(
				await replay.getCurrent('token', {id: String(sparseBlock(6 - depth).number)}),
				`depth ${depth}`,
			).toBeUndefined();
		}
	});

	it('reverts a delete on a sparse stream back into a live row', async () => {
		const store = new PatchStateStore(ENTITIES);
		await store.migrate();
		await award(store, sparseBlock(0), '0xevil', 6);
		await store.applyBlock(sparseBlock(1), [
			{type: 'delete', entity: 'token', id: {id: String(sparseBlock(0).number)}},
		]);
		expect(await store.getCurrent('token', {id: String(sparseBlock(0).number)})).toBeUndefined();

		await store.revertTo(sparseBlock(0).number);

		expect(await store.getCurrent('token', {id: String(sparseBlock(0).number)})).toMatchObject({owner: '0xevil'});
	});

	it('prunes nothing when no finality depth was declared, because no floor was stated', async () => {
		const store = new PatchStateStore(ENTITIES);
		await store.migrate();
		for (let index = 0; index < 3; index++) await award(store, sparseBlock(index), '0xevil', 6);

		const report = await store.prune();

		expect(report).toMatchObject({tip: sparseBlock(2).number, floor: undefined, versionsDeleted: 0, complete: true});
		expect(store.retainedReversals()).toHaveLength(3);
	});
});
