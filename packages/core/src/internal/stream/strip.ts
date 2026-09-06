import type {Abi} from 'abitype';
import type {LastSync, LogEvent, StoredLastSync, StoredLogEvent} from '../../types.js';

/**
 * ONE EVENT, stripped of its decoded half.
 *
 * `args` / `eventName` are what SOME ABI made of those bytes and `decodeError`
 * is what happened when one could not, so all three are a CACHE that
 * `LogEventFetcher.reparse` re-derives on read against the source running now
 * (ADR-0034). What is stored is the half that is true forever.
 *
 * It builds a NEW object, and that is the whole point rather than a detail: the
 * event handed in is the very one the processor is about to fold, so deleting
 * three keys off it would corrupt what the fold reads. Same destructuring as
 * `reparse` does on the way back, so the two halves of "the decoded half is a
 * cache" are spelled the same way.
 */
export function storedEventOf<ABI extends Abi>(event: LogEvent<ABI>): StoredLogEvent {
	const {
		args: _args,
		eventName: _eventName,
		decodeError: _decodeError,
		...raw
	} = event as LogEvent<ABI> & {
		args?: unknown;
		eventName?: unknown;
		decodeError?: unknown;
	};
	return raw as StoredLogEvent;
}

/**
 * A BATCH, stripped of its decoded half.
 *
 * A new ARRAY over the same references would strip nothing: the references are
 * the processor's own event objects, so every element is rebuilt.
 */
export function storedStreamOf<ABI extends Abi>(eventStream: readonly LogEvent<ABI>[]): StoredLogEvent[] {
	return eventStream.map((event) => storedEventOf(event));
}

/**
 * A CURSOR, stripped of the decoded half its unconfirmed window carries.
 *
 * The window is the part that is easy to get wrong twice over. It is worth
 * stripping because a keeper's copy of it is never read back AS EVENTS -- the
 * load path takes a stored `lastSync` for its three block numbers and its
 * context only, the live reorg window is the indexer's in-memory one, and a
 * transaction-inclusion question is answered from the STATE keeper's copy -- so
 * leaving it decoded would leave the one stale thing in the stream.
 *
 * And it must NOT mutate, which is why this builds a new `LastSync` with new
 * blocks and new events inside them: the SAME object is handed to the state
 * keeper on the same tick, so a strip in place would silently empty the LIVE
 * reorg window and take `checkTxInclusion` and the next cycle's retraction
 * derivation down with it.
 *
 * The `context` is carried over by reference, exactly as handing the whole
 * `lastSync` over did: nothing is stripped from it, so copying it would buy an
 * allocation and no guarantee.
 */
export function storedLastSyncOf<ABI extends Abi>(lastSync: LastSync<ABI>): StoredLastSync {
	return {
		context: lastSync.context,
		latestBlock: lastSync.latestBlock,
		lastFromBlock: lastSync.lastFromBlock,
		lastToBlock: lastSync.lastToBlock,
		unconfirmedBlocks: lastSync.unconfirmedBlocks.map((block) => ({
			number: block.number,
			hash: block.hash,
			events: storedStreamOf(block.events),
		})),
	};
}
