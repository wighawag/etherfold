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
 * - `progress-pushed-from-the-worker`: the fold in a dedicated worker, with the
 *   tab COLLECTING what the worker pushes at it. It runs here because the claim
 *   is about a signal crossing a real `postMessage` from a context that is not
 *   the UI thread, unprompted -- and because "nothing polls" is only worth
 *   asserting where there is a second thread that could have been polled.
 * - `controls-the-indexer`: start, stop, reconfigure and generation visibility,
 *   asked of a real worker from a real tab. It runs here because the claim that
 *   needs a second execution context is that the LIFECYCLE crosses: a tab that
 *   holds nothing but a port stops the fold, changes the source, and is answered
 *   from the generation the pointer moved to.
 * - `tx-inclusion-from-the-tab`: the optimistic-update reconciliation, asked of a
 *   real worker from a real tab, before and after the fold reaches the
 *   transaction. It runs here because the verdict is the one answer on this port
 *   that must not be simplified on the way across -- a status, its basis, and the
 *   two distinct causes of `unknown` -- and because "answered from current state"
 *   is only a claim worth making where the state is being folded somewhere else
 *   while the question is asked.
 * - `reads-across-the-port`: the store's four reads, asked of a surface over a
 *   port to a real worker AND of a surface over a store on this thread, with ONE
 *   case list and the same workload behind both. Reading while the fold is still
 *   running is part of it, because that is what makes an app usable during a
 *   first sync rather than after it.
 * - `shared-attach` / `shared-finish` / `shared-both-shapes` / `shared-other-app`
 *   / `shared-unsupported`: the SHAREDWORKER hosting shape. They run here because
 *   the claim is about SEVERAL TABS attached to ONE host: a SharedWorker is
 *   identified by its script URL plus its name, so "one host" is a fact about two
 *   documents in one browser and cannot be arranged between two objects. The
 *   attach/finish pair is one case split in two runs because the spec closes a
 *   page in between, and the port has to survive that: it is kept in module state
 *   (see `sharedlyAttached`).
 * - `cross-tab-reader-listen` / `cross-tab-nextdoor-fold` / `cross-tab-reader-quiet`
 *   / `cross-tab-writer-start` / `cross-tab-reader-late` / `cross-tab-writer-finish`
 *   / `cross-tab-reader-report`: the **state-moved signal** crossing between TABS
 *   over a `BroadcastChannel` (ADR-0083). They run here because the claim cannot
 *   be arranged between two objects: it is one tab folding and ANOTHER tab, with
 *   its OWN host and no port to the first, re-reading because it was told. The
 *   shared-worker cases are deliberately not where this lives -- those tabs hold
 *   ports to ONE host and are pushed to anyway, so a channel test there would pass
 *   while demonstrating nothing. They are seven runs across three pages because
 *   the sequence is the assertion (listen, then a fold NEXT DOOR that must not be
 *   heard, then a fold this tab's channel carries, with a listener attaching half
 *   way through it), and module state is what carries a tab's channels between its
 *   own runs -- the same split `shared-attach` / `shared-finish` already makes.
 * - `sync-progress-reader-with-a-host` / `sync-progress-reader-with-no-host`
 *   / `sync-progress-writer-start` / `sync-progress-reader-report`
 *   / `sync-progress-writer-finish` / `sync-progress-newcomer` / the two `-done`
 *   runs: SYNC PROGRESS riding that same channel, so "syncing, 400 blocks behind"
 *   is renderable in a tab that is not the one folding. They run here for the
 *   reason the case above does -- the tabs that render it hold no port to the host
 *   that computed it -- and the fold is HELD mid-flight so the number asserted on
 *   is one somebody would put on a screen rather than zero. The newcomer is a tab
 *   opened AFTER the fold reached the tip, which is the case that cannot be
 *   arranged any other way: nothing is going to be pushed to it, so it can only
 *   learn where things are by asking.
 * - `hosting-shapes`: ONE behaviour suite (`hostingShapes.ts`) run against all
 *   THREE hosting shapes in one page -- a dedicated worker, a SharedWorker and
 *   `createIndexerState` on this thread. It runs here because it is the only
 *   place all three exist: the two worker shapes need a real browser, and the
 *   node run (`test/theThreeHostingShapesRunOneImplementation.test.ts`) drives
 *   the same list against the main-thread one on every commit. What it asserts
 *   is ADR-0082's opening claim -- one implementation, three hosting shapes --
 *   and it asserts it by there being one list rather than three files that agree.
 * - `restarts-and-resumes`: a real dedicated worker TERMINATED mid-fold, while it
 *   is writing a block, and the port that puts another one in its place. It runs
 *   here and nowhere else for the reason the hosting case does -- a browser is the
 *   only place a `Worker.terminate()` means anything -- and what it asserts on is
 *   the RANGES the replacement asked the node for, because a host that re-indexed
 *   from the start block lands on exactly the same rows as one that resumed.
 * - `write` / `read` phases: reload continuity across a REAL page reload, which
 *   is the thing no node test can show. The `read` phase runs in a page that has
 *   never seen the `write` phase's objects; the only thing that crossed is
 *   IndexedDB.
 */
import type {CodeUnderTest, RunContext, RunResult, Timing} from 'playwright-browser-harness/contract';
import {captureEnv, timed} from 'playwright-browser-harness/contract';
import type {StateMoved} from '@etherfold/core';
import {EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, createReadSurface, openForReading, type StateStoreBackend} from '@etherfold/state-store';
import {PatchStateStore} from '@etherfold/state-store-patch';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createPortReadSurface,
	createProgressReadable,
	dedicatedWorkerHost,
	executionScopeName,
	openStateMovedAcrossTabs,
	sharedWorkerHost,
	type HostDeath,
	type HostProgress,
	type IndexerPort,
	type StateMovedAcrossTabs,
} from '../src/index.js';
import {
	hostingShapeCases,
	openOnTheMainThread,
	runHostingShapeCases,
	watchStateMoved,
	type StateMovedWatch,
} from './hostingShapes.js';
import {foldOnThisThread, readEntities, readWritableStore, runReadSurfaceCases} from './readWorkload.js';
import {
	BRANCH_A_LATER,
	BRANCH_A_LATER_TIP,
	BRANCH_A_TIP,
	BRANCH_B,
	BRANCH_B_TIP,
	entityProcessorOver,
	EXPECTED_A,
	EXPECTED_A_FROM_LATER_BLOCK,
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
	SOURCE_FROM_LATER_BLOCK,
	SOURCE_V2,
	START_BLOCK,
	txInBlock,
	versionCount,
	writableStore,
} from './workload.js';

type Params = Record<string, unknown>;

function databaseName(params: Params, suffix: string): string {
	return `${(params.tag as string) ?? 'etherfold-browser-indexing'}-${suffix}`;
}

/**
 * THE WORKERS A PORT BUILDS FOR A CASE, newest last.
 *
 * The app owns the line that constructs a `Worker` -- the URL has to be a literal
 * its bundler can trace (ADR-0082), and the harness builds `indexer.worker.ts` to
 * `worker.js` beside this bundle -- and the PORT owns when it is called, because a
 * host that died is replaced by another of the same shape.
 *
 * The handles are kept because these fixtures reach past the port for the two
 * things it has no verb for, and should not have: posting a gate release straight
 * at the worker, and KILLING one. An application needs neither.
 */
function hostedWorkers(
	url: URL,
	onBuilt: (worker: Worker) => void = () => undefined,
): {create: () => Worker; latest: () => Worker; built: Worker[]} {
	const built: Worker[] = [];
	const create = () => {
		const worker = new Worker(url, {type: 'module'});
		onBuilt(worker);
		built.push(worker);
		return worker;
	};
	return {create, latest: () => built[built.length - 1], built};
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
	const workers = hostedWorkers(new URL(`./worker.js?db=${encodeURIComponent(database)}`, import.meta.url));
	const indexer = connectToIndexerHost(dedicatedWorkerHost(workers.create));
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
 * THE FOUR READS ACROSS A REAL PORT TO A REAL WORKER, and the same questions
 * asked of a store on this thread.
 *
 * The claim is an EQUALITY, so it is asserted as one: `readSurfaceCases` is run
 * twice, over two surfaces of the same TYPE, built over two stores that were
 * written by the same processor from the same captured logs. A divergence is a
 * failed case with a name, not a difference somebody has to notice.
 *
 * It also reads BEFORE the fold has finished -- the first read is issued as soon
 * as the port exists, while the worker is still folding -- because an app being
 * usable during a first sync is the point of the store living in the host rather
 * than a bonus.
 */
async function readsAcrossThePortCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = databaseName(params, 'reads-across-the-port');
	const workers = hostedWorkers(new URL(`./worker.js?db=${encodeURIComponent(database)}`, import.meta.url));
	const indexer = connectToIndexerHost(dedicatedWorkerHost(workers.create));
	try {
		// A read issued while the worker is still opening its store and folding: it
		// WAITS for the store rather than being refused, and answers with whatever
		// the fold has written by then (`undefined` included -- an absent row is an
		// ordinary answer).
		const whileFolding = await timed('while-folding', timings, async () => {
			const surface = createPortReadSurface(indexer, readEntities);
			const row = await surface.token.getCurrent({id: '1'});
			return {answered: true, owner: row?.owner ?? null, progress: await indexer.progress()};
		});

		const progress = await timed('fold-in-a-worker', timings, () => untilAtTip(indexer));
		const acrossThePort = await timed('cases-across-the-port', timings, () =>
			runReadSurfaceCases(createPortReadSurface(indexer, readEntities)),
		);

		const store = await readWritableStore({databaseName: `${database}-same-thread`});
		await timed('fold-on-this-thread', timings, () => foldOnThisThread(store, fakeChain()));
		const onThisThread = await timed('cases-on-this-thread', timings, () =>
			runReadSurfaceCases(createReadSurface(store, readEntities)),
		);

		return {
			// WHERE the rows were read from, measured in the context that read them
			scope: progress.scope,
			tabScope: executionScopeName(),
			host: progress.host,
			whileFolding: {
				answered: whileFolding.answered,
				// how far the fold had got when that read was answered
				lastToBlock: whileFolding.progress.lastToBlock ?? null,
				indexing: whileFolding.progress.indexing,
			},
			acrossThePort,
			onThisThread,
			// everything the tab was handed, in full
			portSurface: Object.keys(indexer).sort(),
			readSurface: Object.keys(createPortReadSurface(indexer, readEntities).token).sort(),
		};
	} finally {
		indexer.close();
	}
}

