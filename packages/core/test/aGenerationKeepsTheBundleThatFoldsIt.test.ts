import {describe, expect, it} from 'vitest';
import {openMemoryGenerationRegistry} from '../src/generation/memory.js';
import {UnknownGenerationError, type GenerationId, type GenerationRegistry} from '../src/generation/registry.js';
import {openReceivingIndexer, type ReceivingIndexer} from '../src/receivingContainer.js';
import {arrivalOf, bundleBytes, identityOf, identityOfBytes} from './utils/processorIdentity.js';
import {FINALITY, SOURCE, world, type MemoryStore, type TestABI, type World} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// A GENERATION KEEPS THE BUNDLE THAT FOLDS IT, AND THE BUNDLE GOES WITH IT (ADR-0092)
// ---------------------------------------------------------------------------------------------------
// On a Node deployment holding a generation must mean holding something RUNNABLE
// rather than something readable, so registering one stores the octets that fold
// it, beside its state, and every path that deletes the generation deletes them.
// Nothing here READS them back into a processor: that is the next task's. What is
// pinned is that the bytes are present, are the right bytes, and are bounded by
// the registered generations.
//
// The bytes are SYNTHETIC (`bundleBytes`): the identity is the hash of the bytes
// (ADR-0086), so distinct markers give distinct, stable identities, which is all
// the registry, the slots and the deletions need. Nothing is bundled and nothing
// is evaluated.
//
// The seam is the REGISTRY for the storage contract (both halves of the port, the
// memory substrate being the reference one), and the RECEIVING CONTAINER for the
// three ways a generation is deleted in the ordinary course -- because the claim
// is that they share ONE deletion path, and the way to show that is to walk all
// three and look at what is left.
// ---------------------------------------------------------------------------------------------------

const CAPS = {maxGenerations: 8, maxStreams: 4};
const STREAM_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STREAM_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const idOf = (stream: string, marker: string): GenerationId => ({stream, processor: identityOf(marker)});

/** Every bundle this registry holds, one per registered generation that has one. */
async function storedBundles(registry: GenerationRegistry): Promise<Uint8Array[]> {
	const held: Uint8Array[] = [];
	for (const record of await registry.list()) {
		const bundle = await registry.bundleOf(record);
		if (bundle) held.push(bundle);
	}
	return held;
}

describe('registering a generation STORES the bundle that folds it', () => {
	it('stores the bytes with the record, readable back through the port', async () => {
		const registry = await openMemoryGenerationRegistry(CAPS);

		await registry.create(idOf(STREAM_A, 'v1'), {bundle: bundleBytes('v1')});

		expect(await registry.bundleOf(idOf(STREAM_A, 'v1'))).toEqual(bundleBytes('v1'));
	});

	it('stores the EXACT bytes whose hash is the generation identity', async () => {
		const registry = await openMemoryGenerationRegistry(CAPS);
		const record = await registry.create(idOf(STREAM_A, 'v1'), {bundle: bundleBytes('v1')});

		const stored = await registry.bundleOf(record);

		// re-hashed, which is the whole claim: what is kept is what NAMES the generation
		expect(identityOfBytes(stored as Uint8Array)).toBe(record.processor);
	});

	it('keeps its own copy, so a caller reusing its buffer cannot change the code a generation was registered with', async () => {
		const registry = await openMemoryGenerationRegistry(CAPS);
		const bytes = bundleBytes('v1');
		await registry.create(idOf(STREAM_A, 'v1'), {bundle: bytes});

		bytes.fill(0);

		expect(await registry.bundleOf(idOf(STREAM_A, 'v1'))).toEqual(bundleBytes('v1'));
	});

	it('writes no bytes when a registration RESOLVES, so a restart does not re-send its code', async () => {
		const registry = await openMemoryGenerationRegistry(CAPS);
		await registry.create(idOf(STREAM_A, 'v1'), {bundle: bundleBytes('v1')});

		// the identity is the hash of the bytes, so a resolving registration can only
		// carry what is already stored; a different buffer here would be a caller lying
		// about its bytes, and the record keeps what it was registered with
		await registry.create(idOf(STREAM_A, 'v1'), {bundle: bundleBytes('something else')});

		expect(await registry.bundleOf(idOf(STREAM_A, 'v1'))).toEqual(bundleBytes('v1'));
	});

	it('answers NOTHING for a generation it does not hold, and for one registered with no code', async () => {
		const registry = await openMemoryGenerationRegistry(CAPS);
		// the chain-facing container registers with no bytes, because a tab retains no
		// code (ADR-0089); the registry itself is runtime-neutral and says so by answering
		// `undefined` rather than refusing
		await registry.create(idOf(STREAM_A, 'tab'));

		expect(await registry.bundleOf(idOf(STREAM_A, 'tab'))).toBeUndefined();
		expect(await registry.bundleOf(idOf(STREAM_A, 'never-registered'))).toBeUndefined();
	});

	it('refuses NO bytes as a bundle, rather than storing code that could never fold anything', async () => {
		const registry = await openMemoryGenerationRegistry(CAPS);

		await expect(registry.create(idOf(STREAM_A, 'v1'), {bundle: new Uint8Array()})).rejects.toThrow(/non-empty octets/);
		expect(await registry.list()).toEqual([]);
	});
});

