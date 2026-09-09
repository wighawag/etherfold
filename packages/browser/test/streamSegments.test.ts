import 'fake-indexeddb/auto';
import {describe, expect, it, vi} from 'vitest';
import {createStore, get, keys as allKeys, set, type UseStore} from 'idb-keyval';
import {
	resolveStreamConfig,
	streamDigestOf,
	type IndexingSource,
	type StoredLastSync,
	type StoredLogEvent,
} from '@etherfold/core';
import {keepStreamOnIndexedDB, KEYVAL_DATABASE, KEYVAL_OBJECT_STORE, streamAddress} from '../src/index.js';
import {appliedIn, applyingProcessor, browserStore, indexerOver, keysOf} from './utils/applied.js';
import {
	BRANCH_A,
	BRANCH_A_EXTENDED,
	BRANCH_A_EXTENDED_TIP,
	BRANCH_A_TIP,
	BRANCH_B,
	BRANCH_B_TIP,
	fakeChain,
	FINALITY,
	indexToTip,
	SOURCE,
	START_BLOCK,
	type TestABI,
	streamOf,
} from '../browser/workload.js';

/**
 * THE STREAM KEEPER, on `fake-indexeddb`.
 *
 * The rules are asserted against the core helper (`@etherfold/core`'s
 * `streamSegments.test.ts`); what is asserted HERE is everything that is about
 * this substrate and cannot be seen from there: the array address, the key
 * ranges, the one `readwrite` transaction the commit is, the store it shares with
 * every other keeper, and the legacy blob.
 *
 * Cost is asserted as WORK at the INSTRUMENTED OBJECT STORE and never as
 * wall-clock: `fake-indexeddb` is itself quadratic
 * (`fake-indexeddb-write-cost-grows-quadratically`)
 * and ADR-0032 rules a clock out on a loaded machine anyway.
 */

