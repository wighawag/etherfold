import type {Abi} from 'abitype';
import {logs} from 'named-logs';
import type {ExistingStream, IndexingSource, LastSync, LogEvent} from '../types.js';
import {degradingStream} from './degrading.js';

const namedLogger = logs('@etherfold/core');

/**
 * ONE SAVE'S BATCH, and nothing else.
 *
 * No extent, no cursor, no `lastSync`. An earlier design carried a per-segment
 * SCANNED EXTENT whose only reader was a gap recovery that kept the contiguous
 * prefix beneath a gap; that recovery is withdrawn (ADR-0035, as amended) and
 * the extent went with it. The three block numbers and the `context` live ONCE,
 * in the cursor record beside the segments.
 *
 * Deliberately NOT holding `unconfirmedBlocks`: the window is READ from the
 * entity path's serialized sync cursor, and a stream keeper's copy is read by
 * nobody -- `promiseToFeed` takes
 * only the three block numbers and `generateStreamFromReplay` rebuilds the window
 * by WALKING the replayed events (ADR-0042; it was `generateStreamToAppend` until
 * a replay stopped being routed through the fetch path). The captured-stream path
 * (`captureStream`/`replayStream`) is the standing evidence that nothing needs the
 * stored window: it records an empty one and serves an empty one, and a replay off
 * it loses nothing. It is NOT an implementation of this seam -- a fixture serves
 * DECODED events and has its own reader type (ADR-0059) -- which is why it is
 * evidence rather than a keeper.
 */
export type StreamSegment<ABI extends Abi> = {events: LogEvent<ABI>[]};

/**
 * The CURSOR RECORD: a `LastSync` minus its window, plus two numbers of the
 * keeper's own.
 *
 * `nextOrdinal` is here because nothing else stored holds position metadata any
 * more, and because the alternatives differ asymptotically: an in-memory counter
 * breaks across tabs, and enumerating the keys is O(segments) PER SAVE, which
 * leaves the append quadratic in key reads while passing any cost criterion that
 * only watches the writes. It is read INSIDE the commit, which is what makes the
 * allocation safe when two tabs save at once.
 *
 * `startBlock` is the `lastFromBlock` of the FIRST save into this subtree,
 * written once and never updated. It is what lets `fetchFrom` refuse a stream it
 * cannot serve: the indexer's clear-on-absence branch exists in only ONE of its
 * two load branches, so a self-clear on the other one leaves a NEW subtree whose
 * first segment begins mid-history, and nothing downstream marks it as partial.
 */
export type StreamCursorRecord<ABI extends Abi> = {
	context: LastSync<ABI>['context'];
	latestBlock: number;
	lastFromBlock: number;
	lastToBlock: number;
	/** The `lastFromBlock` of the first save into this subtree. Written once. */
	startBlock: number;
	/** The ordinal the next segment takes; equal to the number of segments stored. */
	nextOrdinal: number;
};

/** What ONE commit writes: a segment at an ordinal, and the cursor beside it. */
export type SegmentCommit<ABI extends Abi> = {
	ordinal: number;
	segment: StreamSegment<ABI>;
	cursor: StreamCursorRecord<ABI>;
};

/**
 * One stored segment as the substrate hands it back: its ordinal, and a value
 * this helper has yet to believe.
 *
 * `value` is `unknown` on purpose. A segment that does not parse is one of the
 * three damage shapes, and a port that typed it would be asserting the very
 * thing the helper has to check.
 */
export type StoredSegment = {ordinal: number; value: unknown};

/**
 * What a KEEPER supplies, scoped to one stream's subtree.
 *
 * The three named in ADR-0035 -- commit-segment-with-cursor, read-cursor,
 * write-cursor-only -- are the CURSOR seam, and the other two are the reads a
 * full ordered scan and a scoped delete need on any substrate. Every cursor move
 * goes through one of the three: nothing here writes a cursor by any other
 * route, which is what keeps this helper honest on a substrate whose transaction
 * it cannot see.
 *
 * The two write operations take a DECISION FUNCTION rather than a record,
 * because the decision (which ordinal, which start block, and whether this batch
 * would leave a hole) has to be made from the CURRENT cursor INSIDE the keeper's
 * transaction. A keeper that read the cursor, returned it, and then took a
 * second transaction to write would lose a batch whenever two tabs save at once,
 * with the ordinals still contiguous afterwards so nothing could detect it. The
 * function is synchronous for the same reason `@etherfold/state-store-indexeddb`
 * keeps its cursor steps synchronous: inside a transaction there is nothing it
 * could legitimately await.
 */
