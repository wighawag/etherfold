import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {StateMoved} from '@etherfold/core';
import {EntityEventProcessor, EntityStateView, stateFactoriesFrom} from '@etherfold/processor-entities';
import {openForReading, openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createIndexerState,
	createPortReadSurface,
	serveIndexerHost,
	type HostProgress,
	type IndexingSource,
} from '../src/index.js';
import {wire} from './utils/port.js';
import {
	BRANCH_A_EXTENDED,
	BRANCH_A_EXTENDED_TIP,
	BRANCH_A_TIP,
	CAROL,
	EXPECTED_A,
	FINALITY,
	fakeChain,
	indexToTip,
	processor,
	readState,
	SOURCE,
	START_BLOCK,
	type FetchedRange,
	type TestABI,
} from '../browser/workload.js';

/**
 * ONE TAB INDEXES AND THE OTHERS READ (ADR-0097), in node.
 *
 * Node has a REAL `navigator.locks` and a real `BroadcastChannel`, so the
 * election here is the platform's own lock and not a mock of it: several hosts in
 * one process contend for one lock name exactly as tabs of one origin do. What
 * only a browser can show (a tab CLOSED, a tab or worker KILLED) is
 * `browser/oneTabIndexesAndTheOthersRead.spec.ts`; these are the same claims on
 * every commit.
 */

