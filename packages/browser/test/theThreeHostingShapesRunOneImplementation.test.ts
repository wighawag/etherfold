import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {openForReading, openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createIndexerState,
	createPortReadSurface,
	type IndexerPort,
} from '../src/index.js';
import {hostingShapeCases, openOnTheMainThread, runHostingShapeCases, untilAtTip} from '../browser/hostingShapes.js';
import {
	BRANCH_A_TIP,
	EXPECTED_A,
	FINALITY,
	fakeChain,
	processor,
	readState,
	SOURCE,
	SOURCE_FROM_LATER_BLOCK,
	EXPECTED_A_FROM_LATER_BLOCK,
	type TestABI,
} from '../browser/workload.js';

/**
 * THE MAIN THREAD IS A HOSTING SHAPE, AND `createIndexerState` IS IT (ADR-0082).
 *
 * `browser/hostingShapes.ts` holds ONE behaviour suite and
 * `browser/threeHostingShapes.spec.ts` runs it against all three shapes in a real
 * browser, which is the only place a `Worker` and a `SharedWorker` exist. This
 * file runs the SAME list against the third shape under `fake-indexeddb`, on
 * every commit -- so the list is exercised by the acceptance gate, which has no
 * browser binaries, and a behaviour that stops holding here is a named failure
 * rather than a browser run nobody made.
 *
 * What is asserted HERE and nowhere else is the property that makes the shape
 * worth having at all: the host answering the port is the SAME OBJECT the app
 * drives with `init`, `indexMore` and the reactive triple -- not a second indexer
 * opened beside it over the same store, which is what a parallel main-thread
 * constructor would have been (and what the writer guard would have refused,
 * three layers from the line that caused it).
 */

