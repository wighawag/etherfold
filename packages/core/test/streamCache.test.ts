import type {Abi} from 'abitype';
import {describe, expect, it, vi} from 'vitest';
import {IndexerGeneration} from '../src/indexer.js';
import type {ExistingStream, StoredLogEvent} from '../src/types.js';
import {
	BRANCH_A,
	BRANCH_A_TIP,
	fakeChain,
	fakeProcessor,
	FINALITY,
	idOf,
	indexToTip,
	makeIndexer,
	makeLog,
	memoryStream,
	shapeOf,
	SOURCE,
	START_BLOCK,
	type ProcessorStore,
} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// THE CACHE MAY BE BEHIND THE STATE OR AHEAD OF IT, NEVER HOLED
// ---------------------------------------------------------------------------
// A HOLE is a range of blocks the stream never RECEIVED, hidden behind a cursor
// that claims to cover them. Nothing detects one afterwards: segments are keyed
// by save rather than by block, so a save that never happened leaves no ordinal
// gap, and the next state discard replays the stream as though it were whole.
//
// The engine is where a hole is CAUSED and therefore where it is fixed: the
// stream is written BEFORE the processor is called, a batch that was not written
// is not processed, and the cursor does not move until it is. Everything below
// is asserted at instrumented seams -- what the keeper was handed, what the
// processor was handed, and in which order -- because none of it is visible in
// the state that comes out.
// ---------------------------------------------------------------------------

/** The `named-logs` channel this package logs on, silenced and recorded. */
async function captureLogs() {
	const {logs} = await import('named-logs');
	const namedLogger = logs('@etherfold/core');
	const errors: string[] = [];
	const spy = vi.spyOn(namedLogger, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
	});
	return {errors, restore: () => spy.mockRestore()};
}

describe('the stream is written BEFORE the processor is called', () => {
	it('completes the write before `process` starts', async () => {
		const order: string[] = [];
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const instrumented: ExistingStream<Abi> = {
			...stream.keeper,
			saveNewEvents: async (source, data) => {
				order.push('save:start');
				await stream.keeper.saveNewEvents(source, data);
				order.push('save:end');
			},
		};
		const process = subject.processor.process;
		subject.processor.process = async (...args: unknown[]) => {
			order.push('process:start');
			const outcome = await (process as any)(...args);
			order.push('process:end');
			return outcome;
		};

		const indexer = makeIndexer(chain, subject.processor, instrumented);
		await indexer.load();
		await indexer.indexMore();

		expect(order.slice(0, 3)).toEqual(['save:start', 'save:end', 'process:start']);
	});
});

describe('a TRANSIENT write failure', () => {
	it('does not process the batch and does not move the cursor', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		stream.failOnce(new Error('the store hiccuped'));
		const indexer = makeIndexer(chain, subject.processor, stream.keeper);

		await indexer.load();
		const lastSync = await indexer.indexMore();

		expect(subject.batches).toHaveLength(0);
		expect(lastSync.lastToBlock).toBe(0);
		expect(stream.events).toHaveLength(0);
		expect(stream.clears).toBe(0);
	});

	it('loses nothing, keeps the cache, and holds the batch exactly once', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		stream.failOnce(new Error('the store hiccuped'));
		const indexer = makeIndexer(chain, subject.processor, stream.keeper);

		await indexer.load();
		await indexToTip(indexer);

		expect(stream.events.map(idOf)).toEqual(BRANCH_A.map(idOf));
		expect(stream.clears).toBe(0);

		// and the state is where an unbroken run puts it
		const unbroken = fakeProcessor();
		const cleanChain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const cleanStream = memoryStream();
		const clean = makeIndexer(cleanChain, unbroken.processor, cleanStream.keeper);
		await clean.load();
		await indexToTip(clean);

		expect(subject.state).toEqual(unbroken.state);
	});
});

