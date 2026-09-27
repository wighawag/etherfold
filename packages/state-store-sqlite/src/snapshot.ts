import {encodeSnapshot, ENTITY_SNAPSHOT_FORMAT, type CursorWrite, type SnapshotHead} from '@etherfold/state-store';
import type {VersionedStateStore} from './store.js';

/**
 * ## Producing a state snapshot out of a database (ADR-0095)
 *
 * The seam cannot enumerate a state, deliberately (ADR-0021), so a snapshot is
 * produced from a BACKEND's own query surface, and this is the one for the store
 * a `build` writes: a libSQL database, one generation of it (its ADR-0053 table
 * namespace, which is the `VersionedStateStore` the caller opened over it), read
 * AS OF a block through `liveRowsAsOf`, and written as a format-2 document by the
 * seam's own encoder. The rows come from the versioned store's as-of read, so
 * producing one is a read and never a second fold.
 *
 * What a caller adds is what only it knows: WHICH FOLD computed the rows (the
 * generation's processor identity, ADR-0086) and the RESUME POSITION that belongs
 * to them (the serialized `LastSync` for the cut, opaque here as everywhere at the
 * seam).
 */

export type ProduceStateSnapshotOptions = {
	/**
	 * The CUT: the block the state is taken AS OF.
	 *
	 * The snapshot's pointer (`takenAt`) is the HIGHEST RECORDED BLOCK AT OR BELOW
	 * it (ADR-0095), because the store records only blocks that carry logs and a
	 * pointer needs a hash and a timestamp; the rows as of that block ARE the rows
	 * as of the cut, since nothing changed in between.
	 */
	readonly at: number;
	/** The identity of the fold that computed the rows: the generation's processor (ADR-0086). */
	readonly processor: string;
	/** The resume position for the cut, installed with the rows. See `SnapshotHead.cursor`. */
	readonly cursor?: CursorWrite;
	readonly savedAt?: string;
	/** Rows read per query. Defaults to `liveRowsAsOf`'s page. */
	readonly pageSize?: number;
};

/** A produced snapshot: its head, and its document as a stream of gzipped bytes. */
export type ProducedStateSnapshot = {
	readonly head: SnapshotHead;
	readonly document: ReadableStream<Uint8Array>;
};

/**
 * The live rows of one generation as of a block, as a format-2 snapshot with no
 * history (`none`: the floor is the pointer).
 *
 * The document is a PULL stream: rows are read a page at a time as its consumer
 * asks for bytes, and written as they come, so neither side holds the state.
 *
 * Refuses a cut below every recorded block: there is no state to take there.
 */
export async function produceStateSnapshot(
	store: VersionedStateStore,
	options: ProduceStateSnapshotOptions,
): Promise<ProducedStateSnapshot> {
	const pointer = await store.getBlockAtOrBelow(options.at);
	if (!pointer) {
		throw new Error(
			`there is no state to snapshot at block ${options.at}: this generation has recorded no block at or below it, ` +
				`so it has folded nothing up to that cut.`,
		);
	}
	const head: Omit<SnapshotHead, 'format'> = {
		processor: options.processor,
		savedAt: options.savedAt ?? new Date().toISOString(),
		takenAt: {number: pointer.number, hash: pointer.hash, timestamp: pointer.timestamp},
		floor: pointer.number,
		...(options.cursor ? {cursor: options.cursor} : {}),
	};
	const document = encodeSnapshot(head, store.declarations.values(), [
		{block: head.takenAt, mutations: store.liveRowsAsOf(pointer.number, {pageSize: options.pageSize})},
	]);
	return {head: {format: ENTITY_SNAPSHOT_FORMAT, ...head}, document};
}
