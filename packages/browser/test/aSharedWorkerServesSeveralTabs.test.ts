import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {openForReading, openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	hostIndexerInThisSharedWorker,
	hostIndexerInThisWorker,
	sharedWorkerHost,
	type HostProgress,
	type IndexerHost,
	type IndexerPort,
	type MessageEndpoint,
} from '../src/index.js';
import {
	BRANCH_A_TIP,
	EXPECTED_A,
	FINALITY,
	fakeChain,
	processor,
	readState,
	SOURCE,
	START_BLOCK,
	type TestABI,
} from '../browser/workload.js';

/**
 * ONE HOST, SEVERAL TABS: the SharedWorker hosting shape, over real
 * `MessagePort`s, in node.
 *
 * What runs in a REAL browser with a REAL SharedWorker and two REAL tabs is
 * `browser/sharedWorkerServesSeveralTabs.spec.ts`, which is where "two tabs
 * attached to one host" becomes a fact about two documents rather than about two
 * channels. These are the same claims on every commit, because that run needs
 * browser binaries a clean checkout does not have.
 *
 * ## What is faked here, and what is not
 *
 * The SCOPE is faked and the WIRES are not. A SharedWorker's entry differs from a
 * dedicated worker's in exactly one respect -- it is handed a port per client
 * through a `connect` event instead of owning one global wire -- so the fake is
 * that event and nothing else: `sharedWorkerScope` makes this node global look
 * like a `SharedWorkerGlobalScope` for as long as a case needs it, exactly as the
 * dedicated case's own test makes it look like a document. Every port a client
 * gets is a real `MessagePort` off a real `MessageChannel`, so the
 * structured-clone boundary, the correlation and the routing are the real ones.
 *
 * The one thing a node run cannot have is a second EXECUTION CONTEXT, so nothing
 * here asserts on `scope`: that claim belongs to the Playwright run.
 */