/**
 * THE WORKER TELLING ITS OWN TAB HOW IT IS DOING, in a real browser.
 *
 * Nothing in here asks. The page subscribes once, and everything it learns after
 * that arrives unprompted from a `DedicatedWorkerGlobalScope` -- which is what
 * makes this the run the node tests cannot make: a push that crossed a real
 * `postMessage` between two execution contexts, rather than between two objects.
 *
 * The three claims that need a real worker:
 *
 * - the pushes ARRIVE, carry the phases in order, and the distance to the tip
 *   shrinks to zero as the fold advances (the fixture is fetched four blocks at
 *   a time so that there is more than one advance to watch);
 * - an UNSUBSCRIBED tab stops receiving them ON THE WIRE, counted on the `Worker`
 *   object itself rather than in a callback that is merely no longer called;
 * - a tab that attaches LATE -- here, after the fold is already at the tip and
 *   will therefore never move again -- is told where things stand anyway.
 */
async function progressPushedCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = databaseName(params, 'progress-pushed');

	// EVERY message the worker posts at this tab, ours or not, so "it stopped
	// pushing" is a fact about the wire.
	const posted: {kind?: string}[] = [];
	const workers = hostedWorkers(
		new URL(`./worker.js?db=${encodeURIComponent(database)}&fetch=4`, import.meta.url),
		(worker) => worker.addEventListener('message', (event) => posted.push(event.data as {kind?: string})),
	);

	const indexer = connectToIndexerHost(dedicatedWorkerHost(workers.create));
	try {
		// The helper an app binds to a progress display, built BEFORE anything has
		// been pushed: what it holds until the host answers is nothing at all.
		const progress = createProgressReadable(indexer);
		const helperBeforeAnyPush = progress.$state === undefined;

		const pushes: HostProgress[] = [];
		const atTip = new Promise<HostProgress>((resolve) => {
			const stop = indexer.onProgress((value) => {
				pushes.push(value);
				if (value.phase === 'at-tip') {
					resolve(value);
					// Released from inside, once the fold SAID it was done: this case waits
					// on a value and never on a duration.
					queueMicrotask(() => stop());
				}
			});
		});
		const done = await timed('pushed-to-the-tip', timings, () => atTip);

		// IDENTITY: the helper holds the host's own last report, by reference. It is
		// a view over the signal and not a value it assembled.
		const helperHoldsTheLastPush = progress.$state === pushes[pushes.length - 1];
		progress.close();

		// Both subscriptions are released now. One round trip so the unsubscribes
		// cannot still be in flight, then count what arrives while the worker goes on
		// advancing at the tip.
		await indexer.progress();
		const quietFrom = posted.length;
		await new Promise((resolve) => setTimeout(resolve, 500));
		const pushedWhileUnsubscribed = posted.slice(quietFrom).filter((message) => message?.kind === 'push').length;

		// A tab attaching to a fold that has ALREADY finished: it can only learn
		// where things stand if attaching tells it, because nothing is going to move.
		const late = await timed(
			'late-subscriber',
			timings,
			() =>
				new Promise<HostProgress>((resolve) => {
					const stop = indexer.onProgress((value) => {
						resolve(value);
						queueMicrotask(() => stop());
					});
				}),
		);

		return {
			// WHERE the pushes were computed, measured in the context that computed them
			scope: done.scope,
			tabScope: executionScopeName(),
			host: done.host,
			// the phases as they changed, in order
			phases: pushes.map((push) => push.phase).filter((phase, index, all) => phase !== all[index - 1]),
			// how far behind the tip each report that knew a tip said it was
			blocksBehindTip: pushes.map((push) => push.blocksBehindTip).filter((behind) => behind !== undefined),
			firstPhase: pushes[0]?.phase,
			done: {
				phase: done.phase,
				lastToBlock: done.lastToBlock,
				latestBlock: done.latestBlock,
				blocksBehindTip: done.blocksBehindTip,
				numBlocksProcessedSoFar: done.numBlocksProcessedSoFar,
				syncPercentage: done.syncPercentage,
			},
			helperBeforeAnyPush,
			helperHoldsTheLastPush,
			pushedWhileUnsubscribed,
			lateSubscriber: {phase: late.phase, lastToBlock: late.lastToBlock},
			portSurface: Object.keys(indexer).sort(),
		};
	} finally {
		indexer.close();
	}
}

/**
 * THE LIFECYCLE ACROSS A REAL PORT TO A REAL WORKER: stop, start, reconfigure,
 * and see which generation answers.
 *
 * The page holds a port and nothing else -- no container, no store handle, no
 * provider -- so every one of these is a message that crossed a real
 * `postMessage` and an answer that came back from a `DedicatedWorkerGlobalScope`.
 *
 * The reconfigure is the one with weight, and it is asserted on the COUNTER,
 * which is the one value in this fixture decided purely by which fold answered:
 * the new source starts at block 102, so the two transfers in block 100 are not
 * in it, and a read answering `3` where it answered `5` is the promoted
 * generation answering rather than the retired one.
 *
 * Each generation folds into a database of its own (`generations` on the worker
 * URL), which is the rule the container states for `createState` and which a
 * reconfigure is what makes load-bearing.
 */
async function controlsTheIndexerCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = databaseName(params, 'controls-the-indexer');
	const workers = hostedWorkers(
		new URL(`./worker.js?db=${encodeURIComponent(database)}&generations=1`, import.meta.url),
	);
	const indexer = connectToIndexerHost(dedicatedWorkerHost(workers.create));
	try {
		const folded = await timed('fold-in-a-worker', timings, () => untilAtTip(indexer));
		const before = await transfersAcrossThePort(indexer);

		// STOP, from the tab: what a settings screen or a backgrounded tab does so an
		// app stops burning a user's rate limit.
		const stopped = await timed('stop', timings, () => indexer.stopIndexing());
		// ...and a stopped host is still a host: the store goes on answering, because
		// stopping the DRIVER is not closing the CONTAINER.
		const readWhileStopped = await transfersAcrossThePort(indexer);
		const started = await timed('start', timings, () => indexer.startIndexing());

		// RECONFIGURE: a generation beside the live one, on a stream of its own.
		const reconfigured = await timed('reconfigure', timings, () =>
			indexer.reconfigure({source: SOURCE_FROM_LATER_BLOCK}),
		);
		const duringCatchUp = await transfersAcrossThePort(indexer);

		const promoted = await timed('promotion', timings, () =>
			untilPromoted(indexer, reconfigured.generation.record.stream),
		);
		const afterPromotion = await transfersAcrossThePort(indexer);

		return {
			// WHERE the host is running, measured in the context that answered
			scope: folded.scope,
			tabScope: executionScopeName(),
			host: folded.host,
			before,
			expectedBefore: EXPECTED_A.transfers,
			stopped: {indexing: stopped.indexing, phase: stopped.phase, lastToBlock: stopped.lastToBlock},
			readWhileStopped,
			startedIndexing: started.indexing,
			reconfigure: {
				added: reconfigured.added,
				follows: reconfigured.generation.follows,
				canonicalAtOnce: reconfigured.generation.canonical,
				sameStream: reconfigured.generation.record.stream === promoted.incumbent,
			},
			// what the app was answered WHILE the new generation was still folding
			duringCatchUp,
			generations: promoted.generations,
			afterPromotion,
			expectedAfter: EXPECTED_A_FROM_LATER_BLOCK.transfers,
			promotion: await indexer.promotion(),
			// everything the tab was handed, in full
			portSurface: Object.keys(indexer).sort(),
		};
	} finally {
		indexer.close();
	}
}

/**
 * THE OPTIMISTIC-UPDATE RECONCILIATION, ASKED OF A REAL WORKER FROM A REAL TAB.
 *
 * The page holds a port and nothing else: it has no store, no cursor and no
 * window, so the only thing that could answer this is the context doing the
 * fold. What comes back has to survive the crossing WHOLE -- a status AND the
 * basis for it -- because that is what an app renders: `unknown` means keep the
 * optimistic update, and `absent` means the fold has looked.
 *
 * The fold is held at two known points so that "answered from current state"
 * is a pair of answers rather than a hope. The worker's fixture chain is gated
 * (`holdChain`, `holdAbove`) and the page releases each gate by posting to the
 * worker directly -- not over the port, which ignores a message that is not its
 * own, and which is itself worth crossing once for real.
 *
 * The three moments:
 *
 * 1. nothing served at all, so the host holds no generation: the honest
 *    `unknown`/`not-synced`, answered rather than hung;
 * 2. the fold stopped at block 103, one block below the transaction being
 *    watched: `absent`/`window-miss` -- and the SAME call, given the block a
 *    receipt names, concludes `included`/`below-window` about the transaction in
 *    block 100 that has already fallen out of the sparse window;
 * 3. the fold at the tip: `included`/`window-hit`, naming the block IN THE
 *    INDEXER'S VIEW.
 *
 * `unknown`/`window-not-covering` -- the second cause of unknown -- needs a chain
 * whose tip is tens of thousands of blocks above the fold, which is a counted
 * fixture rather than a second execution context, so it lives in
 * `test/checkTxInclusionFromTheTab.test.ts` with the rest of the timing claims.
 */
