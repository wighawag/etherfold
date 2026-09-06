import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {
	openIndexer,
	CannotPauseFollowerError,
	UnheldGenerationError,
	type AnyGenerationSpec,
} from '../src/container.js';
import {openMemoryGenerationRegistry} from '../src/generation/memory.js';
import {IndexerGeneration} from '../src/indexer.js';
import {getFromBlock} from '../src/internal/engine/utils.js';
import type {EventProcessor, LastSync, LogEvent, StoredLogEvent} from '../src/types.js';
import {
	BRANCH_A,
	BRANCH_A_TIP,
	BRANCH_B,
	fakeChain,
	fakeProcessor,
	FINALITY,
	idOf,
	indexToTip,
	makeIndexer,
	makeLog,
	memoryStream,
	SOURCE,
	START_BLOCK,
} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// A GENERATION PAUSES BY CAPPING AND DRAINING. IT TRUNCATES NOTHING.
// ---------------------------------------------------------------------------
// Pause sets `maxToBlock = x`, where `x` is the cursor at the moment it pauses.
// Nothing else. The EXISTING `getFromBlock` then produces the whole behaviour:
//
//   while `latestBlock - finality <= x` it returns `latestBlock - finality`, so
//   each round re-scans `[latestBlock - finality, x]` -- a SHRINKING window that
//   corrects any reorg touching what the generation holds;
//
//   once `latestBlock - finality > x` it returns `x + 1`, which is ABOVE the
//   capped `toBlock`, so the indexer takes its existing `fromBlock > toBlock`
//   "no new block" branch and fetches nothing.
//
// So a paused generation self-terminates into a no-op poll. The hazard it
// removes is real: a generation that simply STOPPED would carry an UNCONFIRMED
// window it could no longer correct, and a reorg inside that window would leave
// its state permanently holding events from blocks that no longer exist.
//
// Two things are easy to get backwards, and each has its own assertion below:
// the cap goes on `toBlock` BEFORE the guard, and `lastSync.latestBlock` keeps
// tracking the REAL head (cap that too and `getFromBlock` returns
// `latestBlock - finality` forever, so the drain NEVER idles).
// ---------------------------------------------------------------------------

/** A chain that also COUNTS the head polls, which is what "light polling" is made of. */
function countedChain(logs: StoredLogEvent[], tip: number) {
	const chain = fakeChain(logs, tip);
	const calls = {blockNumber: 0};
	const inner = chain.provider;
	chain.provider = {
		async request(args: {method: string; params?: unknown}): Promise<unknown> {
			if (args.method === 'eth_blockNumber') {
				calls.blockNumber++;
			}
			return inner.request(args);
		},
	} as never;
	return Object.assign(chain, {calls});
}

/**
 * The fold, plus the counters that say a pause TRUNCATED nothing.
 *
 * There is no `revertTo` anywhere on this path to spy on, and that is the point:
 * a state is only ever unwound by a `removed` marker reaching the processor, and
 * discarded only by `reset`/`clear`. So "nothing was truncated and nothing was
 * reverted" is asserted as: no retraction delivered, no discard called.
 */
function countingFold() {
	const fold = fakeProcessor();
	const calls = {reset: 0, clear: 0};
	const processor = fold.processor;
	const reset = processor.reset;
	const clear = processor.clear;
	processor.reset = async () => {
		calls.reset++;
		return reset();
	};
	processor.clear = async () => {
		calls.clear++;
		return clear();
	};
	return Object.assign(fold, {
		calls,
		retractions: () => fold.batches.flat().filter((event) => event.removed),
	});
}

/** One generation, indexed to the tip of branch A, then PAUSED there. */
async function pausedAtTheTip() {
	const chain = countedChain([...BRANCH_A], BRANCH_A_TIP);
	const stream = memoryStream();
	const fold = countingFold();
	const indexer = makeIndexer(chain, fold.processor, stream.keeper);
	await indexer.load();
	await indexToTip(indexer);

	const answeredAtPause = [...fold.state];
	const streamAtPause = stream.events.map(idOf);
	const rangesAtPause = chain.ranges.length;
	indexer.pause();

	let served: StoredLogEvent[] = [...BRANCH_A];
	return {
		chain,
		stream,
		fold,
		indexer,
		answeredAtPause,
		streamAtPause,
		/** What the node has been asked for SINCE the pause. */
		rangesSincePause: () => chain.ranges.slice(rangesAtPause),
		/** The chain moves on by one block, then ONE poll: this is the drain, cycle by cycle. */
		round: async (logs?: StoredLogEvent[]): Promise<LastSync<Abi>> => {
			served = logs ?? served;
			chain.serve(served, chain.tip + 1);
			return indexer.indexMore();
		},
	};
}

