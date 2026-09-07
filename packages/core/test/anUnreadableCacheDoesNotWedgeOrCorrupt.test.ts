import {describe, expect, it, vi} from 'vitest';
import type {Abi} from 'abitype';
import {installStreamSeed} from '../src/stream/seedInstall.js';
import {serializeStreamSeed, STREAM_SEED_FORMAT, type StreamSeed} from '../src/stream/seed.js';
import {resolveStreamConfig, streamConfigHashOf} from '../src/internal/engine/utils.js';
import {sourceHashesOf} from '../src/internal/engine/eventRanges.js';
import {streamDigestOfSourceHashes} from '../src/stream/identity.js';
import {gzipSync} from 'node:zlib';
import type {ExistingStream, IndexingSource, StoredLastSync, StoredLogEvent} from '../src/types.js';
import {createSegmentedStream} from '../src/stream/segments.js';
import {readOnlyStream} from '../src/stream/readOnly.js';
import {
	BRANCH_A,
	BRANCH_A_TIP,
	fakeChain,
	fakeProcessor,
	FINALITY,
	indexToTip,
	makeIndexer,
	makeLog,
	memorySegmentPort,
	streamOf,
	SOURCE,
	START_BLOCK,
} from './utils/streamCacheWorld.js';

/**
 * AN UNREADABLE CACHE COSTS A RE-INDEX, NEVER THE INDEXER -- AND NEVER A SILENT
 * CORRUPTION EITHER.
 *
 * This file used to test `degradingStream`, a wrapper each keeper applied to
 * ITSELF so that an unreadable substrate answered ABSENT instead of raising. The
 * rule it encoded is real and is still enforced; what changed is WHERE, and this
 * file follows it there (ADR-0068).
 *
 * The wrapper's problem was that it settled the question at the SEAM, so it
 * bound every caller, including one for whom its answer was false. "Absence is
 * safe" is a statement about the LOAD PATH: a generation responds to an absent
 * stream by re-indexing, so losing a cache costs time and nothing else. It is
 * not true of `installStreamSeed`, which responds to an absent stream by
 * WRITING -- told "empty" about a subtree that was merely unreadable, it appended
 * a seed underneath a stream that was really there, duplicating events beneath a
 * cursor moved backwards, silently and permanently.
 *
 * So the keeper raises now, and the two callers are tested where they decide:
 * the generation still degrades (first block), the installer refuses (second),
 * and a failed WRITE still raises through to the caller that acts on it (third).
 */

const CONFIG = resolveStreamConfig({finality: FINALITY});

function cursor(lastFromBlock: number, lastToBlock: number): StoredLastSync {
	return {
		context: {source: [{startBlock: 0, hash: 'src'}], config: 'cfg', processor: 'proc'},
		latestBlock: lastToBlock,
		lastFromBlock,
		lastToBlock,
		unconfirmedBlocks: [],
	} as unknown as StoredLastSync;
}

/** The `named-logs` channel this package logs on, silenced and recorded. */
async function captureLogs() {
	const {logs} = await import('named-logs');
	const namedLogger = logs('@etherfold/core');
	const messages: string[] = [];
	const record = (...args: unknown[]) => {
		messages.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
	};
	const spies = [
		vi.spyOn(namedLogger, 'error').mockImplementation(record),
		vi.spyOn(namedLogger, 'info').mockImplementation(record),
	];
	return {messages, restore: () => spies.forEach((spy) => spy.mockRestore())};
}

/** A keeper whose substrate is gone: every operation raises. */
function unusableStream(): ExistingStream<Abi> {
	const gone = () => {
		throw new Error('the store is unavailable');
	};
	return {fetchFrom: gone, saveNewEvents: gone, clear: gone} as unknown as ExistingStream<Abi>;
}

/** The same, but REJECTING rather than throwing synchronously. */
function rejectingStream(): ExistingStream<Abi> {
	return {
		fetchFrom: () => Promise.reject(new Error('the store is unavailable')),
		saveNewEvents: () => Promise.reject(new Error('the store is unavailable')),
		clear: () => Promise.reject(new Error('the store is unavailable')),
	};
}

