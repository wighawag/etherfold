import {createMutationContext, MemoryStateStore, type StateStoreBackend} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {PLACEMENT, block} from './utils/fixtures.js';

/**
 * What `MutationContext.list` answers on THIS backend when the limit CUTS the
 * listing, beside the reference store: the SAME rows, UTF-8's first ones, inside
 * a block and out of it (ADR-0021).
 *
 * The read-your-writes merge asks the store for `limit + staged` rows, adds the
 * staged ones, re-sorts with `compareIds` and keeps the first `limit`. That is
 * only one listing when the store and the merge share ONE order. Before the
 * order was decided they did not here: SQLite cut its stored rows in UTF-8 byte
 * order off its BINARY id index and the merge re-sorted in UTF-16 code units, so
 * which rows survived depended on whether a row was STORED or STAGED, and one
 * scenario below answered a set that was neither order's first rows. The
 * measurement is in `docs/spikes/the-listings-id-order-per-backend/README.md`;
 * this pins the answer after the decision, so a store and a merge drifting
 * apart again is seen.
 *
 * The ids: `a` (U+0061), U+E000, U+FFFD, U+1F600 and U+1F601. In UTF-8 the two
 * supplementary-plane characters sort after U+FFFD; in UTF-16 (JavaScript's `<`)
 * they would sort before U+E000, because their high surrogate is U+D83D.
 */

const CHARACTERS: Record<string, string> = {
	'U+0042': 'B',
	'U+0061': 'a',
	'U+E000': '\uE000',
	'U+FFFD': '\uFFFD',
	'U+1F600': '\u{1F600}',
	'U+1F601': '\u{1F601}',
};

const STORED = ['U+0061', 'U+E000', 'U+FFFD', 'U+1F600'];

function child(label: string) {
	return {epoch: 7, position: CHARACTERS[label], playerIndex: 0};
}

async function withStored(store: StateStoreBackend): Promise<StateStoreBackend> {
	await store.migrate();
	await store.applyBlock(
		block(100),
		STORED.map((label) => ({type: 'upsert' as const, entity: 'placement', id: child(label), values: {player: label}})),
	);
	return store;
}

const BACKENDS: Record<string, () => Promise<StateStoreBackend>> = {
	sqlite: () => withStored(new VersionedStateStore(createTestDB(), [PLACEMENT])),
	memory: () => withStored(new MemoryStateStore([PLACEMENT])),
};

/** The labels a listing of epoch 7 answers, and whether it said it was cut. */
function labels(listing: {rows: readonly Record<string, unknown>[]; truncated: boolean}) {
	return {rows: listing.rows.map((row) => row.player), truncated: listing.truncated};
}

/** One scenario: stage some writes in a block, then list epoch 7 inside it with a limit of 2. */
async function insideABlock(backend: string, stage: (set: (label: string) => void) => void) {
	const store = await BACKENDS[backend]();
	const {state} = createMutationContext(store);
	stage((label) => state.set('placement', child(label), {player: label}));
	return labels(await state.list('placement', {epoch: 7}, 2));
}

/** UTF-8's first two of what is stored, which every answer below has to be. */
const UTF8_CUT = {rows: ['U+0061', 'U+E000'], truncated: true};

describe('the bounded listing, cut by its limit inside a block', () => {
	it('outside a block, both stores cut in UTF-8 byte order', async () => {
		for (const backend of Object.keys(BACKENDS)) {
			const store = await BACKENDS[backend]();
			expect(labels(await store.listCurrent('placement', {epoch: 7}, 2)), backend).toEqual(UTF8_CUT);
		}
	});

	it('with nothing staged under the prefix, the cut is the same SET as the listing outside the block', async () => {
		expect(await insideABlock('sqlite', () => {})).toEqual(UTF8_CUT);
		expect(await insideABlock('memory', () => {})).toEqual(UTF8_CUT);
	});

	it('with a STORED row overwritten in the block, the cut is still UTF-8 order', async () => {
		const overwrite = (set: (label: string) => void) => set('U+0061');

		expect(await insideABlock('sqlite', overwrite)).toEqual(UTF8_CUT);
		expect(await insideABlock('memory', overwrite)).toEqual(UTF8_CUT);
	});

	it('with a NEW row staged in the block, the cut is UTF-8 order over stored and staged rows alike', async () => {
		// the staged U+1F601 sorts after every stored row, so it is cut like one.
		// Before the order was decided SQLite answered U+0061, U+1F601 here: the
		// store had already dropped U+1F600 in UTF-8 order, and the merge's UTF-16
		// re-sort put the staged row first.
		const staged = (set: (label: string) => void) => set('U+1F601');

		expect(await insideABlock('sqlite', staged)).toEqual(UTF8_CUT);
		expect(await insideABlock('memory', staged)).toEqual(UTF8_CUT);
	});

	it('with a staged row that sorts INTO the cut, it takes its place in UTF-8 order', async () => {
		// `B` (U+0042) sorts before every stored row, so the cut keeps it and drops
		// U+E000, whichever side of the merge each row came from.
		const staged = (set: (label: string) => void) => set('U+0042');

		expect(await insideABlock('sqlite', staged)).toEqual({rows: ['U+0042', 'U+0061'], truncated: true});
		expect(await insideABlock('memory', staged)).toEqual({rows: ['U+0042', 'U+0061'], truncated: true});
	});
});