describe('a PERMANENT write failure', () => {
	it('freezes the cache after a bounded run of failures, says so plainly, and goes on indexing', async () => {
		const captured = await captureLogs();
		try {
			const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
			const subject = fakeProcessor();
			const stream = memoryStream();
			stream.failEvery(() => new Error('the store is broken'));
			const indexer = makeIndexer(chain, subject.processor, stream.keeper, {
				maxConsecutiveFailures: 3,
				delaySeconds: 0,
			});

			await indexer.load();
			// three refusals, and then the cycle that gives up on the cache
			await indexer.indexMore();
			await indexer.indexMore();
			expect(subject.batches).toHaveLength(0);
			const lastSync = await indexer.indexMore();

			expect(subject.batches).toHaveLength(1);
			expect(lastSync.lastToBlock).toBe(BRANCH_A_TIP);
			expect(captured.errors.some((line) => line.includes('FROZEN'))).toBe(true);
			expect(stream.clears).toBe(0);
		} finally {
			captured.restore();
		}
	});

	it('keeps what is already on disk as a contiguous prefix, and a reload replays it instead of re-fetching it', async () => {
		// index the first blocks with a working cache, then break it for good.
		// The tip sits well above the last log so the finality re-scan on the reload
		// reaches back into the window rather than to the start block.
		const chain = fakeChain([...BRANCH_A], 110);
		const store: ProcessorStore = {};
		const subject = fakeProcessor(store);
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper, {
			maxConsecutiveFailures: 2,
			delaySeconds: 0,
		});
		await indexer.load();
		await indexToTip(indexer);
		const prefix = stream.events.map(idOf);
		expect(prefix).toEqual(BRANCH_A.map(idOf));

		stream.failEvery(() => new Error('the store is broken'));
		chain.serve([...BRANCH_A, makeLog(120, '0xa120')], 121);
		await indexToTip(indexer);

		// the state ran on; the prefix on disk survived, untouched
		expect(subject.state).toContain(idOf(makeLog(120, '0xa120')));
		expect(stream.events.map(idOf)).toEqual(prefix);
		expect(stream.clears).toBe(0);

		// a RELOAD that discards the state replays that prefix rather than asking
		// the node for it, and lands where a from-scratch index lands
		store.saved = undefined;
		stream.succeed();
		const reloadChain = fakeChain([...BRANCH_A, makeLog(120, '0xa120')], 121);
		const reloaded = fakeProcessor({});
		const reloadedIndexer = makeIndexer(reloadChain, reloaded.processor, stream.keeper);
		await reloadedIndexer.load();
		await indexToTip(reloadedIndexer);

		// only the REMAINDER was asked for: the cached prefix replayed, and no range
		// reaches back to a block the cache already held
		for (const range of reloadChain.ranges) {
			expect(range.from).toBeGreaterThan(START_BLOCK);
		}
		expect(reloaded.state.slice(0, prefix.length)).toEqual(prefix);
		const fromScratch = fakeProcessor({});
		const scratchChain = fakeChain([...BRANCH_A, makeLog(120, '0xa120')], 121);
		const scratch = makeIndexer(scratchChain, fromScratch.processor);
		await scratch.load();
		await indexToTip(scratch);
		expect(reloaded.state).toEqual(fromScratch.state);
	});
});

describe('a frozen stream', () => {
	it('revives when the writes recover while the batch still reaches back to the stored cursor', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper, {
			maxConsecutiveFailures: 4,
			delaySeconds: 0,
		});
		await indexer.load();
		await indexToTip(indexer);

		stream.failEvery(() => new Error('a couple of bad cycles'));
		chain.serve([...BRANCH_A, makeLog(106, '0xa106')], 107);
		await indexer.indexMore();
		await indexer.indexMore();
		expect(stream.events.map(idOf)).toEqual(BRANCH_A.map(idOf));

		stream.succeed();
		await indexToTip(indexer);

		expect(stream.events.map(idOf)).toEqual([...BRANCH_A, makeLog(106, '0xa106')].map(idOf));
		expect(stream.clears).toBe(0);
	});

	it('REFUSES an append once the state has run past it, and the prefix stays intact', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper, {
			maxConsecutiveFailures: 1,
			delaySeconds: 0,
		});
		await indexer.load();
		await indexToTip(indexer);
		const prefix = stream.events.map(idOf);
		const cursorBefore = stream.cursor?.lastToBlock;

		// a long outage: the cache gives up, the state runs on past the window
		stream.failEvery(() => new Error('the store is broken'));
		chain.serve([...BRANCH_A, makeLog(500, '0xa500')], 501);
		await indexToTip(indexer);
		stream.succeed();
		chain.serve([...BRANCH_A, makeLog(500, '0xa500'), makeLog(600, '0xa600')], 601);
		const writesBefore = stream.writes.length;
		await indexToTip(indexer);

		// nothing was appended: an append here would put a HOLE behind a cursor
		// claiming to cover it, and nothing could detect that afterwards
		expect(stream.writes.length).toBe(writesBefore);
		expect(stream.events.map(idOf)).toEqual(prefix);
		expect(stream.cursor?.lastToBlock).toBe(cursorBefore);
		expect(stream.clears).toBe(0);
		// and the indexer itself never stopped
		expect(subject.state).toContain(idOf(makeLog(600, '0xa600')));
	});
});