describe('deleting a generation DELETES its bundle, by every registry route', () => {
	it('takes the bytes with the row on `deleteGeneration`', async () => {
		const registry = await openMemoryGenerationRegistry(CAPS);
		await registry.create(idOf(STREAM_A, 'v1'), {bundle: bundleBytes('v1')});
		await registry.create(idOf(STREAM_A, 'v2'), {bundle: bundleBytes('v2')});

		await registry.deleteGeneration(idOf(STREAM_A, 'v2'));

		expect(await registry.bundleOf(idOf(STREAM_A, 'v2'))).toBeUndefined();
		expect(await registry.bundleOf(idOf(STREAM_A, 'v1'))).toEqual(bundleBytes('v1'));
	});

	it("takes every generation's bytes on `deleteStream`", async () => {
		const registry = await openMemoryGenerationRegistry(CAPS);
		await registry.create(idOf(STREAM_A, 'v1'), {bundle: bundleBytes('v1')});
		await registry.create(idOf(STREAM_B, 'v2'), {bundle: bundleBytes('v2')});
		await registry.create(idOf(STREAM_B, 'v3'), {bundle: bundleBytes('v3')});

		await registry.deleteStream(STREAM_B);

		expect(await registry.bundleOf(idOf(STREAM_B, 'v2'))).toBeUndefined();
		expect(await registry.bundleOf(idOf(STREAM_B, 'v3'))).toBeUndefined();
		expect(await storedBundles(registry)).toEqual([bundleBytes('v1')]);
	});

	it('does not bring the bytes back when the same generation is registered again with none', async () => {
		const registry = await openMemoryGenerationRegistry(CAPS);
		await registry.create(idOf(STREAM_A, 'v1'), {bundle: bundleBytes('v1')});
		await registry.create(idOf(STREAM_A, 'v2'), {bundle: bundleBytes('v2')});
		await registry.deleteGeneration(idOf(STREAM_A, 'v2'));

		await registry.create(idOf(STREAM_A, 'v2'));

		// the row is new, and so is everything kept under it: nothing survived the delete
		expect(await registry.bundleOf(idOf(STREAM_A, 'v2'))).toBeUndefined();
	});
});

/** A container over a world, under a promotion config of the test's choosing. */
function openOver(
	w: World,
	marker: string,
	promotion?: {policy: 'manual'; dropOnPromotion: boolean},
): Promise<ReceivingIndexer<TestABI, string[], MemoryStore>> {
	return openReceivingIndexer<TestABI, string[], MemoryStore>({
		port: w.port,
		source: SOURCE,
		stream: {finality: FINALITY},
		appendEmissions: (write) => w.stream.append(write),
		streamCursor: w.stream.cursor(),
		replay: w.stream.source(),
		...(promotion ? {promotion} : {}),
		generation: w.specFor(marker, 1),
	});
}

/** What the port holds for this generation, read the way the next task will read it. */
function bundleIn(w: World, indexer: ReceivingIndexer<TestABI, string[], MemoryStore>, marker: string) {
	return w.port.readBundle({stream: indexer.streamDigest, processor: identityOf(marker)});
}