let counter = 0;
const freshName = () => `segments-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

type Recorded = {
	puts: {key: IDBValidKey; value: unknown; tx: IDBTransaction; mode: IDBTransactionMode}[];
	gets: {key: IDBValidKey; tx: IDBTransaction}[];
	scans: {method: string; count: number}[];
	deletes: IDBValidKey[];
};

/**
 * A `UseStore` over the SAME database and object store the keeper uses, wrapping
 * the object store so every request it makes is counted.
 *
 * Mocking `idb-keyval`'s `set` or `setMany` would measure nothing now that the
 * commit is a raw transaction: a criterion naming either would pass vacuously.
 */
function instrumented(): {store: UseStore; recorded: Recorded} {
	const base = createStore(KEYVAL_DATABASE, KEYVAL_OBJECT_STORE);
	const recorded: Recorded = {puts: [], gets: [], scans: [], deletes: []};
	const store: UseStore = (txMode, callback) =>
		base(txMode, (objectStore) =>
			callback(
				new Proxy(objectStore, {
					get(target, property) {
						const value = (target as unknown as Record<string | symbol, unknown>)[property];
						if (typeof value !== 'function') return value;
						return (...args: unknown[]) => {
							const request = (value as (...a: unknown[]) => unknown).apply(target, args);
							if (property === 'put') {
								recorded.puts.push({
									key: args[1] as IDBValidKey,
									value: args[0],
									tx: target.transaction,
									mode: target.transaction.mode,
								});
							} else if (property === 'get') {
								recorded.gets.push({key: args[0] as IDBValidKey, tx: target.transaction});
							} else if (property === 'delete') {
								recorded.deletes.push(args[0] as IDBValidKey);
							} else if (property === 'getAll' || property === 'getAllKeys' || property === 'openCursor') {
								const scan = {method: property as string, count: 0};
								recorded.scans.push(scan);
								(request as IDBRequest).addEventListener('success', () => {
									const result = (request as IDBRequest).result;
									scan.count = Array.isArray(result) ? result.length : result ? 1 : 0;
								});
							}
							return request;
						};
					},
				}),
			),
		);
	return {store, recorded};
}

/** The `named-logs` channel this package logs on, silenced and recorded. */
async function captureLogs() {
	const {logs} = await import('named-logs');
	const namedLogger = logs('@etherfold/browser');
	const messages: string[] = [];
	const record = (...args: unknown[]) => {
		messages.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
	};
	const spies = [
		vi.spyOn(namedLogger, 'error').mockImplementation(record),
		vi.spyOn(namedLogger, 'info').mockImplementation(record),
	];
	return {messages, restore: () => spies.forEach((spy) => spy.mockRestore())};
}

function event(blockNumber: number, logIndex = 0): StoredLogEvent {
	return {
		blockNumber,
		logIndex,
		removed: false,
		blockHash: `0x${blockNumber.toString(16)}`,
		transactionHash: `0x${blockNumber.toString(16)}-${logIndex}`,
	} as unknown as StoredLogEvent;
}

function cursorAt(lastFromBlock: number, lastToBlock: number): StoredLastSync {
	return {
		context: {source: [{startBlock: 0, hash: 'src'}], config: 'cfg', processor: 'proc'},
		latestBlock: lastToBlock,
		lastFromBlock,
		lastToBlock,
		unconfirmedBlocks: [{number: lastToBlock, hash: '0xtip', events: []}],
	} as unknown as StoredLastSync;
}

const OTHER_CHAIN = {...SOURCE, chainId: '10'};

/**
 * The address of a stream, at the stream config the keeper under test is running.
 *
 * The DIGEST level is a function of the filter AND the config (`streamDigestOf`),
 * so an inspection has to name the same config the keeper was handed or it would
 * be reading a different stream's subtree. A keeper nobody has told runs at the
 * resolved DEFAULT, which is what an indexer given no `stream` config runs at
 * too; the end-to-end cases below pass `CONFIG.stream` instead.
 */
const addressOf = (
	name: string,
	streamConfig: Parameters<typeof resolveStreamConfig>[0] = undefined,
	source: IndexingSource<TestABI> = SOURCE,
) => streamAddress(name, source, resolveStreamConfig(streamConfig));

describe('the address', () => {
	it('is an ARRAY key with the digest level present, and `chainId` is not a level of its own', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);
		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});

		const written = (await allKeys()).filter((key) => Array.isArray(key) && key[1] === tag) as IDBValidKey[][];
		expect(written).toHaveLength(2);
		for (const key of written) {
			expect(Array.isArray(key)).toBe(true);
			// FOUR levels: the literal, the indexer name, the digest, the ordinal or
			// the cursor. `chainId` is not one of them -- it is inside the digest,
			// which is what keeps two chains apart until the real one lands.
			expect(key).toHaveLength(4);
			expect(key[0]).toBe('stream');
			expect(key[1]).toBe(tag);
			expect(key[2]).toBe(streamDigestOf(SOURCE, resolveStreamConfig(undefined)));
			expect(key.slice(0, 3)).not.toContain(SOURCE.chainId);
		}
		expect(written.map((key) => key[3]).sort()).toEqual([0, 'cursor']);
		expect(addressOf(tag).cursor).toEqual([
			'stream',
			tag,
			streamDigestOf(SOURCE, resolveStreamConfig(undefined)),
			'cursor',
		]);
	});

	it('holds the cursor ONCE, in the cursor record inside the subtree, with no competing copy', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);
		const address = addressOf(tag);

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});
		await keeper.saveNewEvents(SOURCE, {eventStream: [event(101)], lastSync: cursorAt(101, 104)});

		// a segment is `{events}` and nothing else: no extent, no `lastSync`, no window
		for (const ordinal of [0, 1]) {
			const segment = await get<Record<string, unknown>>(address.segment(ordinal));
			expect(Object.keys(segment!)).toEqual(['events']);
		}
		const record = await get<Record<string, unknown>>(address.cursor);
		expect(Object.keys(record!).sort()).toEqual([
			'context',
			'lastFromBlock',
			'lastToBlock',
			'latestBlock',
			'nextOrdinal',
			'startBlock',
		]);
		// and it is INSIDE the subtree, so a scoped delete cannot orphan it
		expect((address.cursor as IDBValidKey[]).slice(0, 3)).toEqual(address.prefix);
	});

	it('cannot confuse one indexer name with another that it is a PREFIX of', async () => {
		const tag = freshName();
		const shortName = keepStreamOnIndexedDB<TestABI>(tag);
		const longName = keepStreamOnIndexedDB<TestABI>(`${tag}_10`);

		await shortName.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});
		await longName.saveNewEvents(SOURCE, {eventStream: [event(200), event(201)], lastSync: cursorAt(100, 201)});

		expect(streamOf(await shortName.fetchFrom(SOURCE, 100)).eventStream).toHaveLength(1);
		expect(streamOf(await longName.fetchFrom(SOURCE, 100)).eventStream).toHaveLength(2);

		// a flat delimited key would have made `stream_<tag>_1` a prefix of
		// `stream_<tag>_10_0`; comparing key ELEMENTS cannot
		await shortName.clear(SOURCE);
		expect(await shortName.fetchFrom(SOURCE, 100)).toEqual({status: 'absent'});
		expect(streamOf(await longName.fetchFrom(SOURCE, 100)).eventStream).toHaveLength(2);
	});
});

describe('two CHAINS under one indexer name do not see each other', () => {
	it('writes, reads and clears one while the other stays complete and replayable', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100), event(101)], lastSync: cursorAt(100, 101)});
		await keeper.saveNewEvents(OTHER_CHAIN, {eventStream: [event(500)], lastSync: cursorAt(500, 500)});

		expect(streamOf(await keeper.fetchFrom(SOURCE, 100)).eventStream.map((e) => e.blockNumber)).toEqual([100, 101]);
		expect(streamOf(await keeper.fetchFrom(OTHER_CHAIN, 500)).eventStream.map((e) => e.blockNumber)).toEqual([500]);

		await keeper.clear(SOURCE);

		expect(await keeper.fetchFrom(SOURCE, 100)).toEqual({status: 'absent'});
		const survivor = streamOf(await keeper.fetchFrom(OTHER_CHAIN, 500));
		expect(survivor.eventStream.map((e) => e.blockNumber)).toEqual([500]);
		expect(survivor.lastSync.lastToBlock).toBe(500);
	});
});

describe('segments are read by KEY RANGE, not by a whole-store scan', () => {
	it('reads only the asked-for stream`s records, however many streams share the store', async () => {
		const mine = freshName();
		const theirs = freshName();
		const {store, recorded} = instrumented();
		const keeper = keepStreamOnIndexedDB<TestABI>(mine, {store});
		const neighbour = keepStreamOnIndexedDB<TestABI>(theirs, {store});

		for (let i = 0; i < 5; i++) {
			await keeper.saveNewEvents(SOURCE, {eventStream: [event(100 + i)], lastSync: cursorAt(100 + i, 100 + i)});
			await neighbour.saveNewEvents(SOURCE, {eventStream: [event(100 + i)], lastSync: cursorAt(100 + i, 100 + i)});
		}
		recorded.scans.length = 0;

		const fetched = streamOf(await keeper.fetchFrom(SOURCE, 100));
		expect(fetched.eventStream).toHaveLength(5);

		// five segments, not ten, and not "every key in the store": `keys()` would
		// make `fetchFrom` O(store) once several streams exist
		expect(recorded.scans.length).toBeGreaterThan(0);
		for (const scan of recorded.scans) {
			expect(scan.count).toBe(5);
		}
	});
});

