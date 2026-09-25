import {describe, expect, it} from 'vitest';
import type {ReceivingIndexer} from '../src/receivingContainer.js';
import type {MemoryStore, TestABI, World} from './utils/receivingWorld.js';
import {identityOf} from './utils/processorIdentity.js';
import {anIncumbentThatHasFolded, batch, idOf, reportFor, transfer} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// AN UPGRADING RESTART KEEPS THE INCUMBENT FOLDING, at the container seam
// ---------------------------------------------------------------------------------------------------
// ADR-0092's upgrade window. A process restarted with a changed processor holds a
// fold only for the NEW one, so without this the canonical generation's answers
// froze for the whole catch-up. The end-to-end claim is asserted over a real
// deployment in `packages/cli/test/anUpgradingRestartKeepsTheIncumbentFolding.test.ts`;
// what is asserted HERE is the container's half, with synthetic bytes:
//
//  - at `open`, the CANONICAL generation, and nothing else, is instantiated from
//    its stored bundle when this process holds no fold for it;
//  - it goes on FOLDING while the successor catches up;
//  - the successor is still promoted, against a cursor that moves, and the
//    incumbent stops being folded once the pointer leaves it;
//  - a restart that already holds the canonical fold instantiates nothing;
//  - a canonical generation whose code cannot be built does not stop the
//    deployment starting, and the upgrade still completes.
// ---------------------------------------------------------------------------------------------------

type Container = ReceivingIndexer<TestABI, string[], MemoryStore>;

const heldHere = (indexer: Container) => indexer.held().map((fold) => fold.record.processor);

/** How far one generation has folded, read from its own state with no engine, as the trigger reads it. */
async function positionOf(indexer: Container, marker: string): Promise<number | undefined> {
	return indexer.registry.readStateCursor({stream: indexer.streamDigest, processor: identityOf(marker)});
}

async function catchUp(indexer: Container, marker: string): Promise<void> {
	for (let guard = 0; guard < 50; guard++) {
		const report = reportFor(await indexer.rebuildMore({maxEmissions: 1}), marker);
		if (!report) throw new Error(`no fold ${marker} to advance`);
		if (report.complete) return;
	}
	throw new Error('the rebuild never reported itself complete');
}

let nextBlock = 112;
/**
 * THE CHAIN MOVES ON by one block, fetched and appended by the deployment's own
 * writer -- and NOTHING ELSE: no `rebuildMore`, so what advances is exactly what
 * takes the delta live.
 */
async function theStreamMovesOn(indexer: Container): Promise<{id: string; toBlock: number}> {
	const block = nextBlock;
	nextBlock += 5;
	const LATER = transfer(block, `0xa${block}`, BigInt(block));
	const toBlock = block + 3;
	const fromBlock = await indexer.ingestion.expectedFromBlock();
	await indexer.ingestion.receive(batch(indexer, {toBlock, latestBlock: toBlock, logs: [LATER]}, fromBlock));
	return {id: idOf(LATER), toBlock};
}

/**
 * A deployment that folded under `v1`, RESTARTED with `v2` alone and handed the
 * host's way of instantiating stored bytes.
 */
async function aRestartWithAChangedProcessor(
	extra: Parameters<World['open']>[2] = {},
): Promise<{world: World; restarted: Container}> {
	const {world: w} = await anIncumbentThatHasFolded();
	const restarted = await w.open('v2', 10, {instantiateGeneration: w.instantiateFromBundle, ...extra});
	return {world: w, restarted};
}

