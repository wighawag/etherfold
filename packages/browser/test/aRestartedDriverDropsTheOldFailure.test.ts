import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {openForWriting} from '@etherfold/state-store';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	createIndexerState,
	serveIndexerHost,
	type HostAccess,
} from '../src/index.js';
import {wire} from './utils/port.js';
import {BRANCH_A_TIP, FINALITY, fakeChain, processor, SOURCE, type TestABI} from '../browser/workload.js';

/**
 * A DRIVER THAT IS STARTED AGAIN DROPS THE REFUSAL THAT STOPPED THE LAST ONE.
 *
 * `failure` describes the drive that STOPPED. It was only ever cleared when the
 * host was disposed, so a host that refused, and was then started again, reported
 * a phase that moved (`catching-up`, then `at-tip`) with the old failure still
 * attached to it. A tab rendering "something went wrong" from `progress.failure`
 * showed an error over a fold that was running perfectly well, and the only way
 * out was to throw the host away.
 *
 * Both drivers had it, because they are two implementations of one idea: the
 * worker host's `startIndexing` (`src/host/serve.ts`) and the main-thread host's
 * `startAutoIndexing` (`src/IndexerState.ts`). Both are pinned here, in one file,
 * so the next person to touch either can see that the other one exists.
 */

let counter = 0;
const freshName = () => `restarted-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** A refusal no amount of waiting fixes, which is what stops a driver for good. */
function refusal() {
	return Object.assign(new Error(`this node will not serve those logs`), {
		name: 'RefusedError',
		retryable: false,
	});
}

/**
 * A chain that refuses every `eth_getLogs` until it is FORGIVEN, then serves the
 * fixture normally. So one host can be made to stop on a refusal and then be
 * started again into a chain that works, which is the sequence being asserted.
 */
function forgivableChain() {
	const chain = fakeChain();
	let refusing = true;
	const underlying = chain.provider.request.bind(chain.provider);
	return {
		ranges: chain.ranges,
		forgive: () => {
			refusing = false;
		},
		provider: {
			async request(args: {method: string; params?: unknown}): Promise<unknown> {
				if (refusing && args.method === 'eth_getLogs') throw refusal();
				return underlying(args as never);
			},
		} as never,
	};
}

function hostOver(access: HostAccess, databaseName: string, chain: ReturnType<typeof forgivableChain>) {
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

async function until(satisfied: () => boolean | Promise<boolean>): Promise<void> {
	for (;;) {
		if (await satisfied()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('a driver started again after a refusal', () => {
	it('drops the failure the previous drive stopped on (the worker host)', async () => {
		const ends = wire();
		const chain = forgivableChain();
		const host = hostOver(ends.host, freshName(), chain);
		const port = connectToIndexerHost(ends.tab);

		try {
			// STOPPED, and saying why.
			await until(async () => (await port.progress()).phase === 'refused');
			const refused = await port.progress();
			expect(refused.failure?.name).toBe('RefusedError');
			expect(refused.indexing).toBe(false);

			// Started again into a chain that now answers.
			chain.forgive();
			await port.startIndexing();
			await until(async () => (await port.progress()).phase === 'at-tip');

			// The phase moved AND the failure went with it. Before this fix the host
			// reported `at-tip` with `failure` still set, which is two answers to one
			// question and the wrong one is the one an app renders.
			const running = await port.progress();
			expect(running.failure).toBeUndefined();
			expect(running.indexing).toBe(true);
			expect(running.lastToBlock).toBe(BRANCH_A_TIP);
		} finally {
			host.dispose();
			port.close();
			ends.close();
		}
	});

	it('drops it on the main-thread host too, which is the same wart in the other driver', async () => {
		const chain = forgivableChain();
		const databaseName = freshName();
		const indexer = createIndexerState<TestABI, EntityStateView>({
			createState: async () => openForWriting(await createBrowserStateStore(processor.entities, {databaseName})),
			createProcessor: (store) => new EntityEventProcessor<TestABI>(store, processor),
		});
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		await indexer.startAutoIndexing(0.05);
		// The THIRD hosting shape: the app's own indexer, reached as a port rather than
		// as a second container beside it (ADR-0082). `watch: false` because a
		// main-thread host cannot die independently of the tab holding it.
		const port = connectToIndexerHost(indexer.mainThreadHost(), {watch: false});

		try {
			await until(async () => (await port.progress()).phase === 'refused');
			expect((await port.progress()).failure?.name).toBe('RefusedError');

			chain.forgive();
			await indexer.startAutoIndexing(0.05);

			await until(async () => (await port.progress()).phase === 'at-tip');
			const running = await port.progress();
			expect(running.failure).toBeUndefined();
			expect(running.lastToBlock).toBe(BRANCH_A_TIP);
		} finally {
			port.close();
			indexer.dispose();
		}
	});
});
