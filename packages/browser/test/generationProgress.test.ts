import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {EntityStateView} from '@etherfold/processor-entities';
import type {ExistingStream} from '@etherfold/core';
import {MemoryStateStore, type StateStore} from '@etherfold/state-store';
import {createIndexerState, keepStreamOnIndexedDB, type SyncingState} from '../src/index.js';
import {
	BRANCH_A_TIP,
	entityProcessorOver,
	EXPECTED_A,
	fakeChain,
	FINALITY,
	indexToTip,
	processor,
	processorVariant,
	SOURCE,
	type TestABI,
} from '../browser/workload.js';

/**
 * STORY 5: A NON-CANONICAL GENERATION REPORTS THAT IT EXISTS AND HOW FAR IT HAS
 * CAUGHT UP -- and the library stops there.
 *
 * Only the developer knows whether their reconfigure made the old answers WRONG
 * or merely INCOMPLETE, so the library reports the FACT and the DISTANCE and the
 * app decides whether to render, dim or hide. A library that picked would be
 * picking wrong half the time, so the assertion below is deliberately shaped as
 * three DIFFERENT apps reading the same reported state and reaching three
 * different, defensible conclusions from it.
 *
 * The reporting is DERIVED from the container rather than recorded in a second
 * place: every generation's cursor is already kept there (the promotion trigger
 * is a comparison between two of them), and a second copy in this hook would be
 * a second thing to keep true.
 */