type PausedWorld = Awaited<ReturnType<typeof pausedAtTheTip>>;

/** Poll until the cap is final, bounded so a drain that never idles is a red line and not a hang. */
async function drainToIdle(world: PausedWorld, maxRounds = 12): Promise<{rounds: number; lastSync: LastSync<Abi>}> {
	let rounds = 0;
	let lastSync = await world.round();
	rounds++;
	while (world.indexer.pauseState !== 'drained') {
		if (rounds >= maxRounds) {
			throw new Error(`the drain did not reach idle in ${maxRounds} rounds: a cap that never falls out of the window`);
		}
		lastSync = await world.round();
		rounds++;
	}
	return {rounds, lastSync};
}

describe('pause CAPS and DRAINS', () => {
	it('caps `toBlock` at the cursor it paused on, and truncates nothing', async () => {
		const world = await pausedAtTheTip();

		// the chain moves on, and carries a log ABOVE the cap
		await world.round([...BRANCH_A, makeLog(106, '0xa106')]);

		expect(world.indexer.maxToBlock).toBe(105);
		// it still SCANS -- back into the finality window -- but never above the cap
		expect(world.rangesSincePause()).toEqual([{from: 102, to: 105}]);
		// nothing above the cap reached the fold
		expect(world.fold.state).toEqual(world.answeredAtPause);
		// and nothing was truncated or reverted: no retraction, no discard
		expect(world.fold.retractions()).toEqual([]);
		expect(world.fold.calls).toEqual({reset: 0, clear: 0});
		expect(world.stream.events.map(idOf)).toEqual(world.streamAtPause);
	});

	it('re-scans a SHRINKING window and CORRECTS a reorg that strikes at or below the cap', async () => {
		const world = await pausedAtTheTip();

		await world.round(); // re-scan [102, 105]
		// the chain reorgs at 104, which is BELOW the cap and inside what this
		// generation holds -- exactly the hazard a pause that merely STOPPED would
		// bake in forever
		await world.round([...BRANCH_B]); // re-scan [103, 105]
		await world.round(); // re-scan [104, 105]

		// the window shrinks from below while the cap holds the top fixed
		expect(world.rangesSincePause()).toEqual([
			{from: 102, to: 105},
			{from: 103, to: 105},
			{from: 104, to: 105},
		]);
		// the answers CHANGED, and correctly so: they were wrong before
		expect(world.fold.state).not.toEqual(world.answeredAtPause);
		expect(world.fold.state).toEqual(BRANCH_B.map(idOf));
		expect(world.fold.retractions().map(idOf)).toEqual([idOf(BRANCH_A[3])]);
	});

	it('fetches NOTHING once the cap falls below `latestBlock - finality`, through the EXISTING branch', async () => {
		const world = await pausedAtTheTip();
		const {lastSync} = await drainToIdle(world);

		// idle is not a new branch and not a flag: it is what the EXISTING
		// `getFromBlock` says, asking for a block above the capped `toBlock`, which
		// is the `fromBlock > toBlock` "no new block" branch the indexer already had
		expect(getFromBlock(lastSync, START_BLOCK, FINALITY)).toBeGreaterThan(world.indexer.maxToBlock as number);

		const asked = world.rangesSincePause().length;
		const polls = world.chain.calls.blockNumber;
		await world.round();
		await world.round();
		await world.round();

		// no `eth_getLogs` at all -- zero, not fewer...
		expect(world.rangesSincePause().length).toBe(asked);
		// ...and it is still POLLING the head, which is what makes it a no-op poll
		// rather than a stopped indexer
		expect(world.chain.calls.blockNumber).toBeGreaterThan(polls);
	});

	it('loses NOTHING: with no reorg, its answers once idle are EXACTLY what they were at pause', async () => {
		const world = await pausedAtTheTip();
		await drainToIdle(world);

		expect(world.fold.state).toEqual(world.answeredAtPause);
		expect(world.fold.retractions()).toEqual([]);
		expect(world.fold.calls).toEqual({reset: 0, clear: 0});
		// the stream is untouched too: a pause appends nothing above the cap and
		// removes nothing below it
		expect(world.stream.events.map(idOf)).toEqual(world.streamAtPause);
	});

	it('keeps `lastSync.latestBlock` tracking the REAL head, which is what lets the drain reach idle', async () => {
		const world = await pausedAtTheTip();

		const draining = await world.round(); // head 106
		expect(draining.lastToBlock).toBe(105);
		// the REAL head, not the cap. Capping this too passes several of the
		// criteria above and hangs here: `getFromBlock` would return
		// `latestBlock - finality` forever and the drain would never idle
		expect(draining.latestBlock).toBe(106);

		const {lastSync} = await drainToIdle(world);
		expect(lastSync.lastToBlock).toBe(105);
		expect(lastSync.latestBlock).toBeGreaterThan(105 + FINALITY - 1);
	});

	it('reports the DRAINING state, and then a genuine idle', async () => {
		const world = await pausedAtTheTip();
		expect(world.indexer.pauseState).toBe('draining');

		await world.round();
		expect(world.indexer.pauseState).toBe('draining');

		await drainToIdle(world);
		expect(world.indexer.pauseState).toBe('drained');
	});

	it('is not a state a generation is BORN in', async () => {
		const chain = countedChain([...BRANCH_A], BRANCH_A_TIP);
		const fold = countingFold();
		const indexer = makeIndexer(chain, fold.processor, memoryStream().keeper);
		expect(indexer.pauseState).toBe('running');
		expect(indexer.maxToBlock).toBeUndefined();
		await indexer.load();
		await indexToTip(indexer);
		expect(indexer.pauseState).toBe('running');
	});
});