describe('the LOAD PATH degrades: a generation whose cache cannot be read still comes up', () => {
	it('loads, indexes to the tip and folds every event, rather than rejecting for ever', async () => {
		// The outage story 12 exists to prevent. The keeper raises from `fetchFrom` AND
		// from `clear`, which is the harder shape: reporting absent is what MAKES the
		// load path clear, so a raising `clear` would put the outage one line further
		// down. Nothing above `load()` catches, so if this rule moved home badly the
		// symptom is a rejected promise here.
		const logged = await captureLogs();
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const {processor, store} = fakeProcessor();
		const indexer = makeIndexer(chain, processor, unusableStream());

		await expect(indexer.load()).resolves.toBeDefined();
		await indexToTip(indexer);

		// it re-indexed from the source's start block, which is the whole point of
		// calling an unreadable cache absent
		expect(chain.ranges[0].from).toBe(START_BLOCK);
		expect(store.saved?.state).toHaveLength(BRANCH_A.length);
		expect(logged.messages.some((message) => message.includes('must never wedge the indexer'))).toBe(true);
		logged.restore();
	});

	it('degrades on a REJECTION as well as on a synchronous throw', async () => {
		const logged = await captureLogs();
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const {processor} = fakeProcessor();
		const indexer = makeIndexer(chain, processor, rejectingStream());

		await expect(indexer.load()).resolves.toBeDefined();
		logged.restore();
	});
});

describe('the REPAIR moved to the load path, it did not vanish', () => {
	it('clears damaged segments and re-indexes, which is what the keeper used to do for it', async () => {
		// ADR-0069 took the repair out of `fetchFrom`. The keeper now REPORTS
		// `inconsistent` and touches nothing, so the guarantee that damage does not
		// survive has to be met HERE -- and it is the same guarantee: a generation
		// throws the bytes away and indexes again. Left unrepaired, the next save would
		// take ordinal 0 again and overwrite the orphan.
		const logged = await captureLogs();
		const {port, rows} = memorySegmentPort();
		const keeper = createSegmentedStream<Abi>(port);

		// a stream with its cursor removed: damage the keeper can see and will not fix
		await keeper.saveNewEvents(SOURCE, {
			eventStream: [makeLog(101, '0xs101')],
			lastSync: cursor(START_BLOCK, 101),
		});
		rows.delete('cursor');
		expect(await keeper.fetchFrom(SOURCE, START_BLOCK)).toMatchObject({status: 'inconsistent'});
		expect(rows.size).toBeGreaterThan(0);

		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const {processor, store} = fakeProcessor();
		const indexer = makeIndexer(chain, processor, keeper);
		await indexer.load();
		await indexToTip(indexer);

		// the damage is gone, and the generation re-indexed from the start block
		expect(chain.ranges[0].from).toBe(START_BLOCK);
		expect(store.saved?.state).toHaveLength(BRANCH_A.length);
		expect(logged.messages.some((m) => m.includes('being cleared and will rebuild'))).toBe(true);
		logged.restore();
	});

	it('clears on the state-KEPT branch too, which is the path with no `else` to fall back on', async () => {
		// The case above takes the state-DISCARDED branch, whose own `else` clears
		// regardless -- so it passes with the repair in `readStoredStream` DELETED, and
		// on its own it proves nothing about the line this ADR moved. The state-KEPT
		// branch has no such fallback: `readStoredStream` is the only repair there, and
		// damaged segments left behind mean the next save retakes ordinal 0 and
		// overwrites the old one. This is the case that actually pins it.
		const logged = await captureLogs();
		const {port, rows} = memorySegmentPort();
		const keeper = createSegmentedStream<Abi>(port);
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const {processor, store} = fakeProcessor();

		const first = makeIndexer(chain, processor, keeper);
		await first.load();
		await indexToTip(first);

		// damage the stream while the STATE survives, so the reload keeps its state
		rows.delete('cursor');
		expect(rows.size).toBeGreaterThan(0);

		const second = makeIndexer(chain, fakeProcessor(store).processor, keeper);
		await second.load();

		expect(rows.size).toBe(0);
		logged.restore();
	});

	it('does NOT clear through a read-only view, so a follower cannot destroy its writer`s stream', async () => {
		// The defect this refactor closes as a side effect
		// (`a-follower-can-self-clear-the-writers-stream-through-the-read-only-view`).
		// A follower folds a stream ANOTHER generation is still appending to, and it is
		// handed a `readOnlyStream` whose `clear` is a no-op. That was not enough while
		// the CLEAR happened inside `fetchFrom`, beneath the view: reading a writer's
		// stream from below its start deleted it. Now the read only reports, and the
		// no-op `clear` is what the repair runs into.
		const logged = await captureLogs();
		const {port, rows} = memorySegmentPort();
		const writersKeeper = createSegmentedStream<Abi>(port);
		// the writer's stream opens mid-history, as a resumed one does
		await writersKeeper.saveNewEvents(SOURCE, {eventStream: [makeLog(500, '0xw500')], lastSync: cursor(500, 500)});
		const before = JSON.stringify([...rows.entries()]);

		const follower = readOnlyStream<Abi>(writersKeeper);
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const {processor} = fakeProcessor();
		const indexer = makeIndexer(chain, processor, follower);

		// asks from the source's start block, well below the writer's 500
		await indexer.load();

		expect(JSON.stringify([...rows.entries()])).toBe(before);
		expect(streamOf(await writersKeeper.fetchFrom(SOURCE, 500))).toBeDefined();
		logged.restore();
	});
});

