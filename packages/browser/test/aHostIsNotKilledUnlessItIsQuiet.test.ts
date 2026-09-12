import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, EntityStateView} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	serveIndexerHost,
	type HostAccess,
	type IndexerHost,
} from '../src/index.js';
import {FINALITY, fakeChain, processor, SOURCE, type TestABI} from '../browser/workload.js';
import {wire} from './utils/port.js';

/**
 * A HOST IS ONLY KILLED WHEN IT IS KNOWN TO BE QUIET.
 *
 * The port used to release a host by killing it, on both paths: the tab calling
 * `close()`, and a death concluded from silence. For a dedicated worker that
 * meant `Worker.terminate()`, and the justification was that a worker belongs to
 * the tab that made it, so killing it costs nothing.
 *
 * It can cost the user their local index. Ending a worker that has a `readwrite`
 * and a `readonly` IndexedDB transaction in flight can leave that database
 * PERMANENTLY unable to run any transaction on WebKit -- no reload and no new tab
 * recovers it, and `deleteDatabase` never completes
 * (`work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`).
 * And the host most likely to be killed is the one most likely to be busy, since
 * a death is concluded from a host that did not answer.
 *
 * So the port now establishes quiet before it lets go, and says whether it
 * managed to: `close({quiesced})`. What is asserted here is that the flag is
 * TRUE only when it was earned -- the host answered `stopIndexing`, which is a
 * promise that the cycle in flight landed and no other will start -- and FALSE
 * for a host that answered nothing at all.
 *
 * The kill itself belongs to the shape (`dedicatedWorkerHost` declines unless
 * `quiesced`), which is why this asserts the flag rather than a `terminate` call:
 * the port's job is to know, the shape's job is to act.
 */

let counter = 0;
const freshName = () => `quiet-host-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

function hostOn(access: HostAccess, databaseName: string): IndexerHost {
	const chain = fakeChain();
	return serveIndexerHost<TestABI, EntityStateView>(
		{
			createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
			provider: chain.provider,
			source: SOURCE,
			config: {stream: {finality: FINALITY}},
			tipIntervalInSeconds: 0.05,
		},
		access,
	);
}

describe('a host is not killed unless it is quiet', () => {
	it('asks the host to STOP before releasing it, and reports quiesced', async () => {
		const link = wire();
		const host = hostOn(link.host, freshName());
		const released: {quiesced: boolean}[] = [];

		const port = connectToIndexerHost(
			{...link.tab, close: (state) => released.push(state)},
			{watch: {everyInSeconds: 0.25}},
		);
		// The host is alive and answering before the close, which is the case this
		// exists for: an app unmounting is the commonest way a worker is ended
		// mid-fold.
		expect((await port.progress()).host).toBeTypeOf('string');

		port.close();
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(released).toEqual([{quiesced: true}]);
		// ...and it really stopped, rather than the port merely saying so.
		expect((await host.progress()).indexing).toBe(false);

		host.dispose();
		link.close();
	});

	it('reports NOT quiesced for a host that answers nothing, rather than killing it anyway', async () => {
		const link = wire();
		const host = hostOn(link.host, freshName());
		const released: {quiesced: boolean}[] = [];

		const port = connectToIndexerHost(
			{...link.tab, close: (state) => released.push(state)},
			{watch: {everyInSeconds: 0.1}},
		);
		await port.progress();

		// Stops answering, exactly as an evicted worker does, and tells nobody.
		host.dispose();
		port.close();
		await new Promise((resolve) => setTimeout(resolve, 400));

		expect(released).toEqual([{quiesced: false}]);
		link.close();
	});

	it('does not kill a host it merely SUSPECTS is dead', async () => {
		const link = wire();
		const host = hostOn(link.host, freshName());
		const released: {quiesced: boolean}[] = [];

		const port = connectToIndexerHost(
			// No `reopen`, so the death is concluded and reported and nothing restarts:
			// what is under test is the release, not the restart.
			{...link.tab, close: (state) => released.push(state)},
			{watch: {everyInSeconds: 0.1}},
		);
		await port.progress();

		const died = new Promise<void>((resolve) => port.onHostDeath(() => resolve()));
		host.dispose();
		await died;

		// A concluded death releases the corpse and says it is NOT quiet, because
		// nothing is known about what it had in flight. A shape that would otherwise
		// terminate declines on that.
		expect(released).toEqual([{quiesced: false}]);

		port.close();
		link.close();
	});

	it('closes cleanly when the access has nothing to release', async () => {
		const link = wire();
		const host = hostOn(link.host, freshName());
		const port = connectToIndexerHost({host: 'main-thread', endpoint: link.tabEndpoint}, {watch: false});
		await port.progress();
		expect(() => port.close()).not.toThrow();
		host.dispose();
		link.close();
	});
});
