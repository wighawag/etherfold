/**
 * The code under test, bundled into a real browser page.
 *
 * What runs here is the WHOLE claim of this package, not a piece of it: an
 * application's entity processor, driven by `createIndexerState`, against a
 * store that `createBrowserStateStore` built and a writer CLAIMED, in an engine
 * that has real
 * IndexedDB and a real page reload. The node tests
 * (`test/entityIndexing.test.ts`) ask the same questions of the same workload
 * object under `fake-indexeddb`, on every commit; this is where the answers stop
 * depending on a shim.
 *
 * The cases:
 *
 * - `index`: the captured stream through the hook, landing on the expected state.
 * - `reorg`: the same, then a branch that replaces block 104 with fewer events,
 *   so the counter must come DOWN.
 * - `backends`: the SAME processor object on the IndexedDB default and on the
 *   light patch store, compared to each other rather than to a hand-written
 *   answer.
 * - `prune`: the same workload against a store with a retention FLOOR and
 *   against one without, counting what each physically holds afterwards. It runs
 *   here because reclamation is the one claim a shim cannot make: `prune` is a
 *   range scan over a real `upper` index, in a real transaction, and
 *   `fake-indexeddb`'s write path is not the engine's.
 * - `hot-processor` / `hot-contract`: the two reload axes, which are the ones
 *   that only exist because of a DEVELOPMENT loop -- an edited reducer swapped
 *   into a running tab, and a contract redeployed behind a proxy at an address
 *   that already has indexed history. They run here rather than only under
 *   `fake-indexeddb` because a discard is a real `revertTo` against a real
 *   database, followed by a real re-index, in a page that never reloaded.
 * - `hosted-in-a-worker`: the fold in a DEDICATED WORKER, with the tab holding
 *   only a port. It runs here and nowhere else: a worker is the one thing no node
 *   test can have, and "the UI thread is not doing the fold" is a claim about two
 *   execution contexts rather than about two objects.
 * - `write` / `read` phases: reload continuity across a REAL page reload, which
 *   is the thing no node test can show. The `read` phase runs in a page that has
 *   never seen the `write` phase's objects; the only thing that crossed is
 *   IndexedDB.
 */
import type {CodeUnderTest, RunContext, RunResult, Timing} from 'playwright-browser-harness/contract';
import {captureEnv, timed} from 'playwright-browser-harness/contract';
import {EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, openForReading} from '@etherfold/state-store';
import {PatchStateStore} from '@etherfold/state-store-patch';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	dedicatedWorkerHost,
	executionScopeName,
	type HostProgress,
	type IndexerPort,
} from '../src/index.js';
import {
	BRANCH_A_LATER,
	BRANCH_A_LATER_TIP,
	BRANCH_A_TIP,
	BRANCH_B,
	BRANCH_B_TIP,
	entityProcessorOver,
	fakeChain,
	FINALITY,
	indexerFor,
	indexerForProcessor,
	indexToTip,
	processor,
	processorVariant,
	readState,
	runWorkload,
	SOURCE,
	SOURCE_V2,
	START_BLOCK,
	versionCount,
	writableStore,
} from './workload.js';

type Params = Record<string, unknown>;

function databaseName(params: Params, suffix: string): string {
	return `${(params.tag as string) ?? 'etherfold-browser-indexing'}-${suffix}`;
}

/** The captured stream, through the hook, on the default backend. */
async function indexCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const store = await writableStore({databaseName: databaseName(params, 'index')});
	const {state, lastSync, ranges} = await timed('index', timings, () => runWorkload(store));
	return {state, lastToBlock: lastSync.lastToBlock, latestBlock: lastSync.latestBlock, ranges};
}

/** A reorg through the browser path, including the counter that must decrease. */
async function reorgCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const chain = fakeChain();
	const store = await writableStore({databaseName: databaseName(params, 'reorg')});
	const indexer = indexerFor(store);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

	await timed('branch-a', timings, () => indexToTip(indexer));
	const before = await readState(indexer.state.$state);

	chain.serve(BRANCH_B, BRANCH_B_TIP);
	await timed('branch-b', timings, () => indexToTip(indexer));
	const after = await readState(indexer.state.$state);

	indexer.dispose();
	return {before, after};
}