describe('a NO-SPACE failure', () => {
	it('clears the stream, because there the cache is the cause', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper, {
			maxConsecutiveFailures: 5,
			delaySeconds: 0,
		});
		await indexer.load();
		await indexer.indexMore();
		expect(stream.events.length).toBeGreaterThan(0);

		const full = Object.assign(new Error('no room'), {outOfSpace: true as const});
		stream.failEvery(() => full);
		chain.serve([...BRANCH_A, makeLog(106, '0xa106')], 107);
		await indexer.indexMore();

		expect(stream.clears).toBe(1);
		expect(stream.events).toHaveLength(0);
	});

	it('reads the flag STRUCTURALLY, so a DOMException from a quota-exceeded store is one too', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper, {
			maxConsecutiveFailures: 5,
			delaySeconds: 0,
		});
		await indexer.load();
		await indexer.indexMore();

		const quota = Object.assign(new Error('quota'), {name: 'QuotaExceededError'});
		stream.failEvery(() => quota);
		chain.serve([...BRANCH_A, makeLog(106, '0xa106')], 107);
		await indexer.indexMore();

		expect(stream.clears).toBe(1);
	});

	it('is the ONLY cause that clears: an ordinary failure freezes instead', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper, {
			maxConsecutiveFailures: 2,
			delaySeconds: 0,
		});
		await indexer.load();
		await indexer.indexMore();
		stream.failEvery(() => new Error('the store is broken'));
		chain.serve([...BRANCH_A, makeLog(106, '0xa106')], 107);
		await indexToTip(indexer);

		expect(stream.clears).toBe(0);
		expect(stream.events.length).toBeGreaterThan(0);
	});
});

describe('no cache failure can stop the indexer', () => {
	it('paces the retry and still terminates a driver that loops to the tip', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		stream.failEvery(() => new Error('the store is broken'));
		const indexer = makeIndexer(chain, subject.processor, stream.keeper, {
			maxConsecutiveFailures: 3,
			delaySeconds: 0.02,
		});
		await indexer.load();

		const started = Date.now();
		// a bound on the rounds is what turns a hot spin into a red line
		await indexToTip(indexer, 10);
		const elapsed = Date.now() - started;

		// the two refused cycles before the bound are each paced (the third gives up
		// on the cache and proceeds at once). A LOWER bound, so a loaded machine only
		// ever makes this more true (ADR-0032).
		expect(elapsed).toBeGreaterThanOrEqual(30);
		expect(subject.batches.length).toBeGreaterThan(0);
	});
});

describe('a THROWING processor', () => {
	it('does not grow the cache and does not clear it', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper);
		await indexer.load();

		subject.throwOnProcess(true);
		for (let i = 0; i < 4; i++) {
			await expect(indexer.indexMore()).rejects.toThrow('processor blew up');
		}

		expect(stream.events.map(idOf)).toEqual(BRANCH_A.map(idOf));
		expect(stream.clears).toBe(0);
	});

	it('leaves a stream a replay rebuilds the same state from', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper);
		await indexer.load();
		subject.throwOnProcess(true);
		await expect(indexer.indexMore()).rejects.toThrow();
		await expect(indexer.indexMore()).rejects.toThrow();
		subject.throwOnProcess(false);
		await indexToTip(indexer);

		// replay the cached stream into a processor that has never seen anything
		const replayed = fakeProcessor({});
		const replayChain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const replayIndexer = makeIndexer(replayChain, replayed.processor, stream.keeper);
		await replayIndexer.load();
		await indexToTip(replayIndexer);

		const fromScratch = fakeProcessor({});
		const scratchChain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const scratch = makeIndexer(scratchChain, fromScratch.processor);
		await scratch.load();
		await indexToTip(scratch);

		expect(replayed.state).toEqual(fromScratch.state);
		expect(subject.state).toEqual(fromScratch.state);
	});

	it('retracts a written batch the chain then reorged away, so a replay cannot apply a dead branch', async () => {
		// The one new path the flipped order creates: events are on disk that the
		// state never accepted, and the chain moved under them. A replay would apply
		// them, so the retraction has to be written where the loss is noticed.
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper);
		await indexer.load();

		subject.throwOnProcess(true);
		await expect(indexer.indexMore()).rejects.toThrow();
		expect(stream.events.map(shapeOf)).toContain(`A:0xa104:0`);

		// block 104 is replaced before the processor ever accepted it
		chain.serve([BRANCH_A[0], BRANCH_A[1], BRANCH_A[2], makeLog(104, '0xb104')], 106);
		subject.throwOnProcess(false);
		await indexToTip(indexer);

		const shapes = stream.events.map(shapeOf);
		expect(shapes).toContain('R:0xa104:0');
		expect(shapes.indexOf('R:0xa104:0')).toBeGreaterThan(shapes.indexOf('A:0xa104:0'));
		expect(shapes).toContain('A:0xb104:0');

		// and a replay of that stream lands exactly where a from-scratch index does
		const replayed = fakeProcessor({});
		const replayChain = fakeChain([BRANCH_A[0], BRANCH_A[1], BRANCH_A[2], makeLog(104, '0xb104')], 106);
		const replayIndexer = makeIndexer(replayChain, replayed.processor, stream.keeper);
		await replayIndexer.load();
		await indexToTip(replayIndexer);

		const fromScratch = fakeProcessor({});
		const scratchChain = fakeChain([BRANCH_A[0], BRANCH_A[1], BRANCH_A[2], makeLog(104, '0xb104')], 106);
		const scratch = makeIndexer(scratchChain, fromScratch.processor);
		await scratch.load();
		await indexToTip(scratch);

		expect(replayed.state).toEqual(fromScratch.state);
	});
});