export type StreamSegmentPort<ABI extends Abi> = {
	/** The live cursor, or nothing. This is also what PRESENCE is. */
	readCursor(source: IndexingSource<ABI>): Promise<StreamCursorRecord<ABI> | undefined>;
	/**
	 * Write a segment and make the cursor current, TOGETHER.
	 *
	 * `allocate` is called with the stored cursor and returns what to write, or
	 * `undefined` to write nothing at all.
	 */
	commitSegmentWithCursor(
		source: IndexingSource<ABI>,
		allocate: (current: StreamCursorRecord<ABI> | undefined) => SegmentCommit<ABI> | undefined,
	): Promise<void>;
	/** Move the cursor with NO segment: an empty save, and nothing else. */
	writeCursorOnly(
		source: IndexingSource<ABI>,
		next: (current: StreamCursorRecord<ABI> | undefined) => StreamCursorRecord<ABI> | undefined,
	): Promise<void>;
	/** Every stored segment of this stream, in ORDINAL order. */
	readSegments(source: IndexingSource<ABI>): Promise<StoredSegment[]>;
	/** Delete the stream's whole subtree, cursor included. Returns how many records went. */
	clearSubtree(source: IndexingSource<ABI>): Promise<number>;
};

function isSegment(value: unknown): value is StreamSegment<Abi> {
	return typeof value === 'object' && value !== null && Array.isArray((value as {events?: unknown}).events);
}

/**
 * Segmentation, over a port scoped to one stream's subtree.
 *
 * The rules live HERE, once, so a second keeper (SQL for a server, OPFS in a
 * browser) supplies five substrate operations and inherits every one of them:
 * one segment per batch and no open tail, the ordinal allocated from the cursor
 * record inside the commit, an empty save that writes only the cursor, a full
 * ordered scan on the way back, one comparison that refuses a write which would
 * leave a HOLE, and one rule for damage -- clear the subtree and let it rebuild.
 *
 * Nothing here assumes a tail, reads a segment's cursor, or knows what a key
 * looks like.
 *
 * The damage rule has TWO halves and they are both here, so a second keeper
 * inherits both. The damage a port can SHOW is inspected and cleared below. The
 * damage it can only RAISE -- a substrate that is unavailable, which no amount of
 * reading the keys can detect -- is `degradingStream`: the read side answers
 * ABSENT, which is the same answer, and the caller re-indexes rather than
 * failing to load. The write side raises through, because its caller acts on it.
 */
