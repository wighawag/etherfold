import {describe, expect, it} from 'vitest';
import {MemoryStateStore, compareIds, createMutationContext} from '../src/index.js';
import {PLACEMENT, TOKEN, block} from './utils/fixtures.js';

/**
 * The one SET read at the seam: the rows whose declared id starts with a prefix,
 * bounded by a required limit.
 *
 * Tested here rather than through a backend because both halves are implemented
 * once, above the backend interface: the prefix rule (a listing prefix is a
 * LEADING run of the declared id columns) and the merge of the block's staging
 * area into the scan, which is what makes a listing read-your-writes the same
 * way `get` does.
 */

const CHILDREN = [
	{epoch: 7, position: 2, playerIndex: 0, player: '0xcarol'},
	{epoch: 7, position: 1, playerIndex: 1, player: '0xbob'},
	{epoch: 7, position: 1, playerIndex: 0, player: '0xalice'},
	{epoch: 8, position: 0, playerIndex: 0, player: '0xzoe'},
];

async function withChildren(): Promise<MemoryStateStore> {
	const store = new MemoryStateStore([PLACEMENT]);
	await store.migrate();
	await store.applyBlock(
		block(10),
		CHILDREN.map(({player, ...id}) => ({type: 'upsert' as const, entity: 'placement', id, values: {player}})),
	);
	return store;
}

/** `player` per row, which is enough to name a child and see its order. */
function players(rows: readonly Record<string, unknown>[]): unknown[] {
	return rows.map((row) => row.player);
}

describe('a listing is a bounded range scan over a prefix of the declared id', () => {
	it('answers with the children of the prefix, in ascending id order', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		const {rows} = await state.list('placement', {epoch: 7}, 10);

		// ascending over (position, playerIndex), which is the id's own order and
		// what the range scan gives for free; `epoch: 8` is a different parent.
		expect(players(rows)).toEqual(['0xalice', '0xbob', '0xcarol']);
	});

	it('takes a LONGER prefix down to the whole id', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		expect(players((await state.list('placement', {epoch: 7, position: 1}, 10)).rows)).toEqual(['0xalice', '0xbob']);
		expect(players((await state.list('placement', {epoch: 7, position: 1, playerIndex: 1}, 10)).rows)).toEqual([
			'0xbob',
		]);
	});

	it('answers with the rows themselves, id columns included, so a child can be told apart and deleted', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		const {rows} = await state.list<Record<string, unknown>>('placement', {epoch: 7, position: 1}, 10);

		// id values are strings on every backend: that is the one normalisation the
		// model makes, and a listing cannot be useful without them.
		expect(rows[0]).toMatchObject({epoch: '7', position: '1', playerIndex: '0', player: '0xalice'});
	});

	it('is empty rather than an error when the prefix names no children', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		expect(await state.list('placement', {epoch: 9}, 10)).toEqual({rows: [], truncated: false});
	});
});

describe('the prefix must be a LEADING run of the declared id columns', () => {
	it('refuses a prefix that skips a column, naming the entity and its columns', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		await expect(state.list('placement', {epoch: 7, playerIndex: 0}, 10)).rejects.toThrow(
			/placement.*epoch, position, playerIndex/s,
		);
	});

	it('refuses a prefix that starts in the middle', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		await expect(state.list('placement', {position: 1}, 10)).rejects.toThrow(/leading/i);
	});

	it('refuses a column the entity never declared', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		await expect(state.list('placement', {epoch: 7, colour: 'red'}, 10)).rejects.toThrow(/placement/);
	});

	it('refuses an EMPTY prefix: a listing is anchored at a key, never at a whole table', async () => {
		// This is what keeps the operation an indexed range scan on every backend.
		// Unanchored, SQLite stops riding the id index and sorts, which is exactly
		// the accidental scan the bound exists to make inexpressible.
		const store = await withChildren();
		const {state} = createMutationContext(store);

		await expect(state.list('placement', {}, 10)).rejects.toThrow(/at least/i);
	});

	it('refuses a limit that is not a positive whole number', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		await expect(state.list('placement', {epoch: 7}, 0)).rejects.toThrow(/limit/i);
		await expect(state.list('placement', {epoch: 7}, -1)).rejects.toThrow(/limit/i);
		await expect(state.list('placement', {epoch: 7}, 1.5)).rejects.toThrow(/limit/i);
	});
});

