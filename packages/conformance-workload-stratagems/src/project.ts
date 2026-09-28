/**
 * Entity rows, read back THROUGH THE SEAM and projected into the shape the
 * original processor produces.
 *
 * This is the equality oracle's other half, and it is itself evidence: the
 * amount of code needed here is the amount of structure the entity model could
 * not carry and a reader has to rebuild. Every flat keyed map is one line. The
 * placement window is the interesting part, and it is now SHORTER than the state
 * it projects rather than longer, because the collection is derived from a
 * prefix listing instead of reassembled from a CSV, a count and a stored order.
 *
 * Everything here goes through `getCurrent` / `listCurrent`, never through a
 * backend's own internals, which is what makes the same projection run on a
 * versioned-row store, an object store, and a patch log.
 */
import type {StateStore} from '@etherfold/processor-entities';
import type {Data} from '../vendor/stratagems/js-processor.js';
import {PLACEMENT_WINDOW, SINGLETON, WINDOW} from './entities.js';
import type {TouchedIds} from './replay.js';

/**
 * The most children of one placement this projection will read.
 *
 * A READ cannot page the way the cascade delete does: the seam has a limit and
 * no cursor, on purpose. So the bound is declared here and CHECKED -- a
 * `truncated` answer throws instead of quietly projecting a short collection,
 * which is exactly what `truncated` is in the seam for. The largest arrival on
 * the real captured stream has two orders of magnitude fewer children than this.
 */
export const MAX_PLACEMENT_PLAYERS = 4096;

type CellRow = {
	lastEpochUpdate: number;
	epochWhenTokenIsAdded: number;
	color: number;
	life: number;
	delta: number;
	enemyMap: number;
	distribution: number;
	stake: number;
	producingEpochs: number;
};

/** An empty state in the oracle's own shape, so a run that wrote nothing projects to one. */
function emptyData(): Data {
	return {
		cells: {},
		owners: {},
		commitments: {},
		placements: [],
		points: {
			global: {lastUpdateTime: 0, totalRewardPerPointAtLastUpdate: 0n, totalPoints: 0n},
			fixed: {},
			shared: {},
		},
		computedPoints: {},
	};
}

/**
 * Read every id the run touched, and hand back the ones that are still live.
 *
 * A key the processor deleted comes back `undefined` and is dropped here, which
 * is the assertion hiding in the projection: a backend whose delete did not
 * close the version projects an extra entry and fails the comparison.
 */
async function liveRows<T>(
	store: StateStore,
	entity: string,
	touched: TouchedIds,
	column: string,
): Promise<[string, T][]> {
	const rows: [string, T][] = [];
	for (const id of touched.get(entity)?.values() ?? []) {
		const row = await store.getCurrent<T>(entity, id);
		if (row) rows.push([String(id[column]), row]);
	}
	return rows;
}

export async function projectToData(store: StateStore, touched: TouchedIds): Promise<Data> {
	const data = emptyData();

	for (const [position, row] of await liveRows<CellRow>(store, 'cell', touched, 'position')) {
		data.cells[position] = {
			lastEpochUpdate: Number(row.lastEpochUpdate),
			epochWhenTokenIsAdded: Number(row.epochWhenTokenIsAdded),
			color: Number(row.color),
			life: Number(row.life),
			delta: Number(row.delta),
			enemyMap: Number(row.enemyMap),
			distribution: Number(row.distribution),
			stake: Number(row.stake),
			producingEpochs: Number(row.producingEpochs),
		};
	}

	for (const [position, row] of await liveRows<{owner: string}>(store, 'cellOwner', touched, 'position')) {
		data.owners[position] = row.owner as `0x${string}`;
	}

	for (const [account, row] of await liveRows<{epoch: number; hash: string}>(store, 'commitment', touched, 'account')) {
		data.commitments[account] = {epoch: Number(row.epoch), hash: row.hash as `0x${string}`};
	}

	for (const [owner, row] of await liveRows<{points: number}>(store, 'computedPoints', touched, 'owner')) {
		data.computedPoints[owner] = Number(row.points);
	}

	// The u256 contortion, on the read side: decimal TEXT back through `BigInt()`.
	// Nothing in the declaration says these columns are u256, so this projection is
	// where the knowledge lives, and it is the reason the encoding has to be
	// canonical (ADR-0025: the declaration describes a storage class, not a type).
	const globalRate = await store.getCurrent<{
		lastUpdateTime: number;
		totalRewardPerPointAtLastUpdate: string;
		totalPoints: string;
	}>('globalRate', SINGLETON);
	if (globalRate) {
		data.points.global = {
			lastUpdateTime: Number(globalRate.lastUpdateTime),
			totalRewardPerPointAtLastUpdate: BigInt(globalRate.totalRewardPerPointAtLastUpdate),
			totalPoints: BigInt(globalRate.totalPoints),
		};
	}

	for (const [account, row] of await liveRows<{toWithdraw: string; lastTime: number}>(
		store,
		'fixedRate',
		touched,
		'account',
	)) {
		data.points.fixed[account] = {toWithdraw: BigInt(row.toWithdraw), lastTime: Number(row.lastTime)};
	}

	for (const [account, row] of await liveRows<{
		points: string;
		totalRewardPerPointAccounted: string;
		rewardsToWithdraw: string;
	}>(store, 'sharedRate', touched, 'account')) {
		data.points.shared[account] = {
			points: BigInt(row.points),
			totalRewardPerPointAccounted: BigInt(row.totalRewardPerPointAccounted),
			rewardsToWithdraw: BigInt(row.rewardsToWithdraw),
		};
	}

	data.placements = await projectPlacements(store);
	return data;
}

/**
 * The ordered bounded window, DERIVED.
 *
 * Two listings and a group-by, against three entities plus a CSV plus a count
 * plus a singleton in the port this replaces. The window comes back ascending by
 * arrival, and the original's array is newest-first (it unshifts), so it is
 * reversed; the players of an arrival come back ordered by `(position,
 * moveOrdinal)`, so grouping by position preserves the original's push order
 * inside each cell without sorting anything.
 */
async function projectPlacements(store: StateStore): Promise<Data['placements']> {
	const window = await store.listCurrent<{ordinal: string; epoch: number}>(
		'placement',
		{window: WINDOW},
		PLACEMENT_WINDOW + 1,
	);
	if (window.rows.length > PLACEMENT_WINDOW) {
		throw new Error(
			`the placement window holds ${window.rows.length} arrivals, and the game keeps ${PLACEMENT_WINDOW}: ` +
				`the eviction in onCommitmentRevealed did not run`,
		);
	}

	const placements: Data['placements'] = [];
	for (const arrival of [...window.rows].reverse()) {
		const players = await store.listCurrent<{position: string; color: number; address: string}>(
			'placementPlayer',
			{window: WINDOW, ordinal: arrival.ordinal},
			MAX_PLACEMENT_PLAYERS,
		);
		if (players.truncated) {
			throw new Error(
				`placement ${arrival.ordinal} has more than ${MAX_PLACEMENT_PLAYERS} players: raise ` +
					`MAX_PLACEMENT_PLAYERS rather than projecting a collection the listing cut off`,
			);
		}

		const cells: Data['placements'][number]['cells'] = {};
		for (const player of players.rows) {
			const cell = (cells[player.position] ??= {players: []});
			cell.players.push({color: Number(player.color), address: player.address});
		}
		placements.push({epoch: Number(arrival.epoch), cells});
	}
	return placements;
}