let counter = 0;
const freshName = () => `shared-hosted-indexer-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * THIS NODE GLOBAL, MADE TO LOOK LIKE A `SharedWorkerGlobalScope`, and put back
 * afterwards.
 *
 * A shared worker's entry point is reached through a `connect` event, and node's
 * global is not an `EventTarget` at all, so what is installed here is the two
 * things the entry helper actually uses: the `onconnect` slot that says this
 * scope HAS a connect interface, and the listener registration it attaches to.
 * `connect()` then delivers a client the way a browser does -- one event carrying
 * one port.
 */
function sharedWorkerScope(): {connect: (port: MessageEndpoint) => void; restore: () => void} {
	type Scope = {onconnect?: unknown; addEventListener?: unknown; removeEventListener?: unknown};
	const scope = globalThis as Scope;
	const before = {
		hadOnconnect: 'onconnect' in scope,
		addEventListener: scope.addEventListener,
		removeEventListener: scope.removeEventListener,
	};
	const listeners = new Set<(event: {ports: MessageEndpoint[]}) => void>();
	scope.onconnect = null;
	scope.addEventListener = (type: string, listener: (event: {ports: MessageEndpoint[]}) => void) => {
		if (type === 'connect') listeners.add(listener);
	};
	scope.removeEventListener = (_type: string, listener: (event: {ports: MessageEndpoint[]}) => void) => {
		listeners.delete(listener);
	};
	return {
		connect(port) {
			for (const listener of [...listeners]) listener({ports: [port]});
		},
		restore() {
			if (!before.hadOnconnect) delete scope.onconnect;
			if (before.addEventListener === undefined) delete scope.addEventListener;
			else scope.addEventListener = before.addEventListener;
			if (before.removeEventListener === undefined) delete scope.removeEventListener;
			else scope.removeEventListener = before.removeEventListener;
		},
	};
}

/** The fixture chain, with the fetches that would take the fold above a block HELD. */
function gatedChain(holdAbove: number) {
	const chain = fakeChain();
	let release!: () => void;
	const passed = new Promise<void>((resolve) => (release = resolve));
	const provider = {
		async request(args: {method: string; params?: unknown}): Promise<unknown> {
			if (args.method === 'eth_getLogs') {
				const asked = args.params as [{toBlock: string}];
				if (parseInt(asked[0].toBlock.slice(2), 16) > holdAbove) await passed;
			}
			return (chain.provider as unknown as {request(args: unknown): Promise<unknown>}).request(args);
		},
	} as unknown as typeof chain.provider;
	return {ranges: chain.ranges, provider, release: () => release()};
}

/**
 * A HOST IN A SHARED WORKER, as an app's entry point builds one.
 *
 * The spec is the dedicated case's spec, unchanged (`test/aHostFoldsAndATabAsksHowFar.test.ts`
 * builds the same object): what an app hands its host is the same value in every
 * shape, and the only line that differs is which helper it is handed to.
 */
function sharedHostOver(
	databaseName: string,
	chain: {provider: ReturnType<typeof fakeChain>['provider']} = fakeChain(),
	fetchWidth = 0,
): IndexerHost {
	return hostIndexerInThisSharedWorker<TestABI, EntityStateView>({
		createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
		createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
		provider: chain.provider,
		source: SOURCE,
		config: {
			stream: {finality: FINALITY},
			...(fetchWidth > 0 ? {fetch: {numBlocksToFetchAtStart: fetchWidth, maxBlocksPerFetch: fetchWidth}} : {}),
		},
		// The node run has no reason to rest for four seconds at the tip.
		tipIntervalInSeconds: 0.05,
	});
}

/**
 * ONE TAB, as the shared shape gives a tab its port: a `MessagePort` of its own.
 *
 * The `HostAccess` is built by hand rather than by `sharedWorkerHost`, because
 * the one thing that call does is construct a `SharedWorker` -- which is the
 * browser's, and is what the Playwright run exercises. What CROSSES is identical:
 * a SharedWorker hands a tab a `MessagePort`, and so does this.
 */
function attachTab(scope: ReturnType<typeof sharedWorkerScope>): {
	port: IndexerPort;
	/** EVERY message the host posted at THIS tab, ours or not. */
	received: {kind?: string; id?: number; case?: string}[];
	close: () => void;
} {
	const channel = new MessageChannel();
	const received: {kind?: string; id?: number; case?: string}[] = [];
	const tabEnd = channel.port2 as unknown as MessageEndpoint;
	tabEnd.addEventListener('message', (event) => received.push(event.data as {kind?: string}));
	tabEnd.start?.();
	scope.connect(channel.port1 as unknown as MessageEndpoint);
	const port = connectToIndexerHost({
		host: 'shared-worker',
		endpoint: tabEnd,
		// What `close` does to the HOST is the shape's business, and a SharedWorker
		// serving other tabs is not taken down by one of them letting go: this
		// releases the tab's own end of the wire and nothing else.
		close: () => channel.port2.close(),
	});
	return {
		port,
		received,
		close: () => {
			port.close();
			channel.port1.close();
		},
	};
}

async function untilAtTip(port: IndexerPort, attempts = 400): Promise<HostProgress> {
	let progress = await port.progress();
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (progress.failure) {
			throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
		}
		if (progress.latestBlock === BRANCH_A_TIP && progress.lastToBlock === progress.latestBlock) return progress;
		await new Promise((resolve) => setTimeout(resolve, 20));
		progress = await port.progress();
	}
	throw new Error(`the fold did not reach the tip: ${JSON.stringify(progress)}`);
}

/** Ask until the host's own report says what a case is waiting for. */
async function until(
	port: IndexerPort,
	matches: (progress: HostProgress) => boolean,
	attempts = 400,
): Promise<HostProgress> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const progress = await port.progress();
		if (progress.failure) {
			throw new Error(`the host stopped: ${progress.failure.name}: ${progress.failure.message}`);
		}
		if (matches(progress)) return progress;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`the host never got there: ${JSON.stringify(await port.progress())}`);
}

/** The counter, read THROUGH a tab's port: whatever the canonical generation says it is. */
async function transfersAcross(port: IndexerPort): Promise<number | undefined> {
	const row = (await port.reads.getCurrent('counter', {name: 'transfers'})) as {value?: number} | undefined;
	return row?.value;
}

/** The state the host wrote, read back the way a tab reads it: through a READER. */
async function stateFrom(databaseName: string) {
	const reader = openForReading(await createBrowserStateStore(processor.entities, {databaseName}));
	return readState(new EntityStateView(reader));
}

describe('a SharedWorker serving several tabs from one host', () => {
	it('folds ONCE for two attached tabs, and answers each of them from that one fold', async () => {
		const databaseName = freshName();
		const chain = fakeChain();
		const scope = sharedWorkerScope();
		const host = sharedHostOver(databaseName, chain);
		const first = attachTab(scope);
		const second = attachTab(scope);

		try {
			const [one, two] = await Promise.all([untilAtTip(first.port), untilAtTip(second.port)]);

			// ONE host, and both tabs are told which shape they reached.
			expect(one.host).toBe('shared-worker');
			expect(two.host).toBe('shared-worker');
			expect(first.port.host).toBe('shared-worker');

			// The same fold, so the same cursor: neither tab holds a fold of its own.
			expect(one.lastToBlock).toBe(BRANCH_A_TIP);
			expect(two.lastToBlock).toBe(one.lastToBlock);
			expect(host.progress().lastToBlock).toBe(one.lastToBlock);

			// EXACTLY ONE FOLD IS RUNNING, asserted where a second one would be
			// visible: a host per tab would ask the node for this span twice.
			expect(chain.ranges.filter((range) => range.from === START_BLOCK)).toHaveLength(1);

			// ...and both tabs read the rows that one fold produced.
			expect(await transfersAcross(first.port)).toBe(EXPECTED_A.transfers);
			expect(await transfersAcross(second.port)).toBe(EXPECTED_A.transfers);
			expect(await stateFrom(databaseName)).toEqual(EXPECTED_A);
		} finally {
			host.dispose();
			first.close();
			second.close();
			scope.restore();
		}
	});

	/**
	 * TWO TABS, TWO ID SPACES, ONE HOST.
	 *
	 * A correlation id is unique per PORT and not globally -- the envelope says so
	 * -- which becomes load-bearing here: two tabs are two documents, each counting
	 * from one, so their ids COLLIDE by construction rather than by bad luck. A
	 * host answering onto a broadcast wire would hand tab A the answer to tab B's
	 * question and both promises would RESOLVE, with the wrong values, which is the
	 * worst available kind of wrong.
	 */
	it('answers two tabs whose correlation ids collide, each with its own answer and nobody else', async () => {
		const scope = sharedWorkerScope();
		const host = sharedHostOver(freshName());
		const first = attachTab(scope);
		const second = attachTab(scope);

		try {
			// Interleaved on purpose, and the first call each tab makes carries id 1.
			for (let round = 0; round < 4; round++) {
				const [progress, declarations] = await Promise.all([first.port.progress(), second.port.reads.declarations()]);
				expect(progress.host).toBe('shared-worker');
				expect(declarations.map((entity) => entity.name).sort()).toEqual(['counter', 'token']);
			}

			// ON THE WIRE: each tab was posted exactly the answers it asked for. The
			// shapes above would also be satisfied by a host that answered both tabs
			// twice and let each drop the answer it could not place.
			expect(first.received.filter((message) => message.kind === 'response')).toHaveLength(4);
			expect(second.received.filter((message) => message.kind === 'response')).toHaveLength(4);
			expect(first.received.every((message) => message.kind !== 'response' || message.case === 'progress')).toBe(true);
			expect(second.received.every((message) => message.kind !== 'response' || message.case === 'declarations')).toBe(
				true,
			);
		} finally {
			host.dispose();
			first.close();
			second.close();
			scope.restore();
		}
	});

	it('pushes progress to the tabs that subscribed, and to no others', async () => {
		const scope = sharedWorkerScope();
		const host = sharedHostOver(freshName(), fakeChain(), 4);
		const first = attachTab(scope);
		const second = attachTab(scope);

		try {
			const seenByFirst: HostProgress[] = [];
			await new Promise<void>((resolve) => {
				first.port.onProgress((progress) => {
					seenByFirst.push(progress);
					if (progress.phase === 'at-tip') resolve();
				});
			});

			// The tab that asked was told, unprompted and more than once.
			expect(seenByFirst.length).toBeGreaterThan(1);
			expect(first.received.filter((message) => message.kind === 'push').length).toBeGreaterThan(0);
			// ...and the tab that did NOT ask was sent nothing at all: a host
			// broadcasting its pushes would be paying for a tab that is not watching.
			expect(second.received.filter((message) => message.kind === 'push')).toHaveLength(0);

			// The second tab subscribes, and from then on BOTH are told when the host
			// moves -- waited for as a VALUE on each tab's own wire, because two tabs
			// are two ports and the order two of them are reached in is nobody's
			// promise.
			const seenBySecond: HostProgress[] = [];
			let attached!: (progress: HostProgress) => void;
			const told = new Promise<HostProgress>((resolve) => (attached = resolve));
			const stoppedForSecond = new Promise<HostProgress>((resolve) => {
				second.port.onProgress((progress) => {
					seenBySecond.push(progress);
					attached(progress);
					if (!progress.indexing) resolve(progress);
				});
			});
			const stoppedForFirst = new Promise<HostProgress>((resolve) => {
				first.port.onProgress((progress) => {
					if (!progress.indexing) resolve(progress);
				});
			});
			// The answer to a SUBSCRIBE is where the fold is NOW, so a tab that
			// attached to a fold that has already finished -- and will therefore never
			// move again -- is correct anyway.
			expect((await told).phase).toBe('at-tip');
			const toldFirst = seenByFirst.length;

			await first.port.stopIndexing();

			expect((await stoppedForSecond).indexing).toBe(false);
			expect((await stoppedForFirst).indexing).toBe(false);
			expect(seenByFirst.length).toBeGreaterThan(toldFirst);
		} finally {
			host.dispose();
			first.close();
			second.close();
			scope.restore();
		}
	});

	/**
	 * ONE TAB GOING AWAY IS NOT THE HOST GOING AWAY.
	 *
	 * What closes is a tab's own end of a wire; the host it was talking to belongs
	 * to every tab that connected. So the fold goes on and the remaining tab is
	 * answered from it, which is the whole reason the shared shape is worth
	 * offering.
	 */
	it('goes on folding for the tab that stayed when another lets its port go', async () => {
		const databaseName = freshName();
		const chain = gatedChain(103);
		const scope = sharedWorkerScope();
		const host = sharedHostOver(databaseName, chain, 4);
		const first = attachTab(scope);
		const second = attachTab(scope);

		try {
			// Both tabs attached, and the fold HELD half way, so there is a middle of a
			// fold for the second tab to disappear in.
			await until(first.port, (progress) => progress.lastToBlock === 103);
			expect((await second.port.progress()).lastToBlock).toBe(103);

			second.close();
			chain.release();

			const progress = await untilAtTip(first.port);
			expect(progress.indexing).toBe(true);
			expect(await transfersAcross(first.port)).toBe(EXPECTED_A.transfers);
			expect(await stateFrom(databaseName)).toEqual(EXPECTED_A);
		} finally {
			host.dispose();
			first.close();
			scope.restore();
		}
	});

	/**
	 * THE LAST TAB LEAVING, AND THE TAB THAT COMES AFTERWARDS.
	 *
	 * A browser ends a SharedWorker once its last client is gone -- observed on all
	 * three engines (`browser/sharedWorkerServesSeveralTabs.spec.ts`) -- so what the
	 * next tab connects to is a host that knows NOTHING. That is the same position a
	 * restarted host is in, and it resumes the same way: the cursor is written in
	 * the same transaction as the block it describes (ADR-0027), so reading it and
	 * carrying on is the whole of it.
	 *
	 * Asserted on what the node was ASKED FOR, because the resulting state cannot
	 * tell the two apart: a host that re-indexed from the start block lands on
	 * exactly the same rows as one that resumed.
	 */
	it('leaves a store the tab that comes next resumes from rather than re-indexes', async () => {
		const databaseName = freshName();
		const before = sharedWorkerScope();
		const leaving = sharedHostOver(databaseName, fakeChain());
		const first = attachTab(before);
		await untilAtTip(first.port);
		// Every tab gone, and the host with them: a SharedWorker outlives one client
		// and not all of them.
		first.close();
		leaving.dispose();
		before.restore();

		const chain = fakeChain();
		const next = sharedWorkerScope();
		const arriving = sharedHostOver(databaseName, chain);
		const second = attachTab(next);
		try {
			const progress = await untilAtTip(second.port);

			expect(progress.lastToBlock).toBe(BRANCH_A_TIP);
			expect(chain.ranges.length).toBeGreaterThan(0);
			// NOTHING was asked for at or below the start block: it read the cursor and
			// carried on.
			expect(Math.min(...chain.ranges.map((range) => range.from))).toBeGreaterThan(START_BLOCK);
			expect(await stateFrom(databaseName)).toEqual(EXPECTED_A);
		} finally {
			arriving.dispose();
			second.close();
			next.restore();
		}
	});

	it('hands a tab the same surface the dedicated shape hands it', async () => {
		const scope = sharedWorkerScope();
		const host = sharedHostOver(freshName());
		const tab = attachTab(scope);

		try {
			// App code written against the port cannot tell which shape it reached:
			// there is no verb here the dedicated case does not have and none missing
			// (`test/aHostFoldsAndATabAsksHowFar.test.ts` asserts this same list).
			expect(Object.keys(tab.port).sort()).toEqual([
				'checkTxInclusion',
				'close',
				'generations',
				'host',
				'onHostDeath',
				'onProgress',
				'progress',
				'promotion',
				'reads',
				'reconfigure',
				'startIndexing',
				'stopIndexing',
			]);
		} finally {
			host.dispose();
			tab.close();
			scope.restore();
		}
	});
});

describe('the shared shape refuses what it cannot be', () => {
	/**
	 * A SHARED WORKER ENTRY IS NOT A MODULE A TAB IMPORTS, and it is not a
	 * DEDICATED worker's entry either.
	 *
	 * The second half is the one this shape adds, and it is worth a refusal of its
	 * own: the two helpers are one line apart in an app's entry point, the scopes
	 * differ in nothing an author can see, and a mix-up is silent -- a dedicated
	 * worker's `postMessage` does not exist in a shared scope, and a shared scope's
	 * `connect` never fires in a dedicated one, so what an app would observe is a
	 * host that never answers.
	 */
	it('refuses to host the indexer anywhere that is a document', () => {
		const scope = globalThis as {window?: unknown};
		scope.window = {};
		try {
			expect(() => hostIndexerInThisSharedWorker({} as never)).toThrow(/must be called from INSIDE a SharedWorker/);
		} finally {
			delete scope.window;
		}
	});

	it('refuses to host the indexer where nothing can CONNECT to it', () => {
		// node's main thread: not a document, and no `connect` interface either.
		expect(() => hostIndexerInThisSharedWorker({} as never)).toThrow(/no `connect`/);
	});

	it('sends each helper to the other when the scope is the other one', () => {
		const shared = sharedWorkerScope();
		try {
			// A shared worker's scope has no `postMessage` of its own, so this is where
			// the dedicated helper lands when an entry point calls the wrong one.
			expect(() => hostIndexerInThisWorker({} as never)).toThrow(/hostIndexerInThisSharedWorker/);
		} finally {
			shared.restore();
		}
	});

	/**
	 * A RUNTIME WITHOUT SHAREDWORKER IS TOLD SO, and is not quietly given
	 * something else.
	 *
	 * The refusal names the missing constructor and the shape that works
	 * everywhere. What it deliberately does NOT do is fall back to a dedicated
	 * worker: the shape is a DEPLOYMENT decision an app made at construction (one
	 * store connection, no election), and swapping it silently would change how
	 * many writers an app has without saying so. Which rung a ladder falls back to
	 * is `one-tab-indexes-and-the-others-read`'s decision, not this call's.
	 */
	it('refuses the shared shape on a runtime that has no SharedWorker at all', () => {
		expect(() => sharedWorkerHost(() => undefined as never)).toThrow(/no SharedWorker/);
	});

	it('hands the port the worker\u2019s own message port, and lets the host go on living', () => {
		const channel = new MessageChannel();
		const built: unknown[] = [];
		const scope = globalThis as {SharedWorker?: unknown};
		// A stand-in for the constructor a browser provides, so the SHAPE can be
		// checked where there is no browser: what it has to get right is which
		// object becomes the wire, and what `close` is allowed to do to the host.
		scope.SharedWorker = class {
			readonly port = channel.port2;
			closed = false;
			addEventListener() {}
			constructor() {
				built.push(this);
			}
		};
		try {
			const access = sharedWorkerHost(() => new (scope.SharedWorker as new () => never)());
			expect(access.host).toBe('shared-worker');
			expect(access.endpoint).toBe(channel.port2 as unknown as MessageEndpoint);
			expect(built).toHaveLength(1);

			// A SharedWorker cannot be terminated by a client and must not be: it is
			// serving every other tab. So `close` releases THIS tab's port, and the
			// access has no verb that could do more -- which is also why `quiesced` is
			// nothing to this shape: there is no kill for it to gate.
			access.close?.({quiesced: false});
			// ...and obtaining a port AGAIN is asking the app's own factory again,
			// which for this shape reaches the host that is already running where one
			// is (the URL and the name are what identify it).
			const again = access.reopen?.();
			expect(built).toHaveLength(2);
			expect(again?.host).toBe('shared-worker');
		} finally {
			delete scope.SharedWorker;
			channel.port1.close();
			channel.port2.close();
		}
	});
});
