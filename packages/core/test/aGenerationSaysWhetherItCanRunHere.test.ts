import {describe, expect, it} from 'vitest';
import type {GenerationFolding, ReceivingIndexer} from '../src/receivingContainer.js';
import type {MemoryStore, TestABI, World} from './utils/receivingWorld.js';
import {bundleBytes, identityOf} from './utils/processorIdentity.js';
import {anIncumbentThatHasFolded, reportFor} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// A GENERATION SAYS WHETHER IT CAN RUN HERE, at the container seam
// ---------------------------------------------------------------------------------------------------
// ADR-0092's visibility half. An operator about to revert must be able to tell,
// BEFORE the move, whether the generation they are reverting to can fold on this
// deployment, and a generation that cannot must be a REPORTED state rather than a
// silent stall (the spec's stories 2 and 8).
//
// Each registered generation is one of three things here:
//
//  - `held`         this process folds it now;
//  - `instantiable` it is not folded here, and the bundle stored on its row can
//                   be instantiated through the host's seam the moment it has to
//                   fold;
//  - `frozen`       neither, with the REASON: no bundle stored (its code is gone),
//                   no seam on this host, an attempt in this process that failed,
//                   or a stream this deployment does not fetch.
//
// Story 8 is REACHABLE, and this file is the evidence: a canonical generation
// whose stored code cannot be built at `open` is logged and answers frozen while
// the deployment starts (`an-upgrading-restart-keeps-the-incumbent-folding`), and
// before this nothing but a log line said so. The HTTP half, over a real
// database and a real bundle, is `packages/cli/test/aGenerationSaysWhetherItCanRunHere.test.ts`.
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

/** What the container says about ONE generation, by the marker whose bytes name it. */
async function foldingOf(indexer: Container, marker: string, stream?: string): Promise<GenerationFolding> {
	const processor = identityOf(marker);
	const all = await indexer.folding();
	const one = all.find(
		(entry) => entry.generation.processor === processor && entry.generation.stream === (stream ?? indexer.streamDigest),
	);
	if (!one) throw new Error(`no generation ${marker} is registered`);
	return one;
}

/**
 * An upgrade from `v1` to `v2` that landed, then a RESTART built with `v2` alone:
 * `v1` is what `predecessor` names, stored with its bytes, and folded by nothing.
 */
async function aRestartOnTheNewCodeAlone(
	extra: Parameters<World['open']>[2] = {},
): Promise<{world: World; restarted: Container}> {
	const {world: w, incumbent} = await anIncumbentThatHasFolded();
	await incumbent.add(w.specFor('v2', 10));
	await catchUp(incumbent, 'v2');
	expect((await incumbent.canonical())?.processor).toBe(identityOf('v2'));
	const restarted = await w.open('v2', 10, {instantiateGeneration: w.instantiateFromBundle, ...extra});
	return {world: w, restarted};
}

describe('each registered generation says whether it can fold HERE', () => {
	it('reports the generation this process folds as HELD', async () => {
		const {incumbent} = await anIncumbentThatHasFolded();

		expect(await foldingOf(incumbent, 'v1')).toMatchObject({folding: 'held'});
	});

	it('reports a stored generation this build lacks as INSTANTIABLE, and instantiates nothing to say so', async () => {
		const {world: w, restarted} = await aRestartOnTheNewCodeAlone();

		expect(await foldingOf(restarted, 'v2')).toMatchObject({folding: 'held'});
		expect(await foldingOf(restarted, 'v1')).toEqual({
			generation: expect.objectContaining({processor: identityOf('v1')}),
			folding: 'instantiable',
		});
		// ASKING is not instantiating: ADR-0092 rules out engines for generations nobody reads
		expect(w.instantiated).toEqual([]);
		expect(restarted.held().map((fold) => fold.record.processor)).toEqual([identityOf('v2')]);
	});

	it('reports every registered generation, one entry each, in the order the registry lists them', async () => {
		const {restarted} = await aRestartOnTheNewCodeAlone();

		const all = await restarted.folding();

		expect(all.map((entry) => entry.generation)).toEqual(await restarted.generations());
	});

	it('answers ONE generation exactly as the listing does, which is what `/status` asks about the canonical one', async () => {
		const {world: w, restarted} = await aRestartOnTheNewCodeAlone();

		for (const entry of await restarted.folding()) {
			expect(await restarted.foldingOf(entry.generation)).toEqual(entry);
		}
		// ...and asking about one instantiates nothing either
		expect(w.instantiated).toEqual([]);
	});

	it('follows the pointer: what a revert instantiated is HELD, and what it stopped folding is INSTANTIABLE', async () => {
		const {restarted} = await aRestartOnTheNewCodeAlone();

		await restarted.promote({stream: restarted.streamDigest, processor: identityOf('v1')});

		expect(await foldingOf(restarted, 'v1')).toMatchObject({folding: 'held'});
		expect(await foldingOf(restarted, 'v2')).toMatchObject({folding: 'instantiable'});
	});
});

