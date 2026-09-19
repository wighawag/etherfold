import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import type {EntityProcessor, EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {build} from 'esbuild';
import {createIndexerState, keepStreamOnIndexedDB, reconfigureFromHotUpdate} from '../src/index.js';
import {
	editedProcessorVariant,
	entityProcessorOver,
	EXPECTED_A,
	fakeChain,
	FINALITY,
	indexToTip,
	processorVariant,
	readState,
	SOURCE,
	type TestABI,
} from '../browser/workload.js';

/**
 * THE THIRD ARRIVAL, DRIVEN: a processor handed over by the tab's own dev
 * server, with no page reload and no warm fold thrown away (ADR-0085).
 *
 * The claim worth asserting is one sentence: *this running indexer held a warm
 * fold, took a new processor, and answered throughout*. So these drive the
 * handover DIRECTLY rather than simulating a bundler -- there is nothing of a
 * bundler in this package to simulate, which is itself one of the assertions
 * below -- over a real entity processor, a real store and a real captured
 * stream.
 *
 * ## WHAT IS PINNED ELSEWHERE, so that these stay about the arrival
 *
 * - that a module is NAMED by its handler sources is
 *   `aModuleIsIdentifiedByItsHandlerSources.test.ts`, at the container;
 * - that the `successor` slot holds AT MOST ONE is
 *   `aTabHoldsItsGenerationsInSlots.test.ts`, over a durable registry;
 * - when the pointer MOVES is `promotion.test.ts`.
 *
 * What is only observable HERE is the OUTCOME an application is handed -- the
 * same three the admin re-read route answers, because the arrivals are thin
 * adapters in front of one call -- and that a broken save costs a developer
 * nothing at all.
 *
 * ## THE FOLD IS WARM, WHICH IS THE WHOLE POINT
 *
 * A processor change is a new generation over the SAME stream, so the successor
 * is a FOLLOWER: it fetches not one log and re-folds the stream already on disk
 * (ADR-0044). That is why these hand the hook a real stream keeper -- without a
 * stream to fold, a generation sharing one cannot advance at all -- and why the
 * chain's fetched RANGES are asserted not to grow.
 */

let counter = 0;
const freshName = () => `hot-update-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

async function memoryStore(definition: EntityProcessor<TestABI>): Promise<WritableStateStore> {
	return openForWriting(new MemoryStateStore(definition.entities));
}

/**
 * WHAT A HOT UPDATE HANDS OVER: the two factories, and NOTHING else.
 *
 * No `processorIdentity`, which is the arrival's whole character: a module has no
 * bytes to hash, so it is named by a derivation over its handler sources and an
 * app that could state one would be back on the author-declared identity ADR-0086
 * deletes.
 *
 * `createState` builds the successor its OWN store, because that is what a
 * generation beside the live one needs: the incumbent goes on writing its own
 * rows throughout, and two generations sharing one store are one store.
 */
function handingOver(definition: EntityProcessor<TestABI>) {
	return {
		createState: () => memoryStore(definition),
		createProcessor: (state: WritableStateStore) => entityProcessorOver(state, definition),
	};
}

type TransferHandler = NonNullable<EntityProcessor<TestABI>['onTransfer']>;

/** Fold one transfer, counting by whatever the calling handler's own TEXT says. */
async function countTransfer(
	state: Parameters<TransferHandler>[0],
	event: Parameters<TransferHandler>[1],
	countBy: number,
): Promise<void> {
	state.set('token', {id: event.args.id.toString()}, {owner: event.args.to});
	const counter = await state.get<{value: number}>('counter', {name: 'transfers'});
	state.set('counter', {name: 'transfers'}, {value: (counter?.value ?? 0) + countBy});
}

/**
 * FIVE SAVES, each a different handler SOURCE, because that is what a burst of
 * real edits is.
 *
 * They differ in TEXT rather than in a captured value, deliberately.
 * `editedProcessorVariant({countBy})` closes over its argument and the derivation
 * is over the handler's source, which does not carry it -- so five of those are
 * ONE fold, five times, and the burst this asserts would never happen. That limit
 * is documented rather than a gap (`src/moduleIdentity.ts`), and writing the
 * burst as five edits is what keeps this test about the SLOT.
 */
const SAVED_EDITS: readonly TransferHandler[] = [
	(state, event) => countTransfer(state, event, 2),
	(state, event) => countTransfer(state, event, 3),
	(state, event) => countTransfer(state, event, 4),
	(state, event) => countTransfer(state, event, 5),
	(state, event) => countTransfer(state, event, 6),
];

/** The module one of those saves hands over: a NEW object, over the edited handler. */
function savedModule(onTransfer: TransferHandler): EntityProcessor<TestABI> {
	return {entities: processorVariant().entities, onTransfer};
}

/** A tab that has indexed to the tip and has a UI reading it, with a keeper under it. */
async function aTabAtTheTip() {
	const chain = fakeChain();
	const running = processorVariant();
	const store = await memoryStore(running);
	const indexer = createIndexerState<TestABI, EntityStateView>(
		{
			createState: () => store,
			createProcessor: (state) => entityProcessorOver(state, running),
		},
		{keepStream: keepStreamOnIndexedDB<TestABI>(freshName())},
	);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexToTip(indexer);

	return {
		chain,
		indexer,
		/** What the app on screen reads, through the handle it was given at `init`. */
		read: () => readState(indexer.state.$state),
		/** Advance every generation, so a successor can catch up and the policy can fire. */
		async drive(rounds = 4) {
			for (let round = 0; round < rounds; round++) {
				await indexer.indexMore();
			}
		},
	};
}

describe('a save updates the running tab', () => {
	/**
	 * THE DELIVERABLE: an edited handler registers a SUCCESSOR, the page is not
	 * reloaded, and the generation on screen answers every read throughout.
	 *
	 * The warm fold is visible twice over: the successor FOLLOWS the stream that is
	 * already there, so not one further range is asked of the chain, and the app's
	 * reads are complete at every step rather than blank while the new fold catches
	 * up.
	 */
	it('registers a successor for an edited handler, with the incumbent answering throughout', async () => {
		const app = await aTabAtTheTip();
		expect(await app.read()).toEqual(EXPECTED_A);
		const incumbent = app.indexer.canonical?.record.processor;
		const rangesBefore = app.chain.ranges.length;

		// the developer edited a handler and their bundler handed this tab the module
		const report = await reconfigureFromHotUpdate(app.indexer, handingOver(editedProcessorVariant({countBy: 10})));

		expect(report.outcome).toBe('registered');
		if (report.outcome !== 'registered') throw new Error('unreachable');
		expect(report.generation.processor).not.toBe(incumbent);
		expect(app.indexer.generations.length).toBe(2);

		// NOT A RELOAD AND NOT AN OUTAGE: the generation the UI reads is the one it was
		// reading, and it is still complete
		expect(app.indexer.canonical?.record.processor).toBe(incumbent);
		expect(await app.read()).toEqual(EXPECTED_A);
		// ...and the new fold re-folds the stream that is already there: a processor
		// change moves no fetch filter, so nothing is asked of the chain
		const successor = app.indexer.generations.find((held) => held.record.processor === report.generation.processor);
		expect(successor?.follows).toBe(true);
		expect(app.chain.ranges.length).toBe(rangesBefore);

		// and then the edit is what answers, in one step, once it has caught up
		await app.drive();
		expect(app.indexer.canonical?.record.processor).toBe(report.generation.processor);
		expect(await app.read()).toEqual({...EXPECTED_A, transfers: 50});

		app.indexer.dispose();
	});

	/**
	 * A BURST STAYS BOUNDED: five saves leave the incumbent plus ONE successor.
	 *
	 * This is the property the `successor` slot provides and the one an editing loop
	 * lives or dies on -- before it, every save registered a generation beside the
	 * live one and the SECOND save met a cap of two, so a developer iterating had to
	 * delete a generation by hand. Asserted end to end here rather than at the
	 * registry: what the application sees is five `registered` reports and a tab
	 * that never refuses one.
	 */
	it('leaves the incumbent plus ONE successor after a burst of saves', async () => {
		const app = await aTabAtTheTip();
		const incumbent = app.indexer.canonical?.record.processor;

		for (const edit of SAVED_EDITS) {
			// a hot update hands over a NEW module object every time, so the definition is
			// rebuilt rather than reused: what must differ is the SOURCE, not the object
			const report = await reconfigureFromHotUpdate(app.indexer, handingOver(savedModule(edit)));

			expect(report.outcome).toBe('registered');
			// the incumbent, plus one: the newer save REPLACED the pending successor
			expect(app.indexer.generations.length).toBe(2);
			// ...and there is a UI attached, so the generation that is not being churned
			// goes on answering complete reads
			expect(app.indexer.canonical?.record.processor).toBe(incumbent);
			expect(await app.read()).toEqual(EXPECTED_A);
		}

		app.indexer.dispose();
	});
});

describe('a broken save changes nothing and says so', () => {
	/**
	 * THE NORMAL CASE IN A DEV LOOP, because a developer saves mid-edit.
	 *
	 * A processor that throws on evaluation must leave the running indexer EXACTLY
	 * as it was -- same generations, same pointer, still folding and still answering
	 * -- and nothing partial may be registered. That is a property of the ORDER
	 * rather than of a rollback: the state, the processor and its identity are all
	 * built before a registry record is written or anything is displaced, exactly as
	 * the server arrival fails before registering rather than unwinding afterwards.
	 */
	it('reports the failure and leaves the generations, the pointer and the fold untouched', async () => {
		const app = await aTabAtTheTip();
		const before = app.indexer.generations.map((held) => held.record);
		const canonicalBefore = app.indexer.canonical?.record;
		const cursorBefore = app.indexer.syncing.$state.lastSync?.lastToBlock;

		const report = await reconfigureFromHotUpdate(app.indexer, {
			createState: () => memoryStore(processorVariant()),
			createProcessor: () => {
				throw new Error(`countBy is not defined`);
			},
		});

		expect(report.outcome).toBe('failed');
		if (report.outcome !== 'failed') throw new Error('unreachable');
		// the reason reaches the developer rather than being swallowed into a boolean
		expect(report.message).toContain('countBy is not defined');

		// NOTHING PARTIAL: the same generations, the same pointer
		expect(app.indexer.generations.map((held) => held.record)).toEqual(before);
		expect(app.indexer.canonical?.record).toEqual(canonicalBefore);
		// ...and still folding and still answering, which a count of records cannot say
		expect(await app.read()).toEqual(EXPECTED_A);
		expect(app.indexer.syncing.$state.lastSync?.lastToBlock).toBe(cursorBefore);
		await app.drive(1);
		expect(await app.read()).toEqual(EXPECTED_A);

		// and the next save -- the one that repairs the half-typed handler -- lands, so
		// a failure is a moment in the loop rather than a state to get out of
		const repaired = await reconfigureFromHotUpdate(app.indexer, handingOver(editedProcessorVariant({countBy: 10})));
		expect(repaired.outcome).toBe('registered');

		app.indexer.dispose();
	});
});

describe('a save that changed nothing says so, legibly', () => {
	/**
	 * RARE AND TRUE, which is what an identity derived from the code buys.
	 *
	 * Under an author-declared `version` this was the COMMON answer and it was
	 * misleading: an edited handler named the generation the tab already held, so
	 * `unchanged` read two ways and needed a drift report to say which (ADR-0086
	 * deleted both). Here it means exactly one thing -- the handler sources are the
	 * ones already running -- and it is a SUCCESS, which the report has to make
	 * plain rather than leaving a developer to wonder whether their save failed.
	 */
	it('answers unchanged, names the generation it landed on, and keeps the warm fold', async () => {
		const app = await aTabAtTheTip();
		const incumbent = app.indexer.canonical?.record.processor;
		const rangesBefore = app.chain.ranges.length;

		// a hot update whose module is a new object over the SAME handler sources
		const report = await reconfigureFromHotUpdate(app.indexer, handingOver(processorVariant()));

		expect(report.outcome).toBe('unchanged');
		if (report.outcome !== 'unchanged') throw new Error('unreachable');
		// it names WHICH generation it landed on, which is what makes it actionable
		expect(report.generation.processor).toBe(incumbent);
		// ...and says so in words a developer can act on, including the one case that
		// can surprise them: a change the handler TEXT does not carry
		expect(report.message).toContain('nothing was registered');
		expect(report.message).toContain('force: true');

		// nothing was registered, nothing was discarded, nothing was fetched
		expect(app.indexer.generations.length).toBe(1);
		expect(app.indexer.canonical?.record.processor).toBe(incumbent);
		expect(await app.read()).toEqual(EXPECTED_A);
		expect(app.chain.ranges.length).toBe(rangesBefore);

		app.indexer.dispose();
	});

	/**
	 * The three outcomes are DISTINGUISHABLE, which is the whole reason there are
	 * three: "I saved and nothing happened" otherwise has three indistinguishable
	 * causes, and a developer cannot tell a no-op from a broken build.
	 */
	it('tells a registration, a no-op and a failure apart on one field', async () => {
		const app = await aTabAtTheTip();

		const unchanged = await reconfigureFromHotUpdate(app.indexer, handingOver(processorVariant()));
		const failed = await reconfigureFromHotUpdate(app.indexer, {
			createState: () => memoryStore(processorVariant()),
			createProcessor: () => {
				throw new Error(`half-typed`);
			},
		});
		const registered = await reconfigureFromHotUpdate(app.indexer, handingOver(editedProcessorVariant()));

		expect([unchanged.outcome, failed.outcome, registered.outcome]).toEqual(['unchanged', 'failed', 'registered']);
		app.indexer.dispose();
	});
});

describe('a production build carries no dev-only machinery', () => {
	/**
	 * NOTHING HERE SUBSCRIBES, and this is where that is checked rather than
	 * promised.
	 *
	 * Noticing a change is the APPLICATION's job -- the same rule the server side
	 * follows, where whatever watches a file stays outside the process -- so this
	 * package exposes a function an app calls from its own `import.meta.hot.accept`
	 * handler and contains no bundler HMR global of its own. A deployment built
	 * without an HMR-capable bundler is therefore unaffected BY CONSTRUCTION rather
	 * than by a guard.
	 *
	 * Asserted over the BUILT bundle rather than over the source text, deliberately:
	 * the source says `import.meta.hot` in a doc comment, because the call site is
	 * the thing worth showing, and what matters is that no such reference survives
	 * into what an application ships. Minifying is what strips the comments.
	 */
	it('bundles with no reference to a bundler HMR global', async () => {
		const result = await build({
			entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
			bundle: true,
			platform: 'browser',
			format: 'esm',
			// strips the comments, which is the point: what is left is CODE
			minify: true,
			// not written anywhere: the question is what the bytes SAY
			write: false,
			logLevel: 'silent',
		});

		expect(result.errors).toEqual([]);
		const bundled = result.outputFiles!.map((file) => file.text).join('\n');
		// the assertion is not vacuous: this bundle really does carry the arrival
		expect(bundled).toContain('hot update: registered');
		for (const global of ['import.meta.hot', 'import.meta.webpackHot', 'module.hot', '__vite__']) {
			expect(bundled).not.toContain(global);
		}
	});

	/**
	 * ...AND AN APP THAT DOES NOT CALL IT DOES NOT SHIP IT, which is why the arrival
	 * is a FREE FUNCTION rather than a method on the hook.
	 *
	 * A production build eliminates the app's own `if (import.meta.hot)` block, and a
	 * free function goes with it. A method would be reachable from the indexer object
	 * an app certainly does hold, so every bundle would retain it -- which is the
	 * difference between "unaffected by construction" and "unaffected because we
	 * remembered to guard".
	 */
	it('is tree-shaken out of an application that never calls it', async () => {
		const result = await build({
			stdin: {
				// an ordinary production app: it builds an indexer and nothing else
				contents: `import {createIndexerState} from './src/index.js';\nglobalThis.app = createIndexerState;`,
				resolveDir: new URL('..', import.meta.url).pathname,
				loader: 'ts',
			},
			bundle: true,
			platform: 'browser',
			format: 'esm',
			minify: true,
			write: false,
			logLevel: 'silent',
		});

		expect(result.errors).toEqual([]);
		const bundled = result.outputFiles!.map((file) => file.text).join('\n');
		expect(bundled).not.toContain('hot update: registered');
	});
});
