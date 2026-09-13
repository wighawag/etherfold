import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {connectToIndexerHost, createBrowserStateStore, serveIndexerHost} from '../src/index.js';
import {FINALITY, fakeChain, processor, SOURCE, type TestABI} from '../browser/workload.js';
import {wire} from './utils/port.js';

let counter = 0;
const freshName = () => `claim-patience-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * THE HOST HANDS ITS PATIENCE TO THE FACTORY, so an application does not have to
 * invent a number to avoid waiting for ever.
 *
 * The seam refuses to default a timeout, and is right to: there is none that
 * suits a cold mobile browser, a contended database and a server at once. A HOST
 * is a different proposition, because it already owns every other cadence here --
 * the watch interval, the restart backoff, the tip interval -- so the number has
 * an owner, and `createState` is handed a signal cut to it.
 *
 * What is asserted is the reach rather than the mechanism: the signal ARRIVES, it
 * is live, it fires on the host's schedule and not before, and a factory that
 * forwards it gets a typed refusal that becomes something the tab can read.
 *
 * It is a CONVENTION and cannot be more. The host cannot see the claim inside an
 * application's factory, and wrapping the factory itself would put a ten-second
 * limit on a snapshot install, which would refuse healthy deployments on every
 * engine. So the last case here pins the other half honestly: a factory that
 * ignores the signal is still valid and still waits.
 */
describe('a host hands its patience to the state factory', () => {
	it('gives createState a live signal, cut to the host and not yet fired', async () => {
		const link = wire();
		const chain = fakeChain();
		const seen: AbortSignal[] = [];
		const host = serveIndexerHost<TestABI, EntityStateView>(
			{
				createState: async (_context, {signal}) => {
					seen.push(signal);
					return openForWriting(await createBrowserStateStore(processor.entities, {databaseName: freshName()}));
				},
				createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
				provider: chain.provider,
				source: SOURCE,
				config: {stream: {finality: FINALITY}},
				tipIntervalInSeconds: 0.05,
			},
			link.host,
		);
		const port = connectToIndexerHost(link.tab, {watch: false});
		await port.progress();
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeInstanceOf(AbortSignal);
		// A healthy claim is single-digit milliseconds, so the default patience is
		// nowhere near spent and the store opened normally.
		expect(seen[0].aborted).toBe(false);

		port.close();
		host.dispose();
		link.close();
	});

	it('turns a claim that never lands into a REFUSAL the tab can read', async () => {
		const link = wire();
		const chain = fakeChain();
		const host = serveIndexerHost<TestABI, EntityStateView>(
			{
				// A storage that never answers, which is what a wedged IndexedDB database
				// is. The factory forwards the signal, exactly as every documented example
				// does, and that is the whole of what an application has to do.
				createState: async (_context, {signal}) => {
					const store = await createBrowserStateStore(processor.entities, {databaseName: freshName()});
					store.clearSeamRecord = () => new Promise<void>(() => undefined);
					return openForWriting(store, {signal});
				},
				createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
				provider: chain.provider,
				source: SOURCE,
				config: {stream: {finality: FINALITY}},
				tipIntervalInSeconds: 0.05,
				claimWithinSeconds: 0.1,
			},
			link.host,
		);
		const port = connectToIndexerHost(link.tab, {watch: false});

		let progress = await port.progress();
		for (let attempt = 0; attempt < 100 && !progress.failure; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			progress = await port.progress();
		}

		// NOT `waiting`, which is what this used to be for ever.
		expect(progress.phase).toBe('refused');
		expect(progress.failure?.name).toBe('StoreClaimAbandonedError');

		port.close();
		host.dispose();
		link.close();
	});

	it('still accepts a factory that ignores the signal, because it is the app-s code', async () => {
		const link = wire();
		const chain = fakeChain();
		const host = serveIndexerHost<TestABI, EntityStateView>(
			{
				// The one-argument shape every existing application already has.
				createState: async () =>
					openForWriting(await createBrowserStateStore(processor.entities, {databaseName: freshName()})),
				createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
				provider: chain.provider,
				source: SOURCE,
				config: {stream: {finality: FINALITY}},
				tipIntervalInSeconds: 0.05,
			},
			link.host,
		);
		const port = connectToIndexerHost(link.tab, {watch: false});
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect((await port.progress()).failure).toBeUndefined();

		port.close();
		host.dispose();
		link.close();
	});
});
