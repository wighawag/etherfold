import {expect} from 'vitest';
import {LADDER_BASE, block, cases, opened, owns} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'a block is one atomic unit';

/**
 * A block's mutations apply as ONE unit, and a block is applied once.
 *
 * The point is not the transaction; it is what a caller can conclude. If a
 * failed block could leave half of itself behind, then a retry would double some
 * mutations and not others, and nothing downstream could tell which. So the
 * cases assert the caller-visible half: after a failed apply, the state is what
 * it was, and the block NUMBER is free again -- which is how the suite observes
 * "the block was not recorded" without asking a backend for its block table,
 * something the seam deliberately does not expose.
 *
 * The sharp edges are part of the contract rather than an implementation
 * accident. Applying one block twice raises instead of writing a second version,
 * because a caller that re-applies a block has a bug and the store is the only
 * place that can still see it: silently accepting it would leave two versions
 * open for one key, which every read from then on has to pick between.
 *
 * The same reasoning, one step wider, is why a height must be ABOVE the recorded
 * tip and not merely unused. A store's blocks move forward and a caller reverts
 * before it re-applies, so an offer at or below the tip is a writer working from
 * a position the store has passed -- a stale cursor, a second instance -- and
 * accepting it would open a version underneath the live one rather than after
 * it. An EMPTY store has no tip, so it admits whatever height its caller starts
 * at.
 */
export function blockAtomicityCases(factory: StateStoreFactory): ConformanceCase[] {
	/** A mutation naming an entity nobody declared: rejected, wherever it sits. */
	const undeclared = {type: 'upsert', entity: 'ghost', id: {id: '1'}, values: {}} as const;

	return cases(GROUP, {
		'a block whose mutations include a rejected one applies NONE of them': async () => {
			const store = await opened(factory);
			await expect(store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1), undeclared])).rejects.toThrow();

			expect(await store.getCurrent('token', {id: '1'})).toBeUndefined();
		},

		'a block that failed to apply was not recorded, so its height is free': async () => {
			const store = await opened(factory);
			await expect(store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1), undeclared])).rejects.toThrow();

			// the same height applies cleanly afterwards: nothing of the failed block
			// survived, not even the block itself.
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		},

		'applying the same block twice raises rather than writing a second version': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);

			await expect(store.applyBlock(block(LADDER_BASE), [owns('1', '0xbob', 2)])).rejects.toThrow();
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice', transferCount: 1});
		},

		'a block that carried no mutation is still recorded': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE));

			// which blocks exist is the CALLER's judgement: a block carrying a log
			// that changed nothing is still a block a consumer can pin, so the store
			// records every block it is handed and refuses the height afterwards.
			await expect(store.applyBlock(block(LADDER_BASE))).rejects.toThrow();
		},

		'a height that is not above the recorded tip raises, even where that height is free': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
			await store.applyBlock(block(LADDER_BASE + 2), [owns('1', '0xbob', 2)]);

			// nothing was ever recorded AT this height, so the duplicate-height refusal
			// has nothing to say about it. What refuses it is the TIP: applying here
			// would open a version beneath the live one rather than after it.
			await expect(store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xcarol', 3)])).rejects.toThrow();
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xbob', transferCount: 2});
		},

		'an EMPTY store admits any height, because there is no tip to be above': async () => {
			const store = await opened(factory);

			// the first block a store ever sees is whichever one its caller starts at: a
			// fresh index at a contract's start block, a rebuild resuming mid-chain, a
			// bootstrap installing a snapshot taken far above zero.
			await store.applyBlock(block(LADDER_BASE + 5_000), [owns('1', '0xalice', 1)]);
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		},

		'admits a height again once a revert has taken the tip back below it': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)]);
			await store.applyBlock(block(LADDER_BASE + 2), [owns('1', '0xbob', 2)]);

			// which is what a reorg IS on this seam: revert first, then apply the
			// canonical branch. The refusal above must leave that possible, or a store
			// could not accept the branch that replaces the one it just dropped.
			await store.revertTo(LADDER_BASE + 1);
			await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xcarol', 3)]);
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xcarol', transferCount: 3});
		},

		'a second hash claiming a height that is already recorded raises': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE, '0xaaa'), [owns('1', '0xalice', 1)]);

			// a reorged height must be REVERTED before its replacement is applied;
			// quietly accepting the replacement would leave two truths at one height.
			await expect(store.applyBlock(block(LADDER_BASE, '0xbbb'), [owns('1', '0xbob', 2)])).rejects.toThrow();
		},

		'a mutation naming an entity that was never declared is refused': async () => {
			const store = await opened(factory);
			await expect(store.applyBlock(block(LADDER_BASE), [undeclared])).rejects.toThrow(/ghost/);
		},
	});
}