describe('resume is REMOVING THE CAP', () => {
	it('goes back to the head, and re-derives what changed ABOVE the cap while it drained', async () => {
		const world = await pausedAtTheTip();
		// a reorg BELOW the cap, corrected during the drain...
		await world.round();
		await world.round([...BRANCH_B]);
		await drainToIdle(world);
		expect(world.fold.state).toEqual(BRANCH_B.map(idOf));

		// ...and the chain has moved on ABOVE the cap while it was paused
		const branchC = [...BRANCH_B, makeLog(107, '0xc107'), makeLog(110, '0xc110')];
		world.chain.serve(branchC, 112);

		world.indexer.resume();
		expect(world.indexer.pauseState).toBe('running');
		expect(world.indexer.maxToBlock).toBeUndefined();

		await indexToTip(world.indexer);

		// the first uncapped round re-scans from `latestBlock - finality`, so what
		// happened above the cap is re-derived rather than skipped
		expect(world.fold.state).toEqual(branchC.map(idOf));
		expect(world.rangesSincePause().at(-1)?.to).toBe(112);
	});
});

// ---------------------------------------------------------------------------
// PAUSE ON THE CONTAINER: a generation is paused, and the container SAYS SO
// ---------------------------------------------------------------------------

/** A fold that LABELS what it saw, so an answer says WHICH generation gave it. */
function labelledFold(label: string) {
	const state: string[] = [];
	const calls = {load: 0};
	const processor: EventProcessor<Abi, string[]> = {
		getVersionHash: () => `proc-${label}`,
		getCodeFingerprint: () => undefined,
		load: async () => {
			calls.load++;
			return undefined;
		},
		process: async (events: LogEvent<Abi>[]) => {
			for (const event of events) {
				const entry = `${label}:${idOf(event)}`;
				if (event.removed) {
					const at = state.lastIndexOf(entry);
					if (at >= 0) {
						state.splice(at, 1);
					}
				} else {
					state.push(entry);
				}
			}
			return state;
		},
		reset: async () => {
			state.length = 0;
		},
		clear: async () => {
			state.length = 0;
		},
	};
	return {processor, state, calls};
}

/**
 * A container holding TWO generations over ONE stream: A indexes it, B follows.
 *
 * The fetch seam is instrumented PER GENERATION, because "this generation asked
 * the node for nothing more" is a claim about one generation's calls.
 */