describe('the INSTALLER refuses: absence it cannot verify is not permission to write', () => {
	async function seedOffered() {
		// A REAL config hash, not a placeholder. With `'cfg'` here the seed is
		// INCOHERENT, so the install refuses on that instead -- which is invisible while
		// the fix is in place (the subtree check runs first) and makes the corruption
		// case below pass for the wrong reason if the fix is ever reverted.
		const context = {source: sourceHashesOf(SOURCE), config: streamConfigHashOf(CONFIG), processor: ''};
		const seed: StreamSeed = {
			format: STREAM_SEED_FORMAT,
			producer: {kind: 'capture', name: 'anUnreadableCache.test.ts', at: '2026-09-07T00:00:00.000Z'},
			chainHeadAtCapture: 1_000_000,
			streamConfig: CONFIG,
			streamDigest: streamDigestOfSourceHashes(context.source, CONFIG),
			coverage: {fromBlock: START_BLOCK, toBlock: 150},
			context,
			eventStream: [makeLog(101, '0xs101'), makeLog(110, '0xs110')],
		};
		const body = new Uint8Array(gzipSync(Buffer.from(serializeStreamSeed(seed), 'utf-8')));
		return {get: (async () => new Response(body)) as unknown as typeof globalThis.fetch};
	}

	it('answers `subtree-unreadable` as DATA, distinct from `subtree-not-empty`, and writes nothing', async () => {
		// The corruption this prevents is concrete: `carryForward` keeps an existing
		// cursor's `startBlock` and `nextOrdinal`, and a seed's first batch sits at or
		// below `lastToBlock + 1` so it is NOT declined as a hole. Appending under a
		// stream that was really there therefore duplicates events beneath a cursor
		// moved BACKWARDS -- and every later generation re-folds it.
		const logged = await captureLogs();
		const {get} = await seedOffered();
		const keeper = unusableStream();
		const saveNewEvents = vi.spyOn(keeper, 'saveNewEvents');

		const outcome = await installStreamSeed(keeper, ['https://seeds.example/s.json.gz'], {
			source: SOURCE,
			streamConfig: CONFIG,
			fetch: get,
		});

		// DATA, not a throw: this is a public entry point on an app's boot path
		expect(outcome).toEqual({status: 'not-installed', reason: 'subtree-unreadable'});
		// and the reason is its OWN, because "there is a stream here" and "I cannot
		// tell" are different things an app may want to say differently
		expect(outcome).not.toEqual({status: 'not-installed', reason: 'subtree-not-empty'});
		expect(saveNewEvents).not.toHaveBeenCalled();
		logged.restore();
	});

	it('leaves a REAL stream underneath intact, which is the corruption this exists to stop', async () => {
		// The scenario in full, and the one that actually bites: a VALID seed (it passes
		// every admission check) offered to a client that already holds a stream, whose
		// reads are transiently failing while its writes work.
		//
		// With the old swallowing keeper this returned `{status: 'installed'}` and left
		// two segments: the seed appended UNDER the existing stream, with the cursor's
		// `lastToBlock` moved BACKWARDS from 600 to 200 while `startBlock` stayed at 500
		// -- a cursor claiming a stream from 500 through 200, over events at 500 and 110.
		// It reported SUCCESS while doing it, and every later generation re-folds that.
		const logged = await captureLogs();
		const {get} = await seedOffered();
		const {port, rows} = memorySegmentPort();
		// a stream this client indexed itself, well above the seed's coverage
		await port.commitSegmentWithCursor(SOURCE, () => ({
			ordinal: 0,
			segment: {events: [makeLog(500, '0xold')]},
			cursor: {
				context: {source: sourceHashesOf(SOURCE), config: streamConfigHashOf(CONFIG), processor: ''},
				latestBlock: 600,
				lastFromBlock: 500,
				lastToBlock: 600,
				startBlock: 500,
				nextOrdinal: 1,
			},
		}));
		const before = JSON.stringify([...rows.entries()]);

		// reads fail from here on; writes would still work
		const readCursor = port.readCursor;
		port.readCursor = async () => {
			throw new Error('IndexedDB unavailable');
		};

		const outcome = await installStreamSeed(createSegmentedStream<Abi>(port), ['https://seeds.example/s.json.gz'], {
			source: SOURCE,
			streamConfig: CONFIG,
			fetch: get,
		});

		expect(outcome).toEqual({status: 'not-installed', reason: 'subtree-unreadable'});
		// byte for byte: not appended to, not cleared, not re-cursored
		expect(JSON.stringify([...rows.entries()])).toBe(before);
		// and it is still a readable stream once the substrate comes back
		port.readCursor = readCursor;
		expect(streamOf(await createSegmentedStream<Abi>(port).fetchFrom(SOURCE, 500))).toBeDefined();
		logged.restore();
	});

	it('does not resolve it by CLEARING: a stream it could not read is not one it may destroy', async () => {
		const logged = await captureLogs();
		const {get} = await seedOffered();
		const keeper = unusableStream();
		const clear = vi.spyOn(keeper, 'clear');

		await installStreamSeed(keeper, ['https://seeds.example/s.json.gz'], {
			source: SOURCE,
			streamConfig: CONFIG,
			fetch: get,
		});

		// clearing would turn "I cannot tell whether this is empty" into "it is empty
		// now", which is data loss chosen on a transient read failure
		expect(clear).not.toHaveBeenCalled();
		logged.restore();
	});
});