async function txInclusionCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = databaseName(params, 'tx-inclusion');
	const workers = hostedWorkers(
		new URL(`./worker.js?db=${encodeURIComponent(database)}&fetch=4&holdChain&holdAbove=103`, import.meta.url),
	);
	/** Block 104's transaction: the one an app would be watching. */
	const watched = txInBlock(104);
	/** Block 100's: folded, and below the unconfirmed window at this fixture's tip. */
	const old = txInBlock(100);
	const never = '0x00000000000000000000000000000000000000000000000000000000000000bb';

	const indexer = connectToIndexerHost(dedicatedWorkerHost(workers.create));
	try {
		// (1) NOTHING SYNCED: the chain is held, so the host has not opened a
		// container. The call ANSWERS -- it does not wait for one.
		const beforeAnySync = await timed('before-any-sync', timings, () =>
			indexer.checkTxInclusion([{txHash: watched}, {txHash: old}]),
		);
		const phaseBeforeAnySync = (await indexer.progress()).phase;

		// (2) HELD BELOW THE TRANSACTION: the fold has 100 to 103 and cannot go on.
		workers.latest().postMessage({fixture: 'release', gate: 'chain'});
		await timed('fold-to-the-hold', timings, () => until(indexer, (progress) => progress.lastToBlock === 103));
		const beforeTheFoldReachesIt = await indexer.checkTxInclusion([
			{txHash: watched},
			{txHash: never},
			// the same call, carrying the block a RECEIPT names for a transaction the
			// sparse window no longer holds
			{txHash: old, minedAtBlock: 100},
		]);

		// (3) AT THE TIP: the transaction has been folded.
		workers.latest().postMessage({fixture: 'release', gate: 'fetches'});
		const progress = await timed('fold-to-the-tip', timings, () => untilAtTip(indexer));
		const afterTheFoldReachesIt = await indexer.checkTxInclusion([{txHash: watched}, {txHash: never}]);

		return {
			// WHERE the verdict was computed, measured in the context that computed it
			scope: progress.scope,
			tabScope: executionScopeName(),
			host: progress.host,
			phaseBeforeAnySync,
			beforeAnySync: {watched: beforeAnySync[watched], old: beforeAnySync[old]},
			beforeTheFoldReachesIt: {
				watched: beforeTheFoldReachesIt[watched],
				never: beforeTheFoldReachesIt[never],
				oldWithAReceipt: beforeTheFoldReachesIt[old],
			},
			// a verdict per hash, from ONE call
			askedAtOnce: Object.keys(beforeTheFoldReachesIt).length,
			afterTheFoldReachesIt: {
				watched: afterTheFoldReachesIt[watched],
				never: afterTheFoldReachesIt[never],
			},
			// everything the tab was handed, in full
			portSurface: Object.keys(indexer).sort(),
		};
	} finally {
		indexer.close();
	}
}

/**
 * THE WORKER TERMINATED MID-FOLD, AND THE TAB THAT PUT IT BACK.
 *
 * The kill is a real `Worker.terminate()` on a real dedicated worker, fired from
 * the page the moment the worker says it is STARTING A STORE WRITE -- which is
 * the case that matters and the one no test terminating between cycles produces:
 * a host that dies with a block half-applied is exactly where "the cursor is
 * written in the same transaction as the block it describes" (ADR-0027) earns its
 * keep, because the alternative is a cursor that has moved past data that never
 * landed.
 *
 * The first worker is also HELD below the tip (`holdAbove`), so there is a middle
 * of a fold to die in rather than a race against a five-block fixture that
 * finishes between two polls. Its successor is released the moment the port
 * builds it.
 *
 * What is carried out of the page is what was FETCHED, per worker life, and it is
 * the whole point: a restart that re-runs the load lands on exactly the same rows
 * as one that resumed, so the end state cannot tell them apart and the ranges
 * asked of the node can. The worker reports each range as it happens, because a
 * worker's own memory dies with it and a message already delivered does not.
 */
async function restartsAndResumesCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = databaseName(params, 'restarts-and-resumes');
	const fetched: {life: number; from: number; to: number}[] = [];
	const probes: string[] = [];
	const landed: {life: number; block: number}[] = [];
	let lives = 0;
	let killed: number | undefined;
	/** A call in flight AT THE MOMENT OF DEATH, and what it was answered with. */
	let inFlight: Promise<string> | undefined;

	const workers = hostedWorkers(
		// `claimWithin` is short here because this is the case that can meet a wedged
		// database, and what is being asserted is that the tab is TOLD rather than left
		// waiting. A healthy claim on every engine lands in single-digit milliseconds.
		new URL(
			`./worker.js?db=${encodeURIComponent(database)}&fetch=4&holdAbove=103&report&claimWithin=5`,
			import.meta.url,
		),
		(worker) => {
			const life = lives++;
			// The SUCCESSOR is let go at once. The first host is held below the tip so
			// that it can be killed mid-fold; the one that replaces it has to be able to
			// finish, and what is being asked of it is where it resumes FROM.
			if (life > 0) worker.postMessage({fixture: 'release', gate: 'fetches'});
			worker.addEventListener('message', (event) => {
				const said = event.data as {
					fixture?: string;
					fetched?: {from: number; to: number};
					wrote?: 'starting' | 'landed';
					block?: number;
				};
				if (said?.fixture !== 'worker') return;
				if ((said as any).probe) probes.push(`life${life}:${(said as any).probe}`);
				if (said.fetched) fetched.push({life, ...said.fetched});
				if (said.wrote === 'landed' && said.block !== undefined) landed.push({life, block: said.block});
				// THE KILL: while a store write is in flight, and with a call in the air.
				if (life === 0 && killed === undefined && said.wrote === 'starting' && (said.block ?? 0) >= 102) {
					killed = said.block;
					inFlight = indexer.progress().then(
						() => 'answered',
						(error) => (error as Error).name,
					);
					worker.terminate();
				}
			});
		},
	);

	const indexer = connectToIndexerHost(dedicatedWorkerHost(workers.create), {
		// A browser default of five seconds would make this case wait for a duration
		// rather than for a value. An application leaves both alone.
		watch: {everyInSeconds: 0.25},
		restart: {backoffInSeconds: 0.05},
	});
	const deaths: HostDeath[] = [];
	let sawDeath!: (death: HostDeath) => void;
	const firstDeath = new Promise<HostDeath>((resolve) => (sawDeath = resolve));
	indexer.onHostDeath((death) => {
		deaths.push(death);
		sawDeath(death);
	});

	try {
		const death = await timed('death', timings, () => firstDeath);
		const rejectedInFlight = inFlight ? await inFlight : 'nothing-was-in-flight';
		// THE RESUME, or the WEDGE this case exists to be honest about.
		//
		// On WebKit, about one run in eight, the replacement worker opens the database
		// and the claim can never land, because terminating a worker with a `readwrite`
		// and a `readonly` transaction overlapping wedges the whole database: `open`
		// keeps working and every transaction after it hangs, for every context and
		// across a reload. That is a WebKit defect and no claim can land on a database
		// in that state
		// (`work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`).
		// What the host does about it is NOT wait for ever: the claim is bounded, the
		// refusal travels out of `createState`, and the tab reads it as a failure.
		// So this does NOT throw -- the outcome is REPORTED, and the spec decides what
		// each engine is allowed to do with it, rather than a real product guarantee
		// being expressed as an intermittent timeout.
		const resumed = await timed('resume', timings, () =>
			untilAtTip(indexer).then(
				(progress) => ({stalled: false as const, progress}),
				async () => ({stalled: true as const, progress: await indexer.progress().catch(() => undefined)}),
			),
		);
		if (resumed.stalled) {
			return {
				stalled: true,
				probes,
				// WHERE it stalled, so a reader does not have to guess: the replacement
				// worker is alive and answering, its store opened, and the claim never
				// landed.
				stalledAt: resumed.progress,
				deaths: deaths.length,
				rejectedInFlight,
			};
		}

		// Read back the way a tab reads: from the same database, opened for READING,
		// with the successor's claim untouched.
		const state = await timed('read-back', timings, async () =>
			readState(
				new EntityStateView(
					openForReading(await createBrowserStateStore(processor.entities, {databaseName: database})),
				),
			),
		);

		return {
			probes,
			// WHERE the resumed fold ran, measured in the context that ran it: the
			// replacement is a worker too.
			scope: resumed.progress.scope,
			tabScope: executionScopeName(),
			host: resumed.progress.host,
			lives: workers.built.length,
			killedWritingBlock: killed ?? null,
			death: {
				cause: death.cause,
				attempt: death.attempt,
				restarting: death.restarting,
				rejected: death.rejected,
			},
			deaths: deaths.length,
			rejectedInFlight,
			// what the node was asked for, per worker life
			fetchedBeforeDeath: fetched.filter((range) => range.life === 0).map(({from, to}) => ({from, to})),
			fetchedAfterRestart: fetched.filter((range) => range.life > 0).map(({from, to}) => ({from, to})),
			landedBeforeDeath: landed.filter((write) => write.life === 0).map((write) => write.block),
			startBlock: START_BLOCK,
			tip: BRANCH_A_TIP,
			lastToBlock: resumed.progress.lastToBlock,
			latestBlock: resumed.progress.latestBlock,
			state,
			// every surface the tab had before the death, asked again after it
			afterTheRestart: {
				transfers: await transfersAcrossThePort(indexer),
				generations: (await indexer.generations()).length,
				promotion: (await indexer.promotion()).policy,
				inclusion: (await indexer.checkTxInclusion([{txHash: txInBlock(104)}]))[txInBlock(104)].status,
				reconfigureAdded: (await indexer.reconfigure({source: SOURCE})).added,
				stopped: (await indexer.stopIndexing()).indexing,
				started: (await indexer.startIndexing()).indexing,
			},
			portSurface: Object.keys(indexer).sort(),
		};
	} finally {
		indexer.close();
	}
}

/**
 * A BLOCK APPLIES WHOLE OR NOT AT ALL, even when the worker dies inside it.
 *
 * The seam's own promise -- one block is one transaction, with the sync cursor
 * written inside it (ADR-0027) -- and nothing asserted it on any engine until
 * now. What made it worth asserting is WebKit bug 288682: a terminated worker's
 * half-finished IndexedDB transaction was COMMITTED rather than aborted, which
 * is precisely this shape (every request awaited through a promise) and
 * precisely this trigger. It is fixed upstream. A test is how we stop taking
 * that on trust for every engine and version an application actually meets,
 * rather than for the one on this laptop today.
 *
 * Each iteration is its own DATABASE, killed once, then read back cold. Three
 * facts are recovered per block and they must agree: whether the block record
 * exists, whether the cursor reached it, and whether the rows that belong to
 * that block and no other are there. Any disagreement is a torn commit.
 *
 * ## The other bug gets in the way of measuring this one
 *
 * Killing a worker mid-write is also what can WEDGE the database on WebKit, and
 * at a few percent per kill that lands often across a run. A wedged database
 * answers nothing, so the verification is BOUNDED and a timeout is recorded as
 * `wedged` rather than counted as a torn commit -- the two failures are
 * opposites and must never be confused. `restartsAndResumes.spec.ts` and the
 * finding both describe it.
 */