/**
 * One processor, two backends the application chose between.
 *
 * The comparison is between the runs, not against a literal: an expectation
 * written here could be wrong in the same way twice, while two stores that were
 * never told about each other agreeing is the claim itself.
 */
async function backendsCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const onIndexedDB = await timed('indexeddb', timings, async () =>
		runWorkload(await writableStore({databaseName: databaseName(params, 'backends')})),
	);
	const onPatches = await timed('patch', timings, async () =>
		runWorkload(
			await writableStore({
				backend: (declarations) => new PatchStateStore(declarations, {finalityDepth: FINALITY}),
			}),
		),
	);
	const inMemory = await timed('memory', timings, async () =>
		runWorkload(
			await writableStore({
				backend: (declarations) => new MemoryStateStore(declarations),
			}),
		),
	);

	return {
		indexeddb: onIndexedDB.state,
		patch: onPatches.state,
		memory: inMemory.state,
		// what the light store tells an app author about a reload, BEFORE one happens
		patchDurability: (onPatches.indexer.state.$state.capabilities as {durability?: string}).durability ?? 'unstated',
	};
}

/**
 * The SAME workload on three stores that differ only in what they said they
 * KEEP.
 *
 * The claim is a count, because a count is what a prune changes: a store with a
 * floor holds fewer versions afterwards, a store without one holds every version
 * it ever wrote, and all three answer identically -- which is what makes the
 * reclamation free rather than lossy.
 *
 * `revert-only` with a depth is here beside the window on purpose. It HAS a
 * floor (the depth a revert reaches is its whole retention), and an
 * implementation that triggered on "a window is set" would leave it refusing
 * every historical read while retaining every version for ever.
 */
async function pruneCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const names = {
		unbounded: databaseName(params, 'prune-unbounded'),
		windowed: databaseName(params, 'prune-window'),
		revertOnly: databaseName(params, 'prune-revert-only'),
	};
	const lateBranch = () => fakeChain(BRANCH_A_LATER, BRANCH_A_LATER_TIP);

	const unbounded = await timed('unbounded', timings, async () =>
		runWorkload(await writableStore({databaseName: names.unbounded}), lateBranch()),
	);
	const windowed = await timed('window', timings, async () =>
		runWorkload(
			await writableStore({
				databaseName: names.windowed,
				retention: {blocks: 64},
				finalityDepth: 64,
			}),
			lateBranch(),
		),
	);
	const revertOnly = await timed('revert-only', timings, async () =>
		runWorkload(
			await writableStore({
				databaseName: names.revertOnly,
				retention: 'revert-only',
				finalityDepth: 64,
			}),
			lateBranch(),
		),
	);

	return {
		unboundedVersions: await versionCount(names.unbounded),
		windowedVersions: await versionCount(names.windowed),
		revertOnlyVersions: await versionCount(names.revertOnly),
		unboundedState: unbounded.state,
		windowedState: windowed.state,
		revertOnlyState: revertOnly.state,
	};
}

/** The tab indexes, then goes away. */
async function writePhase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const store = await writableStore({databaseName: databaseName(params, 'reload')});
	const {state, ranges} = await timed('first-tab', timings, () => runWorkload(store));
	return {state, ranges, firstRangeFrom: ranges[0]?.from};
}

/**
 * The tab is opened again: same origin, same database, nothing else in common.
 *
 * The assertion the node side cannot make is that this page really did start
 * cold. Its module instances, its stores and its processor are new; if the
 * cursor had not survived in IndexedDB, this would re-index from
 * `START_BLOCK` and say so in `firstRangeFrom`.
 */
async function readPhase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const store = await timed('cold-start', timings, () => writableStore({databaseName: databaseName(params, 'reload')}));
	const {state, ranges} = await timed('second-tab', timings, () => runWorkload(store));
	return {state, ranges, firstRangeFrom: ranges[0]?.from, startBlock: START_BLOCK};
}

