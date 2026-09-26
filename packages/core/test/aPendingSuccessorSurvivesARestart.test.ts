import {describe, expect, it} from 'vitest';
import type {ReceivingIndexer, SuccessorReplacementAtStart} from '../src/receivingContainer.js';
import type {MemoryStore, TestABI, World} from './utils/receivingWorld.js';
import {identityOf} from './utils/processorIdentity.js';
import {anIncumbentThatHasFolded, SOURCE} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// A PENDING SUCCESSOR SURVIVES A RESTART, at the container seam
// ---------------------------------------------------------------------------------------------------
// ADR-0092's amendment of 2026-09-26, and ADR-0084's and ADR-0093's of the same day.
// The end-to-end claims are asserted over a real `run` and a real `etherfold upload`
// in `packages/cli/test/anUploadedProcessorSurvivesARestart.test.ts`; what is asserted
// HERE is the container's half, with synthetic bytes:
//
//  - at `open`, the generation `successor` names is instantiated from its stored
//    bundle when this process holds no fold for it, catches up, and is promoted under
//    `on-catch-up` with nobody asking; the incumbent's instantiated fold then stops;
//  - `predecessor` is NOT instantiated at open;
//  - a configured fold that would REPLACE a different pending successor asks the host
//    first (`confirmReplacingSuccessorAtStart`), and a refusal registers and deletes
//    nothing; where nothing would be replaced it is not asked at all;
//  - `add` -- a re-read, an upload -- is never asked.
// ---------------------------------------------------------------------------------------------------

type Container = ReceivingIndexer<TestABI, string[], MemoryStore>;

const heldHere = (indexer: Container) => indexer.held().map((fold) => fold.record.processor);

async function catchUp(indexer: Container, marker: string): Promise<void> {
	for (let guard = 0; guard < 50; guard++) {
		const reports = await indexer.rebuildMore({maxEmissions: 1});
		const report = reports.find((one) => one.generation.processor === identityOf(marker));
		if (!report) return;
		if (report.complete) return;
	}
	throw new Error('the rebuild never reported itself complete');
}

/** What a host that knows no source of its own hands back: the stored bytes' fold, and the source THEY carry. */
function instantiatingWithTheirOwnSource(w: World) {
	return async (id: {stream: string; processor: string}, bundle: Uint8Array) => ({
		...(await w.instantiateFromBundle(id, bundle)),
		source: SOURCE,
	});
}

/**
 * A deployment that folded under `v1` and had `v2` ARRIVE beside it (an upload, a
 * re-read) that had not caught up when the process stopped: `v2` is what `successor`
 * names, with its bundle stored.
 */
async function aStoppedDeploymentWithAPendingSuccessor(): Promise<World> {
	const {world: w, incumbent} = await anIncumbentThatHasFolded();
	await incumbent.add(w.specFor('v2', 10));
	const slots = await incumbent.slots();
	expect(slots.canonical?.processor).toBe(identityOf('v1'));
	expect(slots.successor?.processor).toBe(identityOf('v2'));
	return w;
}

describe('the pending successor FOLDS from open', () => {
	it('is instantiated beside the canonical generation on a node started with nothing configured, catches up, and is promoted', async () => {
		const w = await aStoppedDeploymentWithAPendingSuccessor();

		const restarted = await w.openWithNothing({instantiateGeneration: instantiatingWithTheirOwnSource(w)});

		// BOTH are folded here: the canonical generation because it answers reads, the
		// successor because it is catching up -- and in that order
		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v1'), identityOf('v2')]);
		expect(heldHere(restarted)).toEqual([identityOf('v1'), identityOf('v2')]);
		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));

		// under `on-catch-up` (the default) it is promoted with nobody asking, and the
		// incumbent's instantiated fold stops being folded
		await catchUp(restarted, 'v2');
		expect((await restarted.canonical())?.processor).toBe(identityOf('v2'));
		expect(heldHere(restarted)).toEqual([identityOf('v2')]);
		expect((await restarted.slots()).predecessor?.processor).toBe(identityOf('v1'));
	});

	it('is instantiated beside a configured fold that names the canonical generation, which changes nothing', async () => {
		const w = await aStoppedDeploymentWithAPendingSuccessor();
		const asked: SuccessorReplacementAtStart[] = [];

		const restarted = await w.open('v1', 1, {
			instantiateGeneration: w.instantiateFromBundle,
			confirmReplacingSuccessorAtStart: (replacement) => {
				asked.push(replacement);
			},
		});

		expect(asked).toEqual([]);
		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v2')]);
		expect(heldHere(restarted)).toEqual([identityOf('v1'), identityOf('v2')]);
		await catchUp(restarted, 'v2');
		expect((await restarted.canonical())?.processor).toBe(identityOf('v2'));
	});

	it('waits under `manual`: folded, caught up, and NOT promoted until somebody asks', async () => {
		const w = await aStoppedDeploymentWithAPendingSuccessor();

		const restarted = await w.openWithNothing({
			instantiateGeneration: instantiatingWithTheirOwnSource(w),
			promotion: {policy: 'manual'},
		});
		await catchUp(restarted, 'v2');

		expect(heldHere(restarted)).toEqual([identityOf('v1'), identityOf('v2')]);
		expect((await restarted.canonical())?.processor).toBe(identityOf('v1'));
	});

	it('never instantiates what `predecessor` names', async () => {
		const {world: w, incumbent} = await anIncumbentThatHasFolded();
		// v1 -> v2 promoted in a previous process, so v1 is the predecessor; then v3 arrives
		// and is still catching up when that process stops
		await incumbent.add(w.specFor('v2', 10));
		await catchUp(incumbent, 'v2');
		expect((await incumbent.canonical())?.processor).toBe(identityOf('v2'));
		await incumbent.add(w.specFor('v3', 100));
		const slots = await incumbent.slots();
		expect(slots.predecessor?.processor).toBe(identityOf('v1'));
		expect(slots.successor?.processor).toBe(identityOf('v3'));

		const restarted = await w.openWithNothing({
			instantiateGeneration: instantiatingWithTheirOwnSource(w),
			promotion: {policy: 'manual'},
		});

		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v2'), identityOf('v3')]);
		expect(heldHere(restarted)).not.toContain(identityOf('v1'));
	});

	it('starts anyway where the successor cannot be instantiated, and the canonical generation still folds', async () => {
		const w = await aStoppedDeploymentWithAPendingSuccessor();

		const restarted = await w.openWithNothing({
			instantiateGeneration: async (id, bundle) => {
				if (id.processor === identityOf('v2')) throw new Error('these bytes do not evaluate');
				return instantiatingWithTheirOwnSource(w)(id, bundle);
			},
		});

		expect(heldHere(restarted)).toEqual([identityOf('v1')]);
		expect((await restarted.slots()).successor?.processor).toBe(identityOf('v2'));
		expect(await restarted.foldingOf((await restarted.slots()).successor!)).toMatchObject({
			folding: 'frozen',
			frozen: {reason: 'instantiation-failed'},
		});
	});
});