async function blockAtomicityCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const iterations = Number(params.iterations ?? 10);
	const rowsPerBlock = Number(params.rowsPerBlock ?? 24);
	const patienceMs = Number(params.patienceMs ?? 5000);
	const firstBlock = 100;

	const torn: Record<string, unknown>[] = [];
	const outcomes: string[] = [];
	/** Iterations where the worker died with a block announced and not landed. */
	let killedInside = 0;

	for (let iteration = 0; iteration < iterations; iteration++) {
		const database = `${databaseName(params, 'atomicity')}-${iteration}`;
		const url = new URL(`./worker.js?db=${encodeURIComponent(database)}&rows=${rowsPerBlock}`, import.meta.url);
		const worker = new Worker(url, {type: 'module'});
		let announced = firstBlock - 1;
		let landed = firstBlock - 1;

		try {
			const killed = await new Promise<boolean>((resolve) => {
				const patience = setTimeout(() => resolve(false), patienceMs);
				worker.addEventListener('message', (event) => {
					const said = event.data as {fixture?: string; ready?: boolean; wrote?: string; block?: number};
					if (said?.fixture !== 'atomicity') return;
					if (said.wrote === 'starting' && said.block !== undefined) announced = said.block;
					if (said.wrote === 'landed' && said.block !== undefined) landed = said.block;
					// A few blocks in, so there is committed history behind the torn one,
					// then a RANDOM delay so the kill lands at a different point of the
					// transaction each time rather than at one reproducible instant.
					if (said.wrote === 'starting' && (said.block ?? 0) >= firstBlock + 2) {
						setTimeout(() => {
							clearTimeout(patience);
							worker.terminate();
							resolve(true);
						}, Math.random() * 12);
					}
				});
			});
			if (!killed) {
				outcomes.push('never-started');
				worker.terminate();
				continue;
			}

			// READ IT BACK COLD, on a connection that never saw the worker.
			const checked = await Promise.race([
				readBackBlocks(database, firstBlock, announced, rowsPerBlock),
				new Promise<'wedged'>((resolve) => setTimeout(() => resolve('wedged'), patienceMs)),
			]);
			if (checked === 'wedged') {
				outcomes.push('wedged');
				continue;
			}

			const bad = checked.filter((block) => !block.agrees);
			if (bad.length > 0) torn.push({database, landed, announced, blocks: bad});
			// DID THE KILL LAND INSIDE A TRANSACTION? A kill that always fell between
			// two of them would make every iteration pass while asserting nothing, so
			// the instrument reports its own aim and the spec refuses a run that missed.
			if (announced > landed) killedInside++;
			outcomes.push(bad.length > 0 ? 'TORN' : 'atomic');
		} finally {
			worker.terminate();
		}
	}

	timings.push({label: 'atomicity', ms: 0});
	return {
		iterations,
		outcomes,
		killedInside,
		atomic: outcomes.filter((one) => one === 'atomic').length,
		wedged: outcomes.filter((one) => one === 'wedged').length,
		torn,
	};
}

/** The three facts about each block, from a cold connection. */
async function readBackBlocks(
	database: string,
	firstBlock: number,
	lastAnnounced: number,
	rowsPerBlock: number,
): Promise<{number: number; recorded: boolean; cursorReached: boolean; rows: number; agrees: boolean}[]> {
	const store = (await createBrowserStateStore(processor.entities, {databaseName: database})) as StateStoreBackend & {
		getBlock(n: number): Promise<unknown>;
	};
	const cursor = await store.readCursor('lastSync');
	const reached = cursor ? ((JSON.parse(cursor) as {lastToBlock?: number}).lastToBlock ?? -1) : -1;

	const checked = [];
	for (let number = firstBlock; number <= lastAnnounced; number++) {
		const recorded = (await store.getBlock(number)) !== undefined;
		let rows = 0;
		for (let index = 0; index < rowsPerBlock; index++) {
			if (await store.getCurrent('token', {id: `b${number}-${index}`})) rows++;
		}
		const cursorReached = reached >= number;
		// ALL THREE OR NONE. A block that is recorded must have every one of its rows
		// and a cursor that reached it; a block that is not recorded must have none of
		// its rows and a cursor that stopped below it.
		const whole = recorded && cursorReached && rows === rowsPerBlock;
		const absent = !recorded && !cursorReached && rows === 0;
		checked.push({number, recorded, cursorReached, rows, agrees: whole || absent});
	}
	return checked;
}

/**
 * ONE BEHAVIOUR SUITE, THREE HOSTING SHAPES, IN ONE PAGE.
 *
 * The claim ADR-0082 opens with, checked the only way it can be checked without
 * being checked weakly: `hostingShapes.ts` holds ONE list of cases and it is run
 * three times here, against a dedicated worker, a SharedWorker and
 * `createIndexerState` on this very thread. Three test files that happened to
 * agree would prove nothing, because they drift one edit at a time and each goes
 * on passing.
 *
 * The two worker shapes load the SAME bundle (`indexer.bothShapes.worker.ts`,
 * which picks its entry helper from the scope it finds itself in), and the third
 * loads no bundle at all: the host on this thread is the hook, so the shape is
 * `indexer.mainThreadHost()` and there is nothing to construct.
 *
 * Each folds into a database of its own, because three hosts over one store are
 * three writers and the storage guard is not what is being tested here
 * (ADR-0075). What differs between the three, and all that may differ, is
 * `scope`: WHERE the answering code ran, measured rather than declared.
 */
async function hostingShapesCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const base = databaseName(params, 'hosting-shapes');
	const bundle = (database: string) => new URL(`./worker.js?db=${encodeURIComponent(database)}`, import.meta.url);

	const dedicated = connectToIndexerHost(
		dedicatedWorkerHost(() => new Worker(bundle(`${base}-dedicated`), {type: 'module'})),
	);
	// SUBSCRIBED THE MOMENT THE PORT EXISTS, which is what an app does and is the
	// only moment from which the fold's own notifications can be seen at all: the
	// worker has not booted yet, so nothing has been applied. The cases assert on
	// what this recorded; see `hostingShapes.ts` on why it is the second argument.
	const dedicatedTold = watchStateMoved(dedicated);
	const shared = connectToIndexerHost(
		sharedWorkerHost(
			() => new SharedWorker(bundle(`${base}-shared`), {type: 'module', name: 'etherfold-hosting-shapes'}),
		),
	);
	const sharedTold = watchStateMoved(shared);
	const mainThread = await openOnTheMainThread(`${base}-main`);

	/** The app's own code, which does not know which shape it is talking to. */
	const against = async (port: IndexerPort, told: StateMovedWatch) => {
		const run = await runHostingShapeCases(port, told);
		const progress = await port.progress();
		return {host: progress.host, scope: progress.scope, passed: run.passed, failures: run.failures};
	};

	try {
		return {
			tabScope: executionScopeName(),
			cases: hostingShapeCases.length,
			dedicated: await timed('dedicated-worker', timings, () => against(dedicated, dedicatedTold)),
			shared: await timed('shared-worker', timings, () => against(shared, sharedTold)),
			mainThread: await timed('main-thread', timings, () => against(mainThread.port, mainThread.told)),
		};
	} finally {
		dedicatedTold.close();
		sharedTold.close();
		dedicated.close();
		shared.close();
		mainThread.close();
	}
}

/**
 * WHAT THIS FIXTURE'S WORKER SAID, straight at the page and never over the port.
 *
 * `instance` is the value the whole shared claim rests on: two tabs reporting the
 * same one are attached to ONE host, and a different one after every tab went
 * away is a host the browser started afresh.
 */
type WorkerSaid = {fixture?: string; instance?: string; fetched?: {from: number; to: number}[]};

/**
 * WHERE A HELD FOLD STOPS: the block the shared fixture's gate holds it at.
 *
 * The fixture is fetched four blocks at a time from block 100, so the first
 * advance lands here and the next one is what the gate holds -- which is what
 * gives the lifecycle case a MIDDLE of a fold for a tab to be closed in, rather
 * than a race against five blocks that finish between two polls.
 */
const HELD_AT = 103;

/**
 * THE SHARED WORKERS A PORT CONNECTS TO, newest last.
 *
 * The same shape as `hostedWorkers` above and for the same reasons: the app owns
 * the line that constructs the worker (its URL has to be a literal a bundler can
 * trace, and its NAME is half of a SharedWorker's identity), the PORT owns when
 * that line is called, and the handles are kept because these fixtures reach past
 * the port to post a gate release straight at the host. An application needs
 * none of that.
 *
 * What it CANNOT do, and deliberately, is kill one: a `SharedWorker` has no
 * `terminate()`, because the instance belongs to every tab attached to it.
 */
function hostedSharedWorkers(
	url: URL,
	name: string,
	onBuilt: (worker: SharedWorker) => void = () => undefined,
): {create: () => SharedWorker; latest: () => SharedWorker; built: SharedWorker[]} {
	const built: SharedWorker[] = [];
	const create = () => {
		const worker = new SharedWorker(url, {type: 'module', name});
		onBuilt(worker);
		built.push(worker);
		return worker;
	};
	return {create, latest: () => built[built.length - 1], built};
}

/**
 * THIS TAB'S ATTACHMENT TO THE SHARED HOST, kept between runs.
 *
 * The lifecycle case is two runs of one tab with a PAGE CLOSING in between
 * (`shared-attach`, then `shared-finish` after the other tab has gone), and what
 * it is asserting is that the host survived that -- so the port has to be the
 * same port. Module state survives between `run` calls because they are two
 * `page.evaluate` calls into one loaded page, and a reload would clear it, which
 * is correct: a reloaded tab is a new client that has attached to nothing.
 */
let sharedlyAttached:
	| {
			indexer: IndexerPort;
			workers: ReturnType<typeof hostedSharedWorkers>;
			said: WorkerSaid[];
			pushes: HostProgress[];
	  }
	| undefined;

/** The URL a shared host is loaded from: the same bundle every other case loads. */
function sharedWorkerUrl(database: string, query: Record<string, string | number> = {}): URL {
	const extra = Object.entries(query)
		.map(([key, value]) => `&${key}=${encodeURIComponent(String(value))}`)
		.join('');
	return new URL(`./worker.js?db=${encodeURIComponent(database)}${extra}`, import.meta.url);
}

