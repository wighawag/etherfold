/**
 * THE WORKER ENTRY POINT AN APP WRITES, and the whole of it.
 *
 * This file is the claim `a-handful-of-lines` makes, demonstrated rather than
 * stated: import the processor, import this package's entry helper, call it. The
 * PROCESSOR crosses as an IMPORT and never as a message, because it is code and
 * closures (ADR-0082) -- which is also what keeps it inside the app's own
 * bundler, type-checked against the same ABI the tab uses and sharing one copy of
 * its dependencies.
 *
 * The provider is built here for the same reason. An EIP-1193 provider is an
 * object with methods; a tab cannot hand one across a port, so the chain
 * connection belongs where the fold is. In an application this is a URL from its
 * configuration; here it is the captured stream every other test in this package
 * indexes, so that what this worker produces is comparable, log for log, with
 * what the main-thread path produces from the same bytes.
 *
 * WHAT THE PAGE LOADS is `worker.js`, the bundle the harness builds from this
 * module (`mountHarness({worker})`). An application writes
 * `new Worker(new URL('./indexer.worker.ts', import.meta.url), {type: 'module'})`
 * and its bundler builds the same thing from the same source.
 */
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {openForWriting, type WritableStateStore} from '@etherfold/state-store';
import {createBrowserStateStore, hostIndexerInThisWorker} from '../src/index.js';
import {FINALITY, fakeChain, processor, SOURCE, type TestABI} from './workload.js';

/**
 * WHICH database, from this worker's own URL.
 *
 * An application hard-codes its database name or reads it from its build
 * configuration; the harness gives every run a fresh one so that an engine's
 * leftovers from a previous run are never what a case reads.
 */
const databaseName = new URL(self.location.href).searchParams.get('db') ?? 'etherfold-hosted-indexer';

/**
 * HOW WIDE A RANGE this run fetches, where a case wants the fold to take several
 * advances rather than one.
 *
 * An application states this in its own configuration; it is a query parameter
 * here for the same reason the database name is -- the harness owns the URL, and
 * a case that wants to watch progress ADVANCE needs the fixture's five blocks to
 * arrive in more than one piece. Unset by default, so every other case fetches
 * exactly as it always did. It must stay ABOVE `FINALITY`: a range narrower than
 * the unconfirmed window re-asks for the blocks it already has and the cursor
 * never moves.
 */
const fetchWidth = Number(new URL(self.location.href).searchParams.get('fetch') ?? '0');

/**
 * WHETHER EACH GENERATION FOLDS INTO A DATABASE OF ITS OWN.
 *
 * The container's rule is that a generation's state is keyed on
 * `context.stream`: two generations under one storage location are ONE store, so
 * their rows and their cursors collide, and the whole point of a reconfigure --
 * the live generation going on answering complete old answers while the new one
 * catches up -- does not survive that. An application that reconfigures keys it
 * unconditionally, and the CONTROL case here asks for it.
 *
 * It is a parameter rather than the default in this fixture for one fixture-only
 * reason: the cases that predate the control surface read the worker's database
 * back BY NAME from the page, and a page cannot guess a stream digest. Unset, the
 * name is exactly what it always was.
 */
const perGeneration = new URL(self.location.href).searchParams.has('generations');
const databaseFor = (stream: string) => (perGeneration ? `${databaseName}-${stream}` : databaseName);

/**
 * A FOLD THE PAGE CAN HOLD STILL, for the cases whose claim is about WHEN an
 * answer was asked for.
 *
 * `checkTxInclusion` is a SNAPSHOT, so "the verdict changed as the fold advanced"
 * needs the fold to be somewhere KNOWN when the question is asked -- which a
 * fixture chain that answers instantly does not provide. Two gates, both unset
 * by default, so every other case runs exactly as it always did:
 *
 * - `holdChain` holds EVERYTHING, so the container never opens and the host has
 *   no cursor at all;
 * - `holdAbove=N` holds the fetches that would take the fold above block `N`.
 *
 * The page releases them by posting to the worker DIRECTLY, which is the one
 * thing here that is not the port -- and it works precisely because the envelope
 * says a message that is not ours must be IGNORED rather than answered (a worker
 * scope receives whatever anybody posts to it). An application has no need for
 * any of this: its chain is a real node, and a real node takes its time on its
 * own.
 */
const holdChain = new URL(self.location.href).searchParams.has('holdChain');
const holdAbove = Number(new URL(self.location.href).searchParams.get('holdAbove') ?? '0');

/**
 * SAY WHAT THIS WORKER FETCHED AND WHAT IT WROTE, straight at the page.
 *
 * What it is for is the only question a RESTART raises that the resulting state
 * cannot answer: a host that re-ran the load lands on exactly the same rows as
 * one that resumed, so "did it re-index from the start block" is a question about
 * the RANGES it asked the node for. A worker's own memory dies with it, so the
 * ranges have to leave the worker as they happen -- and a message already
 * delivered survives the `terminate()` that follows it.
 *
 * The WRITE announcements are what let a page kill a host DURING a store write,
 * which is the case where "the cursor is written in the same transaction as the
 * block it describes" (ADR-0027) earns its keep. Terminating between cycles would
 * never exercise it.
 *
 * Posted DIRECTLY rather than over the port, like the gate releases above, and it
 * works for the same reason: a message that is not the port's own is IGNORED
 * rather than answered. Unset by default, so every other case's wire is exactly
 * what it always was.
 */
