/**
 * THE SIGNAL, AT THE SEAM IT IS PUBLISHED FROM, OVER A REAL FOLD.
 *
 * `@etherfold/core`'s own suite asserts what a CONTAINER does with an applied
 * block: one notification per block the canonical fold applies, the generation
 * that answered, one unchanged token, nothing held per subscriber. It does that
 * against folds that report names of their own, because a container relays a set
 * it cannot compute.
 *
 * What cannot be asserted there is the half that matters most: that the ENTITY
 * NAMES a reader is told about are the ones a REAL processor's mutations
 * produced. So this drives the container/indexer publication boundary with an
 * in-process subscriber over the committed stratagems capture -- a real ABI,
 * real logs, the shipped `EntityEventProcessor` -- and compares every published
 * set against the mutations the same handlers emit block by block.
 *
 * The ABANDONED deployment's capture (42 logs, 9 event-bearing blocks; see
 * `fixtures.ts` for why `base` is not the launched game). This is a question
 * about the PUBLICATION, and the publication does not get more interesting at
 * 31,332 events -- what does is the processor, which `alpha1.test.ts` asks about
 * on every backend.
 */
import {
	openIndexer,
	openMemoryGenerationRegistry,
	generationDigestOf,
	type LastSync,
	type StateMoved,
} from '@etherfold/core';
import {
	EntityEventProcessor,
	applyEventStream,
	openForWriting,
	type EntityStateView,
} from '@etherfold/processor-entities';
import {MemoryStateStore} from '@etherfold/state-store';
import {describe, expect, it} from 'vitest';
import {BASE_ABANDONED, loadStream, stratagemsProcessor} from '../src/index.js';
import type {StratagemsABI} from '../vendor/stratagems/abi.js';

const CHAIN_ID_HEX = '0x2105'; // 8453, the chain the capture is from

/**
 * A node that answers the identity and the tip, and refuses everything else.
 *
 * Typed `as never` at the boundary, as the container's own tests do: this
 * package does not depend on `eip-1193` and has no business acquiring one to
 * hand over three canned answers.
 */
function fakeNode(tip: number) {
	return {
		async request(args: {method: string}): Promise<unknown> {
			switch (args.method) {
				case 'eth_chainId':
					return CHAIN_ID_HEX;
				case 'eth_blockNumber':
					return `0x${tip.toString(16)}`;
				case 'eth_getLogs':
					return [];
				default:
					throw new Error(`unexpected method ${args.method}`);
			}
		},
	} as never;
}

/** The same fold, driven through the container, with an in-process subscriber attached. */
async function foldThroughAContainer() {
	const fixture = loadStream(BASE_ABANDONED);
	const registry = await openMemoryGenerationRegistry({maxGenerations: 2, maxStreams: 1});
	const indexer = await openIndexer<StratagemsABI, EntityStateView>({
		registry,
		provider: fakeNode(fixture.lastSync.latestBlock),
		source: fixture.source,
		config: {stream: {finality: 12}},
		generations: [
			{
				createState: () => openForWriting(new MemoryStateStore(stratagemsProcessor.entities)),
				createProcessor: (store) => new EntityEventProcessor(store, stratagemsProcessor),
				stateOf: (processor) => (processor as EntityEventProcessor<StratagemsABI>).state,
			},
		],
	});

	const moved: StateMoved[] = [];
	const detach = indexer.onStateMoved((notification) => moved.push(notification));

	await indexer.load();
	await indexer.feed(fixture.eventStream, fixture.lastSync as LastSync<StratagemsABI>);

	return {fixture, indexer, moved, detach};
}

/**
 * What the SAME handlers touch, block by block, established independently.
 *
 * Through `applyEventStream` with a reporter of its own rather than by reading
 * the expectation out of the thing under test: the comparison is then between
 * two runs of the real processor, and a hand-written list of entity names would
 * be a statement about this fixture rather than about the fold.
 */
async function touchedPerBlock(eventStream: ReturnType<typeof loadStream>['eventStream']) {
	const store = await openForWriting(new MemoryStateStore(stratagemsProcessor.entities));
	const applied: {block: number; entities: readonly string[]}[] = [];
	await applyEventStream(store, stratagemsProcessor, eventStream, undefined, undefined, (block) => applied.push(block));
	return applied;
}

describe('a fold over the stratagems capture publishes what it just changed', () => {
	it('publishes one notification per applied block, naming the entities that block really touched', async () => {
		const {fixture, moved} = await foldThroughAContainer();
		const expected = await touchedPerBlock(fixture.eventStream);

		// one per APPLIED block, in order, naming that block
		expect(moved.map((notification) => notification.block)).toEqual(expected.map((block) => block.block));
		// and the entity NAMES are the ones the mutations carried
		expect(moved.map((notification) => notification.entities)).toEqual(expected.map((block) => block.entities));
		// which is a real set and not an empty one
		expect(moved.flatMap((notification) => notification.entities).length).toBeGreaterThan(0);
	});

	it('names only entities the mutations touched, so a declared-but-untouched one is absent', async () => {
		const {moved} = await foldThroughAContainer();
		const declared = stratagemsProcessor.entities.map((entity) => entity.name);
		const named = new Set(moved.flatMap((notification) => notification.entities));

		// every name is a declared entity: the payload is O(schema), never O(mutations)
		expect([...named].filter((name) => !declared.includes(name))).toEqual([]);
		// and the capture does not touch everything this processor declares, which is
		// what makes narrow invalidation worth anything
		expect(declared.filter((name) => !named.has(name)).length).toBeGreaterThan(0);
	});

	it('publishes an empty set for an applied block whose handlers changed nothing', async () => {
		// The capture opens with an `OwnershipTransferred` this processor has no
		// handler for: the block IS applied (it is recorded, and the cursor moves with
		// it) and it touched no entity, so it is published with nothing to invalidate
		// narrowly rather than not published at all.
		const {moved} = await foldThroughAContainer();
		const empty = moved.filter((notification) => notification.entities.length === 0);
		expect(empty.length).toBeGreaterThan(0);
		expect(moved.length).toBeGreaterThan(empty.length);
	});

	it('names the generation that answered, and carries one token across the whole fold', async () => {
		const {indexer, moved} = await foldThroughAContainer();
		const generation = generationDigestOf(indexer.canonical.record);

		expect(moved.every((notification) => notification.generation === generation)).toBe(true);
		expect(new Set(moved.map((notification) => notification.coherence)).size).toBe(1);
	});

	it('carries no rows, no mutations and no state handle: it is a SIGNAL', async () => {
		// A reader handed the delta applies it by hand, and applying a delta by hand
		// is what goes wrong at the next reorg. So the payload is four fields, and
		// what a reader does with it is re-read through the surface it already has --
		// which for an in-process caller is the container's own handle.
		const {indexer, moved} = await foldThroughAContainer();
		for (const notification of moved) {
			expect(Object.keys(notification).sort()).toEqual(['block', 'coherence', 'entities', 'generation']);
			// NAMES, not ids and not rows: a string per entity and nothing structured
			expect(notification.entities.every((entity) => typeof entity === 'string')).toBe(true);
		}

		// what a reader re-reads THROUGH is the surface it already has, untouched by
		// any of this: the container's own handle, which answers from whichever
		// generation is canonical
		expect(indexer.state).toBeDefined();
	});
});
