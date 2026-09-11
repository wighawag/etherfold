import type {Abi} from 'abitype';
import {describe, expect, it, vi} from 'vitest';
import {openIndexer, type AnyGenerationSpec, type Indexer} from '../src/container.js';
import {openMemoryGenerationRegistry} from '../src/generation/memory.js';
import {sameGeneration, writerOf, type GenerationRecord} from '../src/generation/registry.js';
import {IndexerGeneration} from '../src/indexer.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import {streamDigestOf} from '../src/stream/identity.js';
import {readOnlyStream} from '../src/stream/readOnly.js';
import type {
	EventProcessor,
	ExistingStream,
	IndexingSource,
	ProvidedIndexerConfig,
	StoredLastSync,
	StoredLogEvent,
	UsedStreamConfig,
} from '../src/types.js';
import {
	ADDRESS,
	BRANCH_A,
	BRANCH_A_TIP,
	BRANCH_B,
	BRANCH_B_TIP,
	fakeChain,
	fakeProcessor,
	FINALITY,
	idOf,
	makeLog,
	memoryStream,
	shapeOf,
	SOURCE,
	START_BLOCK,
} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// A NON-CANONICAL GENERATION ADVANCES, AND HOW IT ADVANCES IS DETERMINED
// ---------------------------------------------------------------------------
// A generation is a stream plus a fold over it. WHETHER a second generation
// fetches is decided by whether it SHARES A STREAM with one already held, and by
// nothing else -- there is no knob here and there must never be one.
//
//   SAME stream  -> a FOLLOWER. It fetches NOTHING (zero, not fewer), writes no
//                   segment, re-folds the stored stream from the start and then
//                   follows it as the indexing generation appends.
//   OTHER stream -> an ordinary indexer at a different address. It fetches its
//                   own history, into its own keyspace.
//
// The zero matters for three reasons and the third is the load-bearing one: a
// follower with a poller of its own would make its state a function of ITS OWN
// FETCH rather than of the stream, so a later re-fold of the stored stream would
// yield a DIFFERENT state -- and a generation would stop being "a stream plus a
// fold over it", taking the exact-revert promise with it.
// ---------------------------------------------------------------------------

const ADDRESS_B = '0x0000000000000000000000000000000000000002';

/** A DIFFERENT FILTER, so a different stream: the logs it needs were never requested under the first. */
const SOURCE_B: IndexingSource<Abi> = {
	chainId: '1',
	contracts: [{abi: [] as unknown as Abi, address: ADDRESS_B, startBlock: START_BLOCK}],
};

/** What the node serves under the OTHER filter: different blocks, so a mix-up is visible. */
const BRANCH_C = [makeLog(101, '0xc101'), makeLog(103, '0xc103')];

const STREAM_CONFIG: UsedStreamConfig = resolveStreamConfig({finality: FINALITY});

function addressOf(source: IndexingSource<Abi>): string {
	return (source.contracts as readonly {address: string}[])[0].address;
}

/**
 * A stream keeper that ADDRESSES by stream digest, as the shipped one does.
 *
 * `memoryStream` stores one blob and ignores the source, which is right for the
 * engine's cache arithmetic and useless here: the whole question in the
 * separate-stream case is whether two filters land in two keyspaces. So this
 * keeps one bucket per `streamDigestOf(source, config)` and reports the buckets,
 * which is what "the two streams never share entries" is asserted against.
 */
function keyedStream() {
	type Stored = {lastSync: StoredLastSync; eventStream: StoredLogEvent[]};
	const stored = new Map<string, Stored>();
	const writes: {digest: string; events: StoredLogEvent[]}[] = [];
	let clears = 0;
	let streamConfig = resolveStreamConfig(undefined);
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
	const digestOf = (source: IndexingSource<Abi>) => streamDigestOf(source, streamConfig);

	const keeper: ExistingStream<Abi> = {
		setStreamConfig: (config) => {
			streamConfig = config;
		},
		fetchFrom: async (source, fromBlock) => {
			const held = stored.get(digestOf(source));
			return held
				? {
						status: 'stream' as const,
						eventStream: held.eventStream.filter((event) => event.blockNumber >= fromBlock),
						lastSync: clone(held.lastSync),
					}
				: {status: 'absent' as const};
		},
		saveNewEvents: async (source, {eventStream, lastSync}) => {
			const digest = digestOf(source);
			writes.push({digest, events: eventStream.map((event) => ({...event}))});
			const held = stored.get(digest);
			stored.set(digest, {
				lastSync: clone(lastSync),
				eventStream: [...(held?.eventStream ?? []), ...eventStream.map((event) => ({...event}))],
			});
		},
		clear: async (source) => {
			if (stored.delete(digestOf(source))) {
				clears++;
			}
		},
	};

	return {
		keeper,
		writes,
		get clears() {
			return clears;
		},
		digests: () => [...stored.keys()].sort(),
		eventsOf: (source: IndexingSource<Abi>) => stored.get(digestOf(source))?.eventStream ?? [],
		/** The stream's OWN cursor, which is the summary a follower must not trust. */
		cursorOf: (source: IndexingSource<Abi>) => stored.get(digestOf(source))?.lastSync,
	};
}

