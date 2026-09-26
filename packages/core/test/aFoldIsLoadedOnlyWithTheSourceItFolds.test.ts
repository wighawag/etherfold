import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {openIndexer, type AnyGenerationSpec} from '../src/container.js';
import {openMemoryGenerationRegistry} from '../src/generation/memory.js';
import {IndexerGeneration} from '../src/indexer.js';
import type {ReceivingIndexer} from '../src/receivingContainer.js';
import type {EventProcessor, IndexingSource, LogEvent, StoredLogEvent, WireBatch} from '../src/types.js';
import {identityOf, markerOf} from './utils/processorIdentity.js';
import {
	abi,
	AT_101,
	batch,
	SOURCE,
	START_BLOCK,
	world,
	type MemoryStore,
	type TestABI,
} from './utils/receivingWorld.js';
import {BRANCH_A, BRANCH_A_TIP, FINALITY, idOf, makeLog, SOURCE as CHAIN_SOURCE} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------------------------------
// A FOLD IS LOADED ONLY WITH THE SOURCE IT FOLDS, and a cursor READ never calls `load`
// ---------------------------------------------------------------------------------------------------
// `EventProcessor.load(source, streamConfig)` hands a processor a source, and neither shipped
// implementation (`EntityEventProcessor`, `VersionedStateEventProcessor`) chooses its cursor by
// it. So a container that read a fold's cursor with the WRONG source -- its own rather than the
// fold's -- would be a contract violation that no shipped processor could reveal. That was the
// shape once: the receiving container's promotion trigger read a successor's cursor through
// `load` with the CONTAINER's source (measured 2026-09-16).
//
// These suites measure it with a processor that DOES honour the argument: a double that answers
// `undefined` from `load` for any source other than the one it folds under, and records every
// source it was handed. Over a real registry and real state, an incumbent and a successor on a
// DIFFERENT contract (so a different source and a different stream), the successor still
// catches up and is PROMOTED, every `load` of every fold names that fold's own source, and
// reading the cursors -- the promotion trigger, the status report -- calls `load` not at all.
// ---------------------------------------------------------------------------------------------------

type Loaded = {marker: string; address: string};

/** The one contract a source names in these worlds, which is what tells two sources apart. */
function addressOf<A extends Abi>(source: IndexingSource<A>): string {
	return (source.contracts as readonly {address: string}[])[0]?.address.toLowerCase() ?? '';
}

/**
 * A processor that HONOURS `load`'s `source`: for any source but its own it answers
 * `undefined`, which is what a fold that keys its cursor by source would answer for a source it
 * never folded under. Every call is recorded, so a wrong-source read shows up twice: as an
 * `undefined` cursor that holds the pointer, and in the log.
 */
function honouringSource<A extends Abi, R>(
	marker: string,
	inner: EventProcessor<A, R>,
	own: IndexingSource<A>,
	loads: Loaded[],
): EventProcessor<A, R> {
	return {
		...inner,
		load: async (source, streamConfig) => {
			loads.push({marker, address: addressOf(source)});
			if (addressOf(source) !== addressOf(own)) return undefined;
			return inner.load(source, streamConfig);
		},
	};
}

// ---------------------------------------------------------------------------------------------------
// THE RECEIVING CONTAINER (server, CLI)
// ---------------------------------------------------------------------------------------------------

type Container = ReceivingIndexer<TestABI, string[], MemoryStore>;

/** ANOTHER CONTRACT, so another fetch filter and therefore another stream. */
const OTHER_SOURCE: IndexingSource<TestABI> = {
	chainId: '1',
	contracts: [{abi, address: '0x0000000000000000000000000000000000000098', startBlock: START_BLOCK}],
};

async function aReceivingWorld() {
	const w = world();
	const loads: Loaded[] = [];
	const honouring = (marker: string, own: IndexingSource<TestABI>) => {
		const spec = w.specFor(marker, 1);
		return {
			...spec,
			source: own,
			createProcessor: (state: MemoryStore) => honouringSource(marker, spec.createProcessor(state), own, loads),
		};
	};
	const indexer = await w.open('v1', 1, {generation: honouring('v1', SOURCE)});
	return {w, indexer, loads, honouring};
}

