import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {openForReading, openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createIndexerState,
	createPortReadSurface,
	serveIndexerHost,
	type TabElection,
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
 * A VISIBLE TAB TAKES THE LEASE FROM A BACKGROUNDED LEADER (ADR-0097, D4 as
 * amended), in node.
 *
 * Node has a real `navigator.locks` (`steal` included) and a real
 * `BroadcastChannel`, so the lock and the channel here are the platform's. What
 * node has no notion of is a tab's VISIBILITY, so each tab is handed a document of
 * its own (`document` is stubbed around the call that reads it), whose
 * `visibilityState` a test moves and whose `visibilitychange` it dispatches, which
 * is exactly what the real-tab spec does where a harness cannot background a tab.
 */

let counter = 0;
const fresh = (what: string) => `${what}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;
const CONFIG = {stream: {finality: FINALITY}, fetch: {numBlocksToFetchAtStart: 4, maxBlocksPerFetch: 4}};
const EXPECTED_A_EXTENDED = {owners: {...EXPECTED_A.owners, '2': CAROL}, transfers: EXPECTED_A.transfers + 1};
/** Short, so the suite is quick; the default is `DEFAULT_FOREGROUND_SETTLE_MS`. */
const SETTLE_MS = 150;

/** A tab's own document: a visibility the test moves, and the event it dispatches. */
function tabDocument(initially: 'visible' | 'hidden') {
	const listeners = new Set<() => void>();
	const document = {
		visibilityState: initially as string,
		addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
		removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
	};
	const set = (state: 'visible' | 'hidden') => {
		document.visibilityState = state;
		for (const listener of [...listeners]) listener();
	};
	return {document, show: () => set('visible'), hide: () => set('hidden')};
}

/**
 * Start `open` with `document` being this tab's: a host reads its visibility
 * source synchronously as it starts, so the stub is lifted before anything is awaited.
 */
async function asTab<T>(tab: ReturnType<typeof tabDocument>, open: () => Promise<T>): Promise<T> {
	vi.stubGlobal('document', tab.document);
	let started: Promise<T>;
	try {
		started = open();
	} finally {
		vi.unstubAllGlobals();
	}
	return started;
}

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

function tabOf(databaseName: string, election: TabElection) {
	return createIndexerState<TestABI, EntityStateView>(
		{
			createState: async (_context, {signal}) =>
				openForWriting(await createBrowserStateStore(processor.entities, {databaseName}), {signal}),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
			openState: async () => {
				const store = openForReading(await createBrowserStateStore(processor.entities, {databaseName}));
				return {store, state: new EntityStateView(store)};
			},
		},
		{tabElection: election},
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function storedState(databaseName: string) {
	const store = openForReading(await createBrowserStateStore(processor.entities, {databaseName}));
	return readState(new EntityStateView(store));
}

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.unstubAllGlobals();
});

describe('a visible tab takes the lease from a backgrounded leader (main thread)', () => {
	it('a reader visible past the settle time leads and indexes on with no gap; the hidden leader reads and fetches nothing', async () => {
		const database = fresh('fg-db');
		const election = {name: fresh('fg'), foregroundTakeover: {settleMs: SETTLE_MS}};
		const {chain, asked, providerFor} = sharedChain();

		const leaderTab = tabDocument('visible');
		const leader = tabOf(database, election);
		disposers.push(() => leader.dispose());
		await asTab(leaderTab, () => leader.init({provider: providerFor('leader'), source: SOURCE, config: CONFIG}));
		expect(leader.syncing.$state.election).toMatchObject({role: 'writer', visibility: 'visible'});
		await indexToTip(leader);
		await leader.startAutoIndexing(0.05);

		const readerTab = tabDocument('hidden');
		const reader = tabOf(database, election);
		disposers.push(() => reader.dispose());
		await asTab(readerTab, () => reader.init({provider: providerFor('reader'), source: SOURCE, config: CONFIG}));
		expect(reader.syncing.$state.election).toMatchObject({role: 'reader', visibility: 'hidden'});
		expect(await reader.startAutoIndexing(0.05)).toBe(true);

		// The user switches tabs: the leader goes to the background, the reader comes forward.
		leaderTab.hide();
		readerTab.show();

		await until('the takeover', () => reader.syncing.$state.election?.role === 'writer');
		expect(reader.syncing.$state.election).toEqual({
			name: election.name,
			role: 'writer',
			tookOver: true,
			takeoverReason: 'leader-backgrounded',
			visibility: 'visible',
		});
		// THE DISPLACED LEADER reads, through the ordinary demotion, and says why.
		await until('the leader to step down', () => leader.syncing.$state.election?.role === 'reader');
		expect(leader.syncing.$state.election).toMatchObject({role: 'reader', displaced: true, visibility: 'hidden'});
		expect(leader.syncing.$state.demotion?.reason).toBe('lease-lost');
		expect(leader.canonical).toBeUndefined();
		const leaderCallsAtHandover = asked('leader').calls.length;

		// The chain moves on, and the NEW leader follows it from the stored cursor.
		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		await until(
			'the new leader to reach the new tip',
			() => reader.syncing.$state.lastSync?.lastToBlock === BRANCH_A_EXTENDED_TIP,
		);
		const resumed = asked('reader').ranges;
		expect(resumed[0]!.from).toBeLessThanOrEqual(BRANCH_A_TIP + 1);
		expect(resumed[0]!.from).toBeGreaterThan(START_BLOCK);
		expect(await readState(reader.state.$state)).toEqual(EXPECTED_A_EXTENDED);
		// ...and the old leader, reading, sees the same state and asked the chain for nothing.
		await until('the old leader to read the new state', async () => {
			const read = await readState(leader.state.$state);
			return read.transfers === EXPECTED_A_EXTENDED.transfers;
		});
		expect(await readState(leader.state.$state)).toEqual(EXPECTED_A_EXTENDED);
		await sleep(200);
		expect(asked('leader').calls.length).toBe(leaderCallsAtHandover);
	});

	it('the displaced leader queues again, and takes over when the tab that displaced it closes', async () => {
		const database = fresh('fg-back-db');
		const election = {name: fresh('fg-back'), foregroundTakeover: {settleMs: SETTLE_MS}};
		const {providerFor} = sharedChain();

		const leaderTab = tabDocument('hidden');
		const leader = tabOf(database, election);
		disposers.push(() => leader.dispose());
		await asTab(leaderTab, () => leader.init({provider: providerFor('leader'), source: SOURCE, config: CONFIG}));
		await leader.startAutoIndexing(0.05);
		const readerTab = tabDocument('visible');
		const reader = tabOf(database, election);
		disposers.push(() => reader.dispose());
		await asTab(readerTab, () => reader.init({provider: providerFor('reader'), source: SOURCE, config: CONFIG}));

		await until('the takeover', () => reader.syncing.$state.election?.role === 'writer');
		await until('the step-down', () => leader.syncing.$state.election?.role === 'reader');
		reader.dispose();
		await until('the old leader to lead again', () => leader.syncing.$state.election?.role === 'writer');
		expect(leader.syncing.$state.election).toMatchObject({tookOver: true, takeoverReason: 'leader-gone'});
		expect(leader.syncing.$state.demotion).toBeUndefined();
		// The loop it was running before it was displaced starts again on its own.
		await until(
			'the returning leader to fold to the tip',
			() => leader.syncing.$state.lastSync?.lastToBlock === BRANCH_A_TIP,
		);
		expect(await readState(leader.state.$state)).toEqual(EXPECTED_A);
	});

	it('a FROZEN leader, which never answers and never learns, is displaced within the settle time, and the store stays correct when both write', async () => {
		const database = fresh('frozen-db');
		const election = {name: fresh('frozen'), foregroundTakeover: {settleMs: SETTLE_MS}};
		const {chain, providerFor} = sharedChain();

		// FROZEN: its channel posts nothing, and its lock never tells it the lease was taken.
		const locks = navigator.locks;
		class SilentChannel {
			postMessage() {}
			addEventListener() {}
			close() {}
		}
		const leaderTab = tabDocument('hidden');
		const leader = tabOf(database, election);
		disposers.push(() => leader.dispose());
		vi.stubGlobal('document', leaderTab.document);
		vi.stubGlobal('BroadcastChannel', SilentChannel);
		vi.stubGlobal('navigator', {
			locks: {
				request: (name: string, options: object, callback: (lock: unknown) => unknown) =>
					new Promise((resolve) => void locks.request(name, options, callback as never).then(resolve, () => undefined)),
			},
		});
		let initialising: Promise<void>;
		try {
			initialising = leader.init({provider: providerFor('leader'), source: SOURCE, config: CONFIG});
		} finally {
			vi.unstubAllGlobals();
		}
		await initialising;
		await indexToTip(leader);

		const readerTab = tabDocument('visible');
		const reader = tabOf(database, election);
		disposers.push(() => reader.dispose());
		const started = Date.now();
		await asTab(readerTab, () => reader.init({provider: providerFor('reader'), source: SOURCE, config: CONFIG}));
		expect(reader.syncing.$state.election?.role).toBe('reader');
		await until('the takeover', () => reader.syncing.$state.election?.role === 'writer');
		// The bound is the settle time (plus the fresh start's own scheduling).
		expect(Date.now() - started).toBeLessThan(SETTLE_MS + 1500);
		expect(reader.syncing.$state.election).toMatchObject({takeoverReason: 'leader-backgrounded'});
		// THE SEAT IS NOT READINESS: ADR-0097 D4 has the new leader announce its seat the
		// moment it holds the lock, before its fresh start opens the container, and until
		// then `indexMore()` answers as the reader it still is. Wait for the container (the
		// generation it answers reads from) before advancing it; a demotion meanwhile is
		// the failure this case exists to catch, so it ends the wait loudly.
		await until('the new leader to open its container', () => {
			const demoted = reader.syncing.$state.demotion;
			if (demoted) throw new Error(`the new leader was DEMOTED (${demoted.reason}) during its fresh start`);
			return reader.canonical !== undefined;
		});

		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		await indexToTip(reader);
		// THE FROZEN LEADER THAWS and writes, still believing it leads: BOTH WRITE. Its
		// write is refused by the new leader's claim, and it demotes as today.
		expect(await leader.indexMore()).toBeUndefined();
		expect(leader.syncing.$state.demotion?.reason).toBe('write-refused');
		// THE STORE IS CORRECT: the new leader's fold, read by anybody.
		expect(await storedState(database)).toEqual(EXPECTED_A_EXTENDED);
	});

	it('switching faster than the settle time moves nothing, and a visible leader is never displaced', async () => {
		const database = fresh('switch-db');
		const election = {name: fresh('switch'), foregroundTakeover: {settleMs: SETTLE_MS}};
		const {providerFor} = sharedChain();

		const leaderTab = tabDocument('visible');
		const leader = tabOf(database, election);
		disposers.push(() => leader.dispose());
		await asTab(leaderTab, () => leader.init({provider: providerFor('leader'), source: SOURCE, config: CONFIG}));
		const readerTab = tabDocument('hidden');
		const reader = tabOf(database, election);
		disposers.push(() => reader.dispose());
		await asTab(readerTab, () => reader.init({provider: providerFor('reader'), source: SOURCE, config: CONFIG}));
		await sleep(50);

		// QUICK SWITCHES: each visit to the reader is shorter than the settle time.
		for (let switchNumber = 0; switchNumber < 5; switchNumber++) {
			leaderTab.hide();
			readerTab.show();
			await sleep(SETTLE_MS / 3);
			readerTab.hide();
			leaderTab.show();
			await sleep(SETTLE_MS / 3);
		}
		await sleep(SETTLE_MS * 2);
		expect(reader.syncing.$state.election?.role).toBe('reader');
		expect(leader.syncing.$state.election?.role).toBe('writer');

		// BOTH VISIBLE (two windows side by side), for well past the settle time: a
		// visible leader is never displaced.
		readerTab.show();
		await sleep(SETTLE_MS * 4);
		expect(reader.syncing.$state.election?.role).toBe('reader');
		expect(leader.syncing.$state.election).toMatchObject({role: 'writer', tookOver: false});
	});

	it('with the opt-out, a hidden leader keeps the lease and nothing reports a visibility', async () => {
		const database = fresh('optout-db');
		const election = {name: fresh('optout'), foregroundTakeover: false as const};
		const {providerFor} = sharedChain();

		const leaderTab = tabDocument('hidden');
		const leader = tabOf(database, election);
		disposers.push(() => leader.dispose());
		await asTab(leaderTab, () => leader.init({provider: providerFor('leader'), source: SOURCE, config: CONFIG}));
		const readerTab = tabDocument('visible');
		const reader = tabOf(database, election);
		disposers.push(() => reader.dispose());
		await asTab(readerTab, () => reader.init({provider: providerFor('reader'), source: SOURCE, config: CONFIG}));
		readerTab.show();
		await sleep(600);
		// Exactly the first cut's seats, field for field.
		expect(leader.syncing.$state.election).toEqual({name: election.name, role: 'writer', tookOver: false});
		expect(reader.syncing.$state.election).toEqual({name: election.name, role: 'reader', tookOver: false});
	});
});

describe('a visible tab takes the lease from a backgrounded leader (dedicated-worker hosts)', () => {
	function hostOf(
		databaseName: string,
		election: TabElection,
		provider: never,
		tab: ReturnType<typeof tabDocument>,
		shape: 'dedicated-worker' | 'shared-worker' = 'dedicated-worker',
	) {
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
				tabElection: election,
				provider,
				source: SOURCE,
				config: CONFIG,
				tipIntervalInSeconds: 0.05,
			},
			{...line.host, host: shape},
		);
		// THE TAB reports its visibility over the port, from the document it has.
		vi.stubGlobal('document', tab.document);
		const port = connectToIndexerHost(line.tab, {watch: false});
		vi.unstubAllGlobals();
		return {host, port, close: () => (host.dispose(), port.close(), line.close())};
	}

	it('the tab reports its visibility to its worker host, and the visible reader takes the lease', async () => {
		const database = fresh('worker-fg-db');
		const election = {name: fresh('worker-fg'), foregroundTakeover: {settleMs: SETTLE_MS}};
		const {chain, asked, providerFor} = sharedChain();

		const leaderTab = tabDocument('visible');
		const leader = hostOf(database, election, providerFor('leader'), leaderTab);
		disposers.push(leader.close);
		await until('the leader at its tip', async () => (await leader.port.progress()).lastToBlock === BRANCH_A_TIP);
		expect((await leader.port.progress()).election).toMatchObject({role: 'writer', visibility: 'visible'});

		const readerTab = tabDocument('hidden');
		const reader = hostOf(database, election, providerFor('reader'), readerTab);
		disposers.push(reader.close);
		await until('the reader seat', async () => (await reader.port.progress()).election?.role === 'reader');
		await sleep(SETTLE_MS * 2);
		expect((await reader.port.progress()).election?.role).toBe('reader');

		leaderTab.hide();
		readerTab.show();
		const took = await until('the takeover', async () => {
			const progress = await reader.port.progress();
			return progress.election?.role === 'writer' ? progress : undefined;
		});
		expect(took.election).toMatchObject({tookOver: true, takeoverReason: 'leader-backgrounded', visibility: 'visible'});
		const stepped = await until('the old leader to step down', async () => {
			const progress = await leader.port.progress();
			return progress.election?.role === 'reader' ? progress : undefined;
		});
		expect(stepped.election).toMatchObject({displaced: true, visibility: 'hidden'});
		const leaderCallsAtHandover = asked('leader').calls.length;

		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		await until(
			'the new leader at the new tip',
			async () => (await reader.port.progress()).lastToBlock === BRANCH_A_EXTENDED_TIP,
		);
		expect(asked('reader').ranges[0]!.from).toBeLessThanOrEqual(BRANCH_A_TIP + 1);
		expect(asked('reader').ranges[0]!.from).toBeGreaterThan(START_BLOCK);
		// The OLD leader answers reads from the store the new one writes, and reports its progress.
		const reads = createPortReadSurface(leader.port, processor.entities);
		await until(
			'the old leader to read the new state',
			async () => (await reads.counter.getCurrent({name: 'transfers'}))?.value === EXPECTED_A_EXTENDED.transfers,
		);
		await until(
			'the old leader to report the new leader',
			async () => (await leader.port.progress()).lastToBlock === BRANCH_A_EXTENDED_TIP,
		);
		await sleep(200);
		expect(asked('leader').calls.length).toBe(leaderCallsAtHandover);
		expect(await storedState(database)).toEqual(EXPECTED_A_EXTENDED);
	});

	it('a SharedWorker host does not take part: it publishes no visibility and is never displaced', async () => {
		const database = fresh('shared-fg-db');
		const election = {name: fresh('shared-fg'), foregroundTakeover: {settleMs: SETTLE_MS}};
		const {providerFor} = sharedChain();

		const sharedTab = tabDocument('hidden');
		const shared = hostOf(database, election, providerFor('shared'), sharedTab, 'shared-worker');
		disposers.push(shared.close);
		await until('the shared host to lead', async () => (await shared.port.progress()).election?.role === 'writer');
		const readerTab = tabDocument('visible');
		const reader = hostOf(database, election, providerFor('reader'), readerTab);
		disposers.push(reader.close);
		await until('the reader seat', async () => (await reader.port.progress()).election?.role === 'reader');
		await sleep(SETTLE_MS * 4);
		expect((await shared.port.progress()).election).toEqual({name: election.name, role: 'writer', tookOver: false});
		expect((await reader.port.progress()).election?.role).toBe('reader');
	});
});