/**
 * The world: one provider, one keeper, and a per-generation FETCH RECORDER.
 *
 * The fetch seam is instrumented PER GENERATION and not once for the world,
 * because "the follower issued no `eth_getLogs`" is a claim about one
 * generation's calls, and a shared counter cannot make it.
 */
async function openWorld(specs: {name: string; source?: IndexingSource<Abi>}[]) {
	const chain = {logs: {[ADDRESS]: [...BRANCH_A], [ADDRESS_B]: [...BRANCH_C]} as Record<string, StoredLogEvent[]>};
	let tip = BRANCH_A_TIP;
	const stream = keyedStream();
	const folds = new Map<string, ReturnType<typeof fakeProcessor>>();
	const configs = new Map<string, ProvidedIndexerConfig<Abi>>();
	const fetches: {by: string; from: number; to: number}[] = [];
	// Re-decoding the stored stream is the FIRST thing an advance costs, so counting
	// it is how "an unchanged stream costs nothing" is asserted: a follower that
	// re-walks what it has already folded reparses it again.
	const reparses: string[] = [];

	const provider = {
		async request(args: {method: string}): Promise<unknown> {
			switch (args.method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_blockNumber':
					return `0x${tip.toString(16)}`;
			}
			throw new Error(`unexpected method ${args.method}`);
		},
	} as never;

	const specFor = (spec: {name: string; source?: IndexingSource<Abi>}): AnyGenerationSpec<Abi, string[]> => ({
		...(spec.source ? {source: spec.source} : {}),
		createState: () => ({name: spec.name}),
		createProcessor: () => {
			const fold = fakeProcessor();
			fold.processor.getVersionHash = () => `proc-${spec.name}`;
			folds.set(spec.name, fold);
			return fold.processor as EventProcessor<Abi, string[]>;
		},
		stateOf: () => [],
	});

	const registry = await openMemoryGenerationRegistry({maxGenerations: 4, maxStreams: 2});
	const indexer = await openIndexer<Abi, string[]>({
		registry,
		provider,
		source: SOURCE,
		config: {stream: {finality: FINALITY}, keepStream: stream.keeper, streamWriteRetry: {delaySeconds: 0}},
		generations: specs.map(specFor),
		createGeneration: (generationProvider, processor, source, config) => {
			const generation = new IndexerGeneration<Abi, string[]>(generationProvider, processor, source, config);
			const by = processor.getVersionHash();
			configs.set(by, config);
			(generation as unknown as {logEventFetcher: unknown}).logEventFetcher = {
				async getLogEvents({fromBlock, toBlock}: {fromBlock: number; toBlock: number}) {
					fetches.push({by, from: fromBlock, to: toBlock});
					const served = chain.logs[addressOf(source)] ?? [];
					return {
						events: served.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
						toBlockUsed: toBlock,
					};
				},
				reparse: (events: StoredLogEvent[]) => {
					reparses.push(by);
					return events.map((event) => ({...event}));
				},
			};
			return generation;
		},
	});

	return {
		indexer,
		stream,
		folds,
		configs,
		fetches,
		registry,
		serve(address: string, logs: StoredLogEvent[], newTip: number) {
			chain.logs[address] = logs;
			tip = newTip;
		},
		/** The chain moves on by one block, then ONE cycle: every generation steps once. */
		round: async (logs?: StoredLogEvent[]) => {
			if (logs) {
				chain.logs[ADDRESS] = logs;
			}
			tip = tip + 1;
			return indexer.indexMore();
		},
		fetchesBy: (name: string) => fetches.filter((call) => call.by === `proc-${name}`),
		reparsesBy: (name: string) => reparses.filter((who) => who === `proc-${name}`).length,
		batchesOf: (name: string) => folds.get(name)?.batches ?? [],
		heldOf: (name: string) => indexer.generations.find((entry) => entry.record.processor === `proc-${name}`),
		id: (name: string) => ({
			stream: indexer.generations.find((entry) => entry.record.processor === `proc-${name}`)?.record.stream as string,
			processor: `proc-${name}`,
		}),
		stateOf: (name: string) => folds.get(name)?.state ?? [],
		/** Build a generation BESIDE the ones already held, the way a reconfigure will. */
		add: (spec: {name: string; source?: IndexingSource<Abi>}) => indexer.add(specFor(spec)),
	};
}