describe('the limit is required, and truncation is a fact rather than an inference', () => {
	it('makes omitting the limit a TYPE error, not a default', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		// There is no default bound and there deliberately never will be one: a
		// default is a bound nobody chose, and the first collection to outgrow it
		// would get a silently short answer. (`pnpm typecheck` is what runs this
		// assertion: the line below fails to compile if the limit becomes optional.)
		// @ts-expect-error the limit is required
		await expect(state.list('placement', {epoch: 7})).rejects.toThrow(/limit/i);
	});

	it('has nowhere to put a predicate, a sort or an offset', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		// An accidental full scan must be impossible to EXPRESS rather than merely
		// discouraged, so the signature has no options bag to grow one on.
		// @ts-expect-error a listing takes an entity, a prefix and a limit, and nothing else
		await state.list('placement', {epoch: 7}, 10, {orderBy: 'player', offset: 1});
	});

	it('stops at the limit and SAYS it stopped', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		const listing = await state.list('placement', {epoch: 7}, 2);

		expect(players(listing.rows)).toEqual(['0xalice', '0xbob']);
		expect(listing.truncated).toBe(true);
	});

	it('does NOT claim truncation when the set exactly fills the limit', async () => {
		// The reason `truncated` exists: `rows.length === limit` cannot tell an
		// exact answer from a cut-off one, and a handler that guesses wrong leaves
		// orphans behind.
		const store = await withChildren();
		const {state} = createMutationContext(store);

		expect((await state.list('placement', {epoch: 7}, 3)).truncated).toBe(false);
	});
});

describe('read-your-writes: the block being processed is part of the listing', () => {
	it('shows exactly the surviving set to a later event in the SAME block', async () => {
		const store = await withChildren();
		const {state, mutations} = createMutationContext(store);

		// event 1 of this block: two children written, a third deleted
		state.set('placement', {epoch: 7, position: 3, playerIndex: 0}, {player: '0xdan'});
		state.set('placement', {epoch: 7, position: 0, playerIndex: 0}, {player: '0xerin'});
		state.delete('placement', {epoch: 7, position: 1, playerIndex: 1});

		// event 2 of the same block, before anything is applied
		const {rows, truncated} = await state.list('placement', {epoch: 7}, 10);

		expect(players(rows)).toEqual(['0xerin', '0xalice', '0xcarol', '0xdan']);
		expect(truncated).toBe(false);

		// and the store agrees once the block lands
		await store.applyBlock(block(11), mutations());
		const {state: next} = createMutationContext(store);
		expect(players((await next.list('placement', {epoch: 7}, 10)).rows)).toEqual([
			'0xerin',
			'0xalice',
			'0xcarol',
			'0xdan',
		]);
	});

	it('lets a staged write REPLACE the stored row rather than duplicate it', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		state.set('placement', {epoch: 7, position: 1, playerIndex: 0}, {player: '0xnew'});

		expect(players((await state.list('placement', {epoch: 7}, 10)).rows)).toEqual(['0xnew', '0xbob', '0xcarol']);
	});

	it('fills the limit from BEYOND the rows this block deleted', async () => {
		// The arithmetic that is easy to get wrong: a row deleted in this block
		// still occupies a slot in the store's answer and none in ours, so asking
		// the store for exactly `limit` rows would come back short.
		const store = await withChildren();
		const {state} = createMutationContext(store);

		state.delete('placement', {epoch: 7, position: 1, playerIndex: 0});

		const listing = await state.list('placement', {epoch: 7}, 2);
		expect(players(listing.rows)).toEqual(['0xbob', '0xcarol']);
		expect(listing.truncated).toBe(false);
	});

	it('gives a row staged in this block the same shape as one read from the store', async () => {
		const store = await withChildren();
		const {state} = createMutationContext(store);

		// `player` is not mentioned: a version is a COMPLETE row, so it lists as null
		state.set('placement', {epoch: 9, position: 0, playerIndex: 0}, {});

		const {rows} = await state.list<Record<string, unknown>>('placement', {epoch: 9}, 10);
		expect(rows[0]).toEqual({epoch: '9', position: '0', playerIndex: '0', player: null});
	});

	it('is a listing of ONE entity, not of everything staged in the block', async () => {
		const store = new MemoryStateStore([PLACEMENT, TOKEN]);
		await store.migrate();
		const {state} = createMutationContext(store);

		state.set('token', {id: '7'}, {owner: '0xalice', transferCount: 1});
		state.set('placement', {epoch: 7, position: 0, playerIndex: 0}, {player: '0xalice'});

		expect((await state.list('placement', {epoch: 7}, 10)).rows).toHaveLength(1);
	});
});

