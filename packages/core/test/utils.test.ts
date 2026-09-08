import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {
	generateStreamToAppend,
	getFromBlock,
	groupLogsPerBlock,
	resolveStreamConfig,
	streamConfigHashOf,
} from '../src/internal/engine/utils.js';
import type {EventBlock, LastSync, LogEvent} from '../src/types.js';

type TestABI = Abi;

const CONTEXT = {source: [{startBlock: 0, hash: 'h'}], config: 'cfg', processor: 'proc'};

function lastSync(over: Partial<LastSync<TestABI>> = {}): LastSync<TestABI> {
	return {
		context: CONTEXT,
		latestBlock: 0,
		lastFromBlock: 0,
		lastToBlock: 0,
		unconfirmedBlocks: [],
		...over,
	};
}

let logCounter = 0;
// Build a minimal LogEvent. Only the fields used by the stream logic matter
// (blockNumber, blockHash, transactionHash, removed). The rest are filled to
// satisfy the type without affecting behaviour.
function makeEvent(blockNumber: number, blockHash: string, extra: Partial<LogEvent<TestABI>> = {}): LogEvent<TestABI> {
	logCounter++;
	return {
		blockNumber,
		blockHash: blockHash as `0x${string}`,
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000000',
		data: '0x',
		topics: [],
		transactionHash: `0x${logCounter.toString(16).padStart(64, '0')}` as `0x${string}`,
		logIndex: 0,
		extra: undefined,
		// parsed-event fields are not needed for stream logic; cast keeps types happy
		...(extra as any),
	} as unknown as LogEvent<TestABI>;
}

function block(number: number, hash: string, events: LogEvent<TestABI>[]): EventBlock<TestABI> {
	return {number, hash, events};
}

