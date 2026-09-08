import {describe, expect, it} from 'vitest';
import {createTestDB} from './utils/db.js';
import {finality, lastSync, SOURCE, transfer, type TestABI} from './utils/fixtures.js';
import {VersionedStateEventProcessor, type SQLProcessor} from '../src/index.js';

// ---------------------------------------------------------------------------
// THE HANDLE `process()` HANDS BACK CAN USE THE SEAM'S SET READ
// ---------------------------------------------------------------------------
// `VersionedStateView` is what a consumer of `@etherfold/processor-sqlite` is
// actually given: `process()` returns it and `onStateUpdated` forwards it. The
// bounded id-prefix listing is the ONE set read every backend has, and it is how
// a one-to-many is meant to be read; a handle that omits it sends the consumer
// back to `queryCurrent` with a hand-written `WHERE`, which is the surface the
// listing exists to make unnecessary.
//
// So the assertions here go through the RETURNED handle rather than through
// `p.state` or through the store: the point is what a consumer holds, not that
// the store underneath can list (`state-store-sqlite` already pins that,
// including the access path).

/** A holding keyed by (owner, token), so `{owner}` is a real prefix and not a whole id. */
type Holding = {owner: string; id: string; since: number};

/**
 * The ids are ZERO-PADDED on purpose: listing order is lexicographic over the
 * stringified id (`listing.ts`), so a numeric child key has to be fixed-width
 * for ascending order to mean what it looks like.
 */
const padded = (id: bigint) => id.toString().padStart(6, '0');

const processor: SQLProcessor<TestABI> = {
	version: '1.0.0',
	entities: [{name: 'holding', id: ['owner', 'id'], fields: {since: 'integer'}}],
	async onTransfer(state, event) {
		state.delete('holding', {owner: event.args.from, id: padded(event.args.id)});
		state.set('holding', {owner: event.args.to, id: padded(event.args.id)}, {since: event.blockNumber});
	},
};

/**
 * Alice ends block 100 holding tokens 1 and 2, and block 101 holding 1, 2 and 3.
 * Bob holds token 9 throughout, so a prefix that answered with the whole table
 * would be visible rather than merely wrong-by-luck.
 */
async function indexed() {
	const p = new VersionedStateEventProcessor<TestABI>(createTestDB(), processor);
	await p.load(SOURCE, {finality});
	await p.process(
		[
			transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 1n}),
			transfer(100, '0xAAA', {from: '0x0', to: '0xalice', id: 2n}),
			transfer(100, '0xAAA', {from: '0x0', to: '0xbob', id: 9n}),
		],
		lastSync({latestBlock: 100, lastToBlock: 100}),
	);
	return {
		p,
		view: await p.process(
			[transfer(101, '0xBBB', {from: '0x0', to: '0xalice', id: 3n})],
			lastSync({latestBlock: 101, lastToBlock: 101}),
		),
	};
}

describe('the read handle process() returns', () => {
	it('lists the children of an id prefix at the tip', async () => {
		const {view} = await indexed();
		const listing = await view.listCurrent<Holding>('holding', {owner: '0xalice'}, 10);
		expect(listing.rows.map((row) => row.id)).toEqual(['000001', '000002', '000003']);
		expect(listing.truncated).toBe(false);
	});

	it('reports truncation rather than a silently short answer', async () => {
		const {view} = await indexed();
		const listing = await view.listCurrent<Holding>('holding', {owner: '0xalice'}, 2);
		expect(listing.rows.map((row) => row.id)).toEqual(['000001', '000002']);
		expect(listing.truncated).toBe(true);
	});

	it('lists the children that were live as of an earlier block', async () => {
		const {view} = await indexed();
		const listing = await view.listAsOf<Holding>('holding', {owner: '0xalice'}, 100, 10);
		expect(listing.rows.map((row) => row.id)).toEqual(['000001', '000002']);
		expect(listing.truncated).toBe(false);
	});

	it('addresses that earlier listing by hash and by time, as its other as-of reads do', async () => {
		const {view} = await indexed();
		const byHash = await view.listAsOf<Holding>('holding', {owner: '0xalice'}, {hash: '0xAAA'}, 10);
		expect(byHash.rows.map((row) => row.id)).toEqual(['000001', '000002']);
	});

	it('refuses a block it has no record of instead of answering from the tip', async () => {
		const {view} = await indexed();
		await expect(view.listAsOf<Holding>('holding', {owner: '0xalice'}, {hash: '0xdeadbeef'}, 10)).rejects.toThrow(
			/0xdeadbeef/,
		);
	});
});