/** The last thing the host said about itself, and what it had fetched by then. */
function lastSaid(said: WorkerSaid[]): {instance: string | null; fetched: {from: number; to: number}[]} {
	const mine = said.filter((message) => message.fixture === 'shared');
	const last = mine[mine.length - 1];
	return {instance: last?.instance ?? null, fetched: last?.fetched ?? []};
}

/**
 * ONE TAB ATTACHING TO THE SHARED HOST, and everything it can see from there.
 *
 * The page constructs a `SharedWorker` and holds a port, exactly as the dedicated
 * case constructs a `Worker` and holds one. `name` is passed in because it is
 * half of the host's identity: two tabs given the same name and the same URL are
 * two tabs of ONE app, and that is the case this task exists for.
 *
 * It waits for a VALUE and never a duration: the tip, or -- where the spec asked
 * for the fold to be held -- the block the gate holds it at, so that a tab can be
 * closed in the middle of a fold rather than after one.
 */
async function sharedAttachCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = databaseName(params, 'shared-worker');
	const held = params.hold === true;
	const url = sharedWorkerUrl(database, {fetch: 4, ...(held ? {holdAbove: HELD_AT} : {})});
	const said: WorkerSaid[] = [];
	const workers = hostedSharedWorkers(url, (params.name as string) ?? 'etherfold-indexer', (worker) =>
		worker.port.addEventListener('message', (event) => said.push(event.data as WorkerSaid)),
	);

	const indexer = connectToIndexerHost(sharedWorkerHost(workers.create));
	const pushes: HostProgress[] = [];
	indexer.onProgress((progress) => pushes.push(progress));
	sharedlyAttached = {indexer, workers, said, pushes};

	const progress = held
		? await timed('fold-to-the-hold', timings, () => until(indexer, (value) => value.lastToBlock === HELD_AT))
		: await timed('fold-in-a-shared-worker', timings, () => untilAtTip(indexer));
	const {instance, fetched} = lastSaid(said);

	return {
		// WHERE the answer was computed, measured in the answering context
		scope: progress.scope,
		tabScope: executionScopeName(),
		host: progress.host,
		// WHICH host: the fixture's own evidence that two tabs reached one of them
		instance,
		fetched,
		indexing: progress.indexing,
		phase: progress.phase,
		lastToBlock: progress.lastToBlock,
		latestBlock: progress.latestBlock,
		// what this tab was PUSHED, unprompted, from a context that is not the UI thread
		phases: pushes.map((push) => push.phase).filter((phase, index, all) => phase !== all[index - 1]),
		transfers: await transfersAcrossThePort(indexer),
		portSurface: Object.keys(indexer).sort(),
	};
}

/**
 * THE TAB THAT STAYED, carrying the fold to the tip after the other one went
 * away.
 *
 * The gate is released from HERE, which is the point: the tab that closed is gone,
 * and the host it was talking to is still there to be told something and still
 * folding for whoever is left.
 */
async function sharedFinishCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const attached = sharedlyAttached;
	if (!attached) throw new Error(`this tab is not attached to a shared host, so there is nothing to finish`);
	const database = databaseName(params, 'shared-worker');

	attached.workers.latest().port.postMessage({fixture: 'release', gate: 'fetches'});
	const progress = await timed('fold-to-the-tip', timings, () => untilAtTip(attached.indexer));
	const {instance, fetched} = lastSaid(attached.said);

	const state = await timed('read-back', timings, async () =>
		readState(
			new EntityStateView(
				openForReading(
					await createBrowserStateStore(processor.entities, {
						databaseName: `${database}-${(params.name as string) ?? 'etherfold-indexer'}`,
					}),
				),
			),
		),
	);

	return {
		scope: progress.scope,
		host: progress.host,
		// the SAME host as before the other tab closed, or this claim is not the claim
		instance,
		fetched,
		indexing: progress.indexing,
		lastToBlock: progress.lastToBlock,
		latestBlock: progress.latestBlock,
		phases: attached.pushes.map((push) => push.phase).filter((phase, index, all) => phase !== all[index - 1]),
		transfers: await transfersAcrossThePort(attached.indexer),
		state,
	};
}

/**
 * ONE ENTRY POINT, BOTH SHAPES, AND ONE PIECE OF APP CODE RUN AGAINST EACH.
 *
 * `whatAnAppSees` is written once and run twice, which is the criterion stated as
 * code: an app that moves from a dedicated worker to a shared one changes the
 * ARGUMENT it passes to `connectToIndexerHost` and nothing else. Both hosts are
 * built from the SAME bundle (`indexer.bothShapes.worker.ts`, loaded once as a
 * `Worker` and once as a `SharedWorker`), so what runs inside them is not merely
 * equivalent -- it is the same file.
 *
 * Each folds into a database of its own, because two hosts over one store are two
 * writers and the storage guard is not what is being tested here (ADR-0075).
 */
async function sharedBothShapesCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const shared = connectToIndexerHost(
		sharedWorkerHost(
			() =>
				new SharedWorker(sharedWorkerUrl(databaseName(params, 'both-shapes-shared')), {
					type: 'module',
					name: 'both-shapes',
				}),
		),
	);
	const dedicated = connectToIndexerHost(
		dedicatedWorkerHost(
			() => new Worker(sharedWorkerUrl(databaseName(params, 'both-shapes-dedicated')), {type: 'module'}),
		),
	);

	/** The app's own code, which does not know which shape it is talking to. */
	const whatAnAppSees = async (indexer: IndexerPort) => {
		const progress = await untilAtTip(indexer);
		return {
			host: progress.host,
			scope: progress.scope,
			seen: {
				indexing: progress.indexing,
				phase: progress.phase,
				lastToBlock: progress.lastToBlock,
				latestBlock: progress.latestBlock,
				blocksBehindTip: progress.blocksBehindTip,
				syncPercentage: progress.syncPercentage,
				transfers: await transfersAcrossThePort(indexer),
				generations: (await indexer.generations()).length,
				promotion: (await indexer.promotion()).policy,
				inclusion: (await indexer.checkTxInclusion([{txHash: txInBlock(104)}]))[txInBlock(104)].status,
				stopped: (await indexer.stopIndexing()).indexing,
				started: (await indexer.startIndexing()).indexing,
				surface: Object.keys(indexer).sort(),
			},
		};
	};

	try {
		return {
			tabScope: executionScopeName(),
			shared: await timed('shared', timings, () => whatAnAppSees(shared)),
			dedicated: await timed('dedicated', timings, () => whatAnAppSees(dedicated)),
		};
	} finally {
		shared.close();
		dedicated.close();
	}
}

/**
 * A SECOND APP ON ONE ORIGIN, WITH NOTHING CONFIGURED TO KEEP THEM APART.
 *
 * A SharedWorker is identified by its SCRIPT URL plus its NAME, so a second name
 * is a second host -- the same scoping the writer guard arrives at from the
 * storage side (ADR-0075). It is a PROPERTY to verify rather than a mechanism to
 * build: nothing in this package implements it, and this case is here because
 * checking it is free.
 *
 * The two hosts fold into different databases, because the fixture entry derives
 * its database from `self.name`; so this also shows the consequence that matters,
 * which is that two apps sharing a bundle do not contend for one store.
 */
async function sharedOtherAppCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = databaseName(params, 'shared-worker');
	const said: WorkerSaid[] = [];
	const workers = hostedSharedWorkers(
		// THE SAME SCRIPT URL as the two tabs above, down to the query string.
		sharedWorkerUrl(database, {fetch: 4}),
		(params.name as string) ?? 'another-app',
		(worker) => worker.port.addEventListener('message', (event) => said.push(event.data as WorkerSaid)),
	);
	const indexer = connectToIndexerHost(sharedWorkerHost(workers.create));
	try {
		const progress = await timed('fold-in-another-host', timings, () => untilAtTip(indexer));
		return {
			scope: progress.scope,
			host: progress.host,
			instance: lastSaid(said).instance,
			lastToBlock: progress.lastToBlock,
			transfers: await transfersAcrossThePort(indexer),
		};
	} finally {
		indexer.close();
	}
}

/**
 * A RUNTIME WITHOUT SHAREDWORKER IS TOLD, rather than failing obscurely.
 *
 * Every engine this harness runs has one, so the absence is staged: the
 * constructor is taken off this page's global for the length of the call, which
 * is what an app on an engine without it sees. What is asserted is the SENTENCE,
 * because the sentence is the feature -- and that nothing falls back on its own,
 * since the shape decides how many writers an app has.
 */
async function sharedUnsupportedCase(): Promise<Record<string, unknown>> {
	const scope = globalThis as {SharedWorker?: unknown};
	const constructor = scope.SharedWorker;
	delete scope.SharedWorker;
	try {
		sharedWorkerHost(() => undefined as never);
		return {refused: false, message: null};
	} catch (error) {
		return {refused: true, message: (error as Error).message};
	} finally {
		scope.SharedWorker = constructor;
	}
}

/* ---------------------------------------------------------------------------
 * A READER TAB LEARNING FROM THE INDEXING TAB.
 *
 * Three pages, three hosts, two databases, and one `BroadcastChannel` per tab
 * per store. The thing that cannot be arranged between two objects is the whole
 * of it: the tab that re-reads holds NO port to the host that folded, so the
 * only way it can know is the channel.
 * ------------------------------------------------------------------------- */

/** The two stores this case uses: the one both tabs are about, and the app next door. */
function crossTabDatabases(params: Params): {here: string; nextDoor: string} {
	return {here: databaseName(params, 'cross-tab'), nextDoor: databaseName(params, 'cross-tab-next-door')};
}

/** One thing a tab was told, flattened to what a committed result can carry. */
type ToldOf = {kind: string; block: number; coherence: string; entities: string[]; generation: string};

const toldOf = (moved: StateMoved): ToldOf => ({
	kind: moved.kind,
	block: moved.kind === 'applied' ? moved.block : moved.forkPoint,
	coherence: moved.coherence,
	entities: moved.kind === 'applied' ? [...moved.entities] : [],
	generation: moved.generation,
});

