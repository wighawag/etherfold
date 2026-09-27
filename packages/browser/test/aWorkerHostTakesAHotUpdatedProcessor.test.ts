import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {EntityEventProcessor, type EntityProcessor, type EntityStateView} from '@etherfold/processor-entities';
import {MemoryStateStore, openForWriting, type WritableStateStore} from '@etherfold/state-store';
import type {ReconfigureReport} from '@etherfold/core';
import {
	connectToIndexerHost,
	createBrowserStateStore,
	hostIndexerInThisSharedWorker,
	keepStreamOnIndexedDB,
	serveIndexerHost,
	type HostAccess,
	type HostProgress,
	type IndexerHost,
	type IndexerPort,
	type MessageEndpoint,
} from '../src/index.js';
import {moduleProcessorIdentity} from '../src/moduleIdentity.js';
import {wire} from './utils/port.js';
import {sharedWorkerScope} from './utils/sharedWorkerScope.js';
import {
	BRANCH_A_TIP,
	EXPECTED_A,
	editedProcessorVariant,
	fakeChain,
	FINALITY,
	processorVariant,
	SOURCE,
	START_BLOCK,
	type TestABI,
} from '../browser/workload.js';

/**
 * A WORKER HOST TAKES A HOT-UPDATED PROCESSOR: the warm swap of the guide's axis
 * one, where the fold runs in a worker.
 *
 * Under Vite a module worker is an HMR client of its own
 * (`work/notes/findings/a-module-worker-receives-hmr-under-vite.md`), so the
 * edited module arrives INSIDE the worker, at the worker entry's own
 * `import.meta.hot.accept`, and what that handler needs is a verb on the host to
 * hand it to. That verb is `IndexerHost.reconfigureFromHotUpdate`, and these
 * drive it directly, as the main-thread suite drives the free function
 * (`anHmrUpdateReconfiguresTheTab.test.ts`, which is the ORACLE: same verdicts,
 * same fold-beside, same switch on catch-up).
 *
 * What is only observable HERE is that the tab, which did not make the call and
 * holds nothing but a port, SEES the verdict: it rides the progress push.
 *
 * The host is given a stream KEEPER, as the main-thread suite gives its hook one:
 * a processor change is a new generation over the SAME stream, so the successor
 * FOLLOWS the stored stream, fetches not one log, and re-folds it.
 */

