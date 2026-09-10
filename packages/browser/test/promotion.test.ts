import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {createIndexerState, keepStreamOnIndexedDB} from '../src/index.js';
import {
	BRANCH_A_TIP,
	entityProcessorOver,
	EXPECTED_A,
	fakeChain,
	FINALITY,
	indexToTip,
	processor,
	processorVariant,
	readState,
	SOURCE,
	type TestABI,
} from '../browser/workload.js';

/**
 * THE PROMOTION POLICY, from the runtime this spec is FOR.
 *
 * The policy itself, its trigger and drop-on-promotion are pinned in
 * `@etherfold/core`'s `promotion.test.ts`, over a container with no browser in
 * sight. What is only observable HERE is the runtime's own half of the claim:
 *
 * - **the default is `on-catch-up` in this runtime too**, because this hook
 *   deliberately selects nothing. There is no per-runtime default anywhere,
 *   since the axis that would justify one (development versus production) is not
 *   detectable from inside a browser build;
 * - a RECONFIGURE is not an outage: the app goes on reading complete answers
 *   from the canonical generation while the new one folds beside it, and the
 *   answers switch when it is ready (stories 1, 3 and 14);
 * - `immediate` is the opt-in a developer iterating on a fold asks for (story
 *   13), and what it DEGRADES -- `checkTxInclusion` -- degrades honestly.
 *
 * The successor here is the ordinary reconfigure: a processor change, on the
 * stream that is already there. So it is a FOLLOWER and fetches nothing, which
 * is why these tests hand the hook a real stream keeper -- without a stream to
 * fold, a generation sharing one has no way to advance at all.
 */

