/**
 * THE WORKER ENTRY POINT AN APP WRITES, IN BOTH HOSTING SHAPES AT ONCE.
 *
 * `indexer.worker.ts` beside this file is the dedicated case's entry and is what
 * an app actually writes: five lines, one helper. This one is deliberately BOTH
 * entries, selected by the scope it finds itself in, and that is the whole reason
 * it exists: one build, one `worker.js`, loaded once as a `Worker` and once as a
 * `SharedWorker`, so "what runs inside the host is unchanged between the two
 * shapes" is demonstrated by there being ONE FILE rather than asserted by
 * reading two.
 *
 * An app writes ONE of the two calls at the bottom. It is not asked to branch,
 * and nothing in this package branches on a shape either -- `serve.ts` is handed
 * a wire and never learns where it came from.
 *
 * Everything above the two calls is FIXTURE: a captured stream instead of a node,
 * a gate the page can hold the fold at, and a running report of what was fetched.
 * An application needs none of it. The reasons each of those exists are in
 * `indexer.worker.ts`, which introduced them; what differs here is only that they
 * speak to SEVERAL clients, because a shared host has several.
 */
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {
	createBrowserStateStore,
	hostIndexerInThisSharedWorker,
	hostIndexerInThisWorker,
	type HostedIndexerSpec,
} from '../src/index.js';
import {FINALITY, fakeChain, processor, SOURCE, type TestABI} from './workload.js';

const asked = new URL(self.location.href).searchParams;

/**
 * WHICH SHAPE THIS SCRIPT WAS LOADED AS, measured rather than configured.
 *
 * A `SharedWorkerGlobalScope` is the scope with a `connect` interface, and it is
 * the only one: a window and a dedicated worker scope both answer `false` here
 * (observed on all three engines). The package's own helpers make the same check
 * to REFUSE the wrong scope; this fixture makes it to pick the right call.
 */
const shared = 'onconnect' in globalThis;

/**
 * WHICH DATABASE, from this worker's own URL and its own NAME.
 *
 * The name is half of a SharedWorker's identity (the script URL is the other
 * half), so folding it into the database name is what makes "two apps on one
 * origin get different workers" observable without two hosts contending for one
 * store: a second name is a second host, and it writes somewhere else. A
 * dedicated worker is unnamed here, so its database is exactly the `db`
 * parameter.
 */
const scopeName = (self as unknown as {name?: string}).name ?? '';
const databaseName = `${asked.get('db') ?? 'etherfold-hosted-indexer'}${scopeName ? `-${scopeName}` : ''}`;

/** How wide a range this run fetches, so a case has more than one advance to watch. */
const fetchWidth = Number(asked.get('fetch') ?? '0');

/** The fetches that would take the fold above this block are HELD until a page lets them go. */
const holdAbove = Number(asked.get('holdAbove') ?? '0');

/**
 * WHICH HOST THIS IS, as a page can recognise it.
 *
 * Created once per script execution, so it answers the question this task's whole
 * claim rests on: two tabs reporting the SAME value are attached to ONE host, and
 * a tab that reports a different one after every tab went away is attached to a
 * host the browser started afresh. It is the fixture's own evidence and crosses
 * none of the package's own surfaces: the port has no case for "which instance
 * are you", because an app has no use for one.
 */
const instance = Math.random().toString(36).slice(2, 8);

/** Every range the node was asked for, cumulative, so a tab that attached late learns them all. */
const fetched: {from: number; to: number}[] = [];

/**
 * THE PAGES ATTACHED TO THIS HOST, as the fixture talks to them.
 *
 * The shared shape is handed a port per client, so the fixture keeps its own list
 * and says everything to everybody: a page asserting "one fold ran" has to be
 * able to see what the fold did, and which page happened to connect first is not
 * something a case should depend on. The dedicated shape has exactly one wire and
 * it is the worker's own scope.
 *
 * This traffic is NOT the port's, and it works for the reason the dedicated
 * fixture's does: a message that is not the port's own is IGNORED rather than
 * answered, at both ends.
 */
const clients: MessagePort[] = [];

function tell(message: Record<string, unknown>): void {
	const said = {fixture: 'shared', instance, ...message};
	if (!shared) {
		(self as unknown as {postMessage(value: unknown): void}).postMessage(said);
		return;
	}
	for (const client of clients) client.postMessage(said);
}

const gate = openable(holdAbove > 0);

function openable(held: boolean): {passed: Promise<void>; open: () => void} {
	if (!held) return {passed: Promise.resolve(), open: () => undefined};
	let open!: () => void;
	const passed = new Promise<void>((resolve) => (open = resolve));
	return {passed, open};
}

function hear(event: MessageEvent): void {
	const message = event.data as {fixture?: string} | null;
	if (message?.fixture !== 'release') return;
	gate.open();
}

if (shared) {
	(
		self as unknown as {addEventListener(type: 'connect', listener: (event: MessageEvent) => void): void}
	).addEventListener('connect', (event) => {
		const port = (event as unknown as {ports: MessagePort[]}).ports[0];
		clients.push(port);
		port.addEventListener('message', hear);
		port.start();
		// A tab that attached half way through a fold is told what the fold has
		// already done, for the same reason the port answers a subscribe with the
		// current progress: otherwise it can only learn what happens next.
		port.postMessage({fixture: 'shared', instance, fetched: [...fetched]});
	});
} else {
	self.addEventListener('message', hear);
}

/** The fixture chain behind that gate, reporting every range it is asked for. */
const chain = fakeChain();
const gatedProvider = {
	async request(args: {method: string; params?: unknown}): Promise<unknown> {
		if (args.method === 'eth_getLogs') {
			const range = args.params as [{fromBlock: string; toBlock: string}];
			if (holdAbove > 0 && parseInt(range[0].toBlock.slice(2), 16) > holdAbove) await gate.passed;
			fetched.push({
				from: parseInt(range[0].fromBlock.slice(2), 16),
				to: parseInt(range[0].toBlock.slice(2), 16),
			});
			tell({fetched: [...fetched]});
		}
		return (chain.provider as unknown as {request(args: unknown): Promise<unknown>}).request(args);
	},
} as unknown as typeof chain.provider;

/**
 * WHAT AN APP HANDS ITS HOST, and the reason this file can be both entries: the
 * spec is the SAME VALUE in either shape.
 *
 * The processor crosses as an IMPORT and never as a message, the provider is
 * built here because an EIP-1193 provider is an object with methods, and the
 * store is opened for WRITING here, which is what makes the host the writer and
 * every tab a reader. None of that is different in a shared worker.
 */
const spec: HostedIndexerSpec<TestABI, EntityStateView> = {
	createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
	createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
	provider: gatedProvider,
	source: SOURCE,
	config: {
		stream: {finality: FINALITY},
		...(fetchWidth > 0 ? {fetch: {numBlocksToFetchAtStart: fetchWidth, maxBlocksPerFetch: fetchWidth}} : {}),
	},
	// The fixture's tip never moves, so there is nothing to wait four seconds for.
	tipIntervalInSeconds: 0.25,
};

// THE ONE LINE THAT DIFFERS, and the whole of the difference. An app writes one of
// these two; this fixture writes both so that one build can be loaded as either.
if (shared) {
	hostIndexerInThisSharedWorker<TestABI, EntityStateView>(spec);
} else {
	hostIndexerInThisWorker<TestABI, EntityStateView>(spec);
}
