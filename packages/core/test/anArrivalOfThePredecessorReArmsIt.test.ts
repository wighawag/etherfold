import {describe, expect, it} from 'vitest';
import type {ReceivingIndexer, SuccessorReplacementAtStart} from '../src/receivingContainer.js';
import type {MemoryStore, TestABI, World} from './utils/receivingWorld.js';
import {identityOf} from './utils/processorIdentity.js';
import {anIncumbentThatHasFolded, batch, reportFor, SOURCE, transfer} from './utils/receivingWorld.js';

// ---------------------------------------------------------------------------------------------------
// AN ARRIVAL OF THE PREDECESSOR RE-ARMS IT AS SUCCESSOR, at the container seam
// ---------------------------------------------------------------------------------------------------
// ADR-0094 (the maintainer's decision of 2026-09-26). An arrival naming the generation
// `predecessor` holds -- `add` (an upload to a `node`), or a configured start naming it
// -- MOVES it into `successor`, and `predecessor` is emptied. From there it is a
// successor like any other: the policy promotes it (under `on-catch-up` once it has
// caught up from where its own state stood), and the generation it replaces as
// canonical becomes `predecessor`. The pointer is never moved directly.
//
// The end-to-end claims (an `etherfold upload` of the old bundle to a `node`, a
// restart of `run` with the old `-p`) are asserted in
// `packages/cli/test/aBundleIsUploadedToARunningNode.test.ts` and
// `packages/cli/test/anUploadedProcessorSurvivesARestart.test.ts`. What is asserted
// HERE is the container's half, with synthetic bytes.
// ---------------------------------------------------------------------------------------------------

type Container = ReceivingIndexer<TestABI, string[], MemoryStore>;

const heldHere = (indexer: Container) => indexer.held().map((fold) => fold.record.processor);

async function catchUp(indexer: Container, marker: string): Promise<void> {
	for (let guard = 0; guard < 50; guard++) {
		const report = reportFor(await indexer.rebuildMore({maxEmissions: 1}), marker);
		if (!report) return;
		if (report.complete) return;
	}
	throw new Error('the rebuild never reported itself complete');
}

/** The processor identities each slot names, so one expectation reads the whole registry. */
async function slotsOf(indexer: Container): Promise<Record<string, string | undefined>> {
	const slots = await indexer.slots();
	return {
		canonical: slots.canonical?.processor,
		successor: slots.successor?.processor,
		predecessor: slots.predecessor?.processor,
	};
}

/**
 * `v1` folded, `v2` arrived and was PROMOTED over it in that process, so `v1` is what
 * `predecessor` names. The process that did it is handed back too: it still HOLDS a
 * fold for `v1`: it was opened with no `instantiateGeneration`, and there a promotion keeps
 * the superseded fold it built, since a revert could not rebuild it (ADR-0092's third
 * amendment; on a host that can, `aPromotionLeavesNoEngineForThePredecessor.test.ts`).
 */
async function anUpgradeThatLanded(): Promise<{world: World; first: Container}> {
	const {world: w, incumbent} = await anIncumbentThatHasFolded();
	await incumbent.add(w.specFor('v2', 10));
	await catchUp(incumbent, 'v2');
	expect(await slotsOf(incumbent)).toEqual({
		canonical: identityOf('v2'),
		successor: undefined,
		predecessor: identityOf('v1'),
	});
	return {world: w, first: incumbent};
}

/** What a host that knows no source of its own hands back: the stored bytes' fold, and the source THEY carry. */
function instantiatingWithTheirOwnSource(w: World) {
	return async (id: {stream: string; processor: string}, bundle: Uint8Array) => ({
		...(await w.instantiateFromBundle(id, bundle)),
		source: SOURCE,
	});
}

/**
 * ...then a RESTART of a `node` (nothing configured, ADR-0094) over the same rows, so the
 * canonical `v2` is instantiated from its stored bundle and nothing in the process folds `v1`.
 */
async function aRestartHoldingAnUnheldPredecessor(
	extra: Parameters<World['openWithNothing']>[0] = {},
): Promise<{world: World; restarted: Container}> {
	const {world: w} = await anUpgradeThatLanded();
	const restarted = await w.openWithNothing({instantiateGeneration: instantiatingWithTheirOwnSource(w), ...extra});
	expect(heldHere(restarted)).toEqual([identityOf('v2')]);
	return {world: w, restarted};
}

/** The stream moves on while `v1` folds nothing, so a re-armed `v1` has something to catch up. */
async function theStreamMovesOn(indexer: Container): Promise<void> {
	const fromBlock = await indexer.ingestion.expectedFromBlock();
	await indexer.ingestion.receive(
		batch(indexer, {toBlock: 115, latestBlock: 115, logs: [transfer(112, '0xa112', 5n)]}, fromBlock),
	);
	await catchUp(indexer, 'v2');
}