export function createSegmentedStream<ABI extends Abi>(port: StreamSegmentPort<ABI>): ExistingStream<ABI> {
	/**
	 * Whether the last save was refused, so a jump that persists is logged ONCE
	 * rather than once per index cycle. Reset by any save that is accepted, which
	 * is what makes the revival visible too.
	 */
	let declineReported = false;

	/**
	 * The two numbers a save carries forward from the stored cursor, or nothing
	 * if writing this batch would leave a HOLE.
	 *
	 * A batch whose `lastFromBlock` is above `lastToBlock + 1` covers blocks the
	 * stream never received, and no segment-level check can see that afterwards:
	 * segments are keyed by SAVE rather than by block, so a save that never
	 * happened leaves the ordinals perfectly contiguous. The answer is to REFUSE
	 * and keep what is stored -- a contiguous prefix with a cursor that describes
	 * it honestly is a usable seed, and destroying it would cost a re-fetch from
	 * the source's first block for no gain.
	 *
	 * Only a forward JUMP. An OVERLAP is the ordinary tip re-scan, since every
	 * cycle re-reads the last `finality` blocks, and treating that as damage would
	 * refuse almost every save.
	 */
	function carryForward(
		current: StreamCursorRecord<ABI> | undefined,
		lastSync: LastSync<ABI>,
	): {startBlock: number; nextOrdinal: number} | undefined {
		if (!current) {
			return {startBlock: lastSync.lastFromBlock, nextOrdinal: 0};
		}
		if (lastSync.lastFromBlock > current.lastToBlock + 1) {
			return undefined;
		}
		return {startBlock: current.startBlock, nextOrdinal: current.nextOrdinal};
	}

	function cursorRecord(
		lastSync: LastSync<ABI>,
		carried: {startBlock: number; nextOrdinal: number},
	): StreamCursorRecord<ABI> {
		return {
			context: lastSync.context,
			latestBlock: lastSync.latestBlock,
			lastFromBlock: lastSync.lastFromBlock,
			lastToBlock: lastSync.lastToBlock,
			startBlock: carried.startBlock,
			nextOrdinal: carried.nextOrdinal,
		};
	}

	async function clearBecause(source: IndexingSource<ABI>, reason: string): Promise<void> {
		const removed = await port.clearSubtree(source);
		namedLogger.info(
			`the cached stream is inconsistent (${reason}), so it is being cleared and will rebuild: ` +
				`${removed} record(s) removed. Repairing it would cost more machinery than the re-index it saves.`,
		);
	}

	return degradingStream<ABI>({
		async fetchFrom(source: IndexingSource<ABI>, fromBlock: number) {
			const cursor = await port.readCursor(source);
			if (!cursor) {
				// UNCONDITIONALLY, before reporting absent: no cursor is also what
				// SEGMENTS WITH NO CURSOR look like, and left in place the next save
				// would take ordinal 0 again, overwrite the old segment 0 and leave every
				// higher ordinal to be replayed as part of a stream it is not part of.
				// Nothing else cleans it up -- `indexer.ts` clears on absence in its
				// state-DISCARDED branch only.
				const removed = await port.clearSubtree(source);
				if (removed > 0) {
					namedLogger.info(
						`the cached stream has ${removed} segment(s) and no cursor record, so it is being cleared and ` +
							`will rebuild: with no cursor there is nothing to allocate from and nothing to replay them as.`,
					);
				}
				return undefined;
			}

			const stored = await port.readSegments(source);
			const eventStream: LogEvent<ABI>[] = [];
			for (let i = 0; i < stored.length; i++) {
				if (stored[i].ordinal !== i) {
					await clearBecause(source, `a gap in the ordinals at ${i}`);
					return undefined;
				}
				const segment = stored[i].value;
				if (!isSegment(segment)) {
					await clearBecause(source, `segment ${i} does not parse`);
					return undefined;
				}
				eventStream.push(...(segment.events as LogEvent<ABI>[]));
			}
			if (stored.length !== cursor.nextOrdinal) {
				await clearBecause(
					source,
					`the cursor claims ${cursor.nextOrdinal} segment(s) and ${stored.length} are stored`,
				);
				return undefined;
			}
			if (cursor.startBlock > fromBlock) {
				// A stream that does not reach back to what was ASKED FOR. Compared
				// against the REQUESTED `fromBlock` and never against the source's own
				// minimum: the state-KEPT branch asks from the RESUME point, so a keeper
				// re-deriving that minimum would clear a perfectly good partial stream on
				// every reload and the next save would recreate it partial -- a
				// clear-and-recreate loop that never converges.
				await clearBecause(source, `it starts at ${cursor.startBlock} and does not reach back to ${fromBlock}`);
				return undefined;
			}

			return {
				eventStream: eventStream.filter((e) => e.blockNumber >= fromBlock),
				lastSync: {
					context: cursor.context,
					latestBlock: cursor.latestBlock,
					lastFromBlock: cursor.lastFromBlock,
					lastToBlock: cursor.lastToBlock,
					// Read by nobody and stored nowhere: `generateStreamFromReplay` rebuilds
					// the window from the events it is handed back.
					unconfirmedBlocks: [],
				},
			};
		},

		async saveNewEvents(source: IndexingSource<ABI>, stream: {lastSync: LastSync<ABI>; eventStream: LogEvent<ABI>[]}) {
			const {eventStream, lastSync} = stream;
			let declined = false;

			if (eventStream.length === 0) {
				await port.writeCursorOnly(source, (current) => {
					const carried = carryForward(current, lastSync);
					if (!carried) {
						declined = true;
						return undefined;
					}
					return cursorRecord(lastSync, carried);
				});
			} else {
				await port.commitSegmentWithCursor(source, (current) => {
					const carried = carryForward(current, lastSync);
					if (!carried) {
						declined = true;
						return undefined;
					}
					return {
						ordinal: carried.nextOrdinal,
						segment: {events: eventStream},
						cursor: cursorRecord(lastSync, {startBlock: carried.startBlock, nextOrdinal: carried.nextOrdinal + 1}),
					};
				});
			}

			if (declined) {
				// REPORTED, not just logged. The caller's next move depends on it: the indexer
				// tracks how far the stored stream reaches, and a decline read as a write
				// moves that mark past blocks that were never written -- after which its own
				// hole-check compares against a cursor that has already lied, so every later
				// decline goes unnoticed too.
				if (!declineReported) {
					declineReported = true;
					namedLogger.error(
						`this batch starts at ${lastSync.lastFromBlock}, above the block the cached stream reaches, so ` +
							`appending it would leave a hole no later check could see. Nothing is written and nothing is ` +
							`cleared: what is stored is a contiguous prefix with a cursor that describes it honestly, and a ` +
							`contiguous batch is accepted again as soon as one arrives.`,
					);
				}
				return 'declined';
			}
			declineReported = false;
		},

		async clear(source: IndexingSource<ABI>) {
			// The cursor lives INSIDE the subtree, so one scoped delete takes it with
			// the segments and there is no window in which a cursor survives claiming
			// coverage of events that are gone.
			await port.clearSubtree(source);
		},
	});
}