describe('a save writes exactly its BATCH plus the cursor record', () => {
	it('makes two puts, at its own segment and the cursor, and never rewrites a segment', async () => {
		const tag = freshName();
		const {store, recorded} = instrumented();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag, {store});
		const address = addressOf(tag);

		for (let i = 0; i < 100; i++) {
			await keeper.saveNewEvents(SOURCE, {
				eventStream: [event(100 + i, 0), event(100 + i, 1)],
				lastSync: cursorAt(100 + i, 100 + i),
			});
		}

		// exactly two puts per save, whatever the history behind them
		expect(recorded.puts).toHaveLength(200);
		const segmentPuts = recorded.puts.filter((put) => typeof (put.key as IDBValidKey[])[3] === 'number');
		expect(segmentPuts).toHaveLength(100);

		// the 100th save wrote the 100th BATCH, not the history: two events, and the
		// same two the caller handed over
		const last = segmentPuts[segmentPuts.length - 1];
		expect(last.key).toEqual(address.segment(99));
		expect((last.value as {events: unknown[]}).events).toHaveLength(2);
		// no threshold either: every segment is its own batch and no other size, and
		// the bytes written do not grow with the history behind them
		expect(new Set(segmentPuts.map((put) => (put.value as {events: unknown[]}).events.length))).toEqual(new Set([2]));
		const sizes = segmentPuts.map((put) => JSON.stringify(put.value).length);
		expect(Math.max(...sizes)).toBe(Math.min(...sizes));

		// and no segment key is ever written a second time
		const segmentKeys = segmentPuts.map((put) => JSON.stringify(put.key));
		expect(new Set(segmentKeys).size).toBe(segmentKeys.length);
	});

	it('reads the cursor and writes both records in ONE `readwrite` transaction', async () => {
		const tag = freshName();
		const {store, recorded} = instrumented();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag, {store});

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});
		recorded.gets.length = 0;
		recorded.puts.length = 0;
		recorded.scans.length = 0;

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(101)], lastSync: cursorAt(101, 101)});

		expect(recorded.gets).toHaveLength(1);
		expect(recorded.puts).toHaveLength(2);
		expect(recorded.puts[0].mode).toBe('readwrite');
		// the read and both writes on ONE transaction. A `get` followed by `setMany`
		// is two, and two tabs would then both read next-ordinal `n` and both write
		// segment `n`, losing a batch with the ordinals still contiguous.
		expect(recorded.puts[0].tx).toBe(recorded.gets[0].tx);
		expect(recorded.puts[1].tx).toBe(recorded.gets[0].tx);
		// and it decided where to write from the CURSOR, with no scan of the keyspace
		expect(recorded.scans).toHaveLength(0);
	});

	it('an EMPTY save writes ONLY the cursor record', async () => {
		const tag = freshName();
		const {store, recorded} = instrumented();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag, {store});
		const address = addressOf(tag);

		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});
		recorded.puts.length = 0;

		await keeper.saveNewEvents(SOURCE, {eventStream: [], lastSync: cursorAt(101, 400)});

		expect(recorded.puts).toHaveLength(1);
		expect(recorded.puts[0].key).toEqual(address.cursor);
	});
});