let counter = 0;
const fresh = (what: string) => `${what}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;
const CONFIG = {stream: {finality: FINALITY}, fetch: {numBlocksToFetchAtStart: 4, maxBlocksPerFetch: 4}};
const EXPECTED_A_EXTENDED = {owners: {...EXPECTED_A.owners, '2': CAROL}, transfers: EXPECTED_A.transfers + 1};

/** One chain, and what each TAB asked of it: the evidence for "exactly one fetches". */
function sharedChain() {
	const chain = fakeChain();
	const asked = new Map<string, {calls: string[]; ranges: FetchedRange[]}>();
	return {
		chain,
		asked: (tab: string) => asked.get(tab) ?? {calls: [], ranges: []},
		providerFor(tab: string) {
			const mine = {calls: [] as string[], ranges: [] as FetchedRange[]};
			asked.set(tab, mine);
			return {
				async request(args: {method: string; params?: any}): Promise<any> {
					mine.calls.push(args.method);
					if (args.method === 'eth_getLogs') {
						mine.ranges.push({
							from: parseInt(args.params[0].fromBlock.slice(2), 16),
							to: parseInt(args.params[0].toBlock.slice(2), 16),
						});
					}
					return chain.provider.request(args);
				},
			} as never;
		},
	};
}

/** A tab of the app: the hook, with the reader factory and (unless told otherwise) the election. */
function tabOf(databaseName: string, options: {election?: string; readerFactory?: boolean} = {}) {
	return createIndexerState<TestABI, EntityStateView>(
		{
			createState: async (_context, {signal}) =>
				openForWriting(await createBrowserStateStore(processor.entities, {databaseName}), {signal}),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
			...(options.readerFactory === false
				? {}
				: {
						openState: async () => {
							const store = openForReading(await createBrowserStateStore(processor.entities, {databaseName}));
							return {store, state: new EntityStateView(store)};
						},
					}),
		},
		options.election ? {tabElection: {name: options.election}} : {},
	);
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
	for (let attempt = 0; attempt < 500; attempt++) {
		const value = await check();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.unstubAllGlobals();
});

describe('one tab indexes and the others read (main thread)', () => {
	it('elects one writer; the reader fetches nothing, reads the same state, renders progress, and takes over with no gap', async () => {
		const database = fresh('election-db');
		const name = fresh('election');
		const {chain, asked, providerFor} = sharedChain();

		const leader = tabOf(database, {election: name});
		disposers.push(() => leader.dispose());
		await leader.init({provider: providerFor('leader'), source: SOURCE, config: CONFIG});
		expect(leader.syncing.$state.election).toEqual({name, role: 'writer', tookOver: false});

		const reader = tabOf(database, {election: name});
		disposers.push(() => reader.dispose());
		await reader.init({provider: providerFor('reader'), source: SOURCE, config: CONFIG});
		// A READER: no container, no claim, nothing fetched.
		expect(reader.syncing.$state.election).toEqual({name, role: 'reader', tookOver: false});
		expect(reader.canonical).toBeUndefined();
		expect(await reader.indexMore()).toBeUndefined();
		// Remembered, not run: the loop starts when this tab takes over.
		expect(await reader.startAutoIndexing(0.05)).toBe(true);

		const port = connectToIndexerHost(reader.mainThreadHost(), {watch: false});
		const told: StateMoved[] = [];
		port.onStateMoved((moved) => told.push(moved));
		const heard: HostProgress[] = [];
		port.onProgress((progress) => heard.push(progress));

		await indexToTip(leader);

		// THE READER RENDERS THE LEADER'S PROGRESS and follows its signal.
		const atTip = await until('the leader progress on the reader port', () =>
			heard.find((one) => one.lastToBlock === BRANCH_A_TIP),
		);
		expect(atTip.election).toEqual({name, role: 'reader', tookOver: false});
		expect(atTip.host).toBe('main-thread');
		await until('the state-moved signal on the reader port', () => told.some((one) => one.kind === 'applied'));
		// THE SAME STATE, read from the shared store, by a tab that asked the chain for nothing.
		expect(await readState(reader.state.$state)).toEqual(EXPECTED_A);
		expect(asked('reader').calls).toEqual([]);

		// THE LEADER CLOSES, and the chain moves on.
		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		leader.dispose();

		await until('the takeover', () => reader.syncing.$state.election?.role === 'writer');
		expect(reader.syncing.$state.election).toEqual({
			name,
			role: 'writer',
			tookOver: true,
			takeoverReason: 'leader-gone',
		});
		await until(
			'the new writer to reach the new tip',
			() => reader.syncing.$state.lastSync?.lastToBlock === BRANCH_A_EXTENDED_TIP,
		);
		expect(await readState(reader.state.$state)).toEqual(EXPECTED_A_EXTENDED);
		// NO GAP: the new writer resumed from the STORED cursor, so its first request starts
		// at or below the block after the one the leader recorded, and never from the start.
		const resumed = asked('reader').ranges;
		expect(resumed[0]!.from).toBeLessThanOrEqual(BRANCH_A_TIP + 1);
		expect(resumed[0]!.from).toBeGreaterThan(START_BLOCK);
		port.close();
	});

	it('two tabs that both believe they lead leave the store correct, the loser demoting as today', async () => {
		const database = fresh('dual-db');
		const name = fresh('dual');
		const {providerFor} = sharedChain();

		const elected = tabOf(database, {election: name});
		disposers.push(() => elected.dispose());
		await elected.init({provider: providerFor('elected'), source: SOURCE, config: CONFIG});
		expect(elected.syncing.$state.election?.role).toBe('writer');

		// A tab that believes it leads WITHOUT the lock: no election at all, so it writes.
		const rogue = tabOf(database);
		disposers.push(() => rogue.dispose());
		await rogue.init({provider: providerFor('rogue'), source: SOURCE, config: CONFIG});
		expect(rogue.syncing.$state.election).toBeUndefined();
		await indexToTip(rogue);

		// The elected tab's next write is refused, and it DEMOTES exactly as it always did.
		expect(await elected.indexMore()).toBeUndefined();
		expect(elected.syncing.$state.demotion?.reason).toBe('write-refused');
		// The store is correct: it is the writer's fold, read by anybody.
		const store = openForReading(await createBrowserStateStore(processor.entities, {databaseName: database}));
		expect(await readState(new EntityStateView(store))).toEqual(EXPECTED_A);
	});

	it('a demoted leader gives the lock back, so a reader takes over', async () => {
		const database = fresh('handback-db');
		const name = fresh('handback');
		const {providerFor} = sharedChain();

		const elected = tabOf(database, {election: name});
		disposers.push(() => elected.dispose());
		await elected.init({provider: providerFor('elected'), source: SOURCE, config: CONFIG});
		const waiting = tabOf(database, {election: name});
		disposers.push(() => waiting.dispose());
		await waiting.init({provider: providerFor('waiting'), source: SOURCE, config: CONFIG});
		expect(waiting.syncing.$state.election?.role).toBe('reader');

		elected.demoteToReader('lease-lost');
		await until('the takeover', () => waiting.syncing.$state.election?.tookOver);
		await indexToTip(waiting);
		expect(await readState(waiting.state.$state)).toEqual(EXPECTED_A);
	});

	it('two apps with different election names never contend', async () => {
		const {providerFor} = sharedChain();
		const one = tabOf(fresh('app-one'), {election: fresh('app-one')});
		const two = tabOf(fresh('app-two'), {election: fresh('app-two')});
		disposers.push(
			() => one.dispose(),
			() => two.dispose(),
		);
		await one.init({provider: providerFor('one'), source: SOURCE, config: CONFIG});
		await two.init({provider: providerFor('two'), source: SOURCE, config: CONFIG});
		expect(one.syncing.$state.election?.role).toBe('writer');
		expect(two.syncing.$state.election?.role).toBe('writer');
	});

	it('without the reader factory, or without navigator.locks, every tab behaves exactly as today', async () => {
		const {providerFor} = sharedChain();
		const name = fresh('off');
		const noFactory = tabOf(fresh('off-db'), {election: name, readerFactory: false});
		disposers.push(() => noFactory.dispose());
		await noFactory.init({provider: providerFor('noFactory'), source: SOURCE, config: CONFIG});
		expect(noFactory.syncing.$state.election).toBeUndefined();
		expect(noFactory.canonical).toBeDefined();

		vi.stubGlobal('navigator', {});
		const noLocks = tabOf(fresh('off-db'), {election: name});
		disposers.push(() => noLocks.dispose());
		await noLocks.init({provider: providerFor('noLocks'), source: SOURCE, config: CONFIG});
		expect(noLocks.syncing.$state.election).toBeUndefined();
		expect(noLocks.canonical).toBeDefined();
	});
});

describe('one tab indexes and the others read (worker hosts)', () => {
	function hostOf(databaseName: string, name: string, provider: never, source: IndexingSource<TestABI> = SOURCE) {
		const line = wire();
		const host = serveIndexerHost<TestABI, EntityStateView>(
			{
				createState: async (_context, {signal}) =>
					openForWriting(await createBrowserStateStore(processor.entities, {databaseName}), {signal}),
				createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
				openState: async () => {
					const store = openForReading(await createBrowserStateStore(processor.entities, {databaseName}));
					return {store, state: new EntityStateView(store)};
				},
				tabElection: {name},
				provider,
				source,
				config: CONFIG,
				tipIntervalInSeconds: 0.05,
			},
			line.host,
		);
		const port = connectToIndexerHost(line.tab, {watch: false});
		return {host, port, close: () => (host.dispose(), port.close(), line.close())};
	}

	it('one host folds, the other reads its store and its progress, and takes over when it goes', async () => {
		const database = fresh('worker-db');
		const name = fresh('worker-election');
		const {chain, asked, providerFor} = sharedChain();

		const leader = hostOf(database, name, providerFor('leader'));
		disposers.push(leader.close);
		await until('the leader to lead', async () => (await leader.port.progress()).election?.role === 'writer');
		const reader = hostOf(database, name, providerFor('reader'));
		disposers.push(reader.close);

		const atTip = await until('the reader to report the leader at its tip', async () => {
			const progress = await reader.port.progress();
			return progress.lastToBlock === BRANCH_A_TIP ? progress : undefined;
		});
		expect(atTip.election).toEqual({name, role: 'reader', tookOver: false});
		expect(asked('reader').calls).toEqual([]);
		const reads = createPortReadSurface(reader.port, processor.entities);
		expect((await reads.counter.getCurrent({name: 'transfers'}))?.value).toBe(EXPECTED_A.transfers);

		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		leader.close();

		const took = await until('the takeover at the new tip', async () => {
			const progress = await reader.port.progress();
			return progress.lastToBlock === BRANCH_A_EXTENDED_TIP ? progress : undefined;
		});
		expect(took.election).toEqual({name, role: 'writer', tookOver: true, takeoverReason: 'leader-gone'});
		expect((await reads.counter.getCurrent({name: 'transfers'}))?.value).toBe(EXPECTED_A_EXTENDED.transfers);
		expect(asked('reader').ranges[0]!.from).toBeLessThanOrEqual(BRANCH_A_TIP + 1);
	});
});

/**
 * THE SAME ELECTION, with both seats derived from ONE store constructor
 * (`stateFactoriesFrom`, `@etherfold/processor-entities`): the recipe an app
 * writes, so the reader cannot open a database the leader does not write.
 */
describe('one tab indexes and the others read, from ONE store constructor', () => {
	function hostOf(databaseName: string, name: string, provider: never) {
		const line = wire();
		const host = serveIndexerHost<TestABI, EntityStateView>(
			{
				...stateFactoriesFrom({
					open: (_context, entities) => createBrowserStateStore(entities, {databaseName}),
					entities: processor.entities,
				}),
				createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
				tabElection: {name},
				provider,
				source: SOURCE,
				config: CONFIG,
				tipIntervalInSeconds: 0.05,
			},
			line.host,
		);
		const port = connectToIndexerHost(line.tab, {watch: false});
		return {host, port, close: () => (host.dispose(), port.close(), line.close())};
	}

	it('one host folds, the other reads its store and its progress, and takes over when it goes', async () => {
		const database = fresh('helper-db');
		const name = fresh('helper-election');
		const {chain, asked, providerFor} = sharedChain();

		const leader = hostOf(database, name, providerFor('leader'));
		disposers.push(leader.close);
		await until('the leader to lead', async () => (await leader.port.progress()).election?.role === 'writer');
		const reader = hostOf(database, name, providerFor('reader'));
		disposers.push(reader.close);

		const atTip = await until('the reader to report the leader at its tip', async () => {
			const progress = await reader.port.progress();
			return progress.lastToBlock === BRANCH_A_TIP ? progress : undefined;
		});
		expect(atTip.election).toEqual({name, role: 'reader', tookOver: false});
		expect(asked('reader').calls).toEqual([]);
		const reads = createPortReadSurface(reader.port, processor.entities);
		expect((await reads.counter.getCurrent({name: 'transfers'}))?.value).toBe(EXPECTED_A.transfers);
		for (const [id, owner] of Object.entries(EXPECTED_A.owners)) {
			expect((await reads.token.getCurrent({id}))?.owner).toBe(owner);
		}

		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		leader.close();

		const took = await until('the takeover at the new tip', async () => {
			const progress = await reader.port.progress();
			return progress.lastToBlock === BRANCH_A_EXTENDED_TIP ? progress : undefined;
		});
		expect(took.election).toEqual({name, role: 'writer', tookOver: true, takeoverReason: 'leader-gone'});
		expect((await reads.counter.getCurrent({name: 'transfers'}))?.value).toBe(EXPECTED_A_EXTENDED.transfers);
		expect(asked('reader').ranges[0]!.from).toBeLessThanOrEqual(BRANCH_A_TIP + 1);
	});
});