/**
 * WHAT THIS TAB WAS TOLD BY THE OTHERS, and what it read BECAUSE it was told.
 *
 * The re-read is inside the listener and NOWHERE ELSE, which is the claim stated
 * as code: there is no interval in this tab, so a row it renders that is up to
 * date is a row a notification fetched. The reads are chained rather than raced,
 * so what the last one holds is what the last notification asked for.
 */
function whatThisTabWasTold(tabs: StateMovedAcrossTabs, reread?: () => Promise<unknown>) {
	const heard: StateMoved[] = [];
	const reads: {block: number; state: unknown}[] = [];
	const waiting: {matches: (moved: StateMoved) => boolean; resolve: () => void}[] = [];
	let queue: Promise<unknown> = Promise.resolve();
	const stop = tabs.onStateMoved((moved) => {
		heard.push(moved);
		if (reread) {
			queue = queue.then(async () => reads.push({block: toldOf(moved).block, state: await reread()}));
		}
		for (const waiter of [...waiting]) {
			if (waiter.matches(moved)) {
				waiting.splice(waiting.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
	});
	return {
		heard,
		reads,
		stop,
		told: () => heard.map(toldOf),
		/** Settle the re-reads this tab has already been asked for. */
		settled: () => queue,
		/**
		 * Wait for a NOTIFICATION and never for a duration. The bound is a failure
		 * bound: a tab that was never told has to fail saying so rather than hang.
		 */
		until(matches: (moved: StateMoved) => boolean, withinMs = 30_000): Promise<void> {
			if (heard.some(matches)) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const patience = setTimeout(
					() => reject(new Error(`this tab was never told: ${JSON.stringify(heard.map(toldOf))}`)),
					withinMs,
				);
				waiting.push({
					matches,
					resolve: () => {
						clearTimeout(patience);
						resolve();
					},
				});
			});
		},
	};
}

/**
 * THE READER TAB, kept between its own runs.
 *
 * Its own host, the two channels it listens on (this store's, and the app next
 * door's), the reader handle it re-reads through, and the listener that attached
 * LATE. Module state for the reason the shared-worker attach/finish pair uses it:
 * the spec drives the other tabs in between, and a reader that re-subscribed each
 * run would be a tab that missed exactly what is being asserted.
 */
let readerTab:
	| {
			port: IndexerPort;
			published: StateMoved[];
			here: StateMovedAcrossTabs;
			nextDoor: StateMovedAcrossTabs;
			early: ReturnType<typeof whatThisTabWasTold>;
			fromNextDoor: ReturnType<typeof whatThisTabWasTold>;
			late?: ReturnType<typeof whatThisTabWasTold>;
			read: () => Promise<unknown>;
	  }
	| undefined;

function theReaderTab() {
	if (!readerTab) throw new Error(`this tab is not listening to the other tabs, so there is nothing to report`);
	return readerTab;
}

/**
 * THE READER TAB OPENS ITS EARS -- and its own host, which is the shape this case
 * exists to be about.
 *
 * This tab holds a dedicated worker of its OWN over the SAME database as the tab
 * that will do the indexing, so it is not a tab being pushed to by the host that
 * folds (that is the shared-worker case, one layer up and a different claim). Its
 * host is held at its very first fetch, so which tab indexes is decided by this
 * fixture rather than by a race: this one claims the store first and then folds
 * nothing, the writer's host claims it next and folds everything. What the writer
 * token already guarantees about two hosts over one store is not rebuilt here
 * (ADR-0075); it is what this case stands on.
 *
 * It listens on TWO channels: this store's, and the one belonging to the app next
 * door. The second is what makes the negative half non-vacuous -- "heard nothing"
 * is only worth asserting where something was demonstrably being said.
 *
 * It also PUBLISHES what its own host tells it, because that is what every tab
 * does until an election exists: every indexing tab publishes, every tab listens.
 * This one's fold applies nothing, so what it publishes is nothing.
 */
async function crossTabReaderListenCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const databases = crossTabDatabases(params);
	const workers = hostedWorkers(
		// HELD AT THE FIRST FETCH: this host opens its container, claims the store and
		// then folds nothing, so the tab that indexes is the other one.
		new URL(`./worker.js?db=${encodeURIComponent(databases.here)}&fetch=4&holdAbove=99`, import.meta.url),
	);
	const port = connectToIndexerHost(dedicatedWorkerHost(workers.create));

	const here = openStateMovedAcrossTabs({databaseName: databases.here});
	const nextDoor = openStateMovedAcrossTabs({databaseName: databases.nextDoor});
	// The reader handle an app holds: the same database, opened for READING, with
	// the writer's claim untouched.
	const view = new EntityStateView(
		openForReading(await createBrowserStateStore(processor.entities, {databaseName: databases.here})),
	);
	const read = () => readState(view);
	const early = whatThisTabWasTold(here, read);
	const fromNextDoor = whatThisTabWasTold(nextDoor);
	const published: StateMoved[] = [];
	port.onStateMoved((moved) => {
		published.push(moved);
		here.publish(moved);
	});
	readerTab = {port, published, here, nextDoor, early, fromNextDoor, read};

	// ITS HOST IS REALLY RUNNING: loaded, holding the store, and about to ask for a
	// range it will never be given. Waited for so that the writer's host claims the
	// store AFTER this one rather than racing it.
	const progress = await timed('reader-host-loaded', timings, () =>
		until(port, (value) => value.phase === 'catching-up'),
	);

	return {
		tabScope: executionScopeName(),
		// WHERE this tab's own host runs, and that it is its own
		scope: progress.scope,
		host: progress.host,
		phase: progress.phase,
		// the channel names, composed from the STORAGE and nothing else
		channel: here.channelName,
		nextDoorChannel: nextDoor.channelName,
		// what this tab has been told so far, which is nothing: no fold has published
		told: early.told(),
		stateBeforeAnyNotification: await read(),
	};
}

/**
 * THE APP NEXT DOOR: another tab, another host, another store, on this origin.
 *
 * It folds the same fixture to the tip and publishes exactly as the indexing tab
 * does. Nothing keeps it away from the reader tab except the SCOPE of the
 * channel, which is the storage identity it folds into -- the same rule the
 * writer token settles by living inside the store it guards.
 */
async function crossTabNextDoorCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const databases = crossTabDatabases(params);
	const workers = hostedWorkers(
		new URL(`./worker.js?db=${encodeURIComponent(databases.nextDoor)}&fetch=4`, import.meta.url),
	);
	const port = connectToIndexerHost(dedicatedWorkerHost(workers.create));
	const tabs = openStateMovedAcrossTabs({databaseName: databases.nextDoor});
	const published: StateMoved[] = [];
	const forwarding = port.onStateMoved((moved) => {
		published.push(moved);
		tabs.publish(moved);
	});
	try {
		const progress = await timed('fold-next-door', timings, () => untilAtTip(port));
		return {
			scope: progress.scope,
			host: progress.host,
			channel: tabs.channelName,
			lastToBlock: progress.lastToBlock,
			transfers: await transfersAcrossThePort(port),
			published: published.map(toldOf),
		};
	} finally {
		forwarding();
		tabs.close();
		port.close();
	}
}

/**
 * THE READER TAB, AFTER THE APP NEXT DOOR FOLDED A WHOLE CHAIN.
 *
 * It waits until the next door channel has carried that fold's last block, which
 * is what makes the silence on ITS OWN channel a fact rather than a race, and
 * then reports both.
 */
async function crossTabReaderQuietCase(): Promise<Record<string, unknown>> {
	const tab = theReaderTab();
	await tab.fromNextDoor.until((moved) => moved.kind === 'applied' && moved.block === 104);
	return {
		// heard NEXT DOOR: a whole fold, so the channel works and the tab is listening
		nextDoor: tab.fromNextDoor.told(),
		// heard about THIS store: nothing, because nothing has folded into it
		told: tab.early.told(),
		read: tab.early.reads.length,
	};
}

/**
 * THE INDEXING TAB, HELD HALF WAY.
 *
 * Its own dedicated worker over the SAME database the reader tab is reading, and
 * it takes the store from the reader tab's host by claiming it second (ADR-0075).
 * The fold is gated at block 103 so that a reader can attach in the MIDDLE of it
 * and miss what came before, which is the case "converges on the next
 * notification" is about.
 */
async function crossTabWriterStartCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const databases = crossTabDatabases(params);
	const workers = hostedWorkers(
		new URL(`./worker.js?db=${encodeURIComponent(databases.here)}&fetch=4&holdAbove=103`, import.meta.url),
	);
	const port = connectToIndexerHost(dedicatedWorkerHost(workers.create));
	const tabs = openStateMovedAcrossTabs({databaseName: databases.here});
	const published: StateMoved[] = [];
	// THE WHOLE OF THE WIRING an app writes in the tab that holds a host: what it is
	// told, the other tabs are told.
	port.onStateMoved((moved) => {
		published.push(moved);
		tabs.publish(moved);
	});
	writingTab = {port, tabs, workers, published};

	const progress = await timed('fold-to-the-hold', timings, () => until(port, (value) => value.lastToBlock === 103));
	return {
		tabScope: executionScopeName(),
		scope: progress.scope,
		host: progress.host,
		channel: tabs.channelName,
		phase: progress.phase,
		lastToBlock: progress.lastToBlock,
		published: published.map(toldOf),
	};
}

/**
 * A LISTENER THAT ARRIVES HALF WAY THROUGH, which is the tab that missed
 * something.
 *
 * Nothing is replayed to it -- the producer holds nothing per receiving tab
 * (ADR-0083) -- so what it holds at this moment is the evidence, and what repairs
 * it is the next notification.
 */
async function crossTabReaderLateCase(): Promise<Record<string, unknown>> {
	const tab = theReaderTab();
	const late = whatThisTabWasTold(tab.here, tab.read);
	readerTab = {...tab, late};
	await tab.early.settled();
	return {
		// what the tab listening THROUGHOUT has been told, and read because of it
		told: tab.early.told(),
		reads: tab.early.reads,
		// ...and what the listener that just attached holds: nothing at all
		lateTold: late.told(),
	};
}

