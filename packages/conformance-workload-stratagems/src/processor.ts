/**
 * The stratagems processor, as an `EntityProcessor` over `MutationContext`.
 *
 * DERIVED WORK of github.com/wighawag/stratagems `indexer/src/index.ts`
 * @ 3d5a0b3f (GPL-3.0); see `../vendor/stratagems/README.md`. What it is checked
 * against is the state that file computed, committed under `../fixtures/`.
 *
 * Read this next to `../vendor/stratagems/js-processor.ts`. Handlers that touch
 * flat keyed maps (`onCommitmentMade`, the reward handlers, the pokes) port
 * across almost unchanged. `onCommitmentRevealed` is the interesting one,
 * because it is where an ordered bounded array with a cascade lives, and it is
 * the handler this promotion REWROTE.
 *
 * ## What the rewrite removed, and what pays for it
 *
 * The measured port in `work/notes/findings/sqlite-in-the-browser.md` predates
 * the bounded id-prefix listing. Without a way to ask "which rows belong to this
 * parent", it had to write the answer down: a `placement.positions` CSV so the
 * cascade had something to walk, a `placementCell.playerCount` so an append knew
 * which index to write at, and a `placementWindow` singleton holding the arrival
 * order. Three maintained indexes, and one `pop()` became an O(cells x players)
 * loop of manual deletes against a foreign key the store could not answer in the
 * direction needed. That path is not hypothetical: on the real stream the window
 * takes 100 arrivals and keeps 7, so the cascade runs 93 times.
 *
 * Here the window is `state.list('placement', {window: WINDOW}, 8)` and the
 * cascade is `state.list('placementPlayer', {ordinal}, ...)`. Nothing is
 * maintained at write time, the arrival order IS the key, and the entity count
 * went from six to three for the same state. The golden state is what says the
 * meaning survived: this processor lands on the byte-identical output the
 * ORIGINAL `JSProcessor` computed on Base.
 */
import type {EntityProcessor, MutationContext} from '@etherfold/processor-entities';
import type {StratagemsABI} from '../vendor/stratagems/abi.js';
import {
	arrivalOrdinal,
	CASCADE_PAGE,
	moveOrdinal,
	PLACEMENT_WINDOW,
	SINGLETON,
	stratagemsEntities,
	u256,
	WINDOW,
	wide,
} from './entities.js';
import {StratagemsContractOnEntities} from './stratagems-contract.js';

/** What a listed placement carries: its arrival key, and the epoch it is for. */
type PlacementRow = {ordinal: string; epoch: number};
/** What a listed player carries: enough to delete it, and enough to project it. */
type PlacementPlayerRow = {ordinal: string; position: string; moveOrdinal: string};

/**
 * Drop one placement and everything nested under it.
 *
 * This is the original's `state.placements.pop()`, and it is the line that used
 * to need a hand-maintained CSV to know what to delete. Now the cascade follows
 * the DATA: the children of an arrival are a prefix listing under it, so there
 * is no second copy of the membership to keep in step.
 *
 * It pages rather than asking once with a big limit, and the paging is the
 * point: a listing that was `truncated` and got treated as the whole collection
 * is exactly how a cascade leaves orphans behind silently. Deleting a page is
 * visible to the next listing through read-your-writes, so the loop makes
 * progress within the block and stops when the prefix is empty.
 */
async function dropPlacement(state: MutationContext, ordinal: string): Promise<void> {
	for (;;) {
		const page = await state.list<PlacementPlayerRow>('placementPlayer', {ordinal}, CASCADE_PAGE);
		if (page.rows.length === 0) break;
		for (const player of page.rows) {
			state.delete('placementPlayer', {
				ordinal,
				position: player.position,
				moveOrdinal: player.moveOrdinal,
			});
		}
		if (!page.truncated) break;
	}
	state.delete('placement', {window: WINDOW, ordinal});
}

