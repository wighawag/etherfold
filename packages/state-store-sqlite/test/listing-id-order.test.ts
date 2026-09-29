import {createMutationContext, MemoryStateStore, type StateStoreBackend} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {VersionedStateStore} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {PLACEMENT, block} from './utils/fixtures.js';

/**
 * What `MutationContext.list` answers on THIS backend when the limit CUTS the
 * listing, measured beside the reference store. Evidence for
 * `the-listings-id-order-is-decided`, tabulated in
 * `docs/spikes/the-listings-id-order-per-backend/README.md`.
 *
 * The conformance suite asserts each read's ORDER with a limit that covers every
 * id (`idOrder`, in `@etherfold/state-store-conformance`). What it does not
 * assert is the SET a cut keeps, because on this backend that is not one order's
 * first rows: the read-your-writes merge asks the store for `limit + staged`
 * rows, which SQLite answers in UTF-8 byte order off its BINARY id index, then
 * re-sorts the merge with `compareIds` (UTF-16 code units) and keeps the first
 * `limit`. So which rows survive the cut depends on whether a row is STORED
 * (cut in UTF-8 order) or STAGED (never cut by the store).
 *
 * This pins what the code does TODAY so a change to it is seen; it is not a
 * statement of what it should do, which is the decision the evidence is for.
 *
 * The ids: `a` (U+0061), U+E000, U+FFFD, U+1F600 and U+1F601. In UTF-16 the two
 * supplementary-plane characters sort before U+E000 (their high surrogate is
 * U+D83D); in UTF-8 they sort after U+FFFD.
 */

const CHARACTERS: Record<string, string> = {
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

describe('the bounded listing, cut by its limit inside a block', () => {
	it('outside a block, each store cuts in its own order: SQLite in UTF-8 bytes, memory in UTF-16 code units', async () => {
		const sqlite = await BACKENDS.sqlite();
		const memory = await BACKENDS.memory();

		expect(labels(await sqlite.listCurrent('placement', {epoch: 7}, 2))).toEqual({
			rows: ['U+0061', 'U+E000'],
			truncated: true,
		});
		expect(labels(await memory.listCurrent('placement', {epoch: 7}, 2))).toEqual({
			rows: ['U+0061', 'U+1F600'],
			truncated: true,
		});
	});

	it('with nothing staged under the prefix, SQLite keeps the UTF-8 cut: the same SET as its listing outside the block', async () => {
		// UTF-16's first two would be U+0061, U+1F600, which memory answers
		expect(await insideABlock('sqlite', () => {})).toEqual({rows: ['U+0061', 'U+E000'], truncated: true});
		expect(await insideABlock('memory', () => {})).toEqual({rows: ['U+0061', 'U+1F600'], truncated: true});
	});

	it('with a STORED row overwritten in the block, SQLite still keeps the UTF-8 cut', async () => {
		// one staged key widens the store's fetch to 3 rows, all of them UTF-8's
		// first three, and the overwrite replaces one of them
		const overwrite = (set: (label: string) => void) => set('U+0061');

		expect(await insideABlock('sqlite', overwrite)).toEqual({rows: ['U+0061', 'U+E000'], truncated: true});
		expect(await insideABlock('memory', overwrite)).toEqual({rows: ['U+0061', 'U+1F600'], truncated: true});
	});

	it("with a NEW row staged in the block, SQLite answers a set that is NEITHER order's first rows", async () => {
		// the store's fetch (3 rows, UTF-8) leaves out the stored U+1F600, the
		// staged U+1F601 is never cut by the store, and the UTF-16 re-sort puts it
		// first. UTF-16's answer is U+0061, U+1F600; UTF-8's is U+0061, U+E000.
		const staged = (set: (label: string) => void) => set('U+1F601');

		expect(await insideABlock('sqlite', staged)).toEqual({rows: ['U+0061', 'U+1F601'], truncated: true});
		expect(await insideABlock('memory', staged)).toEqual({rows: ['U+0061', 'U+1F600'], truncated: true});
	});
});