describe('a failed WRITE still reaches the caller that acts on it', () => {
	it('handles a keeper that throws SYNCHRONOUSLY, which the deleted wrapper used to normalise', async () => {
		// The one thing `degradingStream` did for the WRITE side. It never swallowed a
		// write failure -- that would let the state advance past events the stream never
		// received, which is a HOLE -- but it WAS declared `async`, so a keeper throwing
		// synchronously still handed its caller the rejected promise the seam is typed
		// to return. Deleting it removes that normalisation, so the shape is pinned here
		// instead: `promiseToSave` awaits inside a `try`, and a synchronous throw in a
		// `try` is caught by the same `catch` a rejection is, so both shapes land on
		// `onStreamWriteFailed` and neither escapes.
		//
		// What the engine then DOES with it -- count, pace, freeze, keep indexing -- is
		// `streamCache.test.ts`'s and is not restated here.
		const logged = await captureLogs();
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const {processor, store} = fakeProcessor();
		const throwsSynchronously: ExistingStream<Abi> = {
			fetchFrom: async () => ({status: 'absent' as const}),
			saveNewEvents: (() => {
				throw new Error('the store is unavailable');
			}) as unknown as ExistingStream<Abi>['saveNewEvents'],
			clear: async () => undefined,
		};
		const indexer = makeIndexer(chain, processor, throwsSynchronously, {
			maxConsecutiveFailures: 2,
			delaySeconds: 0,
		});

		await indexer.load();
		// no unhandled throw out of the cycle, and the fold does not advance past a
		// batch the stream refused to take
		await expect(indexer.indexMore()).resolves.toBeDefined();
		expect(store.saved).toBeUndefined();

		// and it is reported, not silently absorbed
		await indexer.indexMore();
		await indexToTip(indexer);
		expect(store.saved?.state).toHaveLength(BRANCH_A.length);
		logged.restore();
	});
});
