import {describe, expect, it} from 'vitest';
import type {ReceivingIndexer} from '../src/receivingContainer.js';
import {streamDigestOf} from '../src/stream/identity.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import type {MemoryStore, TestABI, World} from './utils/receivingWorld.js';
import {identityOf} from './utils/processorIdentity.js';
import {abi, anIncumbentThatHasFolded, CONTRACT, FINALITY, SOURCE, world} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// A CONTAINER OPENED WITH NOTHING CONFIGURED, at the container seam (ADR-0093)
// ---------------------------------------------------------------------------------------------------
// A `run` node may be started with no processor and no source, and waits for its
// first upload. The end-to-end claim is asserted over a real deployment in
// `packages/cli/test/aRunNodeWithNothingConfiguredWaits.test.ts`; what is asserted
// HERE is the container's half, with synthetic bytes:
//
//  - it OPENS with no fold of its own and no source, and nothing stands in for
//    either: it holds nothing, names no canonical generation and fetches nothing;
//  - the first generation that ARRIVES must name its own source, becomes canonical by
//    the registry's existing rule, and names what the deployment fetches from then on;
//  - over a registry that already has a canonical generation, it instantiates THAT
//    from its stored bundle, on the source the host's instantiation names;
//  - a canonical generation it cannot instantiate does not stop it opening: it is
//    reported frozen with the reason, and the next arrival still registers.
// ---------------------------------------------------------------------------------------------------

type Container = ReceivingIndexer<TestABI, string[], MemoryStore>;

const heldHere = (indexer: Container) => indexer.held().map((fold) => fold.record.processor);
const SOURCE_STREAM = streamDigestOf(SOURCE, resolveStreamConfig({finality: FINALITY}));

/** What a host that knows no source of its own hands back: the stored bytes' fold, and the source THEY carry. */
function instantiatingWithTheirOwnSource(w: World) {
	return async (id: {stream: string; processor: string}, bundle: Uint8Array) => ({
		...(await w.instantiateFromBundle(id, bundle)),
		source: SOURCE,
	});
}

describe('a container opened with NOTHING configured, over an empty registry', () => {
	it('opens holding nothing, names no canonical generation, and fetches nothing', async () => {
		const w = world();

		const indexer = await w.openWithNothing();

		expect(heldHere(indexer)).toEqual([]);
		expect(await indexer.canonical()).toBeUndefined();
		// the read surface's question: NONE answers, which a read tier refuses (ADR-0058)
		expect(await indexer.canonicalGeneration()).toBeUndefined();
		expect(indexer.fetchedSource).toBeUndefined();
		expect(await indexer.liveIngestions()).toEqual([]);
		expect(await indexer.generations()).toEqual([]);
		// ...and no opening fold is invented to answer the singular accessors
		expect(() => indexer.generation).toThrow(/NOTHING configured/);
	});

	it('takes its first ARRIVAL as canonical, and fetches that arrival’s source from then on', async () => {
		const w = world();
		const indexer = await w.openWithNothing();

		const fold = await indexer.add({...w.specFor('v1', 1), source: SOURCE});

		expect(fold.record.stream).toBe(SOURCE_STREAM);
		expect((await indexer.canonical())?.processor).toBe(identityOf('v1'));
		expect(indexer.fetchedSource).toBe(SOURCE);
		expect((await indexer.liveIngestions()).map((writer) => writer.streamDigest)).toEqual([SOURCE_STREAM]);
		// the one it arrived with is now the opening fold
		expect(indexer.generation.processor).toBe(identityOf('v1'));
	});

	it('refuses an arrival that names no source, and registers NOTHING', async () => {
		const w = world();
		const indexer = await w.openWithNothing();

		await expect(indexer.add(w.specFor('v1', 1))).rejects.toThrow(/names no source/);

		expect(await indexer.generations()).toEqual([]);
		expect(heldHere(indexer)).toEqual([]);
		expect(indexer.fetchedSource).toBeUndefined();
	});

	it('takes a LATER arrival carrying another source as a successor, and goes on fetching the first', async () => {
		const w = world();
		const indexer = await w.openWithNothing();
		await indexer.add({...w.specFor('v1', 1), source: SOURCE});
		const other: typeof SOURCE = {chainId: '1', contracts: [{abi, address: CONTRACT, startBlock: 50}]};

		const successor = await indexer.add({...w.specFor('v2', 10), source: other});

		expect(successor.record.stream).not.toBe(SOURCE_STREAM);
		expect((await indexer.slots()).successor?.processor).toBe(identityOf('v2'));
		expect(indexer.fetchedSource).toBe(SOURCE);
	});
});

describe('a container opened with NOTHING configured, over a registry that has a canonical generation', () => {
	it('instantiates the canonical generation from its stored bundle, on the source that instantiation names', async () => {
		const {world: w} = await anIncumbentThatHasFolded();

		const indexer = await w.openWithNothing({instantiateGeneration: instantiatingWithTheirOwnSource(w)});

		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v1')]);
		expect(heldHere(indexer)).toEqual([identityOf('v1')]);
		expect(indexer.fetchedSource).toBe(SOURCE);
		expect((await indexer.canonical())?.processor).toBe(identityOf('v1'));
		expect((await indexer.foldingOf((await indexer.canonical())!)).folding).toBe('held');
	});

	it('opens anyway where the canonical generation cannot be instantiated, reports it frozen, and takes the next arrival', async () => {
		const {world: w} = await anIncumbentThatHasFolded();

		const indexer = await w.openWithNothing({
			instantiateGeneration: async () => {
				throw new Error('these bytes do not evaluate');
			},
		});

		expect(heldHere(indexer)).toEqual([]);
		expect(indexer.fetchedSource).toBeUndefined();
		const canonical = await indexer.canonical();
		expect(canonical?.processor).toBe(identityOf('v1'));
		expect(await indexer.foldingOf(canonical!)).toMatchObject({
			folding: 'frozen',
			frozen: {reason: 'instantiation-failed', message: expect.stringContaining('these bytes do not evaluate')},
		});

		// the next arrival registers beside it, as usual, and names what is fetched from now on
		const successor = await indexer.add({...w.specFor('v2', 10), source: SOURCE});
		expect((await indexer.slots()).successor?.processor).toBe(identityOf('v2'));
		expect((await indexer.canonical())?.processor).toBe(identityOf('v1'));
		expect(successor.record.stream).toBe(SOURCE_STREAM);
		expect(indexer.fetchedSource).toBe(SOURCE);
	});

	it('does not instantiate a canonical generation whose instantiation names no source, and says so', async () => {
		const {world: w} = await anIncumbentThatHasFolded();

		const indexer = await w.openWithNothing({instantiateGeneration: w.instantiateFromBundle});

		expect(heldHere(indexer)).toEqual([]);
		expect(await indexer.foldingOf((await indexer.canonical())!)).toMatchObject({
			folding: 'frozen',
			frozen: {reason: 'instantiation-failed', message: expect.stringContaining('nothing names what it indexes')},
		});
	});
});