describe('two keepers over one store cannot lose a batch', () => {
	it('interleaves saves without writing an ordinal twice or dropping one', async () => {
		const tag = freshName();
		const a = instrumented();
		const b = instrumented();
		const keeperA = keepStreamOnIndexedDB<TestABI>(tag, {store: a.store});
		const keeperB = keepStreamOnIndexedDB<TestABI>(tag, {store: b.store});

		// Both tabs re-scan from the same block, which is what a pair of tabs
		// following the same chain actually does, so neither save is a forward jump
		// whichever order they land in.
		const rounds = 20;
		for (let i = 0; i < rounds; i++) {
			await Promise.all([
				keeperA.saveNewEvents(SOURCE, {eventStream: [event(100, i * 2)], lastSync: cursorAt(100, 100 + i)}),
				keeperB.saveNewEvents(SOURCE, {eventStream: [event(100, i * 2 + 1)], lastSync: cursorAt(100, 100 + i)}),
			]);
		}

		const segmentPuts = [...a.recorded.puts, ...b.recorded.puts].filter(
			(put) => typeof (put.key as IDBValidKey[])[3] === 'number',
		);
		const ordinals = segmentPuts.map((put) => (put.key as IDBValidKey[])[3] as number);
		expect(ordinals).toHaveLength(rounds * 2);
		expect(new Set(ordinals).size).toBe(ordinals.length);

		const stored = streamOf(await keeperA.fetchFrom(SOURCE, 100));
		const logIndexes = stored.eventStream.map((e) => e.logIndex).sort((x, y) => Number(x) - Number(y));
		expect(logIndexes).toEqual(Array.from({length: rounds * 2}, (_, i) => i));
	});
});

