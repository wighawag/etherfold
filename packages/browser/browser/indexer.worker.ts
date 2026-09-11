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

hostIndexerInThisWorker<TestABI, EntityStateView>({
	// The store is opened for WRITING here, in the host. That is the writer/reader
	// split reaching across the boundary: the tab holds a port, and a port names no
	// mutating verb.
	createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
	createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
	provider: fakeChain().provider,
	source: SOURCE,
	config: {
		stream: {finality: FINALITY},
		...(fetchWidth > 0 ? {fetch: {numBlocksToFetchAtStart: fetchWidth, maxBlocksPerFetch: fetchWidth}} : {}),
	},
	// The fixture's tip never moves, so there is nothing to wait four seconds for.
	tipIntervalInSeconds: 0.25,
});
