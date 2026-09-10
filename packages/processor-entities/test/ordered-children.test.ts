import type {Abi, LogEvent} from '@etherfold/core';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {PatchStateStore} from '@etherfold/state-store-patch';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import {createClient} from '@libsql/client';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {beforeEach, describe, expect, it} from 'vitest';
import {applyEventStream, type EntityProcessor} from '../src/index.js';
import {timestampOf} from './utils/fixtures.js';

/**
 * The contortion this listing exists to remove, modelled the idiomatic way.
 *
 * `work/notes/findings/sqlite-in-the-browser.md` (contortions 1 and 2) records
 * the real thing: `state.placements` is an ordered array that keeps seven
 * entries, evicting the oldest and dropping everything nested under it. Ported
 * to entities WITHOUT a listing it cost three entities plus a hand-maintained
 * CSV of positions (kept purely so the cascade delete had something to walk), a
 * `playerCount` per cell, and a singleton holding the arrival order; one `pop()`
 * became an O(cells x players) loop of manual deletes. That path ran 100 times
 * on the real stream.
 *
 * With a bounded id-prefix listing, the same model is what The Graph's
 * `@derivedFrom` would be: children are their own entity keyed by their parent,
 * the collection is DERIVED WHEN READ, and nothing is maintained at write time.
 * Two modelling rules from the spec do the rest:
 *
 * - **The window's children are keyed by ARRIVAL, not by a dense array index.**
 *   The ordinal is `(blockNumber, logIndex)`, which is naturally unique and
 *   naturally ordered, so appending needs no count and the eviction order is the
 *   key itself. Arrival order is not recoverable by sorting on `epoch` (epochs
 *   repeat and go backwards, as they do below), which is exactly why the port
 *   needed a singleton to remember it.
 * - **Keys that must sort numerically are fixed-width.** A listing is ascending
 *   in the id's own order, which is the order a range scan gives for free and is
 *   therefore LEXICOGRAPHIC over the stringified id: `'10'` sorts before `'9'`.
 *
 * Every backend runs it, because "expressible" has to mean expressible wherever
 * the processor is deployed -- including the patch store, where the same listing
 * is a sorted walk over a plain object rather than an indexed range scan, and
 * where the eviction below reads a collection this block has been writing to.
 */

const abi = [
	{
		type: 'event',
		name: 'Placed',
		anonymous: false,
		inputs: [
			{indexed: false, name: 'epoch', type: 'uint256'},
			{indexed: false, name: 'position', type: 'uint256'},
			{indexed: true, name: 'player', type: 'address'},
		],
	},
] as const satisfies Abi;

type PlacedABI = typeof abi;

/** The bound the game itself has: the window keeps the last seven placements. */
const WINDOW = 7;
/** The parent of the window's children. A singleton needs an invented id. */
const GLOBAL = 'global';
/** What the AUTHOR declares a cell and a placement can hold: the limits are theirs. */
const MAX_CELLS = 32;
const MAX_PLAYERS = 16;

/** Fixed-width so the key's own order is the numeric one. */
const wide = (value: number | bigint): string => String(value).padStart(12, '0');

/** Arrival: the one ordering a chain hands out for free, and it is already unique. */
const ordinalOf = (event: {blockNumber: number; logIndex: number}): string =>
	`${wide(event.blockNumber)}:${wide(event.logIndex)}`;

type PlacementRow = {ordinal: string; epoch: number};
type CellRow = {ordinal: string; position: string};
type PlayerRow = {ordinal: string; position: string; player: string};