/** THE INDEXING TAB FINISHES: the gate is released and the fold reaches the tip. */
async function crossTabWriterFinishCase(_params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const tab = writingTab;
	if (!tab) throw new Error(`this tab holds no host, so there is no fold to finish`);
	tab.workers.latest().postMessage({fixture: 'release', gate: 'fetches'});
	const progress = await timed('fold-to-the-tip', timings, () => untilAtTip(tab.port));
	return {
		scope: progress.scope,
		host: progress.host,
		lastToBlock: progress.lastToBlock,
		latestBlock: progress.latestBlock,
		// what the tab that DID the indexing renders, read through its own port
		transfers: await transfersAcrossThePort(tab.port),
		// every notification this tab forwarded, in order
		published: tab.published.map(toldOf),
	};
}

/**
 * THE READER TAB REPORTS: what it was told, what it read because of it, and what
 * it never heard.
 *
 * It waits for the LATE listener to be told about block 104 -- the notification
 * it did not miss -- and the state it reads then is the whole of the writer's
 * fold, including the blocks nobody told it about.
 */
async function crossTabReaderReportCase(): Promise<Record<string, unknown>> {
	const tab = theReaderTab();
	const late = tab.late;
	if (!late) throw new Error(`no listener attached late, so there is nothing to converge`);
	try {
		await late.until((moved) => moved.kind === 'applied' && moved.block === 104);
		await Promise.all([tab.early.settled(), late.settled()]);
		return {
			tabScope: executionScopeName(),
			channel: tab.here.channelName,
			// EVERYTHING this tab was told about this store, and nothing about the one
			// next door
			told: tab.early.told(),
			reads: tab.early.reads,
			// the listener that attached half way through: what it missed, what it was
			// told, and what it read when it was
			lateTold: late.told(),
			lateReads: late.reads,
			// what the app next door said, on its own channel, throughout
			nextDoor: tab.fromNextDoor.told(),
			// this tab published nothing: its own host folded nothing
			published: tab.published.map(toldOf),
			// what it renders now, read through the handle it has held all along
			state: await tab.read(),
			// how far its OWN host got, which is nowhere
			ownHostLastToBlock: (await tab.port.progress()).lastToBlock ?? null,
		};
	} finally {
		late.stop();
		tab.early.stop();
		tab.fromNextDoor.stop();
		tab.here.close();
		tab.nextDoor.close();
		tab.port.close();
		readerTab = undefined;
	}
}

/* ---------------------------------------------------------------------------
 * SYNC PROGRESS RIDING THAT SAME SIGNAL TO A READER TAB.
 *
 * "Syncing, 400 blocks behind", rendered in tabs that are not the one folding.
 * The tab with a host is told over its PORT (ADR-0082, untouched by any of
 * this); a reader tab has no host to ask and cannot work it out, because the
 * cursor is opaque behind the storage seam (ADR-0027). So the tab that knows
 * publishes, on the one channel a reader already listens to.
 * ------------------------------------------------------------------------- */

/** The store this case is about. Its own, so the fold here is the only thing moving in it. */
const progressDatabase = (params: Params) => databaseName(params, 'progress-cross-tab');

/** One report, flattened to what a committed result can carry. */
type ProgressOf = {
	host: string;
	scope: string;
	phase: string;
	lastToBlock: number | null;
	latestBlock: number | null;
	blocksBehindTip: number | null;
	syncPercentage: number | null;
};

const progressOf = (progress: HostProgress): ProgressOf => ({
	host: progress.host,
	scope: progress.scope,
	phase: progress.phase,
	lastToBlock: progress.lastToBlock ?? null,
	latestBlock: progress.latestBlock ?? null,
	blocksBehindTip: progress.blocksBehindTip ?? null,
	syncPercentage: progress.syncPercentage ?? null,
});

/** The SENTENCE an app puts on screen, from the last thing a tab was told. */
const renders = (progress: HostProgress | undefined): string =>
	!progress
		? 'nothing yet'
		: progress.phase === 'at-tip'
			? 'live'
			: `syncing, ${progress.blocksBehindTip ?? '?'} blocks behind`;

/**
 * WHAT THIS TAB WAS TOLD ABOUT WHERE THE FOLD IS, and what it would put on
 * screen.
 *
 * The re-render is not simulated: `createProgressReadable` is the helper this
 * package ships for exactly this, and it binds to the cross-tab end the same way
 * it binds to a port -- which is the claim, so it is what the fixture uses.
 */
function whatThisTabRenders(tabs: StateMovedAcrossTabs) {
	const heard: HostProgress[] = [];
	const waiting: {matches: (progress: HostProgress) => boolean; resolve: () => void}[] = [];
	const view = createProgressReadable(tabs);
	const stop = tabs.onProgress((progress) => {
		heard.push(progress);
		for (const waiter of [...waiting]) {
			if (waiter.matches(progress)) {
				waiting.splice(waiting.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
	});
	return {
		heard,
		stop: () => {
			stop();
			view.close();
		},
		told: () => heard.map(progressOf),
		/** What the SHIPPED helper holds, which is what a progress bar is bound to. */
		rendered: () => renders(view.$state),
		heldByTheHelper: () => (view.$state ? progressOf(view.$state) : null),
		/** The helper holds the last report BY REFERENCE: a view, never a value it assembled. */
		holdsTheLastOneByReference: () => view.$state === heard[heard.length - 1],
		/** Wait for a REPORT and never for a duration; the bound is a failure bound. */
		until(matches: (progress: HostProgress) => boolean, withinMs = 30_000): Promise<void> {
			if (heard.some(matches)) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const patience = setTimeout(
					() =>
						reject(new Error(`this tab was never told where the fold is: ${JSON.stringify(heard.map(progressOf))}`)),
					withinMs,
				);
				waiting.push({
					matches,
					resolve: () => {
						clearTimeout(patience);
						resolve();
					},
				});
			});
		},
	};
}

/** A READER TAB in this case, kept between its own runs. See `readerTab` for why module state. */
let progressReaderTab:
	| {
			tabs: StateMovedAcrossTabs;
			rendering: ReturnType<typeof whatThisTabRenders>;
			/** Its OWN host, where it has one: a second reader tab deliberately has none. */
			port?: IndexerPort;
	  }
	| undefined;

function theProgressReaderTab() {
	if (!progressReaderTab) throw new Error(`this tab is not listening for progress, so there is nothing to report`);
	return progressReaderTab;
}

/**
 * A READER TAB WITH A HOST OF ITS OWN, which is the sharpest version of the
 * case.
 *
 * Its host is HELD at its very first fetch, so it holds the store, folds nothing
 * and can therefore only report a standstill. That is the point: this tab COULD
 * ask a host and the answer would be wrong, so what it renders has to come from
 * the tab that is doing the work. It publishes nothing itself -- progress is
 * published by the tab whose fold is moving, and a held host broadcasting its own
 * standstill is exactly the pre-election noise `one-tab-indexes-and-the-others-read`
 * removes.
 */
async function progressReaderWithAHostCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = progressDatabase(params);
	const workers = hostedWorkers(
		new URL(`./worker.js?db=${encodeURIComponent(database)}&fetch=4&holdAbove=99`, import.meta.url),
	);
	const port = connectToIndexerHost(dedicatedWorkerHost(workers.create));
	const tabs = openStateMovedAcrossTabs({databaseName: database});
	const rendering = whatThisTabRenders(tabs);
	progressReaderTab = {tabs, rendering, port};

	// ITS OWN HOST IS REALLY RUNNING, and waited for so that the indexing tab's host
	// claims the store AFTER this one rather than racing it (ADR-0075).
	const own = await timed('reader-host-loaded', timings, () => until(port, (value) => value.phase === 'catching-up'));

	return {
		tabScope: executionScopeName(),
		channel: tabs.channelName,
		// what its OWN host says, which is a standstill and not the fold's position
		ownHost: progressOf(own),
		// ...and what the channel has told it, which is nothing: no fold has published
		told: rendering.told(),
		rendered: rendering.rendered(),
	};
}

/**
 * A READER TAB WITH NO HOST AT ALL: a window that only renders.
 *
 * The ordinary shape of the story once one tab indexes -- it holds no port, no
 * container and no provider, so the channel is the only thing in this document
 * that could know where the fold is.
 */
async function progressReaderWithNoHostCase(params: Params): Promise<Record<string, unknown>> {
	const database = progressDatabase(params);
	const tabs = openStateMovedAcrossTabs({databaseName: database});
	const rendering = whatThisTabRenders(tabs);
	progressReaderTab = {tabs, rendering};
	return {
		tabScope: executionScopeName(),
		channel: tabs.channelName,
		told: rendering.told(),
		rendered: rendering.rendered(),
	};
}

/**
 * THE INDEXING TAB: the only tab here that holds a host that is folding, and the
 * only one that publishes.
 *
 * The whole of the wiring an app writes is the one line below. The fold is gated
 * at block 103 so the reader tabs can be asserted on MID-FLIGHT, where
 * `blocksBehindTip` is a number somebody would put on a screen rather than zero.
 */
async function progressWriterStartCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = progressDatabase(params);
	const workers = hostedWorkers(
		new URL(`./worker.js?db=${encodeURIComponent(database)}&fetch=4&holdAbove=103`, import.meta.url),
	);
	const port = connectToIndexerHost(dedicatedWorkerHost(workers.create));
	const tabs = openStateMovedAcrossTabs({databaseName: database});
	const published: HostProgress[] = [];
	const movedPublished: StateMoved[] = [];
	// THE TWO LINES a tab with a host writes, onto ONE channel: where the fold is,
	// and what it just did.
	port.onProgress((progress) => {
		published.push(progress);
		tabs.publishProgress(progress);
	});
	port.onStateMoved((moved) => {
		movedPublished.push(moved);
		tabs.publish(moved);
	});
	progressWritingTab = {port, tabs, workers, published, movedPublished};

	const held = await timed('fold-to-the-hold', timings, () => until(port, (value) => value.lastToBlock === 103));
	return {
		tabScope: executionScopeName(),
		channel: tabs.channelName,
		scope: held.scope,
		host: held.host,
		lastToBlock: held.lastToBlock,
		// every report this tab has forwarded so far, in order
		published: published.map(progressOf),
		rendered: renders(published[published.length - 1]),
	};
}