async function driveToTip(indexer: Indexer<Abi, string[]>, maxRounds = 30): Promise<void> {
	let rounds = 0;
	let lastSync = await indexer.indexMore();
	while (lastSync.lastToBlock < lastSync.latestBlock) {
		if (rounds++ >= maxRounds) {
			throw new Error(`did not reach the tip in ${maxRounds} rounds (lastToBlock ${lastSync.lastToBlock})`);
		}
		lastSync = await indexer.indexMore();
	}
}

/**
 * FOLD THE STORED STREAM FROM SCRATCH, with no node and no writer.
 *
 * This is what "the successor's state is a function of the STREAM" is asserted
 * against: a generation built later, over the same stored stream, through the
 * same read-only view, must arrive at the same state.
 */
async function refoldStoredStream(stream: ReturnType<typeof keyedStream>, source = SOURCE): Promise<string[]> {
	const fold = fakeProcessor();
	fold.processor.getVersionHash = () => 'proc-refold';
	const provider = {
		async request(args: {method: string}): Promise<unknown> {
			if (args.method === 'eth_chainId') {
				return '0x1';
			}
			throw new Error(`a re-fold must not reach the node: ${args.method}`);
		},
	} as never;
	const generation = new IndexerGeneration<Abi, string[]>(provider, fold.processor, source, {
		stream: {finality: FINALITY},
		keepStream: readOnlyStream<Abi>(stream.keeper),
	});
	(generation as unknown as {logEventFetcher: unknown}).logEventFetcher = {
		getLogEvents: async () => {
			throw new Error('a re-fold must not fetch');
		},
		reparse: (events: StoredLogEvent[]) => events.map((event) => ({...event})),
	};
	await generation.load();
	return fold.state;
}

