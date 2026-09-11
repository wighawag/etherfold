/**
 * THE WORKER ENTRY POINT AN APP WRITES, for the read fixture.
 *
 * The same five lines as `indexer.worker.ts` -- import the processor, import this
 * package's entry helper, call it -- over the declarations the read-surface cases
 * are asked about (`readWorkload.ts`). It is a second file rather than a branch
 * inside the first because a worker entry is what an APP writes, and an entry
 * that switched processors on a query parameter would demonstrate something no
 * application does.
 *
 * The store is opened for WRITING here, in the host. What the tab gets is a port,
 * and the four reads on it are served from this store.
 */
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {createBrowserStateStore, hostIndexerInThisWorker} from '../src/index.js';
import {readEntities, readProcessor} from './readWorkload.js';
import {FINALITY, fakeChain, SOURCE, type TestABI} from './workload.js';

/** Fresh per run, so an engine's leftovers from a previous run are never what a case reads. */
const databaseName = new URL(self.location.href).searchParams.get('db') ?? 'etherfold-tab-reads';

hostIndexerInThisWorker<TestABI, EntityStateView>({
	createState: async () => openForWriting(await createBrowserStateStore(readEntities, {databaseName})),
	createProcessor: (store) => new EntityEventProcessor<TestABI>(store, readProcessor),
	provider: fakeChain().provider,
	source: SOURCE,
	config: {stream: {finality: FINALITY}},
	// The fixture's tip never moves, so there is nothing to wait four seconds for.
	tipIntervalInSeconds: 0.25,
});