const processor: EntityProcessor<PlacedABI> = {
	version: '1.0.0',
	entities: [
		// no `positions` CSV, no `playerCount`, no singleton holding the order:
		// every field below is state the game has, and nothing is an index.
		{name: 'placement', id: ['window', 'ordinal'], fields: {epoch: 'integer'}},
		{name: 'placementCell', id: ['ordinal', 'position'], fields: {owner: 'text'}},
		{name: 'placementPlayer', id: ['ordinal', 'position', 'player'], fields: {joinedAt: 'integer'}},
	],

	async onPlaced(state, event) {
		const ordinal = ordinalOf(event);
		const position = wide(event.args.position);

		state.set('placement', {window: GLOBAL, ordinal}, {epoch: Number(event.args.epoch)});
		state.set('placementCell', {ordinal, position}, {owner: event.args.player});
		// keyed by the player, which is naturally unique: appending needs no count,
		// which is the whole of contortion 2's fix.
		state.set('placementPlayer', {ordinal, position, player: event.args.player}, {joinedAt: event.blockNumber});

		// the eviction, as one bounded read of the collection: ask for one more
		// than the window keeps, and if it is there, the window has overflowed.
		const window = await state.list<PlacementRow>('placement', {window: GLOBAL}, WINDOW + 1);
		if (window.rows.length > WINDOW) {
			await evict(state, window.rows[0].ordinal);
		}
	},
};

/**
 * Drop a placement and everything nested under it, walking the ids themselves.
 *
 * This is the `pop()` that used to need a hand-maintained CSV to know what to
 * delete. Each level is one prefix listing under the level above, so the cascade
 * follows the data rather than a second copy of it.
 */
async function evict(
	state: Parameters<NonNullable<EntityProcessor<PlacedABI>['onPlaced']>>[0],
	ordinal: string,
): Promise<void> {
	const cells = await state.list<CellRow>('placementCell', {ordinal}, MAX_CELLS);
	for (const cell of cells.rows) {
		const players = await state.list<PlayerRow>('placementPlayer', {ordinal, position: cell.position}, MAX_PLAYERS);
		for (const player of players.rows) {
			state.delete('placementPlayer', {ordinal, position: cell.position, player: player.player});
		}
		state.delete('placementCell', {ordinal, position: cell.position});
	}
	state.delete('placement', {window: GLOBAL, ordinal});
}

let logCounter = 0;

function placed(
	blockNumber: number,
	logIndex: number,
	args: {epoch: bigint; position: bigint; player: string},
): LogEvent<PlacedABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: `0x${blockNumber.toString(16)}` as `0x${string}`,
		blockTimestamp: timestampOf(blockNumber),
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000000',
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex,
		extra: undefined,
		eventName: 'Placed',
		args,
	} as unknown as LogEvent<PlacedABI>;
}

const backends = [
	{name: 'memory', make: (): Promise<WritableStateStore> => openForWriting(new MemoryStateStore(processor.entities))},
	{
		name: 'sqlite',
		make: (): Promise<WritableStateStore> =>
			openForWriting(new VersionedStateStore(new RemoteLibSQL(createClient({url: ':memory:'})), processor.entities)),
	},
	{
		name: 'patch',
		make: (): Promise<WritableStateStore> =>
			openForWriting(new PatchStateStore(processor.entities, {retention: 'revert-only'})),
	},
];

/** Epochs deliberately repeat and go BACKWARDS: arrival order is not `epoch` order. */
const EPOCHS = [5n, 5n, 4n, 9n, 9n, 2n, 7n, 6n, 3n];

/** Nine placements, one per block, so the window of seven overflows twice. */
const STREAM = EPOCHS.map((epoch, index) =>
	placed(100 + index, 0, {epoch, position: BigInt(index), player: `0xplayer${index}`}),
);

