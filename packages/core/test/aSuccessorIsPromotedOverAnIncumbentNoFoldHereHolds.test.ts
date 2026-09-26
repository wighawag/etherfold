import {describe, expect, it} from 'vitest';
import type {ReceivingIndexer} from '../src/receivingContainer.js';
import {identityOf} from './utils/processorIdentity.js';
import {anIncumbentThatHasFolded, type MemoryStore, type TestABI} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// A SUCCESSOR IS PROMOTED OVER AN INCUMBENT NO FOLD HERE HOLDS, which is the restart shape
// ---------------------------------------------------------------------------------------------------
// A deployment folded under `v1`, had `v2` arrive beside it, and stopped before `v2` caught up.
// It is restarted with `v2` alone and NO way to build `v1` from stored bytes: the old code is
// not in this build, so this process holds exactly one fold, the successor's.
//
// The promotion trigger compares the two cursors the SLOTS name. It used to look for the
// canonical generation among the HELD folds and return when there was none, so on this shape
// the trigger could not be evaluated at all and the pointer never moved, however far the
// successor got (measured 2026-09-16, while building
// `promotion-arms-from-the-slot-so-a-restart-can-finish-an-upgrade`). It now reads each cursor by
// IDENTITY through the host's `readStateCursor` seam (ADR-0084's amendment of 2026-09-19), so a
// generation with no engine can still be measured. Since ADR-0092 a host that CAN build stored
// code instantiates the incumbent at `open`, which hides this shape; the host here cannot, which
// is what keeps it in view.
// ---------------------------------------------------------------------------------------------------

type Container = ReceivingIndexer<TestABI, string[], MemoryStore>;

async function catchUp(indexer: Container, marker: string): Promise<void> {
	for (let guard = 0; guard < 50; guard++) {
		const report = (await indexer.rebuildMore({maxEmissions: 1})).find(
			(one) => one.generation.processor === identityOf(marker),
		);
		if (!report || report.complete) return;
	}
	throw new Error('the rebuild never reported itself complete');
}

async function aRestartOnTheSuccessorAlone(policy?: 'manual') {
	const {world: w, incumbent} = await anIncumbentThatHasFolded();
	await incumbent.add(w.specFor('v2', 10));
	// stopped before the successor folded anything: it is PENDING, and `v1` is still canonical
	expect((await incumbent.slots()).successor?.processor).toBe(identityOf('v2'));

	// no `instantiateGeneration`: nothing here can build `v1`
	const restarted = await w.open('v2', 10, policy ? {promotion: {policy}} : {});
	return {restarted, incumbentStream: incumbent.streamDigest};
}

describe('a successor is promoted over an incumbent this process holds NO fold for', () => {
	it('holds only the successor, and still promotes it under `on-catch-up` once it is level', async () => {
		const {restarted} = await aRestartOnTheSuccessorAlone();
		expect(restarted.held().map((fold) => fold.record.processor)).toEqual([identityOf('v2')]);
		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));

		await catchUp(restarted, 'v2');

		expect((await restarted.canonical())?.processor).toBe(identityOf('v2'));
		expect((await restarted.slots()).predecessor?.processor).toBe(identityOf('v1'));
	});

	it('does not promote it BEFORE it is level with the incumbent’s persisted cursor', async () => {
		const {restarted} = await aRestartOnTheSuccessorAlone();

		// one bounded chunk of a single emission MOVES the successor, and cannot reach the incumbent's cursor
		const report = (await restarted.rebuildMore({maxEmissions: 1})).find(
			(one) => one.generation.processor === identityOf('v2'),
		);
		expect(report?.replayed).toBeGreaterThan(0);
		expect(report?.complete).toBe(false);

		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));
	});

	it('still waits under `manual`, however level the successor gets', async () => {
		const {restarted} = await aRestartOnTheSuccessorAlone('manual');

		await catchUp(restarted, 'v2');

		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));
	});
});