describe('a START that would replace a DIFFERENT pending successor asks first', () => {
	it('asks, naming both, and a refusal registers, builds and deletes NOTHING', async () => {
		const w = await aStoppedDeploymentWithAPendingSuccessor();
		const asked: SuccessorReplacementAtStart[] = [];
		const refused = new Error('not without --override');

		await expect(
			w.open('v3', 100, {
				instantiateGeneration: w.instantiateFromBundle,
				confirmReplacingSuccessorAtStart: (replacement) => {
					asked.push(replacement);
					throw refused;
				},
			}),
		).rejects.toBe(refused);

		expect(asked).toHaveLength(1);
		expect(asked[0]?.pending.processor).toBe(identityOf('v2'));
		expect(asked[0]?.arriving.processor).toBe(identityOf('v3'));
		expect(asked[0]?.arriving.stream).toBe(asked[0]?.pending.stream);
		// the registry is exactly as it was: v2 still pending, with its bundle, and no v3
		const after = await w.openWithNothing({promotion: {policy: 'manual'}});
		const slots = await after.slots();
		expect(slots.successor?.processor).toBe(identityOf('v2'));
		expect((await after.generations()).map((record) => record.processor)).toEqual([identityOf('v1'), identityOf('v2')]);
		expect(await after.registry.bundleOf(slots.successor!)).toBeDefined();
		expect(w.instantiated).toEqual([]);
	});

	it('replaces it -- row, state and bytes -- when the host lets it, and folds only the configured successor', async () => {
		const w = await aStoppedDeploymentWithAPendingSuccessor();
		const v2 = identityOf('v2');

		const restarted = await w.open('v3', 100, {
			instantiateGeneration: w.instantiateFromBundle,
			promotion: {policy: 'manual'},
			confirmReplacingSuccessorAtStart: () => undefined,
		});

		const slots = await restarted.slots();
		expect(slots.successor?.processor).toBe(identityOf('v3'));
		expect((await restarted.generations()).map((record) => record.processor)).not.toContain(v2);
		expect(w.rowsIn('v2', restarted.streamDigest).length).toBe(0);
		// the replaced successor was never instantiated: `add` ran first
		expect(w.instantiated.map((call) => call.processor)).toEqual([identityOf('v1')]);
		expect(heldHere(restarted)).toEqual([identityOf('v3'), identityOf('v1')]);
	});

	it('does not ask where the configured fold IS the pending successor', async () => {
		const w = await aStoppedDeploymentWithAPendingSuccessor();
		const asked: SuccessorReplacementAtStart[] = [];

		const restarted = await w.open('v2', 10, {
			instantiateGeneration: w.instantiateFromBundle,
			confirmReplacingSuccessorAtStart: (replacement) => {
				asked.push(replacement);
			},
		});

		expect(asked).toEqual([]);
		expect((await restarted.slots()).successor?.processor).toBe(identityOf('v2'));
	});

	it('never asks an ARRIVAL: `add` on a running container replaces the pending successor as it always did', async () => {
		const w = await aStoppedDeploymentWithAPendingSuccessor();
		const asked: SuccessorReplacementAtStart[] = [];
		const restarted = await w.open('v1', 1, {
			instantiateGeneration: w.instantiateFromBundle,
			promotion: {policy: 'manual'},
			confirmReplacingSuccessorAtStart: (replacement) => {
				asked.push(replacement);
			},
		});

		await restarted.add(w.specFor('v3', 100));

		expect(asked).toEqual([]);
		expect((await restarted.slots()).successor?.processor).toBe(identityOf('v3'));
		expect((await restarted.generations()).map((record) => record.processor)).not.toContain(identityOf('v2'));
		expect(heldHere(restarted)).toEqual([identityOf('v1'), identityOf('v3')]);
	});
});