/** THE INDEXING TAB FINISHES: the gate is released and the fold reaches the tip. */
async function progressWriterFinishCase(_params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const tab = progressWritingTab;
	if (!tab) throw new Error(`this tab holds no host, so there is no fold to finish`);
	tab.workers.latest().postMessage({fixture: 'release', gate: 'fetches'});
	const done = await timed('fold-to-the-tip', timings, () => untilAtTip(tab.port));
	return {
		scope: done.scope,
		host: done.host,
		lastToBlock: done.lastToBlock,
		latestBlock: done.latestBlock,
		// WHAT THE TAB DOING THE WORK RENDERS, from its own port
		rendered: renders(done),
		atTip: progressOf(done),
		published: tab.published.map(progressOf),
		// the notifications on the same channel, to show one channel carrying both
		movedBlocks: tab.movedPublished.map((moved) => (moved.kind === 'applied' ? moved.block : moved.forkPoint)),
	};
}

/** WHAT A READER TAB HAS BEEN TOLD so far, waited for as a VALUE. */
async function progressReaderReportCase(params: Params): Promise<Record<string, unknown>> {
	const tab = theProgressReaderTab();
	const awaited = params.until as {lastToBlock?: number; phase?: string};
	await tab.rendering.until(
		(progress) =>
			(awaited.lastToBlock === undefined || progress.lastToBlock === awaited.lastToBlock) &&
			(awaited.phase === undefined || progress.phase === awaited.phase),
	);
	const own = tab.port ? progressOf(await tab.port.progress()) : null;
	return {
		tabScope: executionScopeName(),
		told: tab.rendering.told(),
		rendered: tab.rendering.rendered(),
		heldByTheHelper: tab.rendering.heldByTheHelper(),
		holdsTheLastOneByReference: tab.rendering.holdsTheLastOneByReference(),
		// where this tab's OWN host is, where it has one: nowhere, which is why the
		// channel is the only honest source
		ownHost: own,
	};
}

/** A READER TAB IS DONE: release everything it held. */
async function progressReaderDoneCase(): Promise<Record<string, unknown>> {
	const tab = theProgressReaderTab();
	const told = tab.rendering.told();
	tab.rendering.stop();
	tab.tabs.close();
	tab.port?.close();
	progressReaderTab = undefined;
	return {told};
}

/**
 * A TAB OPENED AFTER THE FOLD WENT QUIET, which is the case an ask exists for.
 *
 * A host at the tip pushes nothing, so there is no next push for this tab to
 * wait for: if attaching did not ask, this window would render "nothing yet"
 * until the chain moved -- which on a quiet chain is hours.
 */
async function progressNewcomerCase(params: Params, timings: Timing[]): Promise<Record<string, unknown>> {
	const database = progressDatabase(params);
	const tabs = openStateMovedAcrossTabs({databaseName: database});
	const rendering = whatThisTabRenders(tabs);
	try {
		await timed('answered-by-the-tab-that-knows', timings, () => rendering.until(() => true));
		return {
			tabScope: executionScopeName(),
			channel: tabs.channelName,
			// ONE report, and it is where the fold IS: nothing is replayed, so a tab that
			// missed a hundred of them is handed the hundredth and not the hundred
			told: rendering.told(),
			rendered: rendering.rendered(),
		};
	} finally {
		rendering.stop();
		tabs.close();
	}
}

/** THE INDEXING TAB's host and channel for the PROGRESS case, kept between its runs. */
let progressWritingTab:
	| {
			port: IndexerPort;
			tabs: StateMovedAcrossTabs;
			workers: ReturnType<typeof hostedWorkers>;
			published: HostProgress[];
			movedPublished: StateMoved[];
	  }
	| undefined;

/** THE INDEXING TAB is done: release the host and the channel. */
async function progressWriterDoneCase(): Promise<Record<string, unknown>> {
	const tab = progressWritingTab;
	if (!tab) throw new Error(`this tab holds no host, so there is nothing to release`);
	tab.tabs.close();
	tab.port.close();
	progressWritingTab = undefined;
	return {closed: true};
}

/** THE INDEXING TAB's host and channel, kept between its two runs. See `readerTab`. */
let writingTab:
	| {
			port: IndexerPort;
			tabs: StateMovedAcrossTabs;
			workers: ReturnType<typeof hostedWorkers>;
			published: StateMoved[];
	  }
	| undefined;

/** Ask until the host's own report says what a case is waiting for. */
async function until(
	indexer: IndexerPort,
	matches: (progress: HostProgress) => boolean,
	attempts = 600,
): Promise<HostProgress> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const progress = await indexer.progress();
		if (progress.failure) {
			throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
		}
		if (matches(progress)) return progress;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`the host never got there: ${JSON.stringify(await indexer.progress())}`);
}

/** The counter, read THROUGH THE PORT: whatever the canonical generation says it is. */
async function transfersAcrossThePort(indexer: IndexerPort): Promise<number | null> {
	const row = (await indexer.reads.getCurrent('counter', {name: 'transfers'})) as {value?: number} | undefined;
	return row?.value ?? null;
}

/**
 * Ask the generation list until the pointer has moved to `stream`, and answer
 * with what the list said.
 *
 * A VALUE and never a duration: the promotion has happened when the host says
 * the generation is canonical.
 */
async function untilPromoted(
	indexer: IndexerPort,
	stream: string,
	attempts = 600,
): Promise<{generations: unknown; incumbent: string | undefined}> {
	const first = await indexer.generations();
	const incumbent = first.find((generation) => generation.canonical)?.record.stream;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const generations = await indexer.generations();
		const canonical = generations.find((generation) => generation.canonical);
		if (canonical?.record.stream === stream) {
			return {
				incumbent,
				generations: generations.map((generation) => ({
					canonical: generation.canonical,
					follows: generation.follows,
					lastToBlock: generation.lastToBlock ?? null,
					blocksBehind: generation.blocksBehind ?? null,
				})),
			};
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`the reconfigured generation was never promoted: ${JSON.stringify(await indexer.generations())}`);
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
	let progress = await asking(indexer);
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (progress?.failure) {
			throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
		}
		if (progress && progress.latestBlock === BRANCH_A_TIP && progress.lastToBlock === progress.latestBlock) {
			return progress;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
		progress = await asking(indexer);
	}
	throw new Error(`the fold did not reach the tip: ${JSON.stringify(progress)}`);
}

/**
 * How far the fold has got, or NOTHING while the port holds no host.
 *
 * A call made between a death and the restart that answers it is refused rather
 * than held (ADR-0082), which is the behaviour a waiting loop has to expect and
 * not a failure: the host is moments away, exactly as it is while one is still
 * opening. Any other refusal is still a refusal and is raised.
 */
async function asking(indexer: IndexerPort): Promise<HostProgress | undefined> {
	try {
		return await indexer.progress();
	} catch (error) {
		if ((error as Error)?.name === 'IndexerHostDiedError') return undefined;
		throw error;
	}
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
					case 'tx-inclusion-from-the-tab':
						results = await txInclusionCase(ctx.params, timings);
						break;
					case 'reads-across-the-port':
						results = await readsAcrossThePortCase(ctx.params, timings);
						break;
					case 'progress-pushed-from-the-worker':
						results = await progressPushedCase(ctx.params, timings);
						break;
					case 'controls-the-indexer':
						results = await controlsTheIndexerCase(ctx.params, timings);
						break;
					case 'hosting-shapes':
						results = await hostingShapesCase(ctx.params, timings);
						break;
					case 'restarts-and-resumes':
						results = await restartsAndResumesCase(ctx.params, timings);
						break;
					case 'block-atomicity':
						results = await blockAtomicityCase(ctx.params, timings);
						break;
					case 'cross-tab-reader-listen':
						results = await crossTabReaderListenCase(ctx.params, timings);
						break;
					case 'cross-tab-nextdoor-fold':
						results = await crossTabNextDoorCase(ctx.params, timings);
						break;
					case 'cross-tab-reader-quiet':
						results = await crossTabReaderQuietCase();
						break;
					case 'cross-tab-writer-start':
						results = await crossTabWriterStartCase(ctx.params, timings);
						break;
					case 'cross-tab-reader-late':
						results = await crossTabReaderLateCase();
						break;
					case 'cross-tab-writer-finish':
						results = await crossTabWriterFinishCase(ctx.params, timings);
						break;
					case 'cross-tab-reader-report':
						results = await crossTabReaderReportCase();
						break;
					case 'sync-progress-reader-with-a-host':
						results = await progressReaderWithAHostCase(ctx.params, timings);
						break;
					case 'sync-progress-reader-with-no-host':
						results = await progressReaderWithNoHostCase(ctx.params);
						break;
					case 'sync-progress-writer-start':
						results = await progressWriterStartCase(ctx.params, timings);
						break;
					case 'sync-progress-writer-finish':
						results = await progressWriterFinishCase(ctx.params, timings);
						break;
					case 'sync-progress-writer-done':
						results = await progressWriterDoneCase();
						break;
					case 'sync-progress-reader-report':
						results = await progressReaderReportCase(ctx.params);
						break;
					case 'sync-progress-reader-done':
						results = await progressReaderDoneCase();
						break;
					case 'sync-progress-newcomer':
						results = await progressNewcomerCase(ctx.params, timings);
						break;
					case 'shared-attach':
						results = await sharedAttachCase(ctx.params, timings);
						break;
					case 'shared-finish':
						results = await sharedFinishCase(ctx.params, timings);
						break;
					case 'shared-both-shapes':
						results = await sharedBothShapesCase(ctx.params, timings);
						break;
					case 'shared-other-app':
						results = await sharedOtherAppCase(ctx.params, timings);
						break;
					case 'shared-unsupported':
						results = await sharedUnsupportedCase();
						break;
					default:
						throw new Error(`unknown case ${JSON.stringify(ctx.params.case)}`);
				}
			}
		} catch (error) {
			// MESSAGE FIRST, then the stack. `error.stack` carries the message on V8 and
			// NOT on JavaScriptCore, where it is bare frames -- so recording the stack
			// alone made every WebKit-only failure arrive as a list of function names with
			// nothing saying what went wrong. That is the engine a cross-engine harness is
			// least able to reproduce by hand, and therefore the one whose failures most
			// need to explain themselves.
			const raised = error as Error | undefined;
			const message = raised?.message ?? String(error);
			const stack = raised?.stack ?? '';
			errors.push(stack.includes(message) ? stack : `${raised?.name ?? 'Error'}: ${message}\n${stack}`);
		}

		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