describe('an upgrading restart instantiates the CANONICAL generation at open', () => {
	it('instantiates the incumbent from its stored bundle, and nothing else', async () => {
		const {world: w, restarted} = await aRestartWithAChangedProcessor({promotion: {policy: 'manual'}});

		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v1')]);
		// the fold it OPENED with is still the configured one: the incumbent is held beside it
		expect(restarted.generation.processor).toBe(identityOf('v2'));
		expect(heldHere(restarted)).toEqual([identityOf('v2'), identityOf('v1')]);
		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));
	});

	it('keeps the incumbent FOLDING while the successor catches up', async () => {
		const {world: w, restarted} = await aRestartWithAChangedProcessor({promotion: {policy: 'manual'}});
		const stood = await positionOf(restarted, 'v1');
		expect(stood).toBe(110);

		const later = await theStreamMovesOn(restarted);

		// the incumbent took the new block LIVE, with its own code (weight 1), and its
		// cursor moved: the answers a reader gets are not frozen at where it stood
		expect(w.rowsIn('v1', restarted.streamDigest)).toContain(`${later.id}x1`);
		expect(await positionOf(restarted, 'v1')).toBe(later.toBlock);
		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));
	});

	it('instantiates ONLY the canonical generation, never the predecessor a revert left stored', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		// an upgrade to v2 in a previous process, then a revert back to v1: v2 is what
		// `predecessor` names, stored with its bundle and runnable here
		await incumbent.add(w.specFor('v2', 10));
		await catchUp(incumbent, 'v2');
		expect((await incumbent.canonical())?.processor).toBe(identityOf('v2'));
		await incumbent.promote({stream: incumbent.streamDigest, processor: identityOf('v1')});
		expect((await incumbent.slots()).predecessor?.processor).toBe(identityOf('v2'));

		const restarted = await w.open('v3', 100, {
			instantiateGeneration: w.instantiateFromBundle,
			promotion: {policy: 'manual'},
		});

		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v1')]);
		expect(heldHere(restarted)).toEqual([identityOf('v3'), identityOf('v1')]);
	});

	it('instantiates nothing when the restart already holds the canonical fold', async () => {
		const {world: w} = await anIncumbentThatHasFolded();

		const restarted = await w.open('v1', 1, {instantiateGeneration: w.instantiateFromBundle});

		expect(w.instantiated).toEqual([]);
		expect(heldHere(restarted)).toEqual([identityOf('v1')]);
	});

	it('instantiates nothing under `immediate`, because the pointer has left the incumbent by then', async () => {
		const {world: w, restarted} = await aRestartWithAChangedProcessor({promotion: {policy: 'immediate'}});

		expect((await restarted.canonical())?.processor).toBe(identityOf('v2'));
		expect(w.instantiated).toEqual([]);
		expect(heldHere(restarted)).toEqual([identityOf('v2')]);
	});
});

describe('the upgrade still COMPLETES, against an incumbent that moves', () => {
	it('promotes the successor once it has caught the MOVING incumbent up, then stops folding the incumbent', async () => {
		const {world: w, restarted} = await aRestartWithAChangedProcessor();

		// the incumbent moves first: it is level with the stream and takes the block live,
		// while the successor, re-folding from the start, is behind and declines it
		const moved = await theStreamMovesOn(restarted);
		expect(await positionOf(restarted, 'v1')).toBe(moved.toBlock);
		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));

		// the successor catches up to where the incumbent now IS, not to where it stood at open
		await catchUp(restarted, 'v2');
		expect(await positionOf(restarted, 'v2')).toBe(moved.toBlock);
		expect((await restarted.canonical())?.processor).toBe(identityOf('v2'));

		// the incumbent is no longer folded here: kept, named by `predecessor`, and still
		const incumbentRows = [...w.rowsIn('v1', restarted.streamDigest)];
		expect(heldHere(restarted)).toEqual([identityOf('v2')]);
		expect((await restarted.slots()).predecessor?.processor).toBe(identityOf('v1'));
		const after = await theStreamMovesOn(restarted);
		expect(w.rowsIn('v2', restarted.streamDigest)).toContain(`${after.id}x10`);
		expect(w.rowsIn('v1', restarted.streamDigest)).toEqual(incumbentRows);
		expect(await positionOf(restarted, 'v1')).toBe(moved.toBlock);
	});

	it('never promotes a successor that has reached where the incumbent STOOD but not where it now is', async () => {
		const {restarted} = await aRestartWithAChangedProcessor();
		const moved = await theStreamMovesOn(restarted);

		// one emission at a time, so the successor passes 110 -- where the incumbent stood
		// at open -- on the way, and the pointer must not move until it reaches the
		// incumbent's CURRENT position
		let steps = 0;
		for (; steps < 50; steps++) {
			await restarted.rebuildMore({maxEmissions: 1});
			const successorAt = await positionOf(restarted, 'v2');
			if ((await restarted.canonical())?.processor === identityOf('v2')) {
				expect(successorAt).toBe(moved.toBlock);
				break;
			}
			expect(successorAt === undefined || successorAt < moved.toBlock).toBe(true);
		}
		expect((await restarted.canonical())?.processor).toBe(identityOf('v2'));
		expect(steps).toBeGreaterThan(0);
	});
});

describe('a canonical generation whose stored code cannot be built at open', () => {
	it('does not stop the deployment starting, and the upgrade still completes', async () => {
		const {world: w} = await anIncumbentThatHasFolded();

		const restarted = await w.open('v2', 10, {
			instantiateGeneration: async () => {
				throw new Error('these bytes do not evaluate');
			},
		});

		// the incumbent answers, frozen, exactly as it did before retained code existed
		expect(heldHere(restarted)).toEqual([identityOf('v2')]);
		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));
		await catchUp(restarted, 'v2');
		expect((await restarted.canonical())?.processor).toBe(identityOf('v2'));
		expect(w.instantiated).toEqual([]);
	});
});