/**
 * AXIS ONE: the developer edited the reducer.
 *
 * Three swaps in one page, because the interesting part is that they differ:
 * the same edit is a no-op, a rebuild, or a rebuild, depending only on a string
 * the author controls.
 */
async function hotProcessorCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const chain = fakeChain();
	const store = await writableStore({
		databaseName: databaseName(params, 'hot-processor'),
	});
	const indexer = indexerForProcessor(store, processor);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

	await timed('initial-index', timings, () => indexToTip(indexer));
	const before = await readState(indexer.state.$state);

	// (1) the edit, with `version` left alone: the core cannot see it
	const unbumped = await indexer.updateProcessor(
		entityProcessorOver(store, processorVariant({version: '1.0.0', countBy: 10})),
	);
	await indexToTip(indexer);
	const afterUnbumped = await readState(indexer.state.$state);

	// (2) the same edit with `version` bumped: discarded and recomputed
	const bumped = await timed('bumped-swap', timings, () =>
		indexer.updateProcessor(entityProcessorOver(store, processorVariant({version: '2.0.0', countBy: 10}))),
	);
	await indexToTip(indexer);
	const afterBumped = await readState(indexer.state.$state);

	indexer.dispose();
	return {
		before,
		unbumpedDiscarded: unbumped.stateDiscarded,
		afterUnbumped,
		bumpedDiscarded: bumped.stateDiscarded,
		afterBumped,
	};
}

/**
 * AXIS TWO: a redeploy behind the proxy, at an address that already has history.
 *
 * The second half is the one worth running in a real engine: the redeployed
 * implementation has emitted NOTHING yet, so there is no event to overwrite the
 * state with. What the page shows afterwards is whatever the hook published at
 * the moment of the discard, and nothing else will ever correct it.
 */
async function hotContractCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const chain = fakeChain();
	const store = await writableStore({databaseName: databaseName(params, 'hot-contract')});
	const indexer = indexerForProcessor(store, processor);
	await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});

	await timed('initial-index', timings, () => indexToTip(indexer));
	const before = await readState(indexer.state.$state);
	const rangesBefore = chain.ranges.length;

	// the same address, the ABI a redeployed implementation generates
	const outcome = await timed('redeploy', timings, () => indexer.updateIndexer({source: SOURCE_V2 as never}));
	await indexToTip(indexer);
	const after = await readState(indexer.state.$state);
	const reindexedFrom = chain.ranges.slice(rangesBefore)[0]?.from;

	// The case with no next event to hide the defect: a second tab indexes the
	// same history, then the contract is redeployed and the new implementation has
	// emitted nothing at all. What `$state` holds after this is final.
	const emptyChain = fakeChain();
	const emptyStore = await writableStore({
		databaseName: databaseName(params, 'hot-contract-empty'),
	});
	const second = indexerForProcessor(emptyStore, processor);
	await second.init({provider: emptyChain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
	await indexToTip(second);
	const beforeRedeploy = await readState(second.state.$state);

	emptyChain.serve([], 120);
	await second.updateIndexer({source: SOURCE_V2 as never});
	await indexToTip(second);
	const afterEmptyRedeploy = await readState(second.state.$state);

	indexer.dispose();
	second.dispose();
	return {
		before,
		stateDiscarded: outcome.stateDiscarded,
		// The VERDICT the core reached, carried out of the page as it was reported.
		// `stateDiscarded` says the fold went; this says WHICH halves and FROM WHICH
		// block, which is what a caller that wants to do something other than discard
		// has to read -- so it is worth proving it survives a real engine and the
		// harness boundary, not only a node test.
		sourceInvalidation: outcome.sourceInvalidation,
		after,
		reindexedFrom,
		startBlock: START_BLOCK,
		beforeRedeploy,
		afterEmptyRedeploy,
	};
}

/**
 * THE FOLD IN A DEDICATED WORKER, and a tab that only holds a port.
 *
 * The page constructs a `Worker` and nothing else: no container, no store handle
 * it could write through, no provider. Everything the fold needs was IMPORTED by
 * the worker entry point (`indexer.worker.ts`), which is the shape an application
 * writes.
 *
 * What is read back afterwards is the state the WORKER wrote, opened from the
 * page for READING -- the same origin, the same database, the writer's claim
 * untouched. That comparison is the point: the rows a worker folded are the rows
 * the main-thread path folds from the same bytes, which the `index` case above
 * asserts against the same constant.
 */
async function hostedInAWorkerCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = databaseName(params, 'hosted-in-a-worker');
	// The form every current bundler understands, and the reason the APP owns this
	// line: the URL has to be a literal its bundler can trace (ADR-0082). The
	// harness builds `indexer.worker.ts` to `worker.js` beside this bundle.
	const worker = new Worker(new URL(`./worker.js?db=${encodeURIComponent(database)}`, import.meta.url), {
		type: 'module',
	});
	const indexer = connectToIndexerHost(dedicatedWorkerHost(worker));
	try {
		const progress = await timed('fold-in-a-worker', timings, () => untilAtTip(indexer));
		const state = await timed('read-back', timings, async () =>
			readState(
				new EntityStateView(
					openForReading(await createBrowserStateStore(processor.entities, {databaseName: database})),
				),
			),
		);
		return {
			// WHERE the answer was computed, measured in the answering context rather
			// than declared by the caller
			scope: progress.scope,
			tabScope: executionScopeName(),
			host: progress.host,
			indexing: progress.indexing,
			lastToBlock: progress.lastToBlock,
			latestBlock: progress.latestBlock,
			// everything the tab was handed, in full
			portSurface: Object.keys(indexer).sort(),
			state,
		};
	} finally {
		indexer.close();
	}
}