describe('a retraction is never written into a stream that lacks the retracted event', () => {
	it('holds the write back, lets a reorg land, and writes no marker for what it never held', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper, {
			maxConsecutiveFailures: 10,
			delaySeconds: 0,
		});
		await indexer.load();
		// everything up to 102 is indexed and cached
		chain.serve([BRANCH_A[0], BRANCH_A[1], BRANCH_A[2]], 103);
		await indexToTip(indexer);

		// the write of block 104 never lands...
		stream.failEvery(() => new Error('the store is broken'));
		chain.serve([...BRANCH_A], BRANCH_A_TIP);
		await indexer.indexMore();
		// ...and then 104 is reorged away
		chain.serve([BRANCH_A[0], BRANCH_A[1], BRANCH_A[2], makeLog(104, '0xb104')], 106);
		stream.succeed();
		await indexToTip(indexer);

		const written: StoredLogEvent[] = stream.events;
		const held = new Set(written.filter((event) => !event.removed).map(idOf));
		for (const retraction of written.filter((event) => event.removed)) {
			expect(held.has(idOf(retraction))).toBe(true);
		}
		expect(written.map(shapeOf)).not.toContain('R:0xa104:0');
	});
});

describe('a reorg still behaves', () => {
	it('treats an overlapping re-fetch as ordinary and delivers retractions in append order, in ONE process call', async () => {
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const subject = fakeProcessor();
		const stream = memoryStream();
		const indexer = makeIndexer(chain, subject.processor, stream.keeper);
		await indexer.load();
		await indexToTip(indexer);
		const batchesBefore = subject.batches.length;

		chain.serve([BRANCH_A[0], BRANCH_A[1], BRANCH_A[2], makeLog(104, '0xb104')], 106);
		await indexToTip(indexer);

		const afterReorg = subject.batches.slice(batchesBefore).filter((batch) => batch.length > 0);
		const retractionBatches = afterReorg.filter((batch) => batch.some((event) => event.removed));
		expect(retractionBatches).toHaveLength(1);
		expect(stream.clears).toBe(0);

		// the stream records the retraction at its ORIGINAL block, then continues
		const shapes = stream.events.map(shapeOf);
		expect(shapes).toContain('R:0xa104:0');
		expect(shapes.indexOf('A:0xb104:0')).toBeGreaterThan(shapes.indexOf('R:0xa104:0'));

		// and a from-scratch index of the same chain lands on the same state
		const fromScratch = fakeProcessor({});
		const scratchChain = fakeChain([BRANCH_A[0], BRANCH_A[1], BRANCH_A[2], makeLog(104, '0xb104')], 106);
		const scratch = makeIndexer(scratchChain, fromScratch.processor);
		await scratch.load();
		await indexToTip(scratch);
		expect(subject.state).toEqual(fromScratch.state);
	});
});

// ---------------------------------------------------------------------------
// A KEEPER THAT DECLINES IS NOT A KEEPER THAT WROTE
// ---------------------------------------------------------------------------
// A keeper refuses a batch that would leave a hole behind a cursor claiming to
// cover it. That refusal used to be a log line and a normal return, so the
// indexer read it as a write: it moved `streamLastToBlock` to a block the stream
// never received, and from then on its OWN hole-check compared against a mark
// that had already lied, so every later decline was invisible as well. The
// indexer's whole write-outcome apparatus -- do not process a batch that was not
// written, freeze, retry -- was bypassed for exactly the failure it exists for.
// ---------------------------------------------------------------------------