describe('a listing as of an old block answers about that block', () => {
	it('returns the children that were live then, not the ones live now', async () => {
		const store = await withChildren();
		await store.applyBlock(block(11), [
			{type: 'delete', entity: 'placement', id: {epoch: 7, position: 1, playerIndex: 0}},
			{
				type: 'upsert',
				entity: 'placement',
				id: {epoch: 7, position: 9, playerIndex: 0},
				values: {player: '0xlate'},
			},
		]);

		expect(players((await store.listCurrent('placement', {epoch: 7}, 10)).rows)).toEqual([
			'0xbob',
			'0xcarol',
			'0xlate',
		]);
		expect(players((await store.listAsOf('placement', {epoch: 7}, 10, 10)).rows)).toEqual([
			'0xalice',
			'0xbob',
			'0xcarol',
		]);
	});

	it('refuses a historical listing on a store that answers no history', async () => {
		const store = new MemoryStateStore([PLACEMENT], {retention: 'revert-only'});
		await store.migrate();
		await store.applyBlock(block(10), [
			{type: 'upsert', entity: 'placement', id: {epoch: 7, position: 0, playerIndex: 0}, values: {player: '0xa'}},
		]);

		await expect(store.listAsOf('placement', {epoch: 7}, 10, 10)).rejects.toThrow();
	});
});

describe('the id order is UTF-8 bytes, which is code point order (ADR-0021)', () => {
	// U+E000 and U+1F600 are the one pair the two binary string orders disagree
	// on: as UTF-16 code units the emoji's high surrogate (U+D83D) is smaller, as
	// UTF-8 bytes (and code points) the emoji is larger.
	it('puts a character from U+E000 to U+FFFF before one above U+FFFF', () => {
		expect(compareIds(['\uE000'], ['\u{1F600}'])).toBeLessThan(0);
		expect(compareIds(['\u{1F600}'], ['\uE000'])).toBeGreaterThan(0);
		expect(compareIds(['\uFFFD'], ['\u{1F600}'])).toBeLessThan(0);
	});

	it('agrees with the UTF-8 bytes of every id column, compared bytewise', () => {
		const ids = [
			'',
			'B',
			'a',
			'ab',
			'\u00E9',
			'\uD7FF',
			'\uE000',
			'\uFFFD',
			'\u{10000}',
			'\u{1F600}',
			'\u{1F601}',
			'a\u{1F600}',
			'a\uFFFD',
		];
		const bytes = (value: string) => Array.from(new TextEncoder().encode(value));
		const byBytes = (a: string, b: string) => {
			const [x, y] = [bytes(a), bytes(b)];
			for (let index = 0; index < Math.min(x.length, y.length); index++)
				if (x[index] !== y[index]) return x[index] - y[index];
			return x.length - y.length;
		};
		for (const a of ids) {
			for (const b of ids) {
				expect(Math.sign(compareIds([a], [b])), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(
					Math.sign(byBytes(a, b)),
				);
			}
		}
	});

	it('compares column by column, a shorter id first when it is a prefix of the longer', () => {
		expect(compareIds(['7', '\uE000'], ['7', '\u{1F600}'])).toBeLessThan(0);
		expect(compareIds(['7'], ['7', 'a'])).toBeLessThan(0);
		expect(compareIds(['8'], ['7', 'a'])).toBeGreaterThan(0);
	});

	it('sorts a listing staged in the block in the same order as the store', async () => {
		const store = new MemoryStateStore([PLACEMENT]);
		await store.migrate();
		await store.applyBlock(block(10), [
			{
				type: 'upsert',
				entity: 'placement',
				id: {epoch: 7, position: '\u{1F600}', playerIndex: 0},
				values: {player: 'U+1F600'},
			},
			{
				type: 'upsert',
				entity: 'placement',
				id: {epoch: 7, position: '\uFFFD', playerIndex: 0},
				values: {player: 'U+FFFD'},
			},
		]);
		const {state} = createMutationContext(store);
		state.set('placement', {epoch: 7, position: '\uE000', playerIndex: 0}, {player: 'U+E000'});
		state.set('placement', {epoch: 7, position: '\u{1F601}', playerIndex: 0}, {player: 'U+1F601'});

		const stored = await store.listCurrent<{player: string}>('placement', {epoch: 7}, 10);
		const merged = await state.list<{player: string}>('placement', {epoch: 7}, 2);

		expect(stored.rows.map((row) => row.player)).toEqual(['U+FFFD', 'U+1F600']);
		expect({rows: merged.rows.map((row) => row.player), truncated: merged.truncated}).toEqual({
			rows: ['U+E000', 'U+FFFD'],
			truncated: true,
		});
	});
});