let counter = 0;
const freshName = () => `hot-updated-host-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

/** The spec a worker entry hands its host: code, a keeper, and (here) the chain and the source too. */
function entrySpec(databaseName: string, chain: ReturnType<typeof fakeChain>) {
	const running = processorVariant();
	return {
		createState: async (context: {stream: string}) =>
			openForWriting(
				await createBrowserStateStore(running.entities, {databaseName: `${databaseName}-${context.stream}`}),
			),
		createProcessor: (store: WritableStateStore) => new EntityEventProcessor<TestABI>(store, running),
		keepStream: keepStreamOnIndexedDB<TestABI>(`${databaseName}-stream`),
		provider: chain.provider,
		source: SOURCE,
		config: {stream: {finality: FINALITY}},
		tipIntervalInSeconds: 0.05,
	};
}

/**
 * WHAT A WORKER ENTRY'S OWN HOT-UPDATE HANDLER HANDS ITS HOST: the two factories
 * over the module it was handed, and nothing else. The successor gets a store of
 * its OWN, because it folds beside the incumbent.
 */
function handingOver(definition: EntityProcessor<TestABI>) {
	return {
		createState: async () => openForWriting(new MemoryStateStore(definition.entities)),
		createProcessor: (state: WritableStateStore) => new EntityEventProcessor<TestABI>(state, definition),
	};
}

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, attempts = 400): Promise<T> {
	let value = await read();
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (matches(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
		value = await read();
	}
	throw new Error(`never got there: ${JSON.stringify(value)}`);
}

const atTip = (port: IndexerPort) =>
	until(
		() => port.progress(),
		(progress) => progress.latestBlock === BRANCH_A_TIP && progress.lastToBlock === progress.latestBlock,
	);

const canonicalOf = async (port: IndexerPort) =>
	(await port.generations()).find((generation) => generation.canonical)?.record.processor;

const transfersOf = async (port: IndexerPort) =>
	(await port.reads.getCurrent('counter', {name: 'transfers'})) as {value: number} | undefined;

/** Every progress push a tab received, so a case can ask what it was TOLD rather than what it asked. */
function pushesTo(port: IndexerPort): HostProgress[] {
	const seen: HostProgress[] = [];
	port.onProgress((progress) => seen.push(progress));
	return seen;
}

/** A dedicated-worker host at the tip, with a tab holding a port to it. */
async function aHostAtTheTip() {
	const ends = wire();
	const chain = fakeChain();
	const host: IndexerHost<TestABI, EntityStateView> = serveIndexerHost<TestABI, EntityStateView>(
		entrySpec(freshName(), chain),
		ends.host,
	);
	const port = connectToIndexerHost(ends.tab);
	const pushed = pushesTo(port);
	await atTip(port);
	return {
		chain,
		host,
		port,
		pushed,
		close() {
			host.dispose();
			port.close();
			ends.close();
		},
	};
}

describe('a dedicated-worker host takes a hot-updated processor', () => {
	it('folds the edit beside the live generation, which answers until the edit catches up', async () => {
		const app = await aHostAtTheTip();
		try {
			const incumbent = await canonicalOf(app.port);
			// A fold that re-fetched its history would ask for the start block again.
			const fromTheStart = () => app.chain.ranges.filter((range) => range.from === START_BLOCK).length;
			const fetchedFromTheStart = fromTheStart();
			// Held still, so "the incumbent answers throughout" is observed rather than raced.
			await app.port.stopIndexing();

			const report = await app.host.reconfigureFromHotUpdate(handingOver(editedProcessorVariant({countBy: 10})));

			expect(report.outcome).toBe('registered');
			if (report.outcome !== 'registered') throw new Error('unreachable');
			expect(report.arrival).toBe('hot-update');
			expect(report.generation.processor).not.toBe(incumbent);
			// NOT AN OUTAGE: two generations, and the one answering is the one that was
			const generations = await app.port.generations();
			expect(generations.length).toBe(2);
			expect(await canonicalOf(app.port)).toBe(incumbent);
			expect((await transfersOf(app.port))?.value).toBe(EXPECTED_A.transfers);

			// and once it has caught up, the edit is what answers
			await app.port.startIndexing();
			await until(
				() => canonicalOf(app.port),
				(canonical) => canonical === report.generation.processor,
			);
			await until(
				() => transfersOf(app.port),
				(counter) => counter?.value === EXPECTED_A.transfers * 10,
			);
			// WARM: the successor re-folded the stream that was already stored, and asked the
			// chain for none of its history
			expect(fromTheStart()).toBe(fetchedFromTheStart);
		} finally {
			app.close();
		}
	});

	it('tells the tab the verdict over the port, as the main thread reports it', async () => {
		const app = await aHostAtTheTip();
		try {
			const report = await app.host.reconfigureFromHotUpdate(handingOver(editedProcessorVariant({countBy: 2})));

			// the tab did not make the call and still learns what it did: on the push
			const told = await until(
				async () => app.pushed.at(-1),
				(progress) => progress?.hotUpdate !== undefined,
			);
			expect(told?.hotUpdate).toEqual({count: 1, report});
			// and on asking
			expect((await app.port.progress()).hotUpdate).toEqual({count: 1, report});
		} finally {
			app.close();
		}
	});

	it('names the swapped-in fold by what the WORKER instantiated, never by a value handed in', async () => {
		const app = await aHostAtTheTip();
		try {
			const edited = editedProcessorVariant({countBy: 3});
			const report = await app.host.reconfigureFromHotUpdate(handingOver(edited));
			if (report.outcome !== 'registered') throw new Error(`expected registered, got ${JSON.stringify(report)}`);
			// the module arrival's own derivation, over the processor the host built
			const built = new EntityEventProcessor<TestABI>(new MemoryStateStore(edited.entities) as never, edited);
			expect(report.generation.processor).toBe(moduleProcessorIdentity(built));
		} finally {
			app.close();
		}
	});

	it('answers `unchanged` for the fold it is already running, and registers nothing', async () => {
		const app = await aHostAtTheTip();
		try {
			const before = await app.port.generations();
			const report = await app.host.reconfigureFromHotUpdate(handingOver(processorVariant()));

			expect(report.outcome).toBe('unchanged');
			if (report.outcome !== 'unchanged') throw new Error('unreachable');
			expect(report.generation.processor).toBe(before[0].record.processor);
			expect(report.message).toContain('nothing was registered');
			expect((await app.port.generations()).length).toBe(before.length);
			await until(
				() => app.port.progress(),
				(progress) => progress.hotUpdate?.report.outcome === 'unchanged',
			);
		} finally {
			app.close();
		}
	});

	it('answers `failed` for a save that does not build, and the host folds and answers as it was', async () => {
		const app = await aHostAtTheTip();
		try {
			const before = await app.port.generations();
			const report = await app.host.reconfigureFromHotUpdate({
				createState: async () => openForWriting(new MemoryStateStore(processorVariant().entities)),
				createProcessor: () => {
					throw new SyntaxError(`Unexpected token '}' (the developer saved mid-edit)`);
				},
			});

			expect(report.outcome).toBe('failed');
			if (report.outcome !== 'failed') throw new Error('unreachable');
			expect(report.message).toContain('saved mid-edit');
			expect(await app.port.generations()).toEqual(before);
			expect((await transfersOf(app.port))?.value).toBe(EXPECTED_A.transfers);
			const progress = await app.port.progress();
			expect(progress.failure).toBeUndefined();
			expect(progress.indexing).toBe(true);
			expect(progress.hotUpdate).toEqual({count: 1, report});

			// and the next save repairs it
			const repaired = await app.host.reconfigureFromHotUpdate(handingOver(editedProcessorVariant()));
			expect(repaired.outcome).toBe('registered');
			expect((await app.port.progress()).hotUpdate?.count).toBe(2);
		} finally {
			app.close();
		}
	});
});

describe('a SharedWorker host takes a hot-updated processor', () => {
	/** One tab of the shared host, over a real `MessagePort` of its own. */
	function attachTab(scope: ReturnType<typeof sharedWorkerScope>): {port: IndexerPort; close: () => void} {
		const channel = new MessageChannel();
		const tabEnd = channel.port2 as unknown as MessageEndpoint;
		scope.connect(channel.port1 as unknown as MessageEndpoint);
		const access: HostAccess = {host: 'shared-worker', endpoint: tabEnd, close: () => channel.port2.close()};
		const port = connectToIndexerHost(access);
		return {
			port,
			close: () => {
				port.close();
				channel.port1.close();
			},
		};
	}

	it('takes ONE update for every tab it serves, and every tab sees the verdict and the switch', async () => {
		const scope = sharedWorkerScope();
		const chain = fakeChain();
		let host: IndexerHost<TestABI, EntityStateView> | undefined;
		const tabs: {port: IndexerPort; close: () => void}[] = [];
		try {
			host = hostIndexerInThisSharedWorker<TestABI, EntityStateView>(entrySpec(freshName(), chain));
			tabs.push(attachTab(scope), attachTab(scope));
			const told = tabs.map((tab) => pushesTo(tab.port));
			await atTip(tabs[0].port);

			const report: ReconfigureReport = await host.reconfigureFromHotUpdate(
				handingOver(editedProcessorVariant({countBy: 10})),
			);
			if (report.outcome !== 'registered') throw new Error(`expected registered, got ${JSON.stringify(report)}`);

			for (const [index, tab] of tabs.entries()) {
				await until(
					async () => told[index].at(-1),
					(progress) => progress?.hotUpdate?.count === 1,
				);
				expect(told[index].at(-1)?.hotUpdate?.report).toEqual(report);
				await until(
					() => canonicalOf(tab.port),
					(canonical) => canonical === report.generation.processor,
				);
				await until(
					() => transfersOf(tab.port),
					(counter) => counter?.value === EXPECTED_A.transfers * 10,
				);
			}
			// ONE host, so ONE successor: not a generation per tab
			expect((await tabs[1].port.generations()).length).toBeLessThanOrEqual(2);
		} finally {
			host?.dispose();
			for (const tab of tabs) tab.close();
			scope.restore();
		}
	});
});