let counter = 0;
const freshName = () => `main-thread-host-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** The hook, wired as an app wires it, over a database of its own. */
function hookOver(databaseName: string, chain = fakeChain()) {
	return {
		chain,
		indexer: createIndexerState<TestABI, EntityStateView>({
			createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
		}),
	};
}

describe('the three hosting shapes run one implementation', () => {
	it('passes the whole shared behaviour suite on the MAIN-THREAD shape', async () => {
		const shape = await openOnTheMainThread(freshName());
		try {
			const run = await runHostingShapeCases(shape.port);
			// Reported as the behaviours that broke rather than as one opaque red suite,
			// which is the whole reason the cases are data.
			expect(run.failures).toEqual([]);
			expect(run.passed).toBe(hostingShapeCases.length);
		} finally {
			shape.close();
		}
	});

	it('is served by the SAME indexer the app drives, not a second one beside it', async () => {
		const databaseName = freshName();
		const {chain, indexer} = hookOver(databaseName);
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
		try {
			// The APP advances the fold, with the hook's own verb and no port call at all.
			await indexer.indexMore();
			await indexer.indexToLatest();

			// ...and the PORT reports that fold: one container, one store, one cursor. A
			// second main-thread constructor would have opened a second container over the
			// same database, and the first thing anybody would have seen is a writer being
			// refused.
			const progress = await port.progress();
			expect(progress.host).toBe('main-thread');
			expect(progress.lastToBlock).toBe(indexer.syncing.$state.lastSync?.lastToBlock);
			expect(progress.lastToBlock).toBe(BRANCH_A_TIP);
			expect((await port.generations()).length).toBe(indexer.generations.length);

			// The rows the port answers with are the rows the hook's own state handle
			// answers with, because they are the same store.
			const throughThePort = await port.reads.getCurrent('counter', {name: 'transfers'});
			expect(throughThePort).toEqual({name: 'transfers', value: EXPECTED_A.transfers});
			expect(await readState(indexer.state.$state)).toEqual(EXPECTED_A);
		} finally {
			port.close();
			indexer.dispose();
		}
	});

	it('reports the driver the APP is running, and stops it when the tab asks', async () => {
		const databaseName = freshName();
		const {chain, indexer} = hookOver(databaseName);
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
		try {
			expect((await port.progress()).indexing).toBe(false);
			await indexer.startAutoIndexing(0.05);
			expect((await port.progress()).indexing).toBe(true);

			await untilAtTip(port);
			const fetchesAtTheStop = chain.ranges.length;
			const stopped = await port.stopIndexing();

			// The promise a stop makes: when it ANSWERS, no chain request is in flight and
			// none will be made. The hook's own flag agrees, because there is one loop.
			expect(stopped.indexing).toBe(false);
			expect(indexer.syncing.$state.autoIndexing).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(chain.ranges.length).toBe(fetchesAtTheStop);
		} finally {
			port.close();
			indexer.dispose();
		}
	});

	it('waits for the store rather than refusing a read issued before `init`', async () => {
		const databaseName = freshName();
		const {chain, indexer} = hookOver(databaseName);
		const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
		try {
			// Issued while there is no container at all: "read me the rows" has no honest
			// answer yet, so it WAITS -- the same rule the worker hosts follow, and the
			// reason it must never wait for ever is below.
			const waiting = port.reads.getCurrent('counter', {name: 'transfers'});
			expect((await port.progress()).phase).toBe('waiting');

			await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
			// It ANSWERED, which is the claim: not refused, and not left hanging. WHAT it
			// answered with is whatever the fold had written by the moment the store first
			// existed -- `undefined` included, since an absent row is an ordinary answer and
			// the container opens before it folds anything.
			await waiting;

			await indexer.indexToLatest();
			expect(await port.reads.getCurrent('counter', {name: 'transfers'})).toEqual({
				name: 'transfers',
				value: EXPECTED_A.transfers,
			});
		} finally {
			port.close();
			indexer.dispose();
		}
	});

	it('REFUSES a waiting read when the indexer is disposed before it ever built a store', async () => {
		const {indexer} = hookOver(freshName());
		const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
		try {
			const waiting = port.reads.getCurrent('counter', {name: 'transfers'});
			// A round trip AFTER it, so the read is known to have reached the host and to be
			// waiting there: messages on one wire arrive in order, so an answer to the second
			// question is proof the first was received.
			await port.progress();

			indexer.dispose();
			// A hung promise is the worst available outcome (ADR-0082).
			await expect(waiting).rejects.toThrow(/disposed/);
			expect((await port.progress()).phase).toBe('waiting');
		} finally {
			port.close();
		}
	});

	it('answers reads from the generation the pointer moved to, through the port', async () => {
		const databaseName = freshName();
		const chain = fakeChain();
		// Each generation folds into a store of its own, which is the rule the container
		// states for `createState` and which a reconfigure is what makes load-bearing.
		const indexer = createIndexerState<TestABI, EntityStateView>({
			createState: async (context) =>
				openForWriting(
					await createBrowserStateStore(processor.entities, {databaseName: `${databaseName}-${context.stream}`}),
				),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
		});
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		await indexer.startAutoIndexing(0.05);
		const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
		try {
			await untilAtTip(port);
			expect(await transfers(port)).toBe(EXPECTED_A.transfers);

			// A RECONFIGURE across the port, on this shape: a generation BESIDE the live
			// one, which goes on answering every read until the policy moves the pointer.
			const reconfigured = await port.reconfigure({source: SOURCE_FROM_LATER_BLOCK});
			expect(reconfigured.added).toBe(true);
			expect(reconfigured.generation.follows).toBe(false);

			for (let attempt = 0; attempt < 400; attempt++) {
				const generations = await port.generations();
				if (generations.find((one) => one.canonical)?.record.stream === reconfigured.generation.record.stream) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			// The counter is the one value in this fixture decided purely by which fold
			// answered: the new source starts at block 102, so block 100's two transfers
			// are not in it.
			expect(await transfers(port)).toBe(EXPECTED_A_FROM_LATER_BLOCK.transfers);
			expect((await port.generations()).length).toBe(2);
		} finally {
			port.close();
			indexer.dispose();
		}
	});

	it('carries the same TYPED surface a worker-hosted port carries', async () => {
		const shape = await openOnTheMainThread(freshName());
		try {
			await untilAtTip(shape.port);
			// `createPortReadSurface` is the thing an app actually holds, and it does not
			// know which shape it is generated over.
			const reads = createPortReadSurface(shape.port, processor.entities);
			const token = await reads.token.getCurrent({id: '1'});
			expect(token?.owner).toBe(EXPECTED_A.owners['1']);
		} finally {
			shape.close();
		}
	});

	it('holds the WRITER inside the host, so a second wire is still only reads', async () => {
		const databaseName = freshName();
		const shape = await openOnTheMainThread(databaseName);
		try {
			await untilAtTip(shape.port);
			// A store this tab opens beside the host's is a READER, exactly as a tab beside
			// a worker host is: the port is what makes the surface work either way.
			const reader = openForReading(await createBrowserStateStore(processor.entities, {databaseName}));
			expect(await readState(new EntityStateView(reader))).toEqual(EXPECTED_A);
		} finally {
			shape.close();
		}
	});
});

/** The counter, read THROUGH THE PORT. */
async function transfers(port: IndexerPort): Promise<number | null> {
	const row = (await port.reads.getCurrent('counter', {name: 'transfers'})) as {value?: number} | undefined;
	return row?.value ?? null;
}