describe('clear removes the subtree and nothing else', () => {
	it('leaves an unrelated key in the same store alone, and presence reads FALSE afterwards', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);
		const neighbourKey = `some-other-keeper-${tag}`;

		await set(neighbourKey, {mine: true});
		await keeper.saveNewEvents(SOURCE, {eventStream: [event(100)], lastSync: cursorAt(100, 100)});

		await keeper.clear(SOURCE);

		// `idb-keyval`'s `clear()` would have taken this with it, along with every
		// other stream and every row any other keeper wrote
		expect(await get(neighbourKey)).toEqual({mine: true});
		expect(await keeper.fetchFrom(SOURCE, 100)).toEqual({status: 'absent'});
		expect((await allKeys()).filter((key) => Array.isArray(key) && key[1] === tag)).toEqual([]);
	});
});

describe('the legacy flat-key blob', () => {
	it('is REPORTED as unusable by `fetchFrom`, which deletes nothing', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);
		const address = addressOf(tag);
		const logged = await captureLogs();

		// exactly what the shipped keeper wrote: one flat key, the whole stream
		await set(address.legacy, {lastSync: cursorAt(100, 104), eventStream: [event(100), event(104)]});

		// A blob this build cannot read is DAMAGE, not absence: an installer reads
		// `absent` as permission to write. This used to `del` the blob and clear the
		// subtree inline, which made it the last read on this seam that mutated
		// (ADR-0069) -- so a FOLLOWER could destroy its writer's subtree on this one
		// path, and the seed installer's probe could destroy-then-read-absent.
		expect(await keeper.fetchFrom(SOURCE, 100)).toMatchObject({status: 'inconsistent'});
		expect(await get(address.legacy)).toBeDefined();
		logged.restore();
	});

	it('is still DELETED promptly, on the state-KEPT branch as well as the discarded one', async () => {
		// The guarantee the inline delete used to provide, and the reason it was inline:
		// `indexer.ts`'s state-kept branch guards its own `clear` behind
		// `if (existingStreamData)`, so a blob found only by an `else` would survive
		// indefinitely. `readStoredStream` now clears on every non-`stream` verdict
		// regardless of branch, so the blob goes on the first load either way -- which
		// is what makes deferring the delete to the caller safe rather than a leak.
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);
		// the address the INDEXER's keeper will use: the blob is addressed under the
		// resolved stream config, so the default-config address is a different subtree
		const address = addressOf(tag, {finality: FINALITY});
		const definition = applyingProcessor();
		const store = await browserStore(freshName(), definition);
		const indexer = indexerOver(definition, store, {keepStream: keeper});

		const chain = fakeChain(BRANCH_A, BRANCH_A_TIP);
		await indexer.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		await indexToTip(indexer as never);
		indexer.dispose();

		// a blob appears beside a healthy stream, and the next boot keeps its STATE
		await set(address.legacy, {lastSync: cursorAt(100, 104), eventStream: [event(100)]});
		const second = indexerOver(definition, store, {keepStream: keeper});
		await second.init({provider: chain.provider, source: SOURCE, config: {stream: {finality: FINALITY}}});
		// `init` alone does not read the stream: `load()` runs on the first cycle
		await indexToTip(second as never);
		second.dispose();

		expect(await get(address.legacy)).toBeUndefined();
	});

	it('is deleted by `clear` too', async () => {
		const tag = freshName();
		const keeper = keepStreamOnIndexedDB<TestABI>(tag);
		const address = addressOf(tag);

		await set(address.legacy, {lastSync: cursorAt(100, 104), eventStream: []});
		await keeper.clear(SOURCE);

		expect(await get(address.legacy)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// The START BLOCK, end to end.
// ---------------------------------------------------------------------------

const CONFIG = {stream: {finality: FINALITY}};
const DIVERGED_TIP = 120;

describe('a stream that does not reach back to the requested fromBlock', () => {
	it('is cleared on a REBUILD and re-fetched, while a state-kept reload keeps it', async () => {
		const tag = freshName();
		const chain = fakeChain();
		const stream = keepStreamOnIndexedDB<TestABI>(tag);
		// driven by an INDEXER below, which hands the keeper the config it resolved
		const address = addressOf(tag, CONFIG.stream);
		const definition = applyingProcessor();
		const store = await browserStore(tag, definition);

		// A tab whose stream was the shipped blob: the state is good, the blob is
		// deleted on load, and nothing re-fetches -- so the NEXT save opens a subtree
		// whose first segment begins mid-history. This is the state a self-clear
		// creates, and it is why the cursor record carries a start block at all.
		const first = indexerOver(definition, store);
		await first.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(first as never);
		first.dispose();
		await set(address.legacy, {lastSync: cursorAt(START_BLOCK, BRANCH_A_TIP), eventStream: []});

		chain.serve(BRANCH_A_EXTENDED, DIVERGED_TIP);
		const second = indexerOver(definition, store, {keepStream: stream});
		await second.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(second as never);
		second.dispose();

		const partial = await get<{startBlock: number}>(address.cursor);
		expect(partial).toBeDefined();
		expect(partial!.startBlock).toBeGreaterThan(START_BLOCK);

		// THE NEGATIVE, and it matters as much: while the state is kept, the request
		// is for the RESUME point, which this stream does serve. A keeper comparing
		// its start block against the SOURCE's minimum instead would clear here, the
		// next save would recreate it partial, and it would re-index on every reload
		// forever.
		for (let reload = 0; reload < 3; reload++) {
			const kept = indexerOver(definition, store, {keepStream: stream});
			await kept.init({provider: chain.provider, source: SOURCE, config: CONFIG});
			await indexToTip(kept as never);
			kept.dispose();
			expect(await get(address.cursor)).toBeDefined();
		}
		expect((await get<{startBlock: number}>(address.cursor))!.startBlock).toBe(partial!.startBlock);

		// now DISCARD the state -- a store this deployment has never written to, which
		// is what a cleared one is: the rebuild asks from the source's first block, and
		// this stream cannot serve it. Replaying it would rebuild state that is
		// silently missing every block below its start.
		const rangesBefore = chain.ranges.length;
		const rebuiltDefinition = applyingProcessor();
		const rebuilt = indexerOver(rebuiltDefinition, await browserStore(freshName(), rebuiltDefinition), {
			keepStream: stream,
		});
		await rebuilt.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(rebuilt as never);

		expect(chain.ranges.slice(rangesBefore).some((range) => range.from === START_BLOCK)).toBe(true);

		const scratchChain = fakeChain(BRANCH_A_EXTENDED, DIVERGED_TIP);
		const scratchDefinition = applyingProcessor();
		const scratch = indexerOver(scratchDefinition, await browserStore(freshName(), scratchDefinition));
		await scratch.init({provider: scratchChain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(scratch as never);
		const rebuiltApplied = await appliedIn(rebuilt.state.$state);
		expect(keysOf(rebuiltApplied)).toEqual(keysOf(await appliedIn(scratch.state.$state)));
		expect(rebuiltApplied).toHaveLength(BRANCH_A_EXTENDED.length);

		rebuilt.dispose();
		scratch.dispose();
	});
});

/**
 * The SAME keeper, with an unconfirmed WINDOW re-attached on the way out.
 *
 * The shipped keeper stored the whole `lastSync`, window included, and this is
 * the control for dropping it: if a rebuild off a stream that carries the window
 * lands where a rebuild off one that does not lands, the window was REDUNDANT
 * here rather than merely unread. (It is: `promiseToFeed` takes the three block
 * numbers and `generateStreamFromReplay` rebuilds the window from the events.)
 *
 * A SUPERSEDED block is dropped, and that is not a detail. The stored stream is
 * an EMISSION stream, so a reorged-out block appears TWICE in it -- once as it
 * was emitted and once at its original height flagged `removed` -- and a
 * reconstruction that only skipped the `removed` entries would put two entries
 * at one height in the window. That is a window no keeper ever wrote, and it
 * makes the engine re-emit a block the replay already applied.
 */
function withWindowReattached(keeper: ReturnType<typeof keepStreamOnIndexedDB<TestABI>>) {
	return {
		...keeper,
		async fetchFrom(source: never, fromBlock: number) {
			const fetched = await keeper.fetchFrom(source, fromBlock);
			// only a real stream has a window to rebuild; every other verdict passes through
			if (fetched.status !== 'stream') return fetched;
			const floor = fetched.lastSync.latestBlock - FINALITY;
			const events = fetched.eventStream as unknown as {
				blockNumber: number;
				blockHash: string;
				removed?: boolean;
			}[];
			const superseded = new Set(events.filter((e) => e.removed).map((e) => e.blockHash));
			const blocks: {number: number; hash: string; events: unknown[]}[] = [];
			for (const e of events) {
				if (e.removed || superseded.has(e.blockHash) || e.blockNumber <= floor) continue;
				let block = blocks.find((b) => b.hash === e.blockHash);
				if (!block) blocks.push((block = {number: e.blockNumber, hash: e.blockHash, events: []}));
				block.events.push(e);
			}
			return {...fetched, lastSync: {...fetched.lastSync, unconfirmedBlocks: blocks as never}};
		},
	};
}

describe('a reorg, replayed', () => {
	/** Index branch A to its tip, then the reorged branch B, keeping the stream. */
	async function liveRunThroughAReorg(tag: string) {
		const chain = fakeChain();
		const stream = keepStreamOnIndexedDB<TestABI>(tag);
		const definition = applyingProcessor();
		const live = indexerOver(definition, await browserStore(tag, definition), {keepStream: stream});
		await live.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(live as never);
		chain.serve(BRANCH_B, BRANCH_B_TIP);
		await indexToTip(live as never);
		const applied = await appliedIn(live.state.$state);
		live.dispose();
		return {chain, stream, applied};
	}

	/** The same shape with NO reorg in it: branch A, then one more block on top. */
	async function liveRunWithoutAReorg(tag: string) {
		const chain = fakeChain();
		const stream = keepStreamOnIndexedDB<TestABI>(tag);
		const definition = applyingProcessor();
		const live = indexerOver(definition, await browserStore(tag, definition), {keepStream: stream});
		await live.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(live as never);
		chain.serve(BRANCH_A_EXTENDED, BRANCH_A_EXTENDED_TIP);
		await indexToTip(live as never);
		live.dispose();
		return {chain, stream};
	}

	it('returns the retractions in APPEND order', async () => {
		const {stream} = await liveRunThroughAReorg(freshName());

		const stored = streamOf(await stream.fetchFrom(SOURCE, START_BLOCK));
		const order = stored.eventStream.map((e) => `${e.blockHash}:${e.logIndex}${e.removed ? ':removed' : ''}`);
		// the superseded 104 comes back at its ORIGINAL block, flagged `removed`, AFTER
		// the events it supersedes and BEFORE the replacement branch -- which is why
		// segments are keyed by ordinal and the read is a full ordered scan: a later
		// segment holds LOWER block numbers and no block ordering could produce this.
		expect(order.filter((entry) => entry.includes('0xa104'))).toEqual([
			'0xa104:0',
			'0xa104:1',
			'0xa104:0:removed',
			'0xa104:1:removed',
		]);
		expect(order.indexOf('0xa104:0:removed')).toBeLessThan(order.indexOf('0xb104:0'));
		expect(stored?.lastSync.unconfirmedBlocks).toEqual([]);
	});

	/**
	 * A rebuild off a stream that CONTAINS a reorg lands on the state the LIVE run
	 * landed on, which is the whole claim ADR-0008 rests a processor upgrade on.
	 *
	 * This case used to assert the opposite, and the inversion is the regression
	 * proof. `generateStreamToAppend` derives retractions from the CURSOR's
	 * unconfirmed window and `groupLogsPerBlock` drops `removed` events out of what
	 * it is given, so a rebuild -- which starts from a fresh cursor with an EMPTY
	 * window -- silently discarded the retractions the stream itself carries and
	 * replayed both branches of the reorg as live blocks. The store refused the
	 * second block at that height (`block 104 is already recorded`), which was the
	 * store doing exactly its job, and on any path that TOLERATED the double-apply
	 * the result was silently wrong state derived partly from a dead branch.
	 *
	 * The replay now goes through `IndexerGeneration.replay`, which honours the
	 * verdicts the stream carries instead of recomputing them from a window a
	 * rebuild does not have. Asserted as an EQUALITY against the live state rather
	 * than as the absence of a throw, because a no-throw says nothing about which
	 * branch the state came from.
	 */
	it('reaches the SAME state as the live run, applying the replacement block once', async () => {
		const {chain, stream, applied} = await liveRunThroughAReorg(freshName());

		const definition = applyingProcessor();
		const rebuilt = indexerOver(definition, await browserStore(freshName(), definition), {keepStream: stream});

		await rebuilt.init({provider: chain.provider, source: SOURCE, config: CONFIG});

		// the replay happens inside `load`, which the first `indexMore` runs -- and
		// the same call goes on to run the first TIP CYCLE after it
		await indexToTip(rebuilt as never);

		const rebuiltApplied = await appliedIn(rebuilt.state.$state);
		expect(rebuiltApplied).toEqual(applied);
		// the dead branch is not in it, the replacement is, and nothing was applied
		// twice -- `times` is what would show a double application through a write
		// that merely looks idempotent
		expect(keysOf(rebuiltApplied)).toContain('0xb104:0');
		expect(keysOf(rebuiltApplied).filter((key) => key.startsWith('0xa104'))).toEqual([]);
		expect(rebuiltApplied.map((row) => row.times)).toEqual(rebuiltApplied.map(() => 1));

		// and the cycle AFTER that one re-reads the finality window without applying
		// the replacement block a second time: the replay left it IN the window
		await indexToTip(rebuilt as never);
		expect(await appliedIn(rebuilt.state.$state)).toEqual(applied);

		rebuilt.dispose();
	});

	it('rebuilds the same state whether or not the cursor carries a window', async () => {
		const withoutWindow = await liveRunWithoutAReorg(freshName());
		const withWindow = await liveRunWithoutAReorg(freshName());

		const plainDefinition = applyingProcessor();
		const plain = indexerOver(plainDefinition, await browserStore(freshName(), plainDefinition), {
			keepStream: withoutWindow.stream,
		});
		await plain.init({provider: withoutWindow.chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(plain as never);

		const windowedDefinition = applyingProcessor();
		const windowed = indexerOver(windowedDefinition, await browserStore(freshName(), windowedDefinition), {
			keepStream: withWindowReattached(withWindow.stream),
		});
		await windowed.init({provider: withWindow.chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(windowed as never);

		expect(keysOf(await appliedIn(plain.state.$state))).toEqual(keysOf(await appliedIn(windowed.state.$state)));
		plain.dispose();
		windowed.dispose();
	});
});

describe('`fetchFrom` answers what it answered before', () => {
	it('returns the same events in the same order as one whole-blob read did', async () => {
		const tag = freshName();
		const chain = fakeChain();
		const stream = keepStreamOnIndexedDB<TestABI>(tag);

		const definition = applyingProcessor();
		const indexer = indexerOver(definition, await browserStore(tag, definition), {keepStream: stream});
		await indexer.init({provider: chain.provider, source: SOURCE, config: CONFIG});
		await indexToTip(indexer as never);
		indexer.dispose();

		const whole = streamOf(await stream.fetchFrom(SOURCE, START_BLOCK));
		expect(whole.eventStream.map((e) => `${e.blockHash}:${e.logIndex}`)).toEqual(
			BRANCH_A.map((log) => `${log.blockHash}:${parseInt(log.logIndex.slice(2), 16)}`),
		);
		// the window is not stored and not reconstructed
		expect(whole.lastSync.unconfirmedBlocks).toEqual([]);
	});
});