describe('a SHARED stream: the successor FOLLOWS and fetches nothing', () => {
	it('advances alongside the canonical generation, to the same state', async () => {
		const world = await openWorld([{name: 'A'}, {name: 'B'}]);

		await world.indexer.load();
		await driveToTip(world.indexer);

		// the canonical generation indexed the chain...
		expect(world.stateOf('A')).toEqual(BRANCH_A.map(idOf));
		// ...and the non-canonical one ADVANCED, which is the whole point
		expect(world.stateOf('B')).toEqual(world.stateOf('A'));
		expect(world.indexer.canonical.record.processor).toBe('proc-A');
	});

	it('issues NO `eth_getLogs` AT ALL: zero, not fewer', async () => {
		const world = await openWorld([{name: 'A'}, {name: 'B'}]);

		await world.indexer.load();
		await driveToTip(world.indexer);

		expect(world.fetchesBy('A').length).toBeGreaterThan(0);
		// a head-following poller would make this "fewer"; the criterion is ZERO
		expect(world.fetchesBy('B')).toEqual([]);
	});

	it('writes NO segment: only the indexing generation appends', async () => {
		const together = await openWorld([{name: 'A'}, {name: 'B'}]);
		await together.indexer.load();
		await driveToTip(together.indexer);

		const alone = await openWorld([{name: 'A'}]);
		await alone.indexer.load();
		await driveToTip(alone.indexer);

		// byte for byte what the canonical generation alone would have written
		expect(together.stream.writes).toEqual(alone.stream.writes);
		expect(together.stream.digests()).toEqual(alone.stream.digests());
		expect(together.stream.eventsOf(SOURCE).map(idOf)).toEqual(BRANCH_A.map(idOf));
		// nor did it CLEAR: the load path clears on every shape it cannot use, and a
		// follower taking one of those branches would delete the live history
		expect(together.stream.clears).toBe(0);
	});

	it('holds the stream through a READ-ONLY VIEW, so a write cannot reach the keeper', async () => {
		const world = await openWorld([{name: 'A'}, {name: 'B'}]);
		await world.indexer.load();
		await driveToTip(world.indexer);

		const follower = world.configs.get('proc-B')?.keepStream as ExistingStream<Abi>;
		const writer = world.configs.get('proc-A')?.keepStream as ExistingStream<Abi>;

		// the WRITER holds the keeper itself; the FOLLOWER holds a view of it
		expect(writer).toBe(world.stream.keeper);
		expect(follower).not.toBe(world.stream.keeper);

		const before = world.stream.writes.length;
		await follower.saveNewEvents(SOURCE, {
			eventStream: [makeLog(199, '0xdead')],
			lastSync: {
				context: {source: [], config: 'c', processor: 'proc-B'},
				latestBlock: 200,
				lastFromBlock: 199,
				lastToBlock: 199,
				unconfirmedBlocks: [],
			},
		});
		await follower.clear(SOURCE);

		expect(world.stream.writes.length).toBe(before);
		expect(world.stream.clears).toBe(0);
		expect(world.stream.eventsOf(SOURCE).map(idOf)).toEqual(BRANCH_A.map(idOf));
	});

	it('is DETERMINED by the shared stream and never configured', async () => {
		const shared = await openWorld([{name: 'A'}, {name: 'B'}]);
		expect(shared.indexer.generations.map((held) => held.follows)).toEqual([false, true]);
		// one stream, two generations: the second cannot be a second writer
		expect(shared.indexer.generations[0].record.stream).toBe(shared.indexer.generations[1].record.stream);

		const separate = await openWorld([{name: 'A'}, {name: 'B', source: SOURCE_B}]);
		expect(separate.indexer.generations.map((held) => held.follows)).toEqual([false, false]);
	});

	it('keeps ONE writer whichever way the two processor hashes sort (a PRECONDITION, see the note)', async () => {
		// READ THIS BEFORE ADDING A CASE HERE. This asserts a PRECONDITION, and it
		// cannot distinguish the container's rule from the one ADR-0071 rejected --
		// swapping `container.ts` back to `writerOf`-per-generation leaves this file, and
		// the whole core suite, green.
		//
		// That is not an oversight, it is the consequence of the fix. The two rules used
		// to differ only under a same-millisecond TIE, and ADR-0072 made ties impossible
		// (`createdAt` is strictly increasing within a registry), so the input that told
		// them apart can no longer be constructed through the public API. What survives
		// is a live tie case over the RECEIVING container in `rebuild.test.ts`, which
		// pins the ordering itself; if that ever goes, this file silently stops meaning
		// anything.
		//
		// The fixtures still sort against registration order, because that is the input
		// that used to discriminate and costs nothing to keep.
		const shared = await openWorld([{name: 'zzz-first'}, {name: 'aaa-second'}]);

		expect(shared.indexer.generations.map((held) => held.follows)).toEqual([false, true]);
		expect(shared.indexer.generations[0].record.stream).toBe(shared.indexer.generations[1].record.stream);
		expect(shared.indexer.generations.filter((held) => !held.follows)).toHaveLength(1);

		// the registry ordered them by REGISTRATION, so `writerOf` and the container
		// agree here rather than merely happening not to disagree
		const records = await shared.registry.list();
		expect(records[0].createdAt).toBeLessThan(records[1].createdAt);
		const named = writerOf(records, records[0].stream) as GenerationRecord;
		expect(sameGeneration(named, shared.indexer.generations[0].record)).toBe(true);
	});

	it('RE-FOLDS the stored stream from the start when it is added to a running indexer', async () => {
		const world = await openWorld([{name: 'A'}]);
		await world.indexer.load();
		await driveToTip(world.indexer);
		const writesBefore = world.stream.writes.length;

		// the successor arrives with the whole history already on disk
		const added = await world.add({name: 'B'});
		expect(added.follows).toBe(true);
		await world.indexer.load();

		// the load IS the re-fold: it arrives at the canonical state having fetched
		// nothing and written nothing
		expect(world.stateOf('B')).toEqual(BRANCH_A.map(idOf));
		expect(world.fetchesBy('B')).toEqual([]);
		expect(world.stream.writes.length).toBe(writesBefore);
		expect(world.stream.clears).toBe(0);
	});

	it('keeps following as the indexing generation appends, retractions included', async () => {
		const world = await openWorld([{name: 'A'}, {name: 'B'}]);
		await world.indexer.load();
		await driveToTip(world.indexer);

		// the chain reorgs at 104 and moves on
		world.serve(ADDRESS, [...BRANCH_B], BRANCH_B_TIP);
		await driveToTip(world.indexer);

		expect(world.stateOf('A')).toEqual(BRANCH_B.map(idOf));
		expect(world.stateOf('B')).toEqual(world.stateOf('A'));
		expect(world.fetchesBy('B')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// A PAUSED WRITER MOVES THE STREAM WITHOUT MOVING ITS CURSOR
// ---------------------------------------------------------------------------
// A pause caps `toBlock` at the cursor it paused on (ADR-0045), so a paused
// writer's `lastToBlock` is FROZEN while it re-scans a shrinking window -- and a
// reorg it detects at or below that cap is appended to the stream with the
// cursor never moving. A follower level with the cap therefore cannot ask "has
// this stream changed" by comparing cursors: the stream moved and the summary of
// it did not. What it asks instead is the stream ITSELF, which is the only
// answer that cannot lie about it.
// ---------------------------------------------------------------------------

/** Two generations over one stream, indexed to the tip of branch A, the WRITER then paused there. */
async function pausedWriterWithFollower() {
	const world = await openWorld([{name: 'A'}, {name: 'B'}]);
	await world.indexer.load();
	await driveToTip(world.indexer);

	expect(world.stateOf('A')).toEqual(BRANCH_A.map(idOf));
	expect(world.stateOf('B')).toEqual(BRANCH_A.map(idOf));

	world.indexer.pause(world.id('A'));
	expect(world.heldOf('A')?.pauseState).toBe('draining');
	return world;
}

/** Poll until the cap is final, bounded so a drain that never idles is a red line and not a hang. */
async function drainToIdle(world: Awaited<ReturnType<typeof pausedWriterWithFollower>>, maxRounds = 12) {
	for (let round = 0; round < maxRounds; round++) {
		if (world.heldOf('A')?.pauseState === 'drained') {
			return;
		}
		await world.round();
	}
	throw new Error(`the writer did not drain in ${maxRounds} rounds`);
}

describe('a PAUSED writer appends, and the follower follows THE STREAM and not the cursor', () => {
	it('replays a retraction appended below the cap, and lands where a from-scratch fold lands', async () => {
		const world = await pausedWriterWithFollower();

		await world.round(); // re-scan [102, 105]: nothing new
		await world.round([...BRANCH_B]); // the reorg at 104, which is BELOW the cap

		// the writer corrected itself and APPENDED both verdicts to the stream...
		expect(world.stateOf('A')).toEqual(BRANCH_B.map(idOf));
		expect(world.stream.eventsOf(SOURCE).map(shapeOf)).toEqual([
			...BRANCH_A.map(shapeOf),
			`R:${idOf(BRANCH_A[3])}`,
			`A:${idOf(BRANCH_B[3])}`,
		]);
		// ...while the stored CURSOR never moved: that frozen summary is exactly what
		// a follower comparing cursors would have believed
		expect(world.stream.cursorOf(SOURCE)?.lastToBlock).toBe(105);

		// THE REGRESSION: the follower replays them rather than keeping the dead branch
		expect(world.stateOf('B')).toEqual(BRANCH_B.map(idOf));
		expect(world.stateOf('B')).toEqual(world.stateOf('A'));
		// and it is the state the stream itself folds to, from scratch, with no writer
		expect(await refoldStoredStream(world.stream)).toEqual(world.stateOf('B'));
	});

	it('delivers the retraction and its replacement in the order the writer emitted them', async () => {
		const world = await pausedWriterWithFollower();
		await world.round();
		await world.round([...BRANCH_B]);

		const delivered = world.batchesOf('B').flat().map(shapeOf);
		expect(delivered.slice(-2)).toEqual([`R:${idOf(BRANCH_A[3])}`, `A:${idOf(BRANCH_B[3])}`]);
	});

	it('still fetches NOTHING and writes NOTHING while it does it', async () => {
		const world = await pausedWriterWithFollower();
		await world.round();
		await world.round([...BRANCH_B]);

		expect(world.fetchesBy('B')).toEqual([]);
		expect(world.stream.clears).toBe(0);
		// the one-writer rule: the stream holds the writer's emissions and nothing else
		expect(world.stream.digests()).toHaveLength(1);
		expect(world.stream.eventsOf(SOURCE)).toHaveLength(BRANCH_A.length + 2);
	});

	it('costs NOTHING while the stream is unchanged: no re-walk, nothing re-delivered', async () => {
		const world = await openWorld([{name: 'A'}, {name: 'B'}]);
		await world.indexer.load();
		await driveToTip(world.indexer);
		// the chain stands still: two cycles for the follower to settle level with the stream
		await world.indexer.indexMore();
		await world.indexer.indexMore();

		const reparses = world.reparsesBy('B');
		const batches = world.batchesOf('B').length;

		await world.indexer.indexMore();
		await world.indexer.indexMore();
		await world.indexer.indexMore();

		// not "fewer": an idle follower re-walks nothing and re-delivers nothing, which
		// is what makes this a replacement for the early return rather than its removal
		expect(world.reparsesBy('B')).toBe(reparses);
		expect(world.batchesOf('B').length).toBe(batches);
	});

	it('costs nothing beside a DRAINED writer either, whose stream has stopped moving', async () => {
		const world = await pausedWriterWithFollower();
		await drainToIdle(world);
		// the drained writer fetches nothing, so the stream stands still: two cycles to settle
		await world.round();
		await world.round();

		const reparses = world.reparsesBy('B');
		const batches = world.batchesOf('B').length;

		await world.round();
		await world.round();
		await world.round();

		expect(world.reparsesBy('B')).toBe(reparses);
		expect(world.batchesOf('B').length).toBe(batches);
		expect(world.fetchesBy('B')).toEqual([]);
	});

	it('behaves exactly as it does today when the writer is RUNNING', async () => {
		const world = await openWorld([{name: 'A'}, {name: 'B'}]);
		await world.indexer.load();
		await driveToTip(world.indexer);

		// the same reorg, with no cap anywhere: the path that was already correct
		world.serve(ADDRESS, [...BRANCH_B], BRANCH_B_TIP);
		await driveToTip(world.indexer);

		expect(world.stateOf('A')).toEqual(BRANCH_B.map(idOf));
		expect(world.stateOf('B')).toEqual(world.stateOf('A'));
		expect(world.batchesOf('B').flat().map(shapeOf).slice(-2)).toEqual([
			`R:${idOf(BRANCH_A[3])}`,
			`A:${idOf(BRANCH_B[3])}`,
		]);
		expect(world.fetchesBy('B')).toEqual([]);
		expect(await refoldStoredStream(world.stream)).toEqual(world.stateOf('B'));
	});

	it('leaves a RESUMED writer’s follower exactly where it was: it follows the uncapped stream too', async () => {
		const world = await pausedWriterWithFollower();
		await drainToIdle(world);

		// the chain moved on ABOVE the cap while the writer drained
		const branchC = [...BRANCH_A, makeLog(107, '0xc107')];
		world.indexer.resume(world.id('A'));
		expect(world.heldOf('A')?.pauseState).toBe('running');

		await world.round(branchC);
		await driveToTip(world.indexer);

		expect(world.stateOf('A')).toEqual(branchC.map(idOf));
		expect(world.stateOf('B')).toEqual(world.stateOf('A'));
		expect(world.fetchesBy('B')).toEqual([]);
		expect(await refoldStoredStream(world.stream)).toEqual(world.stateOf('B'));
	});
});

describe('the successor state is a function of the STREAM, not of its own fetch', () => {
	it('re-folding the stored stream LATER reproduces the follower state exactly', async () => {
		const world = await openWorld([{name: 'A'}, {name: 'B'}]);
		await world.indexer.load();
		await driveToTip(world.indexer);

		expect(await refoldStoredStream(world.stream)).toEqual(world.stateOf('B'));
	});

	it('still reproduces it after a reorg has been appended to the stream', async () => {
		const world = await openWorld([{name: 'A'}, {name: 'B'}]);
		await world.indexer.load();
		await driveToTip(world.indexer);
		world.serve(ADDRESS, [...BRANCH_B], BRANCH_B_TIP);
		await driveToTip(world.indexer);

		// story 4's promise: what a generation answers is what the stream says, so
		// moving the pointer back and re-folding are the same state
		expect(await refoldStoredStream(world.stream)).toEqual(world.stateOf('B'));
	});
});

describe('DIFFERENT streams: the successor fetches its own history', () => {
	it('fetches under its own filter and the two streams never share entries', async () => {
		const world = await openWorld([{name: 'A'}, {name: 'B', source: SOURCE_B}]);

		await world.indexer.load();
		await driveToTip(world.indexer);

		// it MUST fetch: the logs it needs were never requested under the old filter
		expect(world.fetchesBy('B').length).toBeGreaterThan(0);
		expect(world.stateOf('A')).toEqual(BRANCH_A.map(idOf));
		expect(world.stateOf('B')).toEqual(BRANCH_C.map(idOf));

		// two filters, two keyspaces, disjoint contents
		expect(world.stream.digests()).toHaveLength(2);
		expect(world.stream.eventsOf(SOURCE).map(idOf)).toEqual(BRANCH_A.map(idOf));
		expect(world.stream.eventsOf(SOURCE_B).map(idOf)).toEqual(BRANCH_C.map(idOf));
		const shared = world.stream
			.eventsOf(SOURCE)
			.map(idOf)
			.filter((id) => world.stream.eventsOf(SOURCE_B).map(idOf).includes(id));
		expect(shared).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// THE FOLLOWER'S QUESTION IS ABOUT CONTENT, NOT ABOUT COUNT
// ---------------------------------------------------------------------------
// `hasAlreadyFolded` is the whole of the follower's "is there anything new"
// shortcut (ADR-0049), and it is the piece that replaced a cursor comparison
// precisely because a SUMMARY of a stream can lie about it. A length check is
// another such summary: two slices of the same size are not the same slice, and
// a follower that skips on equal length alone would miss an emission superseded
// one-for-one -- the same class of miss, one level down.
//
// Pinned directly rather than through a driven world, because the scenario that
// distinguishes them is exactly the one a cursor cannot express: same count,
// different content. The mutation this kills is deleting the comparison loop and
// keeping the length guard, which the whole core suite otherwise passes.
// ---------------------------------------------------------------------------

/** Exposes the two protected members that ARE the shortcut, so it can be pinned directly. */
class FollowerUnderTest extends IndexerGeneration<Abi> {
	setFolded(events: StoredLogEvent[] | undefined) {
		this.followedEmissions = events?.map(
			(event) => `${event.blockHash}:${event.logIndex}:${event.removed ? 'R' : 'A'}`,
		);
	}
	alreadyFolded(events: StoredLogEvent[]): boolean {
		return this.hasAlreadyFolded(events);
	}
}

describe('the follower decides on the emissions themselves', () => {
	function follower() {
		const provider = {
			async request({method}: {method: string}) {
				if (method === 'eth_chainId') return '0x1';
				throw new Error(`unexpected ${method}`);
			},
		};
		return new FollowerUnderTest(provider as any, fakeProcessor().processor as any, SOURCE, {
			stream: {finality: FINALITY},
		});
	}

	it('is FOLDED only when the slice is emission-for-emission what it folded', () => {
		const f = follower();
		const slice = [makeLog(101, '0xa101'), makeLog(102, '0xa102')];
		f.setFolded(slice);
		expect(f.alreadyFolded([makeLog(101, '0xa101'), makeLog(102, '0xa102')])).toBe(true);
	});

	it('is NOT folded when an emission was superseded ONE FOR ONE, so the count did not move', () => {
		// the case a length check cannot see, and the reason the comparison exists
		const f = follower();
		f.setFolded([makeLog(101, '0xa101'), makeLog(102, '0xa102')]);
		expect(f.alreadyFolded([makeLog(101, '0xa101'), makeLog(102, '0xb102')])).toBe(false);
	});

	it('is NOT folded when the same block is now a RETRACTION at the same position', () => {
		// identical hash, identical index, opposite meaning: the emission mark carries
		// the application/retraction bit for exactly this
		const f = follower();
		f.setFolded([makeLog(101, '0xa101')]);
		const retracted: StoredLogEvent = {...makeLog(101, '0xa101'), removed: true};
		expect(f.alreadyFolded([retracted])).toBe(false);
	});

	it('is NOT folded when the slice is REORDERED, though it holds the same emissions', () => {
		const f = follower();
		f.setFolded([makeLog(101, '0xa101'), makeLog(101, '0xa101', 1)]);
		expect(f.alreadyFolded([makeLog(101, '0xa101', 1), makeLog(101, '0xa101')])).toBe(false);
	});

	it('is NOT folded when nothing has been folded yet, which is the safe direction', () => {
		const f = follower();
		f.setFolded(undefined);
		expect(f.alreadyFolded([makeLog(101, '0xa101')])).toBe(false);
	});

	it('is NOT folded when the slice changed LENGTH either', () => {
		const f = follower();
		f.setFolded([makeLog(101, '0xa101')]);
		expect(f.alreadyFolded([makeLog(101, '0xa101'), makeLog(102, '0xa102')])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// THE PROVIDER MUST NOT HAVE CHANGED CHAINS UNDER THE FETCH
// ---------------------------------------------------------------------------
// The chain is checked ONCE per cycle, AFTER the fetch, and that one call is the
// guard (ADR-0081). It catches a provider that moved DURING the fetch, which is
// the case where logs from the wrong chain are in hand and about to be written --
// the only one of the two that can produce a corrupt fold. The before-fetch call
// that used to sit beside it caught nothing this one does not; it only failed
// fast, so a provider that moved BETWEEN cycles now pays for a range it will not
// keep and is refused a moment later, with the same nothing reaching the fold.
//
// Both outcomes are pinned below, and so is the CALL COUNT: restoring the deleted
// call for symmetry must fail here rather than pass quietly.
// ---------------------------------------------------------------------------

describe('a provider that changes chain mid-cycle', () => {
	/** A chain whose `eth_chainId` answer can be moved, including from inside the fetch. */
	function movableChain(logs: StoredLogEvent[], tip: number) {
		const base = fakeChain(logs, tip);
		let chainId = '0x1';
		let flipDuringFetch: string | undefined;
		// The cycle's ORDER of operations, which is what "after the fetch and before
		// anything is applied" is asserted against: a count alone cannot say WHERE the
		// surviving call sits. `eth_blockNumber` is left out because the tip read is not
		// what these tests are about.
		const trace: string[] = [];
		return {
			...base,
			trace,
			/** Drop what `load()` cost, so the trace that follows is ONE cycle's. */
			forgetCalls() {
				trace.length = 0;
			},
			setChainId(next: string) {
				chainId = next;
			},
			/** The provider moves WHILE the logs are being fetched, which is the dangerous case. */
			flipDuringFetchTo(next: string) {
				flipDuringFetch = next;
			},
			provider: {
				async request(args: {method: string; params?: any}): Promise<any> {
					if (args.method === 'eth_chainId') {
						trace.push('eth_chainId');
						return chainId;
					}
					return base.provider.request(args);
				},
			} as any,
			fetcher: {
				async getLogEvents(range: {fromBlock: number; toBlock: number}) {
					trace.push('eth_getLogs');
					const result = await base.fetcher.getLogEvents(range);
					if (flipDuringFetch) {
						chainId = flipDuringFetch;
					}
					return result;
				},
				reparse: base.fetcher.reparse,
			},
		};
	}

	function indexerOn(chain: ReturnType<typeof movableChain>) {
		const processor = fakeProcessor();
		const fold = processor.processor.process.bind(processor.processor);
		processor.processor.process = async (events: any, lastSync: any) => {
			chain.trace.push('fold');
			return fold(events, lastSync);
		};
		// A keeper, so "nothing from the wrong chain reached the STREAM" is a claim about
		// something rather than about an absent seam.
		const stream = memoryStream();
		const keeper: ExistingStream<Abi> = {
			...stream.keeper,
			saveNewEvents: async (source, data) => {
				chain.trace.push('stream write');
				return stream.keeper.saveNewEvents(source, data);
			},
		};
		const indexer = new IndexerGeneration<Abi, string[]>(chain.provider, processor.processor, SOURCE, {
			stream: {finality: FINALITY},
			keepStream: keeper,
		});
		(indexer as any).logEventFetcher = chain.fetcher;
		return {indexer, processor, stream};
	}

	it('costs ONE `eth_chainId` for a cycle, after the fetch and before the write and the fold', async () => {
		const chain = movableChain([makeLog(100, '0xa100')], 200);
		const {indexer, processor} = indexerOn(chain);
		await indexer.load();
		chain.forgetCalls();

		await indexer.indexMore();

		// ONE identity round trip per cycle and not two (ADR-0081), asserted as a COUNT
		// so a before-fetch call added back fails this test instead of passing quietly
		expect(chain.trace.filter((step) => step === 'eth_chainId')).toEqual(['eth_chainId']);
		// ...and it sits where the answer is worth having: the logs are in hand and
		// nothing has been written or folded yet
		expect(chain.trace).toEqual(['eth_getLogs', 'eth_chainId', 'stream write', 'fold']);
		// not vacuous: the cycle really did fold the range it fetched
		expect(processor.state).toEqual([idOf(makeLog(100, '0xa100'))]);
	});

	it('is REFUSED when it moves DURING the fetch, rather than folding the wrong chain', async () => {
		// the case only the post-fetch guard can catch: the range was fetched from one
		// chain and the provider is now answering for another, so the logs in hand are
		// about to be written against a source they did not come from
		const chain = movableChain([makeLog(100, '0xa100')], 200);
		const {indexer, processor} = indexerOn(chain);
		await indexer.load();
		chain.flipDuringFetchTo('0x2');

		await expect(indexer.indexMore()).rejects.toThrow(/chainId changed after fetch/);
		// and nothing from the wrong chain reached the fold
		expect(processor.state).toEqual([]);
	});

	it('is REFUSED when it moved BETWEEN cycles too, and the range it wasted is re-derived', async () => {
		// This used to assert the refusal happened before a single range was requested,
		// which was the fail-fast call's only contribution and is what the deletion gave
		// up. What it PROTECTED is unchanged and is what is asserted now: a moved
		// provider reaches neither the stream nor the fold, and the cursor stays put, so
		// the range it paid for is asked for again rather than skipped.
		const chain = movableChain([makeLog(100, '0xa100')], 200);
		const {indexer, processor, stream} = indexerOn(chain);
		await indexer.load();
		chain.setChainId('0x2');

		await expect(indexer.indexMore()).rejects.toThrow(/chainId changed after fetch/);
		expect(processor.state).toEqual([]);
		expect(stream.writes).toEqual([]);
		expect(stream.cursor).toBe(undefined);

		// the cursor did not move, so the next cycle re-derives the SAME range
		const refusedRange = chain.ranges[chain.ranges.length - 1];
		chain.setChainId('0x1');
		await indexer.indexMore();
		expect(chain.ranges[chain.ranges.length - 1]).toEqual(refusedRange);
		expect(processor.state).toEqual([idOf(makeLog(100, '0xa100'))]);
	});
});