/** Push one batch onto a stream through that stream's own writer. */
async function pushTo(indexer: Container, stream: string, toBlock: number, logs: LogEvent<TestABI>[]) {
	const writer = (await indexer.fetchedStreams()).find((one) => one.stream === stream)?.writer;
	if (!writer) throw new Error(`nothing here writes the stream ${stream}`);
	const fromBlock = await writer.expectedFromBlock();
	const wire: WireBatch<TestABI> = {
		...batch(indexer, {toBlock, latestBlock: toBlock, logs}, fromBlock),
		context: writer.context,
	};
	await writer.receive(wire);
}

async function settle(indexer: Container): Promise<void> {
	for (let round = 0; round < 20; round++) {
		const reports = await indexer.rebuildMore();
		if (reports.every((report) => report.complete)) return;
	}
}

describe('the receiving container loads each fold with the source it folds, and PROMOTES a successor on its own source', () => {
	it('promotes a filter-change successor even when its processor answers nothing for a source it never folded under', async () => {
		const {indexer, loads, honouring} = await aReceivingWorld();
		const oldStream = indexer.streamDigest;
		await pushTo(indexer, oldStream, 110, [AT_101]);

		const successor = await indexer.add(honouring('v2', OTHER_SOURCE));
		expect(successor.record.stream).not.toBe(oldStream);
		await pushTo(indexer, successor.record.stream, 110, []);
		await settle(indexer);

		expect((await indexer.canonical())?.processor).toBe(identityOf('v2'));
		// and EVERY load either fold was ever handed named that fold's own contract
		expect(loads.length).toBeGreaterThan(0);
		for (const load of loads) {
			expect(load, `${load.marker} was loaded with the source of ${load.address}`).toEqual({
				marker: load.marker,
				address: addressOf(load.marker === 'v1' ? SOURCE : OTHER_SOURCE),
			});
		}
	});

	it('uses a double that would have caught the wrong source: handed the container’s source, it answers nothing', async () => {
		const {w, indexer, honouring} = await aReceivingWorld();
		const successor = await indexer.add(honouring('v2', OTHER_SOURCE));
		await pushTo(indexer, successor.record.stream, 110, []);
		await settle(indexer);

		// the successor HAS a cursor, read by its own source...
		expect(await successor.processor.load(OTHER_SOURCE, indexer.streamConfig)).toBeDefined();
		// ...and none by the container's, which is what the trigger was once handed
		expect(await successor.processor.load(SOURCE, indexer.streamConfig)).toBeUndefined();
		expect(w.stores.size).toBeGreaterThan(0);
	});

	it('reads the cursors it compares and reports WITHOUT calling `load`', async () => {
		const {indexer, loads, honouring} = await aReceivingWorld();
		await pushTo(indexer, indexer.streamDigest, 110, [AT_101]);
		await indexer.add({...honouring('v2', OTHER_SOURCE)});
		await settle(indexer);
		const before = loads.length;

		// the status report and a manual pointer move both read cursors
		await indexer.folding();
		await indexer.slots();
		await indexer.promote({stream: indexer.held()[1]?.record.stream ?? '', processor: identityOf('v2')});

		expect(loads.slice(before)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------------
// THE CHAIN-FACING CONTAINER (browser, `openIndexer`)
// ---------------------------------------------------------------------------------------------------

const ADDRESS_B = '0x0000000000000000000000000000000000000002';
const CHAIN_SOURCE_B: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: ADDRESS_B, startBlock: START_BLOCK}],
};

/** A fold that keeps a list and its cursor in memory, so `load` has something to answer. */
function listFold(): EventProcessor<Abi, string[]> {
	let state: string[] = [];
	let lastSync: Parameters<EventProcessor<Abi, string[]>['process']>[1] | undefined;
	return {
		getCodeFingerprint: () => undefined,
		load: async () => (lastSync ? {state, lastSync} : undefined),
		process: async (events, next) => {
			for (const event of events) state.push(idOf(event));
			lastSync = next;
			return state;
		},
		reset: async () => {
			state = [];
			lastSync = undefined;
		},
		clear: async () => {
			state = [];
			lastSync = undefined;
		},
	};
}

async function aChainFacingWorld() {
	const loads: Loaded[] = [];
	const chain: Record<string, StoredLogEvent[]> = {
		[addressOf(CHAIN_SOURCE)]: [...BRANCH_A],
		[ADDRESS_B]: [makeLog(101, '0xc101'), makeLog(103, '0xc103')],
	};
	const provider = {
		async request(args: {method: string}): Promise<unknown> {
			if (args.method === 'eth_chainId') return '0x1';
			if (args.method === 'eth_blockNumber') return `0x${BRANCH_A_TIP.toString(16)}`;
			throw new Error(`unexpected method ${args.method}`);
		},
	} as never;
	const specFor = (marker: string, own: IndexingSource<Abi>, named: boolean): AnyGenerationSpec<Abi, string[]> => ({
		...(named ? {source: own} : {}),
		processorIdentity: identityOf(marker),
		createState: () => ({marker}),
		createProcessor: () => honouringSource(marker, listFold(), own, loads),
		stateOf: () => [],
	});
	const registry = await openMemoryGenerationRegistry({maxGenerations: 4, maxStreams: 2});
	const indexer = await openIndexer<Abi, string[]>({
		registry,
		provider,
		source: CHAIN_SOURCE,
		config: {stream: {finality: FINALITY}},
		generations: [specFor('A', CHAIN_SOURCE, false)],
		createGeneration: (generationProvider, processor, source, config, processorIdentity) => {
			const generation = new IndexerGeneration<Abi, string[]>(generationProvider, processor, source, config, {
				processorIdentity,
			});
			(generation as unknown as {logEventFetcher: unknown}).logEventFetcher = {
				async getLogEvents({fromBlock, toBlock}: {fromBlock: number; toBlock: number}) {
					const logs = chain[addressOf(source)] ?? [];
					return {
						events: logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
						toBlockUsed: toBlock,
					};
				},
				reparse: (events: StoredLogEvent[]) => events.map((event) => ({...event})),
			};
			return generation;
		},
	});
	return {indexer, loads, add: (marker: string) => indexer.add(specFor(marker, CHAIN_SOURCE_B, true))};
}

describe('the chain-facing container loads each fold with the source it folds, and PROMOTES a successor on its own source', () => {
	it('promotes a filter-change successor with a source-honouring processor, and every load named the fold’s own source', async () => {
		const {indexer, loads, add} = await aChainFacingWorld();
		await indexer.load();
		for (let round = 0; round < 5; round++) await indexer.indexMore();

		await add('B');
		for (let round = 0; round < 10; round++) await indexer.indexMore();

		expect(markerOf(indexer.canonical.record.processor)).toBe('B');
		expect(loads).toContainEqual({marker: 'A', address: addressOf(CHAIN_SOURCE)});
		expect(loads).toContainEqual({marker: 'B', address: ADDRESS_B});
		for (const load of loads) {
			expect(load.address, `${load.marker} was loaded with another fold's source`).toBe(
				load.marker === 'A' ? addressOf(CHAIN_SOURCE) : ADDRESS_B,
			);
		}
	});

	it('reads the cursor the trigger compares from what each engine reported, never through `load`', async () => {
		const {indexer, loads, add} = await aChainFacingWorld();
		await indexer.load();
		await add('B');
		const before = loads.length;

		for (let round = 0; round < 10; round++) await indexer.indexMore();

		// ten cycles of the trigger, and a promotion among them, and not one `load` beyond each
		// engine's own first one
		expect(markerOf(indexer.canonical.record.processor)).toBe('B');
		expect(loads.slice(before).filter((load) => load.marker === 'A')).toEqual([]);
		expect(loads.slice(before).filter((load) => load.marker === 'B').length).toBeLessThanOrEqual(1);
	});
});