describe('an ARRIVAL (`add`) of what `predecessor` names', () => {
	it('MOVES it into `successor`, empties `predecessor`, catches it up, and promotes it under `on-catch-up`', async () => {
		const {world: w, restarted} = await aRestartHoldingAnUnheldPredecessor();
		await theStreamMovesOn(restarted);

		await restarted.add(w.specFor('v1', 1));

		// RE-ARMED, not promoted: it is behind, so it waits in `successor` and folds
		expect(await slotsOf(restarted)).toEqual({
			canonical: identityOf('v2'),
			successor: identityOf('v1'),
			predecessor: undefined,
		});
		expect(heldHere(restarted)).toContain(identityOf('v1'));

		// ...catches up from where its own state stood, and the policy promotes it; the
		// generation it replaced as canonical is what `predecessor` names now
		await catchUp(restarted, 'v1');
		expect(await slotsOf(restarted)).toEqual({
			canonical: identityOf('v1'),
			successor: undefined,
			predecessor: identityOf('v2'),
		});
		// ...and NO ENGINE is left running for the generation `predecessor` names: `v2` was
		// instantiated here only because it answered reads
		expect(heldHere(restarted)).toEqual([identityOf('v1')]);
	});

	it('waits in `successor` under `manual`, folded and caught up, and is promoted only when asked', async () => {
		const {world: w, restarted} = await aRestartHoldingAnUnheldPredecessor({promotion: {policy: 'manual'}});
		await theStreamMovesOn(restarted);

		await restarted.add(w.specFor('v1', 1));
		await catchUp(restarted, 'v1');

		expect(await slotsOf(restarted)).toEqual({
			canonical: identityOf('v2'),
			successor: identityOf('v1'),
			predecessor: undefined,
		});
		expect(heldHere(restarted)).toEqual([identityOf('v2'), identityOf('v1')]);

		await restarted.promote((await restarted.slots()).successor!);
		expect(await slotsOf(restarted)).toEqual({
			canonical: identityOf('v1'),
			successor: undefined,
			predecessor: identityOf('v2'),
		});
		expect(heldHere(restarted)).not.toContain(identityOf('v2'));
	});

	it('replaces a DIFFERENT pending successor without asking, as any arrival does', async () => {
		const {world: w, restarted} = await aRestartHoldingAnUnheldPredecessor({promotion: {policy: 'manual'}});
		await restarted.add(w.specFor('v3', 100));
		expect((await restarted.slots()).successor?.processor).toBe(identityOf('v3'));

		await restarted.add(w.specFor('v1', 1));

		expect(await slotsOf(restarted)).toEqual({
			canonical: identityOf('v2'),
			successor: identityOf('v1'),
			predecessor: undefined,
		});
		expect((await restarted.generations()).map((record) => record.processor)).not.toContain(identityOf('v3'));
		expect(heldHere(restarted)).not.toContain(identityOf('v3'));
	});

	it('builds no SECOND fold where this process still holds one for it, and re-arms the one it holds', async () => {
		const {world: w, first} = await anUpgradeThatLanded();
		// the same process: the superseded fold it built for `v1` is still held
		expect(heldHere(first)).toEqual([identityOf('v1'), identityOf('v2')]);
		const held = first.held().find((fold) => fold.record.processor === identityOf('v1'));

		const fold = await first.add(w.specFor('v1', 1));

		expect(fold).toBe(held);
		expect(heldHere(first)).toEqual([identityOf('v1'), identityOf('v2')]);
		// level already (it kept folding), so `on-catch-up` promotes it at once
		expect(await slotsOf(first)).toEqual({
			canonical: identityOf('v1'),
			successor: undefined,
			predecessor: identityOf('v2'),
		});
	});
});

describe('a configured START naming what `predecessor` names', () => {
	it('re-arms it with NOBODY asked where nothing is pending, and promotes it: a rollback by configuration', async () => {
		const {world: w} = await anUpgradeThatLanded();
		const asked: SuccessorReplacementAtStart[] = [];

		const restarted = await w.open('v1', 1, {
			instantiateGeneration: w.instantiateFromBundle,
			confirmReplacingSuccessorAtStart: (replacement) => {
				asked.push(replacement);
			},
		});

		expect(asked).toEqual([]);
		// level with `v2`, so `on-catch-up` promoted it inside `open`
		expect(await slotsOf(restarted)).toEqual({
			canonical: identityOf('v1'),
			successor: undefined,
			predecessor: identityOf('v2'),
		});
		// the generation the start rolled back from is never built into an engine
		expect(w.instantiated).toEqual([]);
		expect(heldHere(restarted)).toEqual([identityOf('v1')]);
	});

	it('asks before REPLACING a different pending successor, and a refusal changes nothing', async () => {
		const {world: w, first} = await anUpgradeThatLanded();
		await first.add(w.specFor('v3', 100));
		const asked: SuccessorReplacementAtStart[] = [];
		const refused = new Error('not without --override');

		await expect(
			w.open('v1', 1, {
				instantiateGeneration: w.instantiateFromBundle,
				confirmReplacingSuccessorAtStart: (replacement) => {
					asked.push(replacement);
					throw refused;
				},
			}),
		).rejects.toBe(refused);

		expect(asked).toHaveLength(1);
		const replacement = asked[0];
		if (replacement?.kind !== 'replace') throw new Error(`asked about a ${replacement?.kind}, not a replacement`);
		expect(replacement.pending.processor).toBe(identityOf('v3'));
		expect(replacement.arriving.processor).toBe(identityOf('v1'));
		const after = await w.openWithNothing({promotion: {policy: 'manual'}});
		expect(await slotsOf(after)).toEqual({
			canonical: identityOf('v2'),
			successor: identityOf('v3'),
			predecessor: identityOf('v1'),
		});
	});

	it('replaces it, re-arms the predecessor and promotes it, when the host lets it', async () => {
		const {world: w, first} = await anUpgradeThatLanded();
		await first.add(w.specFor('v3', 100));

		const restarted = await w.open('v1', 1, {
			instantiateGeneration: w.instantiateFromBundle,
			confirmReplacingSuccessorAtStart: () => undefined,
		});

		expect(await slotsOf(restarted)).toEqual({
			canonical: identityOf('v1'),
			successor: undefined,
			predecessor: identityOf('v2'),
		});
		expect((await restarted.generations()).map((record) => record.processor)).not.toContain(identityOf('v3'));
		expect(heldHere(restarted)).toEqual([identityOf('v1')]);
	});
});