describe('a generation that can fold NOWHERE here is FROZEN, and says why (story 8)', () => {
	it('when its stored code could not be built at OPEN, which otherwise only a log line said', async () => {
		const {world: w} = await anIncumbentThatHasFolded();

		// a restart with a changed processor, whose host cannot build the incumbent's bytes:
		// the deployment starts, and the generation answering every read does not advance
		const restarted = await w.open('v2', 10, {
			instantiateGeneration: async () => {
				throw new Error('these bytes do not evaluate');
			},
		});
		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));

		const canonical = await foldingOf(restarted, 'v1');
		expect(canonical).toMatchObject({folding: 'frozen', frozen: {reason: 'instantiation-failed'}});
		expect(canonical.folding === 'frozen' && canonical.frozen.message).toMatch(/these bytes do not evaluate/);
		expect(await foldingOf(restarted, 'v2')).toMatchObject({folding: 'held'});
	});

	it('when a revert onto it was REFUSED because its code could not be built', async () => {
		const {restarted} = await aRestartOnTheNewCodeAlone({
			instantiateGeneration: async () => {
				throw new Error('the loader refused these bytes');
			},
		});
		// before anything tried, nothing is known to be wrong with the stored bytes
		expect(await foldingOf(restarted, 'v1')).toMatchObject({folding: 'instantiable'});

		await expect(restarted.promote({stream: restarted.streamDigest, processor: identityOf('v1')})).rejects.toThrow(
			/the loader refused these bytes/,
		);

		expect(await foldingOf(restarted, 'v1')).toMatchObject({
			folding: 'frozen',
			frozen: {reason: 'instantiation-failed', message: expect.stringMatching(/the loader refused these bytes/)},
		});
	});

	it('when NO BUNDLE is stored for it: its code is gone', async () => {
		const {restarted} = await aRestartOnTheNewCodeAlone();
		// registered on the registry with no bytes, which the Node container's own `add`
		// refuses -- the shape a generation whose code is gone has on the durable row
		await restarted.registry.create({stream: restarted.streamDigest, processor: identityOf('v9')});

		expect(await foldingOf(restarted, 'v9')).toMatchObject({folding: 'frozen', frozen: {reason: 'no-bundle'}});
	});

	it('when this host was given no way to turn stored bytes into a fold', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		await incumbent.add(w.specFor('v2', 10));
		await catchUp(incumbent, 'v2');

		const restarted = await w.open('v2', 10);

		expect(await foldingOf(restarted, 'v1')).toMatchObject({folding: 'frozen', frozen: {reason: 'no-instantiator'}});
		expect(await foldingOf(restarted, 'v2')).toMatchObject({folding: 'held'});
	});

	it('when its stream is not one this deployment fetches (a filter change), though its code is fine', async () => {
		const {world: w, restarted} = await aRestartOnTheNewCodeAlone();
		const elsewhere = 'a-stream-this-deployment-does-not-fetch';
		await restarted.registry.create({stream: elsewhere, processor: identityOf('v1')}, {bundle: bundleBytes('v1')});

		expect(await foldingOf(restarted, 'v1', elsewhere)).toMatchObject({
			folding: 'frozen',
			frozen: {reason: 'stream-not-fetched'},
		});
		// ...and the report agrees with what a move onto it then does: it moves, and nothing folds it
		await restarted.promote({stream: elsewhere, processor: identityOf('v1')});
		expect(await foldingOf(restarted, 'v1', elsewhere)).toMatchObject({
			folding: 'frozen',
			frozen: {reason: 'stream-not-fetched'},
		});
		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v1')]);
	});
});
