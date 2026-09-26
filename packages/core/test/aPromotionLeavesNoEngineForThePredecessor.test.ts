import {describe, expect, it} from 'vitest';
import type {GenerationFolding, ReceivingIndexer} from '../src/receivingContainer.js';
import type {MemoryStore, TestABI, World} from './utils/receivingWorld.js';
import {identityOf} from './utils/processorIdentity.js';
import {anIncumbentThatHasFolded, batch, idOf, reportFor, transfer} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// A PROMOTION LEAVES NO ENGINE FOR THE PREDECESSOR, at the container seam (ADR-0092's third amendment)
// ---------------------------------------------------------------------------------------------------
// A generation `predecessor` names is not read and is not catching up, so it needs no
// engine; a revert instantiates it again from its stored bundle. That held only for a
// fold this process had INSTANTIATED from stored bytes: a fold `add` built here (an
// upload to a running `node`, the configured fold of a `run`) went on being folded after
// a same-stream promotion. Now, on a host that can rebuild a generation from stored
// bytes (`instantiateGeneration`), a PROMOTION stops folding the generation it
// superseded however it arrived, and it is RETAINED: registered, with its state and
// its bundle, and named by `predecessor`.
//
//  - on such a host, the superseded fold is no longer held and reports `instantiable`;
//  - a revert onto it instantiates it from its stored bundle and it folds again;
//  - a host with NO `instantiateGeneration` keeps folding it, because there stopping
//    it would turn every revert into a freeze;
//  - an arrival of it re-arms it as successor within the same process.
//
// The end-to-end claim (a `node` that received two uploads) is asserted in
// `packages/cli/test/aBundleIsUploadedToARunningNode.test.ts`; the push-fed guarantee on
// ANOTHER stream in `aSuccessorOnANewStreamIsFetched.test.ts`.
// ---------------------------------------------------------------------------------------------------

type Container = ReceivingIndexer<TestABI, string[], MemoryStore>;

/** The host's seam for turning stored bytes into a fold, as the CLI's commands inject it. */
const instantiating = (w: World) => ({instantiateGeneration: w.instantiateFromBundle});

const heldHere = (indexer: Container) => indexer.held().map((fold) => fold.record.processor);

async function catchUp(indexer: Container, marker: string): Promise<void> {
	for (let guard = 0; guard < 50; guard++) {
		const report = reportFor(await indexer.rebuildMore({maxEmissions: 1}), marker);
		if (!report) throw new Error(`no fold ${marker} to advance`);
		if (report.complete) return;
	}
	throw new Error('the rebuild never reported itself complete');
}

async function foldingOf(indexer: Container, marker: string): Promise<GenerationFolding> {
	const one = (await indexer.folding()).find((entry) => entry.generation.processor === identityOf(marker));
	if (!one) throw new Error(`no generation ${marker} is registered`);
	return one;
}

let nextBlock = 112;
/** The stream moves on by one block, appended by the deployment's own writer, and every held fold takes it. */
async function theStreamMovesOn(indexer: Container): Promise<string> {
	const block = nextBlock;
	nextBlock += 5;
	const LATER = transfer(block, `0xa${block}`, BigInt(block));
	const fromBlock = await indexer.ingestion.expectedFromBlock();
	await indexer.ingestion.receive(
		batch(indexer, {toBlock: block + 3, latestBlock: block + 3, logs: [LATER]}, fromBlock),
	);
	await indexer.rebuildMore();
	return idOf(LATER);
}

/**
 * A process that BUILT `v1` itself (its configured fold, not one instantiated from stored
 * bytes), then took `v2` as a successor on the SAME stream and promoted it on catching up.
 */
