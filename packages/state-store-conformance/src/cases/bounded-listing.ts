import {createMutationContext, type StateStoreCapabilities} from '@etherfold/state-store';
import {expect} from 'vitest';
import {
	ID_ORDER_SAMPLE,
	ID_ORDER_SEQUENCES,
	LADDER_BASE,
	answersHistoryOverLadder,
	block,
	cases,
	claimedDepth,
	opened,
	placed,
	playersOf,
} from '../fixtures.js';
import type {ConformanceCase, IdOrder, StateStoreConformanceOptions, StateStoreFactory} from '../types.js';

const GROUP = 'bounded id-prefix listing';

/**
 * The one SET read at the seam, asked of every backend.
 *
 * A backend earns the right to be behind the seam by answering "which rows
 * belong to this parent" the same way as every other: ascending in the declared
 * id's own order, never more than the limit, and saying when the limit cut the
 * answer off. Those three are what a handler models a one-to-many on
 * (`@derivedFrom`-style: children keyed by their parent, the collection derived
 * WHEN READ), so a backend that gets any of them subtly wrong makes an idiomatic
 * model quietly incorrect rather than obviously broken.
 *
 * Nothing here looks at an access path: that a listing is an indexed range scan
 * rather than a scan-and-sort is a property of a particular backend, pinned in
 * that backend's own tests (`state-store-sqlite/test/listing.test.ts`).
 */