export const stratagemsProcessor: EntityProcessor<StratagemsABI> = {
	entities: stratagemsEntities,

	async onCommitmentRevealed(state, event) {
		const epoch = Number(event.args.epoch);
		const account = event.args.player.toLowerCase();

		// `state.placements.find(v => v.epoch === ...)`: the window is a DERIVED
		// collection, so finding an epoch in it is one bounded listing of the seven
		// it keeps -- no singleton remembering which epochs are in it, and no CSV.
		const window = await state.list<PlacementRow>('placement', {window: WINDOW}, PLACEMENT_WINDOW + 1);
		let ordinal = window.rows.find((row) => Number(row.epoch) === epoch)?.ordinal;
		if (ordinal === undefined) {
			// the original's `placements.unshift(...)`: appending is ONE row,
			// because the key is the arrival rather than a dense array position.
			ordinal = arrivalOrdinal(event);
			state.set('placement', {window: WINDOW, ordinal}, {epoch});
			if (window.rows.length >= PLACEMENT_WINDOW) {
				// ... and its `placements.pop()`: the oldest arrival is `rows[0]`,
				// because the ordering IS the key.
				await dropPlacement(state, window.rows[0].ordinal);
			}
		}

		const stratagemsContract = new StratagemsContractOnEntities(state, 7);
		for (let moveIndex = 0; moveIndex < event.args.moves.length; moveIndex++) {
			const move = event.args.moves[moveIndex];
			await stratagemsContract.computeMove(event.args.player, epoch, move);

			// `cell.players.push({color, address})`, as one write. The old port's
			// read-count / write-at-count / write-count-plus-one existed only because
			// the child's id ended in an array index; keyed by the move's own arrival
			// it is naturally unique, naturally ordered, and needs no count. The cell
			// itself is not a row at all: in the original a cell is created only in
			// order to push a player into it, so the set of cells is the set of
			// positions among the players, derived when read.
			state.set(
				'placementPlayer',
				{ordinal, position: move.position.toString(), moveOrdinal: moveOrdinal(event, moveIndex)},
				{color: move.color, address: account},
			);
		}

		state.delete('commitment', {account});
	},

	async onSinglePoke(state, event) {
		const stratagemsContract = new StratagemsContractOnEntities(state, 7);
		await stratagemsContract.poke(event.args.position, Number(event.args.epoch));
	},

	async onMultiPoke(state, event) {
		const stratagemsContract = new StratagemsContractOnEntities(state, 7);
		for (const position of event.args.positions) {
			await stratagemsContract.poke(position, Number(event.args.epoch));
		}
	},

	onCommitmentCancelled(state, event) {
		const account = event.args.player.toLowerCase();
		state.delete('commitment', {account});
	},

	onCommitmentMade(state, event) {
		const account = event.args.player.toLowerCase();
		state.set('commitment', {account}, {epoch: Number(event.args.epoch), hash: event.args.commitmentHash});
	},

	onCommitmentVoid(state, event) {
		const account = event.args.player.toLowerCase();
		state.delete('commitment', {account});
	},

	onReserveDeposited() {},
	onReserveWithdrawn() {},

	// --------------------------

	async onForceSimpleCells(state, event) {
		const stratagemsContract = new StratagemsContractOnEntities(state, 7);
		await stratagemsContract.forceSimpleCells(Number(event.args.epoch), event.args.cells as never);
	},

	// The three reward handlers are the flat case and port one-to-one, apart from
	// the u256 fields: there is no column type that holds one, so each is written
	// as decimal TEXT through `u256` and read back through `BigInt()`. 16,046 of
	// the 31,332 real events are these three, so the canonical encoding is
	// load-bearing on this workload rather than a footnote.
	onAccounFixedRewardUpdated(state, event) {
		state.set(
			'fixedRate',
			{account: event.args.account},
			{
				toWithdraw: u256(event.args.fixedRateStatus.toWithdraw),
				lastTime: Number(event.args.fixedRateStatus.lastTime),
			},
		);
	},

	onAccountSharedRewardUpdated(state, event) {
		state.set(
			'sharedRate',
			{account: event.args.account},
			{
				points: u256(event.args.sharedRateStatus.points),
				totalRewardPerPointAccounted: u256(event.args.sharedRateStatus.totalRewardPerPointAccounted),
				rewardsToWithdraw: u256(event.args.sharedRateStatus.rewardsToWithdraw),
			},
		);
	},

	onGlobalRewardUpdated(state, event) {
		state.set('globalRate', SINGLETON, {
			lastUpdateTime: Number(event.args.globalStatus.lastUpdateTime),
			totalRewardPerPointAtLastUpdate: u256(event.args.globalStatus.totalRewardPerPointAtLastUpdate),
			totalPoints: u256(event.args.globalStatus.totalPoints),
		});
	},
};

/** Re-exported so a reader of the processor sees the key rules next to it. */
export {arrivalOrdinal, moveOrdinal, wide};
