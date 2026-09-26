import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {openIndexer, type AnyGenerationSpec, OpenedSpecsDisplaceOneAnotherError} from '../src/container.js';
import {openMemoryGenerationRegistry} from '../src/generation/memory.js';
import type {GenerationId, GenerationRegistry} from '../src/generation/registry.js';
import type {EventProcessor} from '../src/types.js';
import {identityOf, markerOf} from './utils/processorIdentity.js';
import {FINALITY, SOURCE} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------------------------------
// AN OPEN WHOSE SPECS WOULD DISPLACE ONE ANOTHER IS REFUSED, and holds no fold the registry does not name
// ---------------------------------------------------------------------------------------------------
// `open` registers every spec into `successor` before it builds any engine (ADR-0088), and
// `successor` holds AT MOST ONE (ADR-0084). So on a fresh registry the first spec takes
// `canonical`, the second takes `successor`, and a THIRD distinct one would displace the
// second: its row and its state deleted by the shared rule (`displacedBySuccessor`, ADR-0071).
// Before this refusal `open` then built an engine for all three, and the container held a
// fold whose registry record no longer existed.
//
// A list is not a sequence of arrivals, so nothing in it is "newer" than anything else: the
// open is REFUSED, naming both specs, before any of them is deleted. The caps do not prevent it:
// the displaced record is dropped before the arriving one is created, so this suite runs under
// the browser's own caps (two generations) and reproduces it there. What keeps a tab clear of it
// is that every browser host opens with ONE spec; `openIndexer` takes several.
// ---------------------------------------------------------------------------------------------------

/** A fold that folds nothing: this suite is about which records and engines exist, never about state. */
function inertProcessor(): EventProcessor<Abi, string[]> {
	return {
		getCodeFingerprint: () => undefined,
		load: async () => undefined,
		process: async () => [],
		reset: async () => {},
		clear: async () => {},
	};
}

function specFor(marker: string): AnyGenerationSpec<Abi, string[]> {
	return {
		processorIdentity: identityOf(marker),
		createState: () => ({marker}),
		createProcessor: () => inertProcessor(),
		stateOf: () => [],
	};
}

const provider = {
	async request(args: {method: string}): Promise<unknown> {
		if (args.method === 'eth_chainId') return '0x1';
		throw new Error(`unexpected method ${args.method}`);
	},
} as never;

async function aRegistry(): Promise<{registry: GenerationRegistry; dropped: GenerationId[]}> {
	const dropped: GenerationId[] = [];
	// the browser's own caps (`BROWSER_GENERATION_CAPS`): they do not prevent the displacement
	const registry = await openMemoryGenerationRegistry(
		{maxGenerations: 2, maxStreams: 2},
		{
			dropState: async (id) => {
				dropped.push(id);
			},
		},
	);
	return {registry, dropped};
}

function openOver(registry: GenerationRegistry, markers: string[]) {
	return openIndexer<Abi, string[]>({
		registry,
		provider,
		source: SOURCE,
		config: {stream: {finality: FINALITY}},
		generations: markers.map(specFor),
	});
}

describe('an open whose specs would displace one another', () => {
	it('never leaves the container holding a fold whose registry record was displaced during the open', async () => {
		const {registry} = await aRegistry();

		const opened = await openOver(registry, ['A', 'B', 'C']).catch(() => undefined);

		const registered = await registry.list();
		for (const held of opened?.generations ?? []) {
			expect(
				registered.some((one) => one.processor === held.record.processor && one.stream === held.record.stream),
				`the container holds ${markerOf(held.record.processor)}, which the registry no longer names`,
			).toBe(true);
		}
	});

	it('is REFUSED on a fresh registry with three distinct specs, naming the two that both want `successor`', async () => {
		const {registry} = await aRegistry();

		const refusal = await openOver(registry, ['A', 'B', 'C']).catch((err: unknown) => err);

		expect(refusal).toBeInstanceOf(OpenedSpecsDisplaceOneAnotherError);
		const error = refusal as OpenedSpecsDisplaceOneAnotherError;
		expect(error.displaced.processor).toBe(identityOf('B'));
		expect(error.arriving.processor).toBe(identityOf('C'));
		expect(error.message).toContain(identityOf('B'));
		expect(error.message).toContain(identityOf('C'));
	});

	it('deletes NOTHING it registered: the displaced spec keeps its row, its slot and its state', async () => {
		const {registry, dropped} = await aRegistry();

		await openOver(registry, ['A', 'B', 'C']).catch(() => undefined);

		expect(dropped).toEqual([]);
		const slots = await registry.slots();
		expect(markerOf(slots.canonical?.processor)).toBe('A');
		expect(markerOf(slots.successor?.processor)).toBe('B');
		// the third was never registered: the refusal came before its record, as a cap's does
		expect((await registry.list()).map((record) => markerOf(record.processor)).sort()).toEqual(['A', 'B']);
	});

	it('is refused whatever ORDER the specs are listed in, since a list says nothing about which is newer', async () => {
		for (const order of [
			['A', 'C', 'B'],
			['B', 'A', 'C'],
		]) {
			const {registry, dropped} = await aRegistry();
			await expect(openOver(registry, order)).rejects.toBeInstanceOf(OpenedSpecsDisplaceOneAnotherError);
			expect(dropped).toEqual([]);
		}
	});

	it('is refused on a registry an earlier session left with a canonical and a pending successor, when two new specs arrive', async () => {
		const {registry, dropped} = await aRegistry();
		await openOver(registry, ['A', 'B']);

		await expect(openOver(registry, ['A', 'C', 'D'])).rejects.toBeInstanceOf(OpenedSpecsDisplaceOneAnotherError);
		// C replaced the PENDING successor B, as any arrival would (it was not one of this open's specs),
		// and only D's arrival over C was refused
		expect(dropped.map((id) => markerOf(id.processor))).toEqual(['B']);
		expect(markerOf((await registry.slots()).successor?.processor)).toBe('C');
	});
});

describe('what an open that displaces nothing among its own specs still does', () => {
	it('holds exactly the records the registry names, for two specs', async () => {
		const {registry} = await aRegistry();

		const indexer = await openOver(registry, ['A', 'B']);

		const held = indexer.generations.map((one) => one.record);
		const registered = await registry.list();
		expect(held.map((record) => markerOf(record.processor))).toEqual(['A', 'B']);
		for (const record of held) {
			expect(registered.some((one) => one.processor === record.processor && one.stream === record.stream)).toBe(true);
		}
	});

	it('resolves a spec named twice to ONE generation rather than refusing it', async () => {
		const {registry} = await aRegistry();

		const indexer = await openOver(registry, ['A', 'B', 'B']);

		expect(indexer.generations.map((one) => markerOf(one.record.processor))).toEqual(['A', 'B']);
	});

	it('lets a fresh spec replace a successor an EARLIER session left pending, as any arrival does', async () => {
		const {registry, dropped} = await aRegistry();
		await openOver(registry, ['A', 'B']);

		const reopened = await openOver(registry, ['A', 'C']);

		expect(dropped.map((id) => markerOf(id.processor))).toEqual(['B']);
		expect(reopened.generations.map((one) => markerOf(one.record.processor))).toEqual(['A', 'C']);
	});
});