/**
 * HOW LONG THIS FIXTURE WAITS FOR THE WRITER CLAIM, in seconds.
 *
 * An application states its own; it is a query parameter here because one case
 * deliberately wedges a database and needs the refusal to arrive inside a test's
 * patience rather than a user's. Ten seconds by default, which is far longer than
 * any healthy claim on any engine and far shorter than for ever.
 */
const claimWithinSeconds = Number(new URL(self.location.href).searchParams.get('claimWithin') ?? '10');

const reports = new URL(self.location.href).searchParams.has('report');
const report = (message: Record<string, unknown>) => {
	if (reports) self.postMessage({fixture: 'worker', ...message});
};

/**
 * The store, saying when it is about to write a block and when that write landed.
 *
 * A PROXY rather than a subclass, because what is being wrapped is the handle
 * `openForWriting` hands back and the point is to change nothing about it: every
 * other method is the store's own, bound to the store itself so that a backend's
 * private fields still work.
 */
function announcingWrites(store: WritableStateStore): WritableStateStore {
	return new Proxy(store, {
		get(target, property) {
			const value = Reflect.get(target, property) as unknown;
			if (typeof value !== 'function') return value;
			if (property !== 'applyBlock') return value.bind(target);
			return async (...args: unknown[]) => {
				const block = args[0] as {number: number};
				report({wrote: 'starting', block: block?.number});
				const applied = await (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args);
				report({wrote: 'landed', block: block?.number});
				return applied;
			};
		},
	});
}

const gates = {chain: openable(holdChain), fetches: openable(holdAbove > 0)};

function openable(held: boolean): {passed: Promise<void>; open: () => void} {
	if (!held) return {passed: Promise.resolve(), open: () => undefined};
	let open!: () => void;
	const passed = new Promise<void>((resolve) => (open = resolve));
	return {passed, open};
}

self.addEventListener('message', (event: MessageEvent) => {
	const message = event.data as {fixture?: string; gate?: 'chain' | 'fetches'} | null;
	if (message?.fixture !== 'release') return;
	gates[message.gate ?? 'fetches'].open();
});

/** The fixture chain behind those gates. Ungated, it is the same provider every other case drives. */
const chain = fakeChain();
const gatedProvider = {
	async request(args: {method: string; params?: unknown}): Promise<unknown> {
		await gates.chain.passed;
		if (args.method === 'eth_getLogs' && holdAbove > 0) {
			const asked = args.params as [{toBlock: string}];
			if (parseInt(asked[0].toBlock.slice(2), 16) > holdAbove) await gates.fetches.passed;
		}
		if (args.method === 'eth_getLogs') {
			const asked = args.params as [{fromBlock: string; toBlock: string}];
			report({
				fetched: {
					from: parseInt(asked[0].fromBlock.slice(2), 16),
					to: parseInt(asked[0].toBlock.slice(2), 16),
				},
			});
		}
		return (chain.provider as {request(args: unknown): Promise<unknown>}).request(args);
	},
} as unknown as typeof chain.provider;

// The entry point was reached at all, which separates "the worker never started"
// from "the worker started and its store never opened".
report({probe: 'host-construct'});
hostIndexerInThisWorker<TestABI, EntityStateView>({
	// The store is opened for WRITING here, in the host. That is the writer/reader
	// split reaching across the boundary: the tab holds a port, and a port names no
	// mutating verb.
	// The store is opened for WRITING here, in the host. That is the writer/reader
	// split reaching across the boundary: the tab holds a port, and a port names no
	// mutating verb.
	//
	// THE PROBES ARE NOT SCAFFOLDING. Opening a store has three steps that fail
	// differently, and from outside the worker all three look identical -- a host
	// that says `waiting` for ever. Reporting each one is what turned an
	// intermittent WebKit timeout into a located defect: the store OPENS and the
	// claim never lands, which is what pointed at a wedged DATABASE rather than a
	// dead worker and led to the WebKit bug behind it (see the finding named in
	// `restartsAndResumes.spec.ts`). They stay because the next stall of this shape
	// should be diagnosable in one run instead of ten.
	createState: async (context) => {
		report({probe: 'store-open-start'});
		const raw = await createBrowserStateStore(processor.entities, {databaseName: databaseFor(context.stream)});
		report({probe: 'store-open-done'});
		// THE CLAIM IS BOUNDED, because a claim can hang: a WebKit database that was
		// wedged by a worker terminated mid-write never answers, and an unbounded wait
		// here is an app in `waiting` for ever with nothing to render (see the finding
		// named in `restartsAndResumes.spec.ts`). The refusal travels out of
		// `createState`, which the host turns into `phase: 'refused'` with a `failure`
		// the tab can read across the port. An application picks its own bound; this
		// one is short because a fixture's fold is a fixture's fold.
		const writable = await openForWriting(raw, {signal: AbortSignal.timeout(claimWithinSeconds * 1000)});
		report({probe: 'writer-claimed'});
		return announcingWrites(writable);
	},
	createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
	provider: gatedProvider,
	source: SOURCE,
	config: {
		stream: {finality: FINALITY},
		...(fetchWidth > 0 ? {fetch: {numBlocksToFetchAtStart: fetchWidth, maxBlocksPerFetch: fetchWidth}} : {}),
	},
	// The fixture's tip never moves, so there is nothing to wait four seconds for.
	tipIntervalInSeconds: 0.25,
});
