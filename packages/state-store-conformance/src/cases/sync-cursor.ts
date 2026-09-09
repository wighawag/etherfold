import {expect} from 'vitest';
import {LADDER_BASE, block, cases, opened, owns} from '../fixtures.js';
import type {ConformanceCase, StateStoreFactory} from '../types.js';

const GROUP = 'the sync cursor';

/** Every case writes under this; the string is opaque to the store, so anything reads back. */
const KEY = 'lastSync';

/**
 * A store remembers how far its caller has got, and it never claims more
 * progress than it holds.
 *
 * The cursor is one OPAQUE STRING under one key (`cursor.ts` at the seam), so
 * these cases never look at what it means: they check that what went in comes
 * out, that clearing forgets it, and -- the one that matters -- that the cursor
 * and the block it describes move as ONE unit.
 *
 * ## Why that last one is the case worth having
 *
 * Before the cursor lived here it was a second round trip after the block, and
 * the gap between them was not self-healing in either direction. A cursor left
 * BEHIND the state wedges the indexer: the restart replays a block the store
 * already holds and `applyBlock` refuses it, correctly, as the caller bug it
 * normally is, so no amount of restarting clears it
 * (`sync-cursor-write-is-not-atomic-with-the-block-it-describes`,
 * now deleted because it stopped being true). A cursor left AHEAD is worse and
 * quieter: the restart skips a block nothing ever applied, and the state is
 * simply missing it with nothing to say so.
 *
 * So the property asserted is symmetric. After a block applies, the cursor is
 * the one handed with it. After a block is REFUSED, the cursor is exactly what
 * it was before -- never a cursor describing a block this store does not hold.
 */
export function syncCursorCases(factory: StateStoreFactory): ConformanceCase[] {
	/** A mutation naming an entity nobody declared: makes the block fail, wherever it sits. */
	const undeclared = {type: 'upsert', entity: 'ghost', id: {id: '1'}, values: {}} as const;

	return cases(GROUP, {
		'is absent before anything is written, rather than empty or thrown': async () => {
			const store = await opened(factory);
			expect(await store.readCursor(KEY)).toBeUndefined();
		},

		'reads back exactly the string that was written, and is overwritten in place': async () => {
			const store = await opened(factory);
			await store.writeCursor(KEY, 'first');
			expect(await store.readCursor(KEY)).toBe('first');

			await store.writeCursor(KEY, 'second');
			expect(await store.readCursor(KEY)).toBe('second');
		},

		'is opaque: a value with quotes, newlines and unicode survives unchanged': async () => {
			// the store persists a string and knows nothing about what it means, so
			// the codec above it (JSON with a bigint tag) is free to change shape.
			const store = await opened(factory);
			const value = '{"lastToBlock":100,"n":{"__bigint__":"7"},"note":"line\\nbreak \u2603 \'quoted\'"}';
			await store.writeCursor(KEY, value);
			expect(await store.readCursor(KEY)).toBe(value);
		},

		'keeps two keys apart': async () => {
			const store = await opened(factory);
			await store.writeCursor(KEY, 'one');
			await store.writeCursor('other', 'two');
			expect([await store.readCursor(KEY), await store.readCursor('other')]).toEqual(['one', 'two']);
		},

		'is forgotten by clear, and clearing an absent one is not an error': async () => {
			const store = await opened(factory);
			await store.clearCursor('never-written');

			await store.writeCursor(KEY, 'first');
			await store.clearCursor(KEY);
			expect(await store.readCursor(KEY)).toBeUndefined();
		},

		'moves WITH the block it describes': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)], {key: KEY, value: 'at-100'});

			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
			expect(await store.readCursor(KEY)).toBe('at-100');
		},

		'is never ahead of the last applied block: a refused block leaves it where it was': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)], {key: KEY, value: 'at-100'});

			// the block fails, so its cursor must not land: a cursor describing a
			// block this store does not hold sends the next run PAST it, silently.
			await expect(
				store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2), undeclared], {key: KEY, value: 'at-101'}),
			).rejects.toThrow();

			expect(await store.readCursor(KEY)).toBe('at-100');
			expect(await store.getCurrent('token', {id: '1'})).toMatchObject({owner: '0xalice'});
		},

		'is never ahead of the last applied block: a re-applied height leaves it where it was': async () => {
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)], {key: KEY, value: 'at-100'});

			await expect(
				store.applyBlock(block(LADDER_BASE), [owns('1', '0xbob', 2)], {key: KEY, value: 'later'}),
			).rejects.toThrow();
			expect(await store.readCursor(KEY)).toBe('at-100');
		},

		'survives a revert, because how far the CALLER got is not entity state': async () => {
			// The cursor is deliberately not versioned, not revertible and not
			// prunable -- the reason a reserved entity was rejected as its home. A
			// revert is followed by the canonical branch being applied WITH its own
			// cursor, so the caller moves it; the store must not move it for them.
			const store = await opened(factory);
			await store.applyBlock(block(LADDER_BASE), [owns('1', '0xalice', 1)], {key: KEY, value: 'at-100'});
			await store.applyBlock(block(LADDER_BASE + 1), [owns('1', '0xbob', 2)], {key: KEY, value: 'at-101'});

			await store.revertTo(LADDER_BASE);
			expect(await store.readCursor(KEY)).toBe('at-101');

			await store.applyBlock(block(LADDER_BASE + 1, '0xother'), [owns('1', '0xcarol', 2)], {
				key: KEY,
				value: 'at-101-canonical',
			});
			expect(await store.readCursor(KEY)).toBe('at-101-canonical');
		},

		'installs contents and a cursor together, which is what a bootstrap needs': async () => {
			// A snapshot is rows plus the cursor they belong to, and the two have to
			// land as ONE unit or a client that crashed mid-install comes up holding
			// rows it cannot account for. That is `applyBlock`'s third argument used
			// for its other purpose, and it is why the port is here rather than
			// beside the store. See `bootstrap-an-entity-store-from-a-snapshot`.
			const store = await opened(factory);
			const snapshot = [owns('1', '0xalice', 3), owns('2', '0xbob', 1)];
			await store.applyBlock(block(LADDER_BASE), snapshot, {key: KEY, value: 'snapshot-at-100'});

			expect(await store.getCurrent('token', {id: '2'})).toMatchObject({owner: '0xbob'});
			expect(await store.readCursor(KEY)).toBe('snapshot-at-100');
		},
	});
}