describe.each(backends)('an ordered bounded child collection, on $name', (backend) => {
	let store: WritableStateStore;

	beforeEach(async () => {
		// `openForWriting` migrates on the way, so claiming is the whole of the open.
		store = await backend.make();
	});

	/** The window as a caller sees it: the derived collection, in arrival order. */
	async function windowOf(): Promise<{ordinal: string; epoch: number}[]> {
		const listing = await store.listCurrent<PlacementRow>('placement', {window: GLOBAL}, WINDOW + 1);
		expect(listing.truncated).toBe(false);
		return listing.rows.map((row) => ({ordinal: row.ordinal, epoch: row.epoch}));
	}

	it('keeps the last seven, in arrival order, with no stored array and no count', async () => {
		await applyEventStream(store, processor, STREAM, undefined);

		const window = await windowOf();
		expect(window).toHaveLength(WINDOW);
		// the last seven ARRIVALS: epochs 4, 9, 9, 2, 7, 6, 3 -- not sorted, not
		// deduplicated, and not recoverable from `epoch` by any ordering.
		expect(window.map((row) => row.epoch)).toEqual([4, 9, 9, 2, 7, 6, 3]);
		expect(window.map((row) => row.ordinal)).toEqual(STREAM.slice(2).map(ordinalOf));
	});

	it('drops everything nested under an evicted entry, leaving no orphan', async () => {
		await applyEventStream(store, processor, STREAM, undefined);

		const evicted = ordinalOf(STREAM[0]);
		const survivor = ordinalOf(STREAM[8]);

		expect((await store.listCurrent('placementCell', {ordinal: evicted}, MAX_CELLS)).rows).toEqual([]);
		expect((await store.listCurrent('placementPlayer', {ordinal: evicted}, MAX_PLAYERS)).rows).toEqual([]);
		// and the cascade stopped where it should have
		expect((await store.listCurrent('placementCell', {ordinal: survivor}, MAX_CELLS)).rows).toHaveLength(1);
		expect((await store.listCurrent('placementPlayer', {ordinal: survivor}, MAX_PLAYERS)).rows).toHaveLength(1);
	});

	it('evicts correctly when the whole window arrives in ONE block', async () => {
		// The read-your-writes case, which is where a listing that fell through to
		// the store alone would be wrong: every placement here is staged in the same
		// block, so the window the eighth event reads has never been written down.
		const burst = EPOCHS.map((epoch, index) =>
			placed(100, index, {epoch, position: BigInt(index), player: `0xplayer${index}`}),
		);
		await applyEventStream(store, processor, burst, undefined);

		const window = await windowOf();
		expect(window.map((row) => row.epoch)).toEqual([4, 9, 9, 2, 7, 6, 3]);
		expect((await store.listCurrent('placementCell', {ordinal: ordinalOf(burst[0])}, MAX_CELLS)).rows).toEqual([]);
	});

	it('counts the players in a cell by listing them, which is what the count used to be for', async () => {
		// Contortion 2: `players.push(...)` became read-count, write-at-count,
		// write-count-plus-one, purely because the child's id ended in a dense array
		// position. Keyed by the player instead, an append is one write.
		await applyEventStream(
			store,
			processor,
			[
				placed(100, 0, {epoch: 1n, position: 4n, player: '0xalice'}),
				placed(100, 1, {epoch: 1n, position: 4n, player: '0xbob'}),
			],
			undefined,
		);

		const cell = {ordinal: ordinalOf({blockNumber: 100, logIndex: 0}), position: wide(4n)};
		const first = await store.listCurrent<PlayerRow>('placementPlayer', cell, MAX_PLAYERS);
		// the second placement is its own arrival, with its own cell
		const second = await store.listCurrent<PlayerRow>(
			'placementPlayer',
			{
				ordinal: ordinalOf({blockNumber: 100, logIndex: 1}),
				position: wide(4n),
			},
			MAX_PLAYERS,
		);

		expect(first.rows.map((row) => row.player)).toEqual(['0xalice']);
		expect(second.rows.map((row) => row.player)).toEqual(['0xbob']);
		expect(first.truncated).toBe(false);
	});

	it('un-derives the window when the block that grew it is reverted', async () => {
		await applyEventStream(store, processor, STREAM.slice(0, 5), undefined);
		expect(await windowOf()).toHaveLength(5);

		await applyEventStream(
			store,
			processor,
			[placed(104, 0, {epoch: 9n, position: 4n, player: '0xplayer4'})].map((event) => ({...event, removed: true})),
			undefined,
		);

		// nothing was stored ABOUT the collection, so nothing had to be undone for
		// it: the versions came back and the derived answer followed.
		const window = await windowOf();
		expect(window.map((row) => row.epoch)).toEqual([5, 5, 4, 9]);
	});
});

describe('the model this is written in', () => {
	it('declares no array, no CSV index and no count', async () => {
		// The regression guard on the claim above: if a later change reintroduces a
		// maintained index, it shows up as a field here.
		expect(processor.entities.map((entity) => [entity.name, Object.keys(entity.fields)])).toEqual([
			['placement', ['epoch']],
			['placementCell', ['owner']],
			['placementPlayer', ['joinedAt']],
		]);
	});
});