async function openWorld() {
	const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
	const stream = memoryStream();
	const A = labelledFold('A');
	const B = labelledFold('B');
	const fetches: {by: string; from: number; to: number}[] = [];

	const specFor = (fold: ReturnType<typeof labelledFold>): AnyGenerationSpec<Abi, string[]> => ({
		createState: () => ({}),
		createProcessor: () => fold.processor,
		stateOf: () => [],
	});

	const registry = await openMemoryGenerationRegistry({maxGenerations: 4, maxStreams: 2});
	const indexer = await openIndexer<Abi, string[]>({
		registry,
		provider: chain.provider,
		source: SOURCE,
		config: {stream: {finality: FINALITY}, keepStream: stream.keeper, streamWriteRetry: {delaySeconds: 0}},
		generations: [specFor(A), specFor(B)],
		createGeneration: (provider, processor, source, config) => {
			const generation = new IndexerGeneration<Abi, string[]>(provider, processor, source, config);
			const by = processor.getVersionHash();
			(generation as unknown as {logEventFetcher: unknown}).logEventFetcher = {
				async getLogEvents(range: {fromBlock: number; toBlock: number}) {
					fetches.push({by, from: range.fromBlock, to: range.toBlock});
					return chain.fetcher.getLogEvents(range);
				},
				reparse: (events: StoredLogEvent[]) => chain.fetcher.reparse(events),
			};
			return generation;
		},
	});

	const idOfGeneration = (label: string) => {
		const held = indexer.generations.find((entry) => entry.record.processor === `proc-${label}`);
		return {stream: held?.record.stream as string, processor: `proc-${label}`};
	};

	return {
		chain,
		stream,
		indexer,
		folds: {A, B},
		fetches,
		id: idOfGeneration,
		heldOf: (label: string) =>
			indexer.generations.find((entry) => entry.record.processor === `proc-${label}`) ?? undefined,
		fetchesBy: (label: string) => fetches.filter((call) => call.by === `proc-${label}`),
		round: async (logs?: StoredLogEvent[]) => {
			chain.serve(logs ?? [...BRANCH_A], chain.tip + 1);
			return indexer.indexMore();
		},
	};
}

describe('the container pauses ONE generation', () => {
	it('drains it to a genuine idle and reports the DRAINING state throughout', async () => {
		const world = await openWorld();
		await world.indexer.load();
		await indexToTip(world.indexer.canonical.generation);

		expect(world.heldOf('A')?.pauseState).toBe('running');
		world.indexer.pause(world.id('A'));
		expect(world.heldOf('A')?.pauseState).toBe('draining');

		for (let round = 0; round < 8 && world.heldOf('A')?.pauseState !== 'drained'; round++) {
			await world.round();
		}
		expect(world.heldOf('A')?.pauseState).toBe('drained');
		// the OTHER generation was never paused, and says so
		expect(world.heldOf('B')?.pauseState).toBe('running');
	});

	it('is REVERTIBLE-TO: the pointer moves back to it and it answers exactly what it did, with no re-index and no fetch', async () => {
		const world = await openWorld();
		await world.indexer.load();
		await indexToTip(world.indexer.canonical.generation);

		world.indexer.pause(world.id('A'));
		for (let round = 0; round < 8 && world.heldOf('A')?.pauseState !== 'drained'; round++) {
			await world.round();
		}
		const answeredAtPause = [...world.folds.A.state];
		const fetchesWhenIdle = world.fetchesBy('A').length;
		const loadsWhenIdle = world.folds.A.calls.load;

		// the pointer moves AWAY, the world turns, and then it moves BACK
		await world.indexer.promote(world.id('B'));
		await world.round();
		await world.round();
		await world.indexer.promote(world.id('A'));

		// story 4's promise, kept exactly: what it answered at pause is what it
		// answers now -- minus nothing, plus nothing
		expect([...(world.indexer.state as string[])]).toEqual(answeredAtPause);
		expect(world.folds.A.state).toEqual(answeredAtPause);
		// with no re-index and no fetch
		expect(world.folds.A.calls.load).toBe(loadsWhenIdle);
		expect(world.fetchesBy('A').length).toBe(fetchesWhenIdle);
	});

	it('REFUSES a follower, which has no `toBlock` of its own to cap', async () => {
		const world = await openWorld();
		await world.indexer.load();

		expect(world.heldOf('B')?.follows).toBe(true);
		expect(() => world.indexer.pause(world.id('B'))).toThrow(CannotPauseFollowerError);
		expect(world.heldOf('B')?.pauseState).toBe('running');
	});

	it('REFUSES a generation it does not hold', async () => {
		const world = await openWorld();
		expect(() => world.indexer.pause({stream: 'nope', processor: 'nope'})).toThrow(UnheldGenerationError);
		expect(() => world.indexer.resume({stream: 'nope', processor: 'nope'})).toThrow(UnheldGenerationError);
	});

	it('resumes by removing the cap, and the generation indexes to the head again', async () => {
		const world = await openWorld();
		await world.indexer.load();
		await indexToTip(world.indexer.canonical.generation);

		world.indexer.pause(world.id('A'));
		for (let round = 0; round < 8 && world.heldOf('A')?.pauseState !== 'drained'; round++) {
			await world.round();
		}
		const branchC = [...BRANCH_A, makeLog(109, '0xc109')];
		world.chain.serve(branchC, 112);

		world.indexer.resume(world.id('A'));
		expect(world.heldOf('A')?.pauseState).toBe('running');
		await indexToTip(world.indexer.canonical.generation);

		expect(world.folds.A.state).toEqual(branchC.map((log) => `A:${idOf(log)}`));
	});
});