describe('getFromBlock', () => {
	it('returns defaultFromBlock when never synced (latestBlock === 0)', () => {
		expect(getFromBlock(lastSync({latestBlock: 0, lastToBlock: 0}), 100, 12)).toBe(100);
	});

	it('returns lastToBlock + 1 when well within the finality window', () => {
		const ls = lastSync({latestBlock: 1000, lastToBlock: 500});
		// min(501, 1000-12=988) = 501
		expect(getFromBlock(ls, 0, 12)).toBe(501);
	});

	it('never goes past latestBlock - finality (re-scans the unconfirmed window)', () => {
		const ls = lastSync({latestBlock: 1000, lastToBlock: 999});
		// min(1000, 988) = 988
		expect(getFromBlock(ls, 0, 12)).toBe(988);
	});

	it('never returns a negative block', () => {
		const ls = lastSync({latestBlock: 5, lastToBlock: 4});
		// min(5, 5-12=-7) = -7 -> clamped to 0
		expect(getFromBlock(ls, 0, 12)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AN EXPLICIT `undefined` IS AN ABSENT KEY
// ---------------------------------------------------------------------------
// Every field of a `ProvidedStreamConfig` is optional, so `{finality: undefined}`
// type-checks -- and it is what a JSON round-trip or an options object built as
// `{finality: opts.finality}` produces, which makes it ordinary rather than
// exotic. A plain spread let it overwrite the default back to nothing, and the
// damage was silent on three axes at once: the reorg arithmetic went NaN, the
// config hashed as though no default applied, and it therefore read as a
// DIFFERENT config from every other spelling of the same default. The digest
// this feeds already collapses explicit-undefined to absent (`hash.test.ts`), so
// the resolver is simply made to agree with it.
// ---------------------------------------------------------------------------

describe('resolveStreamConfig', () => {
	it('fills the default when the config is absent, empty, or leaves finality unset', () => {
		expect(resolveStreamConfig(undefined)).toEqual({finality: 17});
		expect(resolveStreamConfig({})).toEqual({finality: 17});
		expect(resolveStreamConfig({parse: {}})).toEqual({finality: 17, parse: {}});
	});

	it('treats an explicit `undefined` finality as ABSENT, not as a value', () => {
		expect(resolveStreamConfig({finality: undefined})).toEqual({finality: 17});
		// the shape a JSON round-trip produces, and the shape an options object
		// forwarding an unset flag produces
		expect(resolveStreamConfig(JSON.parse(JSON.stringify({finality: undefined})))).toEqual({finality: 17});
		expect(resolveStreamConfig({finality: undefined, parse: {}})).toEqual({
			finality: 17,
			parse: {},
		});
	});

	it('drops any other explicitly-undefined key rather than carrying it', () => {
		// asserted on the KEYS, not with `toEqual`: `toEqual` ignores undefined-valued
		// properties, so it would pass just as happily on a config that carried them
		expect(Object.keys(resolveStreamConfig({parse: undefined}))).toEqual(['finality']);
		expect(Object.keys(resolveStreamConfig({finality: undefined, parse: undefined}))).toEqual(['finality']);
		expect(resolveStreamConfig({parse: undefined})).toStrictEqual({finality: 17});
		// a carried `undefined` is not merely untidy: `canonical_form` drops it, so the
		// object and its digest would disagree about which keys the config has
		expect(Object.keys(resolveStreamConfig({finality: undefined}))).toEqual(['finality']);
	});

	it('still lets a REAL value win, including a falsy one', () => {
		expect(resolveStreamConfig({finality: 5})).toEqual({finality: 5});
		// 0 is a value, not an absence: a chain with no reorgs is a legitimate config
		expect(resolveStreamConfig({finality: 0})).toEqual({finality: 0});
	});

	it('is IDEMPOTENT, so resolving an already-resolved config moves nothing', () => {
		for (const provided of [undefined, {}, {finality: undefined}, {finality: 5}, {parse: {}}]) {
			expect(resolveStreamConfig(resolveStreamConfig(provided))).toEqual(resolveStreamConfig(provided));
		}
	});

	it('keeps the reorg window ARITHMETIC out of NaN', () => {
		// the consequence that made this worth fixing rather than noting: `getFromBlock`
		// subtracts `finality` from the head, so an undefined one poisons the block the
		// next round asks from
		const ls = lastSync({latestBlock: 1000, lastToBlock: 999});
		expect(getFromBlock(ls, 0, resolveStreamConfig({finality: undefined}).finality)).toBe(983);
		expect(getFromBlock(ls, 0, resolveStreamConfig({}).finality)).toBe(983);
	});

	it('makes every spelling of the default ONE config to the digest', () => {
		// the third axis: the hash is what decides a reconfigure is a no-op, so a
		// spelling that hashes differently is a full re-index
		const theDefault = streamConfigHashOf({});
		expect(streamConfigHashOf({finality: undefined})).toBe(theDefault);
		expect(streamConfigHashOf(undefined)).toBe(theDefault);
		expect(streamConfigHashOf({finality: 17})).toBe(theDefault);
		// and a config that genuinely moved is still its own digest
		expect(streamConfigHashOf({finality: 5})).not.toBe(theDefault);
	});
});

describe('groupLogsPerBlock', () => {
	it('groups events by blockHash preserving order', () => {
		const e1 = makeEvent(10, '0xa');
		const e2 = makeEvent(10, '0xa');
		const e3 = makeEvent(11, '0xb');
		const groups = groupLogsPerBlock([e1, e2, e3]);
		expect(groups).toHaveLength(2);
		expect(groups[0].hash).toBe('0xa');
		expect(groups[0].events).toHaveLength(2);
		expect(groups[1].hash).toBe('0xb');
		expect(groups[1].events).toHaveLength(1);
	});

	it('skips removed events', () => {
		const e1 = makeEvent(10, '0xa');
		const e2 = makeEvent(10, '0xa', {removed: true});
		const groups = groupLogsPerBlock([e1, e2]);
		expect(groups).toHaveLength(1);
		expect(groups[0].events).toHaveLength(1);
	});
});

describe('generateStreamToAppend', () => {
	const finality = 12;

	it('throws when newLastFromBlock does not match the expected fromBlock', () => {
		const ls = lastSync({latestBlock: 1000, lastToBlock: 500});
		// expected fromBlock = min(501, 988) = 501
		expect(() =>
			generateStreamToAppend(ls, 0, [], {
				newLatestBlock: 1000,
				newLastToBlock: 600,
				newLastFromBlock: 400, // wrong
				finality,
			}),
		).toThrow();
	});

	it('appends fresh events on a clean first sync and records unconfirmed blocks', () => {
		const ls = lastSync({latestBlock: 0, lastToBlock: 0, lastFromBlock: 0});
		const events = [makeEvent(100, '0x100'), makeEvent(101, '0x101')];
		const {eventStream, newLastSync} = generateStreamToAppend(ls, 0, events, {
			newLatestBlock: 105,
			newLastToBlock: 105,
			newLastFromBlock: 0, // first sync -> getFromBlock returns defaultFromBlock (0)
			finality,
		});
		expect(eventStream).toHaveLength(2);
		expect(eventStream.every((e) => !e.removed)).toBe(true);
		// both blocks are within finality of latest (105 - 100 <= 12 is false for 100? 105-100=5 <=12 true)
		expect(newLastSync.unconfirmedBlocks.map((b) => b.number)).toEqual([100, 101]);
		expect(newLastSync.latestBlock).toBe(105);
		expect(newLastSync.lastToBlock).toBe(105);
	});

	it('does not track blocks as unconfirmed when they are older than the finality window', () => {
		const ls = lastSync({latestBlock: 0});
		const events = [makeEvent(10, '0x10')];
		const {newLastSync} = generateStreamToAppend(ls, 0, events, {
			newLatestBlock: 1000, // 1000 - 10 = 990 > finality => confirmed
			newLastToBlock: 1000,
			newLastFromBlock: 0,
			finality,
		});
		expect(newLastSync.unconfirmedBlocks).toHaveLength(0);
	});

	it('handles a single-block reorg: emits removed events then the new ones', () => {
		// Previous sync had unconfirmed block 100 with hash 0xAAA containing one event.
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			lastFromBlock: 89, // expected fromBlock for next call
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		// getFromBlock(ls) = min(101, 100-12=88) ... wait latest=100 -> 88. Use that as newLastFromBlock.
		const expectedFrom = getFromBlock(ls, 0, finality); // 88
		// Reorg: block 100 now has a different hash 0xBBB with a new event.
		const newEvent = makeEvent(100, '0xBBB');
		const {eventStream, newLastSync} = generateStreamToAppend(ls, 0, [newEvent], {
			newLatestBlock: 101,
			newLastToBlock: 101,
			newLastFromBlock: expectedFrom,
			finality,
		});
		// First the reorged-out event flagged removed, then the new event.
		expect(eventStream).toHaveLength(2);
		expect(eventStream[0].removed).toBe(true);
		expect(eventStream[0].blockHash).toBe('0xAAA');
		expect(eventStream[1].removed).toBe(false);
		expect(eventStream[1].blockHash).toBe('0xBBB');
		// The new unconfirmed set reflects the canonical chain.
		expect(newLastSync.unconfirmedBlocks.map((b) => b.hash)).toEqual(['0xBBB']);
	});

	it('keeps appending without removals when unconfirmed blocks still match', () => {
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		const expectedFrom = getFromBlock(ls, 0, finality);
		// Re-fetch includes the same block 100 (0xAAA) plus a new block 101.
		const sameEvent = makeEvent(100, '0xAAA');
		const newEvent = makeEvent(101, '0xBBB');
		const {eventStream} = generateStreamToAppend(ls, 0, [sameEvent, newEvent], {
			newLatestBlock: 101,
			newLastToBlock: 101,
			newLastFromBlock: expectedFrom,
			finality,
		});
		// No removals; only the genuinely-new block 101 event is appended.
		expect(eventStream.some((e) => e.removed)).toBe(false);
		expect(eventStream).toHaveLength(1);
		expect(eventStream[0].blockHash).toBe('0xBBB');
	});

	// Regression: a reorg that REMOVES an unconfirmed block's logs without replacing them at
	// another block-with-logs (e.g. the tx went back to the mempool and is not re-mined yet).
	// The re-fetch legitimately returns a SHORTER list than unconfirmedBlocks, so a comparison
	// driven by the incoming list alone never looks at the vanished block.
	it('detects a reorg when a trailing unconfirmed block vanishes from the re-fetch', () => {
		const event100 = makeEvent(100, '0xAAA');
		const event105 = makeEvent(105, '0xBBB');
		const ls = lastSync({
			latestBlock: 105,
			lastToBlock: 105,
			unconfirmedBlocks: [block(100, '0xAAA', [event100]), block(105, '0xBBB', [event105])],
		});
		const expectedFrom = getFromBlock(ls, 0, finality); // 93, covers both unconfirmed blocks
		// Block 105 was reorged out; its log is gone. Block 100 is untouched and still returned.
		const {eventStream, newLastSync} = generateStreamToAppend(ls, 0, [makeEvent(100, '0xAAA')], {
			newLatestBlock: 106,
			newLastToBlock: 106,
			newLastFromBlock: expectedFrom,
			finality,
		});
		// The vanished block's event must be retracted...
		expect(eventStream).toHaveLength(1);
		expect(eventStream[0].removed).toBe(true);
		expect(eventStream[0].blockHash).toBe('0xBBB');
		// ...and it must not linger in the unconfirmed set (where it would later be pruned silently).
		expect(newLastSync.unconfirmedBlocks.map((b) => b.hash)).toEqual(['0xAAA']);
	});

	// A reorg is concluded in two very different ways, and ADR-0004 requires them to be
	// distinguishable: a CONTRADICTION (the same height now has a different hash) is proof,
	// while an ABSENCE (a block we hold is simply not in the payload) is an inference, and it
	// is the inference that silently deletes state when a sender under-delivers a range.
	it('reports a hash contradiction as the reorg cause', () => {
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		const {reorg} = generateStreamToAppend(ls, 0, [makeEvent(100, '0xBBB')], {
			newLatestBlock: 101,
			newLastToBlock: 101,
			newLastFromBlock: getFromBlock(ls, 0, finality),
			finality,
		});
		expect(reorg).toEqual({cause: 'contradiction', blockNumber: 100, blockHash: '0xAAA'});
	});

	it('reports a vanished block as an absence, not a contradiction', () => {
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		const {reorg} = generateStreamToAppend(ls, 0, [], {
			newLatestBlock: 101,
			newLastToBlock: 101,
			newLastFromBlock: getFromBlock(ls, 0, finality),
			finality,
		});
		expect(reorg).toEqual({cause: 'absence', blockNumber: 100, blockHash: '0xAAA'});
	});

	it('reports no reorg when nothing was reverted', () => {
		const ls = lastSync({latestBlock: 1000, lastToBlock: 1000});
		const {reorg} = generateStreamToAppend(ls, 0, [], {
			newLatestBlock: 1001,
			newLastToBlock: 1001,
			newLastFromBlock: getFromBlock(ls, 0, finality),
			finality,
		});
		expect(reorg).toBeUndefined();
	});

	it('detects a reorg when ALL unconfirmed blocks vanish (empty re-fetch)', () => {
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		const expectedFrom = getFromBlock(ls, 0, finality);
		const {eventStream, newLastSync} = generateStreamToAppend(ls, 0, [], {
			newLatestBlock: 101,
			newLastToBlock: 101,
			newLastFromBlock: expectedFrom,
			finality,
		});
		expect(eventStream).toHaveLength(1);
		expect(eventStream[0].removed).toBe(true);
		expect(eventStream[0].blockHash).toBe('0xAAA');
		expect(newLastSync.unconfirmedBlocks).toHaveLength(0);
	});

	it('does not treat an unconfirmed block as reorged when it is outside the re-fetched range', () => {
		// Defensive: only blocks the re-fetch actually covered can be judged missing.
		const prevEvent = makeEvent(100, '0xAAA');
		const ls = lastSync({
			latestBlock: 100,
			lastToBlock: 100,
			unconfirmedBlocks: [block(100, '0xAAA', [prevEvent])],
		});
		const expectedFrom = getFromBlock(ls, 0, finality);
		// A narrow re-fetch that stops BELOW the unconfirmed block.
		const {eventStream} = generateStreamToAppend(ls, 0, [], {
			newLatestBlock: 100,
			newLastToBlock: 95,
			newLastFromBlock: expectedFrom,
			finality,
		});
		expect(eventStream).toHaveLength(0);
	});

	it('produces an empty stream when there are no new events and nothing to reorg', () => {
		const ls = lastSync({latestBlock: 1000, lastToBlock: 1000});
		const expectedFrom = getFromBlock(ls, 0, finality);
		const {eventStream, newLastSync} = generateStreamToAppend(ls, 0, [], {
			newLatestBlock: 1001,
			newLastToBlock: 1001,
			newLastFromBlock: expectedFrom,
			finality,
		});
		expect(eventStream).toHaveLength(0);
		expect(newLastSync.latestBlock).toBe(1001);
	});
});

// ---------------------------------------------------------------------------
// A RE-FETCHED BLOCK IS NEW UNLESS THE WINDOW ALREADY HOLDS IT
// ---------------------------------------------------------------------------
// The rule that decides which incoming blocks are delivered, and the SILENT
// PERMANENT LOSS it replaces.
//
// `unconfirmedBlocks` holds only EVENT-BEARING blocks, so it is SPARSE: its
// lowest entry is usually far above the height the chain actually forked at. The
// old rule was a scalar height (`reorgBlock.number` on a reorg, the window's top
// plus one otherwise) and every incoming block below it was dropped, which
// encodes the claim "we already hold everything below this". A sparse window
// makes that claim false, so the replacement branch's logs in the gap were
// fetched, dropped in memory, and never fetched again -- the next range starts
// above them.
//
// The rule is now MEMBERSHIP: a block is new unless the RETAINED window (what
// survived the retraction) already holds it by `(number, hash)`. It is the rule
// the replay path in the same file already applies, and it is sound because a
// re-fetch never starts below `latestBlock - finality`, so anything we applied
// WITH EVENTS inside the re-fetched range is still in the window unless it was
// retracted.
//
// Both halves are asserted here, and the once-only half as hard as the delivery
// half: the scalar was what stopped a re-offered block being applied twice, so
// the membership test has to keep doing that job.
// ---------------------------------------------------------------------------

describe('a re-fetched block is new unless the window already holds it', () => {
	const finality = 12;

	it('delivers the new branch logs BELOW the lowest block we held logs for', () => {
		// We hold ONE event-bearing block, at 200. The chain forks at 195, where we
		// held nothing because 195 carried no logs for our filter.
		const ls = lastSync({
			latestBlock: 205,
			lastFromBlock: 190,
			lastToBlock: 205,
			unconfirmedBlocks: [block(200, '0xa200', [makeEvent(200, '0xa200')])],
		});
		// the re-fetch carries a log at 196 (in the gap) and a replacement at 200
		const incoming = [makeEvent(196, '0xb196'), makeEvent(200, '0xb200')];
		// = min(lastToBlock + 1, latestBlock - finality), so the gap block IS in range
		expect(getFromBlock(ls, 0, finality)).toBe(193);

		const {eventStream, reorg} = generateStreamToAppend(ls, 0, incoming, {
			newLatestBlock: 210,
			newLastFromBlock: 193,
			newLastToBlock: 210,
			finality,
		});

		expect(reorg).toEqual({cause: 'contradiction', blockNumber: 200, blockHash: '0xa200'});
		const delivered = eventStream.filter((e) => !e.removed).map((e) => `${e.blockNumber}:${e.blockHash}`);
		// the gap log, which the scalar threshold discarded for ever
		expect(delivered).toContain('196:0xb196');
		expect(delivered).toEqual(['196:0xb196', '200:0xb200']);
		// and the retraction is unchanged: the block we held is still taken back
		expect(eventStream.filter((e) => e.removed).map((e) => `${e.blockNumber}:${e.blockHash}`)).toEqual(['200:0xa200']);
	});

	it('delivers a block the window never held even when NOTHING reorged', () => {
		// The same sparseness, without a fork: the window's lowest entry is 200 and
		// the re-fetch reaches back to 193, so a log at 196 the window does not hold
		// is a log we never applied. Under the scalar it was below `top + 1` and
		// therefore assumed already held, which is the same false claim.
		const ls = lastSync({
			latestBlock: 205,
			lastFromBlock: 190,
			lastToBlock: 205,
			unconfirmedBlocks: [block(200, '0xa200', [makeEvent(200, '0xa200')])],
		});
		const {eventStream, reorg} = generateStreamToAppend(
			ls,
			0,
			[makeEvent(196, '0xc196'), makeEvent(200, '0xa200'), makeEvent(203, '0xa203')],
			{
				newLatestBlock: 206,
				newLastFromBlock: getFromBlock(ls, 0, finality),
				newLastToBlock: 206,
				finality,
			},
		);

		// nothing was contradicted and nothing vanished: 200 came back as itself
		expect(reorg).toBeUndefined();
		expect(eventStream.map((e) => `${e.blockNumber}:${e.blockHash}`)).toEqual(['196:0xc196', '203:0xa203']);
	});

	it('applies a block the window ALREADY HOLDS once, however often it is re-offered', () => {
		// This is the job the discarded scalar was doing, and the reason a re-fetch
		// re-reading the finality window every cycle does not double-apply: every
		// cycle from `latestBlock - finality` re-offers blocks that are already in the
		// window, at the same hashes.
		const ls = lastSync({
			latestBlock: 205,
			lastFromBlock: 190,
			lastToBlock: 205,
			unconfirmedBlocks: [
				block(196, '0xa196', [makeEvent(196, '0xa196')]),
				block(200, '0xa200', [makeEvent(200, '0xa200')]),
			],
		});
		const {eventStream, newLastSync, reorg} = generateStreamToAppend(
			ls,
			0,
			[makeEvent(196, '0xa196'), makeEvent(200, '0xa200'), makeEvent(205, '0xa205')],
			{
				newLatestBlock: 206,
				newLastFromBlock: getFromBlock(ls, 0, finality),
				newLastToBlock: 206,
				finality,
			},
		);

		expect(reorg).toBeUndefined();
		// only the genuinely new block, and each held block exactly once in the window
		expect(eventStream.map((e) => `${e.blockNumber}:${e.blockHash}`)).toEqual(['205:0xa205']);
		expect(newLastSync.unconfirmedBlocks.map((b) => `${b.number}:${b.hash}`)).toEqual([
			'196:0xa196',
			'200:0xa200',
			'205:0xa205',
		]);
	});

	it('does not deliver the gap block a SECOND time once the window holds it', () => {
		// The delivery half and the once-only half in one run: the gap block is
		// delivered on the cycle that discovers it, enters the window, and the very
		// next cycle re-fetches the same range and delivers nothing.
		const ls = lastSync({
			latestBlock: 205,
			lastFromBlock: 190,
			lastToBlock: 205,
			unconfirmedBlocks: [block(200, '0xa200', [makeEvent(200, '0xa200')])],
		});
		const forked = [makeEvent(196, '0xb196'), makeEvent(200, '0xb200')];
		const first = generateStreamToAppend(ls, 0, forked, {
			newLatestBlock: 206,
			newLastFromBlock: getFromBlock(ls, 0, finality),
			newLastToBlock: 206,
			finality,
		});
		expect(first.eventStream.filter((e) => !e.removed)).toHaveLength(2);
		expect(first.newLastSync.unconfirmedBlocks.map((b) => b.number)).toEqual([196, 200]);

		// the same range again, exactly as the next cycle re-reads it
		const second = generateStreamToAppend(first.newLastSync, 0, [...forked, makeEvent(206, '0xb206')], {
			newLatestBlock: 207,
			newLastFromBlock: getFromBlock(first.newLastSync, 0, finality),
			newLastToBlock: 207,
			finality,
		});

		expect(second.reorg).toBeUndefined();
		expect(second.eventStream.map((e) => `${e.blockNumber}:${e.blockHash}`)).toEqual(['206:0xb206']);
		expect(second.newLastSync.unconfirmedBlocks.map((b) => `${b.number}:${b.hash}`)).toEqual([
			'196:0xb196',
			'200:0xb200',
			'206:0xb206',
		]);
	});

	it('still re-applies a block that was RETRACTED and then re-offered under the same hash', () => {
		// A reorg concluded at the FIRST window block retracts every later one too,
		// and a re-fetch that still contains one of them re-applies it under the same
		// hash. That is why the membership test reads the RETAINED window and not the
		// whole one: a retracted block has left it, so its re-offer is new again.
		const ls = lastSync({
			latestBlock: 205,
			lastFromBlock: 190,
			lastToBlock: 205,
			unconfirmedBlocks: [
				block(196, '0xa196', [makeEvent(196, '0xa196')]),
				block(200, '0xa200', [makeEvent(200, '0xa200')]),
			],
		});
		// 196's logs vanished (an absence); 200 is still there, unchanged
		const {eventStream, reorg} = generateStreamToAppend(ls, 0, [makeEvent(200, '0xa200')], {
			newLatestBlock: 206,
			newLastFromBlock: getFromBlock(ls, 0, finality),
			newLastToBlock: 206,
			finality,
		});

		expect(reorg).toEqual({cause: 'absence', blockNumber: 196, blockHash: '0xa196'});
		expect(eventStream.map((e) => `${e.removed ? 'removed' : 'applied'} ${e.blockNumber}:${e.blockHash}`)).toEqual([
			'removed 196:0xa196',
			'removed 200:0xa200',
			'applied 200:0xa200',
		]);
	});

	it('keeps the rebuilt window ASCENDING when a delivered block sits below a retained one', () => {
		// The window is read in block order by the next cycle's reorg walk, so the
		// membership rule must not leave it unordered: a block below the lowest
		// RETAINED one can now be delivered, and it is appended after the blocks
		// carried forward.
		const ls = lastSync({
			latestBlock: 205,
			lastFromBlock: 190,
			lastToBlock: 205,
			unconfirmedBlocks: [
				block(195, '0xa195', [makeEvent(195, '0xa195')]),
				block(200, '0xa200', [makeEvent(200, '0xa200')]),
			],
		});
		const {eventStream, newLastSync} = generateStreamToAppend(
			ls,
			0,
			[makeEvent(193, '0xc193'), makeEvent(195, '0xa195'), makeEvent(200, '0xb200')],
			{
				// the tip did not move this cycle, so 193 is still inside the finality
				// window and enters the rebuilt one
				newLatestBlock: 205,
				newLastFromBlock: getFromBlock(ls, 0, finality),
				newLastToBlock: 205,
				finality,
			},
		);

		// 195 is retained (its hash came back), so it is neither retracted nor
		// re-delivered; 193 and the replacement at 200 are both new
		expect(eventStream.map((e) => `${e.removed ? 'removed' : 'applied'} ${e.blockNumber}:${e.blockHash}`)).toEqual([
			'removed 200:0xa200',
			'applied 193:0xc193',
			'applied 200:0xb200',
		]);
		expect(newLastSync.unconfirmedBlocks.map((b) => b.number)).toEqual([193, 195, 200]);
	});
});