async function aPromotionOfAFoldBuiltHere(
	host: (w: World) => Parameters<World['open']>[2] = () => ({}),
): Promise<{world: World; indexer: Container}> {
	const {world: w} = await anIncumbentThatHasFolded();
	const indexer = await w.open('v1', 1, host(w));
	expect(heldHere(indexer)).toEqual([identityOf('v1')]);
	await indexer.add(w.specFor('v2', 10));
	await catchUp(indexer, 'v2');
	expect((await indexer.canonical())?.processor).toBe(identityOf('v2'));
	expect((await indexer.slots()).predecessor?.processor).toBe(identityOf('v1'));
	return {world: w, indexer};
}

describe('on a host that can instantiate stored bytes, a promotion stops folding what it superseded', () => {
	for (const host of ['push-fed', 'fetching'] as const) {
		it(`holds NO fold for the predecessor it built, and reports it instantiable (${host})`, async () => {
			const {world: w, indexer} = await aPromotionOfAFoldBuiltHere((w) => ({
				instantiateGeneration: w.instantiateFromBundle,
				...(host === 'fetching' ? {fetchesItsOwnStreams: true} : {}),
			}));
			const before = [...w.rowsIn('v1', indexer.streamDigest)];

			expect(heldHere(indexer)).toEqual([identityOf('v2')]);
			expect(await foldingOf(indexer, 'v1')).toMatchObject({folding: 'instantiable'});
			expect(await foldingOf(indexer, 'v2')).toMatchObject({folding: 'held'});

			// nothing folds it any more: the stream moves on, and its rows do not
			const later = await theStreamMovesOn(indexer);
			expect(w.rowsIn('v2', indexer.streamDigest)).toContain(`${later}x10`);
			expect(w.rowsIn('v1', indexer.streamDigest)).toEqual(before);
			// ...and it is RETAINED: registered, with its bundle, named by `predecessor`
			expect((await indexer.generations()).map((record) => record.processor)).toContain(identityOf('v1'));
			expect(await indexer.registry.bundleOf({stream: indexer.streamDigest, processor: identityOf('v1')})).toBeTruthy();
		});
	}

	it('instantiates it again from its stored bundle at a revert, and it FOLDS', async () => {
		const {world: w, indexer} = await aPromotionOfAFoldBuiltHere(instantiating);

		await indexer.promote({stream: indexer.streamDigest, processor: identityOf('v1')});

		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v1')]);
		expect(heldHere(indexer)).toEqual([identityOf('v1')]);
		expect(await foldingOf(indexer, 'v1')).toMatchObject({folding: 'held'});
		const later = await theStreamMovesOn(indexer);
		expect(w.rowsIn('v1', indexer.streamDigest)).toContain(`${later}x1`);
	});

	it('re-arms it as successor when it ARRIVES again in the same process, and promotes it', async () => {
		const {world: w, indexer} = await aPromotionOfAFoldBuiltHere(instantiating);
		await theStreamMovesOn(indexer);

		await indexer.add(w.specFor('v1', 1));
		expect((await indexer.slots()).successor?.processor).toBe(identityOf('v1'));
		expect(heldHere(indexer)).toContain(identityOf('v1'));

		await catchUp(indexer, 'v1');
		expect((await indexer.canonical())?.processor).toBe(identityOf('v1'));
		expect((await indexer.slots()).predecessor?.processor).toBe(identityOf('v2'));
		expect(heldHere(indexer)).toEqual([identityOf('v1')]);
	});
});

describe('on a host with NO `instantiateGeneration`, a promotion keeps folding what it superseded', () => {
	it('holds the predecessor’s fold and it advances, since a revert could not rebuild it', async () => {
		const {world: w, indexer} = await aPromotionOfAFoldBuiltHere();

		expect(heldHere(indexer)).toEqual([identityOf('v1'), identityOf('v2')]);
		expect(await foldingOf(indexer, 'v1')).toMatchObject({folding: 'held'});
		const later = await theStreamMovesOn(indexer);
		expect(w.rowsIn('v1', indexer.streamDigest)).toContain(`${later}x1`);
	});
});