describe('the RECEIVING container registers a generation WITH its bundle, and only with one', () => {
	it("stores the opening fold's bundle, and a successor's, as each is registered", async () => {
		const w = world();
		const indexer = await openOver(w, 'v1');
		await indexer.add(w.specFor('v2', 10));

		expect(await bundleIn(w, indexer, 'v1')).toEqual(bundleBytes('v1'));
		expect(await bundleIn(w, indexer, 'v2')).toEqual(bundleBytes('v2'));
		expect(identityOfBytes((await bundleIn(w, indexer, 'v2')) as Uint8Array)).toBe(identityOf('v2'));
	});

	it('REFUSES a fold handed over with no bundle, before anything is built or registered', async () => {
		const w = world();
		const indexer = await openOver(w, 'v1');
		let built = false;
		const {bundle: _dropped, ...withoutBytes} = w.specFor('v2', 10);

		await expect(
			indexer.add({
				...withoutBytes,
				createState: (context: {stream: string}) => {
					built = true;
					return withoutBytes.createState(context);
				},
			} as never),
		).rejects.toThrow(/BUNDLE that folds it/);

		expect(built).toBe(false);
		expect((await indexer.generations()).map((record) => record.processor)).toEqual([identityOf('v1')]);
	});

	it('does not REGISTER through its resolve path, which carries no bytes to store', async () => {
		const w = world();
		const indexer = await openOver(w, 'v1');

		await expect(
			indexer.resolveGeneration({stream: indexer.streamDigest, processor: identityOf('never-added')}),
		).rejects.toBeInstanceOf(UnknownGenerationError);
		expect((await indexer.generations()).length).toBe(1);
		// ...while what `add` registered still resolves, which is all a receiver asks it
		expect((await indexer.resolveGeneration(indexer.generation)).processor).toBe(identityOf('v1'));
	});
});

describe('EVERY way the receiving container deletes a generation takes its bundle', () => {
	it('a REPLACED SUCCESSOR goes with its bytes', async () => {
		const w = world();
		const indexer = await openOver(w, 'v1');
		await indexer.add(w.specFor('v2', 10));

		await indexer.add(w.specFor('v3', 10));

		expect((await indexer.generations()).map((record) => record.processor)).not.toContain(identityOf('v2'));
		expect(await bundleIn(w, indexer, 'v2')).toBeUndefined();
		expect(await bundleIn(w, indexer, 'v3')).toEqual(bundleBytes('v3'));
	});

	it('a generation DROPPED ON PROMOTION goes with its bytes', async () => {
		const w = world();
		const indexer = await openOver(w, 'v1', {policy: 'manual', dropOnPromotion: true});
		const successor = await indexer.add(w.specFor('v2', 10));

		await indexer.promote(successor.record);

		expect((await indexer.generations()).map((record) => record.processor)).toEqual([identityOf('v2')]);
		expect(await bundleIn(w, indexer, 'v1')).toBeUndefined();
		expect(await bundleIn(w, indexer, 'v2')).toEqual(bundleBytes('v2'));
	});

	it('a RECLAIMED generation goes with its bytes, and a slotted one keeps them', async () => {
		const w = world();
		const indexer = await openOver(w, 'v1');
		const second = await indexer.add(w.specFor('v2', 10));
		await indexer.promote(second.record);
		const third = await indexer.add(w.specFor('v3', 10));
		await indexer.promote(third.record);

		const report = await indexer.reclaim();

		expect(report.reclaimed.map((one) => one.generation.processor)).toEqual([identityOf('v1')]);
		expect(await bundleIn(w, indexer, 'v1')).toBeUndefined();
		// the REVERT TARGET keeps its code, which is the point of keeping it at all
		expect(await bundleIn(w, indexer, 'v2')).toEqual(bundleBytes('v2'));
		expect(await bundleIn(w, indexer, 'v3')).toEqual(bundleBytes('v3'));
	});
});

describe('the bundles are BOUNDED by the registered generations', () => {
	it('holds exactly one bundle per registered generation across a run of reconfigurations', async () => {
		const w = world();
		const indexer = await openOver(w, 'v1');
		for (const marker of ['v2', 'v3', 'v4', 'v5', 'v6']) {
			const fold = await indexer.add(w.specFor(marker, 10));
			if (marker === 'v3' || marker === 'v5') {
				await indexer.promote(fold.record);
			}
			const registered = await indexer.generations();
			const bundles = await storedBundles(indexer.registry);
			expect(bundles.length).toBe(registered.length);
			// ...and each is the code of the generation it is stored under, never a stray
			expect(bundles.map((bundle) => identityOfBytes(bundle)).sort()).toEqual(
				registered.map((record) => record.processor).sort(),
			);
		}
		await indexer.reclaim();
		expect((await storedBundles(indexer.registry)).length).toBe((await indexer.generations()).length);
	});

	it("is the ARRIVAL's identity and bytes together, never two values a host assembled apart", () => {
		// what every suite hands a receiving container, stated once: one marker, one name,
		// the bytes that name is the hash of
		const {processorIdentity, bundle} = arrivalOf('v1');
		expect(identityOfBytes(bundle)).toBe(processorIdentity);
	});
});
