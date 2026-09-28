/**
 * The FAST half of the workload: the abandoned early deployment, on every
 * backend, on every test invocation.
 *
 * 42 events over 9 blocks, which is small enough that a failure is a readable
 * diff and quick enough that nobody is tempted to skip it. It exercises the same
 * processor, the same projection and the same golden-state comparison as the
 * launched game does in `alpha1.test.ts`, so a mistake in the shared machinery
 * surfaces here first, in seconds, rather than in a run over 31,332 events.
 *
 * What it does NOT cover is what makes the launched game the workload: the
 * reward handlers (they do not exist in this deployment's contracts), the
 * placement window ever overflowing, and the reorg case. That is the split, and
 * `alpha1.test.ts` says how the other half runs.
 */
import {describe, expect, it} from 'vitest';
import {
	arrivalOrdinal,
	BASE_ABANDONED,
	expectFixtureShape,
	expectGoldenState,
	moveOrdinal,
	runWorkload,
	stratagemsProcessor,
} from '../src/index.js';
import {BACKENDS} from './utils/backends.js';

describe.each(BACKENDS)('the abandoned early stratagems deployment, on $name', (backend) => {
	it('lands on the state the original JSProcessor computed from the same stream', async () => {
		const run = await runWorkload(backend.make, BASE_ABANDONED);

		expectFixtureShape(run, BASE_ABANDONED);
		expectGoldenState(run, BASE_ABANDONED);
	});
});

describe('the model the port is written in', () => {
	it('declares no stored array, no CSV index, no count and no remembered order', () => {
		// The regression guard on what this promotion REMOVED. The measured port in
		// `work/notes/findings/sqlite-in-the-browser.md` needed `placement.positions`
		// (a CSV so the cascade had something to walk), `placementCell.playerCount`
		// (so an append knew its index) and a `placementWindow` singleton (so the
		// arrival order could be recovered). If any of them comes back, it comes
		// back as a field or an entity, and it shows up here.
		expect(stratagemsProcessor.entities.map((entity) => [entity.name, Object.keys(entity.fields)])).toEqual([
			[
				'cell',
				[
					'lastEpochUpdate',
					'epochWhenTokenIsAdded',
					'color',
					'life',
					'delta',
					'enemyMap',
					'distribution',
					'stake',
					'producingEpochs',
				],
			],
			['cellOwner', ['owner']],
			['commitment', ['epoch', 'hash']],
			['placement', ['epoch']],
			['placementPlayer', ['color', 'address']],
			['globalRate', ['lastUpdateTime', 'totalRewardPerPointAtLastUpdate', 'totalPoints']],
			['fixedRate', ['toWithdraw', 'lastTime']],
			['sharedRate', ['points', 'totalRewardPerPointAccounted', 'rewardsToWithdraw']],
			['computedPoints', ['points']],
		]);
	});

	it('keys its ordered children by arrival, fixed-width, so the id order is the numeric one', () => {
		// A listing is ascending in the id's OWN order, which is lexicographic over
		// the stringified id, so an unpadded numeric key would sort '10' before '9'
		// and the placement window would evict the wrong arrival.
		const early = stratagemsProcessor.entities.find((entity) => entity.name === 'placement');
		expect(early?.id).toEqual(['window', 'ordinal']);

		// ... and the padding is what makes that true, so it is asserted rather than
		// described: the 9th log of a block must sort BEFORE the 10th, and a block
		// before the one after it, under plain string comparison.
		const ninth = arrivalOrdinal({blockNumber: 13_364_821, logIndex: 9});
		const tenth = arrivalOrdinal({blockNumber: 13_364_821, logIndex: 10});
		const nextBlock = arrivalOrdinal({blockNumber: 13_364_822, logIndex: 0});
		expect([tenth, nextBlock, ninth].sort()).toEqual([ninth, tenth, nextBlock]);
		expect(moveOrdinal({blockNumber: 13_364_821, logIndex: 9}, 2)).toBe(`${ninth}:${'2'.padStart(12, '0')}`);
		expect(stratagemsProcessor.entities.find((entity) => entity.name === 'placementPlayer')?.id).toEqual([
			'window',
			'ordinal',
			'position',
			'moveOrdinal',
		]);
	});

	it("declares a placement's players as its children, which is why their id starts with the placement's whole id", () => {
		// ADR-0098: the relation is checked against the ids at declaration time, on
		// every backend, so this declaration being accepted by the stores the golden
		// comparison runs on is what says the ids match it.
		const player = stratagemsProcessor.entities.find((entity) => entity.name === 'placementPlayer');
		expect(player?.parent).toEqual({entity: 'placement', as: 'players'});
	});
});
