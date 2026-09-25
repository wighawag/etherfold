import {describe, expect, it} from 'vitest';
import {GenerationInstantiationError, type ReceivingIndexer} from '../src/receivingContainer.js';
import type {MemoryStore, TestABI, World} from './utils/receivingWorld.js';
import {bundleBytes, identityOf} from './utils/processorIdentity.js';
import {anIncumbentThatHasFolded, batch, idOf, reportFor, transfer, world} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// A REVERT RESUMES FOLDING, at the container seam
// ---------------------------------------------------------------------------------------------------
// The end-to-end claim -- upgrade, restart with only the new code, revert, and
// the deployment advances -- is asserted over a real deployment and a real bundle
// in `packages/cli/test/aRevertResumesFolding.test.ts`. What is asserted HERE is
// the container's half of it, with synthetic bytes and an injected
// `instantiateGeneration` standing where the loader stands on a Node deployment
// (ADR-0092: the loader is `@etherfold/utils`', which depends on this package):
//
//  - the moment of instantiation is the POINTER MOVE, never `open`;
//  - what it is handed is the bundle STORED for the generation;
//  - the generation moved away from by a revert stops being folded;
//  - an instantiation that fails REFUSES the move and changes nothing.
// ---------------------------------------------------------------------------------------------------

type Container = ReceivingIndexer<TestABI, string[], MemoryStore>;

async function catchUp(indexer: Container, marker: string): Promise<void> {
	for (let guard = 0; guard < 50; guard++) {
		const report = reportFor(await indexer.rebuildMore({maxEmissions: 1}), marker);
		if (!report) throw new Error(`no fold ${marker} to advance`);
		if (report.complete) return;
	}
	throw new Error('the rebuild never reported itself complete');
}

/**
 * An upgrade from `v1` to `v2` that landed, then a RESTART built with `v2` alone,
 * handed the host's way of instantiating stored bytes.
 */
async function aRestartOnTheNewCodeAlone(
	instantiate?: World['instantiateFromBundle'],
): Promise<{world: World; restarted: Container}> {
	const {world: w, incumbent} = await anIncumbentThatHasFolded();
	await incumbent.add(w.specFor('v2', 10));
	await catchUp(incumbent, 'v2');
	expect((await incumbent.canonical())?.processor).toBe(identityOf('v2'));
	const restarted = await w.open('v2', 10, {instantiateGeneration: instantiate ?? w.instantiateFromBundle});
	return {world: w, restarted};
}

const v1 = (indexer: Container) => ({stream: indexer.streamDigest, processor: identityOf('v1')});
const v2 = (indexer: Container) => ({stream: indexer.streamDigest, processor: identityOf('v2')});
const heldHere = (indexer: Container) => indexer.held().map((fold) => fold.record.processor);

/** The stream moves on: one more block, fetched and appended by the deployment's own writer. */
async function theStreamMovesOn(indexer: Container): Promise<string> {
	const LATER = transfer(112, '0xa112', 5n);
	const fromBlock = await indexer.ingestion.expectedFromBlock();
	await indexer.ingestion.receive(batch(indexer, {toBlock: 115, latestBlock: 115, logs: [LATER]}, fromBlock));
	await indexer.rebuildMore();
	return idOf(LATER);
}

describe('the generation a revert lands on is INSTANTIATED from its stored bundle', () => {
	it('instantiates nothing at open, though a stored generation this build lacks is registered', async () => {
		const {world: w, restarted} = await aRestartOnTheNewCodeAlone();

		await restarted.rebuildMore();

		expect(heldHere(restarted)).toEqual([identityOf('v2')]);
		expect(w.instantiated).toEqual([]);
	});

	it('instantiates it at the pointer move, from the bytes stored on its row, and it FOLDS', async () => {
		const {world: w, restarted} = await aRestartOnTheNewCodeAlone();

		await restarted.promote(v1(restarted));

		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v1')]);
		expect(Buffer.from(w.instantiated[0]!.bundle).equals(Buffer.from(bundleBytes('v1')))).toBe(true);
		expect(heldHere(restarted)).toContain(identityOf('v1'));

		const later = await theStreamMovesOn(restarted);
		// v1's OWN fold ran (weight 1): the reverted-to generation advanced, with its code
		expect(w.rowsIn('v1', restarted.streamDigest)).toContain(`${later}x1`);
		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));
	});

	it('stops folding the generation it moved away from, and keeps it registered', async () => {
		const {world: w, restarted} = await aRestartOnTheNewCodeAlone();
		const rejectedBefore = [...w.rowsIn('v2', restarted.streamDigest)];

		await restarted.promote(v1(restarted));
		const later = await theStreamMovesOn(restarted);

		expect(heldHere(restarted)).toEqual([identityOf('v1')]);
		expect(w.rowsIn('v2', restarted.streamDigest)).toEqual(rejectedBefore);
		expect(w.rowsIn('v2', restarted.streamDigest)).not.toContain(`${later}x10`);
		expect((await restarted.slots()).predecessor?.processor).toBe(identityOf('v2'));

		// and forward again is the same act the other way: v2 is instantiated from ITS bytes
		await restarted.promote(v2(restarted));
		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v1'), identityOf('v2')]);
		expect(heldHere(restarted)).toEqual([identityOf('v2')]);
	});

	it('instantiates nothing on a move onto a generation it already folds', async () => {
		const {world: w} = await anIncumbentThatHasFolded();
		const both = await w.open('v1', 1, {instantiateGeneration: w.instantiateFromBundle});
		await both.add(w.specFor('v2', 10));
		await catchUp(both, 'v2');

		await both.promote(v1(both));

		expect(w.instantiated).toEqual([]);
		// the one moved away from stops being folded here too, for the same reason
		expect(heldHere(both)).toEqual([identityOf('v1')]);
	});
});

describe('a stored generation that cannot be instantiated REFUSES the move', () => {
	async function refusedWith(instantiate: World['instantiateFromBundle'], why: RegExp): Promise<void> {
		const {world: w, restarted} = await aRestartOnTheNewCodeAlone(instantiate);

		const moving = restarted.promote(v1(restarted));

		await expect(moving).rejects.toBeInstanceOf(GenerationInstantiationError);
		await expect(moving).rejects.toThrow(why);
		// exactly as it was: the same generation answers, and it is still the one folded
		expect((await restarted.canonical())?.processor).toBe(identityOf('v2'));
		expect(heldHere(restarted)).toEqual([identityOf('v2')]);
		const later = await theStreamMovesOn(restarted);
		expect(w.rowsIn('v2', restarted.streamDigest)).toContain(`${later}x10`);
	}

	it('when the host cannot build a fold from the stored bytes', async () => {
		await refusedWith(async () => {
			throw new Error('these bytes do not evaluate');
		}, /these bytes do not evaluate/);
	});

	it('when the stored bytes name a DIFFERENT fold than the generation they are stored under', async () => {
		await refusedWith(async () => world().specFor('v3', 3), /not the generation they are stored under/);
	});

	it('when no bundle is stored for it at all', async () => {
		const {world: w, restarted} = await aRestartOnTheNewCodeAlone();
		// registered on the registry with NO bytes, which the Node container never does
		// itself -- the shape a generation whose code is gone would have
		const bare = await restarted.registry.create({stream: restarted.streamDigest, processor: identityOf('v9')});

		await expect(restarted.promote(bare)).rejects.toThrow(/no bundle is stored for it/);
		expect((await restarted.canonical())?.processor).toBe(identityOf('v2'));
		expect(w.instantiated).toEqual([]);
	});
});