/**
 * Ask until the fold is level with THIS FIXTURE'S tip, and fail SAYING SO if the
 * host stopped.
 *
 * The tip is NAMED rather than inferred from equality. A container that has
 * loaded and not yet fetched publishes `0` for both numbers, so
 * `lastToBlock === latestBlock` holds before a single log has been asked for;
 * waiting on that returns instantly and leaves the read below racing the fold,
 * which is what it did on Chromium (and not on the other two) until this said
 * `BRANCH_A_TIP`.
 */
async function untilAtTip(indexer: IndexerPort, attempts = 600): Promise<HostProgress> {
	let progress = await indexer.progress();
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (progress.failure) {
			throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
		}
		if (progress.latestBlock === BRANCH_A_TIP && progress.lastToBlock === progress.latestBlock) {
			return progress;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
		progress = await indexer.progress();
	}
	throw new Error(`the fold did not reach the tip: ${JSON.stringify(progress)}`);
}

const cut: CodeUnderTest = {
	name: '@etherfold/browser',
	async run(ctx: RunContext): Promise<RunResult> {
		const timings: Timing[] = [];
		const errors: string[] = [];
		let results: Record<string, unknown> = {};

		try {
			if (ctx.phase === 'write') {
				results = await writePhase(ctx.params, timings);
			} else if (ctx.phase === 'read') {
				results = await readPhase(ctx.params, timings);
			} else {
				switch (ctx.params.case) {
					case 'index':
						results = await indexCase(ctx.params, timings);
						break;
					case 'reorg':
						results = await reorgCase(ctx.params, timings);
						break;
					case 'backends':
						results = await backendsCase(ctx.params, timings);
						break;
					case 'prune':
						results = await pruneCase(ctx.params, timings);
						break;
					case 'hot-processor':
						results = await hotProcessorCase(ctx.params, timings);
						break;
					case 'hot-contract':
						results = await hotContractCase(ctx.params, timings);
						break;
					case 'hosted-in-a-worker':
						results = await hostedInAWorkerCase(ctx.params, timings);
						break;
					default:
						throw new Error(`unknown case ${JSON.stringify(ctx.params.case)}`);
				}
			}
		} catch (error) {
			errors.push(`${(error as Error)?.stack ?? error}`);
		}

		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
