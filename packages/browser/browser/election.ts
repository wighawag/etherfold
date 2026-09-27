import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {openForReading, openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createIndexerState,
	createPortReadSurface,
	dedicatedWorkerHost,
	type HostProgress,
	type IndexerPort,
} from '../src/index.js';
import {FINALITY, fakeChain, processor, readState, SOURCE, type FetchedRange, type TestABI} from './workload.js';

/**
 * THE TAB ELECTION (ADR-0097) in real tabs: the page side of
 * `oneTabIndexesAndTheOthersRead.spec.ts`.
 *
 * Every tab of one app runs ONE of these per page and keeps it in module state
 * between runs, because the spec closes and kills OTHER tabs in between and the
 * evidence is what each surviving tab saw across that. Nothing here mocks the
 * lock: it is the engine's `navigator.locks`, and the handover the spec asserts on
 * is the engine releasing it when a tab or a worker goes away.
 *
 * What a tab reports is what it can know of itself: its seat, what IT asked the
 * chain for, the progress its port reports, and the state it reads.
 */

type Params = Record<string, unknown>;

/** The fetch width, so a fold is several requests and a hold can stop it part way. */
const FETCH = 4;

type ElectionTab = {
	port: IndexerPort;
	calls: string[];
	ranges: FetchedRange[];
	reads: () => Promise<{owners: Record<string, string | undefined>; transfers: number}>;
	seat: () => unknown;
	demotion: () => unknown;
	worker?: Worker;
};

let tab: ElectionTab | undefined;

function electionName(params: Params): string {
	return `${params.tag as string}-${(params.app as string) ?? 'app'}`;
}

function databaseOf(params: Params): string {
	return `${params.tag as string}-${(params.app as string) ?? 'app'}-db`;
}

/**
 * A MAIN-THREAD TAB of the app: the hook, with the reader factory and (unless
 * `noElection`) the election. Its chain is held above `holdAbove`, so a leader
 * stops part way and what a takeover does next is visible in the ranges.
 */
export async function electionMainOpenCase(params: Params): Promise<Record<string, unknown>> {
	const databaseName = databaseOf(params);
	const holdAbove = Number(params.holdAbove ?? 0);
	const chain = fakeChain();
	const calls: string[] = [];
	const ranges: FetchedRange[] = [];
	const provider = {
		async request(args: {method: string; params?: any}): Promise<unknown> {
			calls.push(args.method);
			if (args.method === 'eth_getLogs') {
				const from = parseInt(args.params[0].fromBlock.slice(2), 16);
				const to = parseInt(args.params[0].toBlock.slice(2), 16);
				// HELD for ever: this tab's fold stops here, as a slow or dying leader would.
				if (holdAbove > 0 && to > holdAbove) await new Promise(() => undefined);
				ranges.push({from, to});
			}
			return chain.provider.request(args);
		},
	} as never;
	const indexer = createIndexerState<TestABI, EntityStateView>(
		{
			createState: async (_context, {signal}) =>
				openForWriting(await createBrowserStateStore(processor.entities, {databaseName}), {signal}),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
			openState: async () => {
				const store = openForReading(await createBrowserStateStore(processor.entities, {databaseName}));
				return {store, state: new EntityStateView(store)};
			},
		},
		params.noElection ? {} : {tabElection: {name: electionName(params)}},
	);
	await indexer.init({
		provider,
		source: SOURCE,
		config: {stream: {finality: FINALITY}, fetch: {numBlocksToFetchAtStart: FETCH, maxBlocksPerFetch: FETCH}},
	});
	await indexer.startAutoIndexing(0.1);
	const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});
	tab = {
		port,
		calls,
		ranges,
		reads: () => readState(indexer.state.$state),
		seat: () => indexer.syncing.$state.election ?? null,
		demotion: () => indexer.syncing.$state.demotion?.reason ?? null,
	};
	return {seat: tab.seat()};
}

/**
 * A DEDICATED-WORKER TAB of the app: its own worker, holding the election's lock
 * INSIDE the worker. The port does not watch, so a worker this tab kills stays
 * dead and the handover is another tab's.
 */
export async function electionWorkerOpenCase(params: Params): Promise<Record<string, unknown>> {
	const ranges: FetchedRange[] = [];
	const calls: string[] = [];
	const url = new URL(
		`./worker.js?db=${encodeURIComponent(databaseOf(params))}&fetch=${FETCH}&holdAbove=${Number(params.holdAbove ?? 0)}` +
			`&election=${encodeURIComponent(electionName(params))}&report`,
		import.meta.url,
	);
	let worker: Worker | undefined;
	const port = connectToIndexerHost(
		dedicatedWorkerHost(() => {
			worker = new Worker(url, {type: 'module'});
			worker.addEventListener('message', (event: MessageEvent) => {
				const fetched = (event.data as {fixture?: string; fetched?: FetchedRange} | null)?.fetched;
				if ((event.data as {fixture?: string} | null)?.fixture === 'worker' && fetched) {
					calls.push('eth_getLogs');
					ranges.push(fetched);
				}
			});
			return worker;
		}),
		{watch: false},
	);
	const surface = createPortReadSurface(port, processor.entities);
	let latest: HostProgress | undefined;
	port.onProgress((progress) => (latest = progress));
	const progress = await port.progress();
	tab = {
		port,
		calls,
		ranges,
		async reads() {
			const owners: Record<string, string | undefined> = {};
			for (const id of ['1', '2', '3', '4']) owners[id] = (await surface.token.getCurrent({id}))?.owner as string;
			return {owners, transfers: ((await surface.counter.getCurrent({name: 'transfers'}))?.value as number) ?? 0};
		},
		seat: () => (latest ?? progress).election ?? null,
		demotion: () => null,
		worker,
	};
	return {seat: tab.seat()};
}

/** WHAT THIS TAB KNOWS: its seat, what it asked the chain for, its port's progress, and what it reads. */
export async function electionReportCase(): Promise<Record<string, unknown>> {
	if (!tab) throw new Error(`this tab never opened the app`);
	const progress = await tab.port.progress();
	return {
		seat: progress.election ?? tab.seat(),
		demotion: tab.demotion(),
		calls: tab.calls.length,
		ranges: tab.ranges,
		progress: {
			phase: progress.phase,
			lastToBlock: progress.lastToBlock ?? null,
			latestBlock: progress.latestBlock ?? null,
			blocksBehindTip: progress.blocksBehindTip ?? null,
		},
		state: await tab.reads(),
	};
}

/** KILL this tab's worker: not a clean close, the worker just stops existing. */
export async function electionWorkerKillCase(): Promise<Record<string, unknown>> {
	if (!tab?.worker) throw new Error(`this tab holds no worker to kill`);
	tab.worker.terminate();
	return {killed: true};
}