let counter = 0;
const freshName = () => `progress-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** The edited fold: the same events counted by two, so a READ says which generation answered. */
const EDITED = processorVariant({version: '2.0.0', countBy: 2});

async function memoryStore(entities = processor.entities): Promise<StateStore> {
	const store = new MemoryStateStore(entities);
	await store.migrate();
	return store;
}

/**
 * A keeper that can HOLD FOLLOWERS BACK at a block.
 *
 * Being behind is not something a test can ask a follower to be: a follower
 * advances exactly as far as the stream it folds, and it re-folds the whole
 * stored stream on its first advance, so on this fixture it is level again by
 * the end of the very cycle it was created in. What it CAN be given is less
 * stream -- which is what being behind IS, from the follower's side -- so the cap
 * truncates what `fetchFrom` serves, and lifting it lets the follower catch up
 * exactly as an ordinary one does.
 *
 * The writer is unaffected: it reads the keeper on its LOAD and never again, and
 * the cap goes on after it has loaded.
 */
function cappedKeeper(name: string) {
	const real = keepStreamOnIndexedDB<TestABI>(name);
	let cap: number | undefined;
	const keeper = {
		...real,
		async fetchFrom(source: never, fromBlock: never) {
			const read = await real.fetchFrom(source, fromBlock);
			// every non-`stream` verdict passes through untouched: there is nothing to cap
			if (read.status !== 'stream' || cap === undefined) {
				return read;
			}
			const capped = cap;
			return {
				status: 'stream' as const,
				eventStream: read.eventStream.filter((event) => event.blockNumber <= capped),
				lastSync: {...read.lastSync, lastToBlock: Math.min(read.lastSync.lastToBlock, capped)},
			};
		},
	};
	return {
		keeper: keeper as unknown as ExistingStream<TestABI>,
		holdFollowersAt(block: number) {
			cap = block;
		},
		release() {
			cap = undefined;
		},
	};
}

/** An app at the tip, with a keeper under it, and a reconfigure it can ask for. */
async function anAppAtTheTip(promotion?: {policy?: 'on-catch-up' | 'immediate' | 'manual'}) {
	const chain = fakeChain();
	const stream = cappedKeeper(freshName());
	const indexer = createIndexerState<TestABI, EntityStateView>(
		{
			createState: () => memoryStore(),
			createProcessor: (state) => entityProcessorOver(state, processor),
		},
		{keepStream: stream.keeper, ...(promotion ? {promotion} : {})},
	);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexToTip(indexer);

	return {
		chain,
		indexer,
		stream,
		reported: () => indexer.syncing.$state.nonCanonicalGenerations,
		async reconfigure() {
			const next = await memoryStore(EDITED.entities);
			return indexer.addGeneration({
				createState: () => next,
				createProcessor: (state) => entityProcessorOver(state, EDITED),
			});
		},
		async drive(rounds = 4) {
			for (let round = 0; round < rounds; round++) {
				await indexer.indexMore();
			}
		},
	};
}

describe('a non-canonical generation is REPORTED, with the distance', () => {
	it('reports nothing while there is only one generation', async () => {
		const app = await anAppAtTheTip();
		expect(app.reported()).toEqual([]);
		app.indexer.dispose();
	});

	it('reports it the moment it is created, before it has folded anything', async () => {
		const app = await anAppAtTheTip({policy: 'manual'});
		const successor = await app.reconfigure();

		expect(app.reported()).toHaveLength(1);
		expect(app.reported()[0].record).toEqual(successor.record);
		// a processor change: the same stream, so it fetches nothing at all
		expect(app.reported()[0].follows).toBe(true);
		// it EXISTS and it has folded nothing, which is not the same claim as being
		// level at block 0 -- so the two numbers are absent rather than zero
		expect(app.reported()[0].lastToBlock).toBeUndefined();
		expect(app.reported()[0].blocksBehind).toBeUndefined();
		app.indexer.dispose();
	});

	it('reports HOW FAR it has caught up, in blocks', async () => {
		const app = await anAppAtTheTip({policy: 'manual'});
		app.stream.holdFollowersAt(102);
		await app.reconfigure();
		await app.drive(2);

		expect(app.indexer.syncing.$state.lastSync?.lastToBlock).toBe(BRANCH_A_TIP);
		expect(app.reported()[0].lastToBlock).toBe(102);
		expect(app.reported()[0].blocksBehind).toBe(BRANCH_A_TIP - 102);

		// and the distance CLOSES as it advances, which is what a progress bar reads
		app.stream.release();
		await app.drive(2);
		expect(app.reported()[0].lastToBlock).toBe(BRANCH_A_TIP);
		expect(app.reported()[0].blocksBehind).toBe(0);
		app.indexer.dispose();
	});
});

describe('reporting STOPS at the promotion', () => {
	it('drops the successor from the report once the pointer names it', async () => {
		const app = await anAppAtTheTip();
		const successor = await app.reconfigure();
		expect(app.reported().map((generation) => generation.record.processor)).toEqual([successor.record.processor]);

		await app.drive();

		// it is canonical now, so it is not a non-canonical generation and is not
		// reported as one: an app told otherwise would dim the answers it is showing
		expect(app.indexer.canonical?.record.processor).toBe(successor.record.processor);
		expect(app.reported().map((generation) => generation.record.processor)).not.toContain(successor.record.processor);
		app.indexer.dispose();
	});

	it('reports the generation the pointer moved OFF, which is retained and revertible', async () => {
		const app = await anAppAtTheTip({policy: 'manual'});
		const previous = app.indexer.generations[0];
		const successor = await app.reconfigure();
		await app.drive();
		await app.indexer.promote(successor.record);

		// the predecessor is kept (that is what makes moving the pointer BACK a revert
		// rather than a re-index), so it is a non-canonical generation and says so --
		// level, at distance 0, which is how an app tells it apart from one building
		expect(app.reported().map((generation) => generation.record.processor)).toEqual([previous.record.processor]);
		expect(app.reported()[0].blocksBehind).toBe(0);
		app.indexer.dispose();
	});

	it('reports nothing again after a dispose', async () => {
		const app = await anAppAtTheTip({policy: 'manual'});
		await app.reconfigure();
		app.indexer.dispose();
		expect(app.reported()).toEqual([]);
	});
});

describe('the library reports; the APP decides to render, dim or hide', () => {
	/** An app whose reconfigure made the old answers merely INCOMPLETE: keep rendering. */
	const rendersAnyway = (_syncing: SyncingState<TestABI>) => 'render';

	/** An app that wants the user to know a rebuild is under way: dim while one is behind. */
	const dimsWhileBehind = (syncing: SyncingState<TestABI>) =>
		syncing.nonCanonicalGenerations.some((generation) => generation.blocksBehind !== 0) ? 'dim' : 'render';

	/** An app whose reconfigure made the old answers WRONG: hide until the new fold answers. */
	const hidesUntilReady = (syncing: SyncingState<TestABI>) =>
		syncing.nonCanonicalGenerations.length > 0 ? 'hide' : 'render';

	it('carries enough for all three, and picks none of them', async () => {
		const app = await anAppAtTheTip({policy: 'manual'});
		app.stream.holdFollowersAt(102);
		await app.reconfigure();
		await app.drive(2);

		const building = app.indexer.syncing.$state;
		expect([rendersAnyway(building), dimsWhileBehind(building), hidesUntilReady(building)]).toEqual([
			'render',
			'dim',
			'hide',
		]);
		// none of those is a decision this library took: what it reported is a fact
		// (a generation exists) and a distance (how far behind it is)
		expect(Object.keys(building.nonCanonicalGenerations[0]).sort()).toEqual([
			'blocksBehind',
			'follows',
			'lastToBlock',
			'record',
		]);

		// and the canonical generation is answering completely throughout, which is the
		// premise all three apps are deciding ON
		const view = app.indexer.state.$state;
		expect((await view.getCurrent<{value: number}>('counter', {name: 'transfers'}))?.value).toBe(EXPECTED_A.transfers);
		app.indexer.dispose();
	});
});