let counter = 0;
const freshName = () => `promotion-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** The edited fold: the same events, counted by two, so a READ says which generation answered. */
const EDITED = processorVariant({version: '2.0.0', countBy: 2});

async function memoryStore(entities = processor.entities): Promise<WritableStateStore> {
	const store = await openForWriting(new MemoryStateStore(entities));
	return store;
}

/**
 * An app that has indexed to the tip, with a keeper under it.
 *
 * `promotion` is passed through exactly as an application would pass it: NOT AT
 * ALL for the default, which is the point of the first test below.
 */
async function anAppAtTheTip(promotion?: {policy?: 'on-catch-up' | 'immediate' | 'manual'; dropOnPromotion?: boolean}) {
	const chain = fakeChain();
	const store = await memoryStore();
	const indexer = createIndexerState<TestABI, EntityStateView>(
		{
			createState: () => store,
			createProcessor: (state) => entityProcessorOver(state, processor),
		},
		{keepStream: keepStreamOnIndexedDB<TestABI>(freshName()), ...(promotion ? {promotion} : {})},
	);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexToTip(indexer);

	return {
		chain,
		indexer,
		/** What the APP reads, through the handle it was given at `init`. */
		read: () => readState(indexer.state.$state),
		/** Build the edited fold beside the live one: what a reconfigure does. */
		async reconfigure() {
			const next = await memoryStore(EDITED.entities);
			return indexer.addGeneration({
				createState: () => next,
				createProcessor: (state) => entityProcessorOver(state, EDITED),
			});
		},
		/** Advance every generation, so a successor can catch up. */
		async drive(rounds = 4) {
			for (let round = 0; round < rounds; round++) {
				await indexer.indexMore();
			}
		},
	};
}

describe('the default is `on-catch-up` in the browser too, because nothing here selects one', () => {
	it('keeps answering from the canonical generation until the successor is ready', async () => {
		const app = await anAppAtTheTip();
		expect(await app.read()).toEqual(EXPECTED_A);

		const successor = await app.reconfigure();
		// a processor change: the same stream, so it fetches nothing at all
		expect(successor.follows).toBe(true);
		// story 14: the user did not ask for this reconfigure and must not see the
		// state go backwards, so the complete old answers stay on screen
		expect(app.indexer.canonical?.record.processor).toBe(app.indexer.generations[0].record.processor);
		expect(app.indexer.canonical?.record.processor).not.toBe(successor.record.processor);
		expect(await app.read()).toEqual(EXPECTED_A);

		await app.drive();

		// ...and the answers switch, in one step, once the new fold has reached the
		// cursor the canonical generation had
		expect(app.indexer.canonical?.record.processor).toBe(successor.record.processor);
		expect(await app.read()).toEqual({...EXPECTED_A, transfers: EXPECTED_A.transfers * 2});
		app.indexer.dispose();
	});

	it('reports the same policy the core resolves, rather than a browser one', async () => {
		const app = await anAppAtTheTip();
		// the assertion is that this runtime adds NO default of its own: an
		// `import.meta.env.DEV` sniff here would be a guess with `immediate`'s
		// consequences, and there is nothing in a browser build to sniff
		expect(app.indexer.promotion).toEqual({policy: 'on-catch-up', dropOnPromotion: false});
		app.indexer.dispose();
	});
});

describe('`immediate` is the opt-in, and it degrades HONESTLY', () => {
	it('makes the new generation canonical from creation, before it has caught up', async () => {
		const app = await anAppAtTheTip({policy: 'immediate'});
		expect(await app.read()).toEqual(EXPECTED_A);

		await app.reconfigure();

		// story 13: the developer is looking for what their edit does, and an
		// incomplete answer from the new fold beats a complete one from the fold
		// they just replaced
		expect(await app.read()).toEqual({
			owners: {'1': undefined, '2': undefined, '3': undefined, '4': undefined},
			transfers: 0,
		});

		await app.drive();
		expect(await app.read()).toEqual({...EXPECTED_A, transfers: EXPECTED_A.transfers * 2});
		app.indexer.dispose();
	});

	/**
	 * `checkTxInclusion` answers from the CURSOR this hook holds, and after an
	 * `immediate` promotion that cursor belonged to the generation that no longer
	 * answers. Left in place it would report a transaction as INCLUDED that the
	 * generation now answering has not reached -- the double-counted optimistic
	 * update the verdict exists to prevent. So it is dropped at the move, and what
	 * comes back is `unknown` / `not-synced`: the honest answer for a fold that has
	 * processed nothing, rather than a confident wrong one.
	 */
	it('stops answering `checkTxInclusion` from the retired generation', async () => {
		const app = await anAppAtTheTip({policy: 'immediate'});
		const indexed = app.indexer.syncing.$state.lastSync;
		const included = indexed?.unconfirmedBlocks.flatMap((block) => block.events)[0]?.transactionHash as string;
		expect(included).toBeTruthy();
		expect(app.indexer.checkTxInclusion([{txHash: included}])[included]).toEqual({
			status: 'included',
			basis: 'window-hit',
			blockNumber: expect.any(Number),
			blockHash: expect.any(String),
		});

		await app.reconfigure();

		// the same transaction, now asked of a generation that has folded nothing
		expect(app.indexer.checkTxInclusion([{txHash: included}])[included]).toEqual({
			status: 'unknown',
			basis: 'not-synced',
		});
		app.indexer.dispose();
	});
});

describe('`manual` waits to be asked, and the explicit verb is never gated', () => {
	it('promotes only when told, and moves BACK the same way', async () => {
		const app = await anAppAtTheTip({policy: 'manual'});
		const successor = await app.reconfigure();
		await app.drive();

		// caught up and still not canonical: an operator inspects first
		expect(await app.read()).toEqual(EXPECTED_A);

		await app.indexer.promote(successor.record);
		expect(await app.read()).toEqual({...EXPECTED_A, transfers: EXPECTED_A.transfers * 2});

		// story 4: the new fold is worse, and the way back is one small write
		await app.indexer.promote(app.indexer.generations[0].record);
		expect(await app.read()).toEqual(EXPECTED_A);
		expect(app.indexer.syncing.$state.lastSync?.lastToBlock).toBe(BRANCH_A_TIP);
		app.indexer.dispose();
	});
});