export function boundedListingCases(
	factory: StateStoreFactory,
	capabilities: StateStoreCapabilities,
	options: StateStoreConformanceOptions = {},
): ConformanceCase[] {
	const idOrder = options.idOrder ?? {};

	/**
	 * The ids of `ID_ORDER_SAMPLE` as children of epoch 7, one `position` each.
	 * The position column is where the sample lives, so the order under test is
	 * the order of one id column under a fixed prefix, and nothing else.
	 */
	function sampled(indexes: readonly number[] = ID_ORDER_SAMPLE.map((_, index) => index)) {
		return indexes.map((index) => ({
			type: 'upsert' as const,
			entity: 'placement',
			id: {epoch: 7, position: ID_ORDER_SAMPLE[index].id, playerIndex: 0},
			values: {player: ID_ORDER_SAMPLE[index].label},
		}));
	}

	/**
	 * What every id-order case asserts: the rows came back in EXACTLY the declared
	 * order. The limit covers every id written, so what is measured is the order
	 * and never which rows a cut kept.
	 */
	function expectOrder(read: string, rows: readonly Record<string, unknown>[], order: IdOrder = 'utf-8') {
		expect(playersOf(rows), `${read}, declared as ${order}`).toEqual(ID_ORDER_SEQUENCES[order]);
	}

	/** Three children of epoch 7, applied out of order, plus one of epoch 8. */
	async function withChildren() {
		const store = await opened(factory);
		await store.applyBlock(block(LADDER_BASE), [
			placed(7, 2, 0, '0xcarol'),
			placed(7, 1, 1, '0xbob'),
			placed(7, 1, 0, '0xalice'),
			placed(8, 0, 0, '0xzoe'),
		]);
		return store;
	}

	return [
		...cases(GROUP, {
			'answers with the children of the prefix, in ascending id order': async () => {
				const store = await withChildren();

				const listing = await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 10);

				// written in another order, and epoch 8 is a different parent
				expect(playersOf(listing.rows)).toEqual(['0xalice', '0xbob', '0xcarol']);
				expect(listing.truncated).toBe(false);
			},

			'narrows as the prefix lengthens, down to the whole id': async () => {
				const store = await withChildren();

				const cell = await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7, position: 1}, 10);
				const one = await store.listCurrent<Record<string, unknown>>(
					'placement',
					{epoch: 7, position: 1, playerIndex: 1},
					10,
				);

				expect(playersOf(cell.rows)).toEqual(['0xalice', '0xbob']);
				expect(playersOf(one.rows)).toEqual(['0xbob']);
			},

			'answers with the rows themselves, id columns included': async () => {
				// A listing whose rows cannot be told apart is useless: the id is what a
				// handler deletes, follows or keys anything else by. Id values are
				// strings on every backend, which is the one normalisation the model makes.
				const store = await withChildren();

				const listing = await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 10);

				expect(listing.rows[0]).toMatchObject({epoch: '7', position: '1', playerIndex: '0', player: '0xalice'});
			},

			'is empty, not an error, when the prefix has no children': async () => {
				const store = await withChildren();

				expect(await store.listCurrent('placement', {epoch: 9}, 10)).toMatchObject({rows: [], truncated: false});
			},

			'stops at the limit and SAYS it stopped': async () => {
				const store = await withChildren();

				const listing = await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 2);

				expect(playersOf(listing.rows)).toEqual(['0xalice', '0xbob']);
				expect(listing.truncated).toBe(true);
			},

			'does not claim truncation when the children exactly fill the limit': async () => {
				// The reason `truncated` is reported rather than inferred: a caller
				// comparing `rows.length` to the limit cannot tell these two apart, and
				// a cascade that stops early leaves orphans nobody notices.
				const store = await withChildren();

				expect((await store.listCurrent('placement', {epoch: 7}, 3)).truncated).toBe(false);
			},

			'refuses a prefix that is not a LEADING run of the declared id columns': async () => {
				const store = await withChildren();

				// skips `position`
				await expect(store.listCurrent('placement', {epoch: 7, playerIndex: 0}, 10)).rejects.toThrow(/placement/);
				// starts in the middle
				await expect(store.listCurrent('placement', {position: 1}, 10)).rejects.toThrow(/placement/);
				// no anchor at all: a listing is anchored at a key, never at a table
				await expect(store.listCurrent('placement', {}, 10)).rejects.toThrow(/placement/);
			},

			'refuses a limit that is not a positive whole number': async () => {
				const store = await withChildren();

				await expect(store.listCurrent('placement', {epoch: 7}, 0)).rejects.toThrow(/limit/i);
				await expect(store.listCurrent('placement', {epoch: 7}, -1)).rejects.toThrow(/limit/i);
			},

			'drops a deleted child from the listing without touching its siblings': async () => {
				const store = await withChildren();
				await store.applyBlock(block(LADDER_BASE + 1), [
					{type: 'delete', entity: 'placement', id: {epoch: 7, position: 1, playerIndex: 1}},
				]);

				expect(playersOf((await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 10)).rows)).toEqual(
					['0xalice', '0xcarol'],
				);
			},

			'un-derives the collection when the block that grew it is reverted': async () => {
				// The collection is derived WHEN READ, so a revert needs no separate
				// undo for it -- but only if the listing reads the same versions the
				// point reads do. A backend that reverted rows and not ranges shows here.
				const store = await withChildren();
				await store.applyBlock(block(LADDER_BASE + 1), [placed(7, 3, 0, '0xdan')]);
				expect((await store.listCurrent('placement', {epoch: 7}, 10)).rows).toHaveLength(4);

				await store.revertTo(LADDER_BASE);

				expect(playersOf((await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 10)).rows)).toEqual(
					['0xalice', '0xbob', '0xcarol'],
				);
			},

			// ADR-0021 does not say WHICH string order "lexicographic" is, and the
			// backends disagree, so each declares its own (`idOrder`) and this asserts
			// it POSITIVELY: a backend that changes its order, in either direction,
			// goes red here. Evidence for `the-listings-id-order-is-decided`, in
			// `docs/spikes/the-listings-id-order-per-backend/README.md`.
			'listCurrent ascends in the declared id order across the UTF-8 / UTF-16 boundary': async () => {
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), sampled());

				const listing = await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 10);

				expectOrder('listCurrent', listing.rows, idOrder.listCurrent);
				expect(listing.truncated).toBe(false);
			},

			'MutationContext.list, with ids staged in the block, ascends in the declared id order': async () => {
				// three ids stored, two staged: the merge sees both kinds on each side
				// of the boundary, and the limit still covers every one of them.
				const store = await opened(factory);
				await store.applyBlock(block(LADDER_BASE), sampled([0, 1, 2]));
				const {state} = createMutationContext(store);
				for (const mutation of sampled([3, 4])) state.set(mutation.entity, mutation.id, mutation.values);

				const listing = await state.list<Record<string, unknown>>('placement', {epoch: 7}, 10);

				expectOrder('MutationContext.list', listing.rows, idOrder.mutationContextList);
				expect(listing.truncated).toBe(false);
			},
		}),

		...(answersHistoryOverLadder(capabilities)
			? cases(GROUP, {
					'as of an old block, answers with the children that were live THEN': async () => {
						const store = await withChildren();
						await store.applyBlock(block(LADDER_BASE + 1), [
							{type: 'delete', entity: 'placement', id: {epoch: 7, position: 1, playerIndex: 0}},
							placed(7, 3, 0, '0xdan'),
						]);

						const now = await store.listCurrent<Record<string, unknown>>('placement', {epoch: 7}, 10);
						const then = await store.listAsOf<Record<string, unknown>>('placement', {epoch: 7}, LADDER_BASE, 10);

						expect(playersOf(now.rows)).toEqual(['0xbob', '0xcarol', '0xdan']);
						expect(playersOf(then.rows)).toEqual(['0xalice', '0xbob', '0xcarol']);
					},

					'is empty as of a block before the first child existed': async () => {
						const store = await withChildren();

						const before = await store.listAsOf('placement', {epoch: 7}, LADDER_BASE - 1, 10);

						expect(before.rows).toEqual([]);
					},

					'listAsOf ascends in the declared id order across the UTF-8 / UTF-16 boundary': async () => {
						const store = await opened(factory);
						await store.applyBlock(block(LADDER_BASE), sampled());
						// a later block, so the read is a historical one and not the tip
						await store.applyBlock(block(LADDER_BASE + 1), [placed(8, 0, 0, '0xzoe')]);

						const listing = await store.listAsOf<Record<string, unknown>>('placement', {epoch: 7}, LADDER_BASE, 10);

						expectOrder('listAsOf', listing.rows, idOrder.listAsOf);
						expect(listing.truncated).toBe(false);
					},
				})
			: claimedDepth(capabilities) === 0
				? cases(GROUP, {
						'refuses a historical listing it never claimed to answer': async () => {
							const store = await withChildren();

							// the same refusal as `getAsOf`, for the same reason: a collection
							// served from the tip is a plausible wrong answer, and a caller
							// cannot tell it from a true one.
							await expect(store.listAsOf('placement', {epoch: 7}, LADDER_BASE, 10)).rejects.toThrow();
						},
					})
				: // a window narrower than the ladder answers about some blocks and not
					// others, and where its edge falls is `declaredCapabilityCases`'s
					// subject, not this group's.
					[]),
	];
}
