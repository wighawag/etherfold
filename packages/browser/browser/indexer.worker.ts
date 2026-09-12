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
import {openForWriting} from '@etherfold/state-store';
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
		return (chain.provider as {request(args: unknown): Promise<unknown>}).request(args);
	},
} as unknown as typeof chain.provider;

hostIndexerInThisWorker<TestABI, EntityStateView>({
	// The store is opened for WRITING here, in the host. That is the writer/reader
	// split reaching across the boundary: the tab holds a port, and a port names no
	// mutating verb.
	createState: async (context) =>
		openForWriting(await createBrowserStateStore(processor.entities, {databaseName: databaseFor(context.stream)})),
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