describe('a keeper that declines the batch', () => {
	/** A keeper that stores nothing and refuses everything, in the way a hole-check does. */
	function decliningStream() {
		let declines = 0;
		const keeper: ExistingStream<Abi> = {
			fetchFrom: async () => ({status: 'absent' as const}),
			saveNewEvents: async () => {
				declines++;
				return 'declined' as const;
			},
			clear: async () => {},
			setStreamConfig: () => {},
		};
		return {
			keeper,
			get declines() {
				return declines;
			},
		};
	}

	it('does not record the stream as covering what it refused', async () => {
		const chain = fakeChain([makeLog(101, '0xa101')], 200);
		const declining = decliningStream();
		const processor = fakeProcessor();
		const indexer = new IndexerGeneration<Abi, string[]>(chain.provider, processor.processor, SOURCE, {
			stream: {finality: FINALITY},
			keepStream: declining.keeper,
			streamWriteRetry: {delaySeconds: 0},
		});
		(indexer as any).logEventFetcher = chain.fetcher;
		await indexer.load();
		await indexer.indexMore();

		expect(declining.declines).toBeGreaterThan(0);
		// the mark that decides whether a later append can leave a hole must not have
		// moved onto blocks the stream never received
		expect((indexer as any).streamLastToBlock).toBeUndefined();
	});

	it('lets the FOLD go on, because a decline degrades the cache and does not stop indexing', async () => {
		// Deliberately not the write-before-process rule, which governs a FAILED write:
		// a decline is not a failure and retrying it cannot help, so the state keeps
		// advancing while the stored stream stays the contiguous prefix it already is.
		// It is replayed and the remainder re-fetched the next time the state is rebuilt.
		const chain = fakeChain([makeLog(101, '0xa101')], 200);
		const declining = decliningStream();
		const processor = fakeProcessor();
		const indexer = new IndexerGeneration<Abi, string[]>(chain.provider, processor.processor, SOURCE, {
			stream: {finality: FINALITY},
			keepStream: declining.keeper,
			streamWriteRetry: {delaySeconds: 0},
		});
		(indexer as any).logEventFetcher = chain.fetcher;
		await indexer.load();
		await indexer.indexMore();

		expect(processor.state).toEqual([idOf(makeLog(101, '0xa101'))]);
		// and the cache still claims nothing it does not hold
		expect((indexer as any).streamLastToBlock).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// A CANCELLATION MUST NOT LOSE WORK THAT ALREADY LANDED
// ---------------------------------------------------------------------------
// `unlessCancelled(p)` rejects the CALLER; it cannot stop `p`. It also only
// throws once `p` has RESOLVED, so when the cancellation fires the processor has
// already applied the batch and persisted it -- state and cursor together, in
// one transaction (ADR-0027). Throwing before the in-memory cursor moved left
// the engine believing the batch never happened, so the next cycle re-derived it
// and handed the SAME events over a second time.
//
// A processor whose store refuses a re-applied block turns that into a wedge
// that no number of cycles clears; one that accepts it silently double-applies.
// Reverting is not available to the engine -- `process` is the processor's own
// transaction and the interface has no per-batch undo, only `reset`/`clear`,
// which discard everything -- so the fix is to record the work that DID land and
// then honour the cancellation.
// ---------------------------------------------------------------------------

describe('a cancellation landing while the processor is applying a batch', () => {
	it('does not hand the same events over again on the next cycle', async () => {
		const chain = fakeChain([makeLog(101, '0xa101'), makeLog(102, '0xa102')], 200);
		const processor = fakeProcessor();
		const indexer = new IndexerGeneration<Abi, string[]>(chain.provider, processor.processor, SOURCE, {
			stream: {finality: FINALITY},
			streamWriteRetry: {delaySeconds: 0},
		});
		(indexer as any).logEventFetcher = chain.fetcher;
		await indexer.load();

		// cancel from INSIDE the process call, which is what every reconfigure verb
		// does: they all call `disableProcessing()` first
		let cancelled = false;
		const inner = processor.processor.process.bind(processor.processor);
		processor.processor.process = async (events: any, ls: any) => {
			const result = await inner(events, ls);
			if (!cancelled) {
				cancelled = true;
				indexer.disableProcessing();
			}
			return result;
		};

		await expect(indexer.indexMore()).rejects.toThrow();
		const afterCancel = [...processor.state];
		expect(afterCancel.length).toBeGreaterThan(0);

		// the next cycle carries on from where the fold actually is
		indexer.reenableProcessing();
		(indexer as any).logEventFetcher = chain.fetcher;
		await indexer.indexMore();

		// not one event was delivered twice
		expect(processor.state).toEqual([...new Set(processor.state)]);
		expect(processor.state).toEqual(afterCancel);
	});
});
