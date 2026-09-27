import {
	encodeSnapshot,
	ENTITY_SNAPSHOT_FORMAT,
	type CursorWrite,
	type SnapshotBlockSource,
	type SnapshotHead,
} from '@etherfold/state-store';
import type {RecordedBlock} from './blocks.js';
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
 * ## The history option: where the FLOOR goes
 *
 * A format-2 document is the rows live at a FLOOR, then what every later block
 * changed, up to the CUT; how much history it carries is ONE option over that one
 * shape (`SnapshotHistory`). The changes are read off the version ranges
 * (`VersionedStateStore.changesAt`), block by recorded block, so they are the
 * store's own history and installing them is replaying them through `applyBlock`.
 * The installed store reports the floor as its history floor (ADR-0028).
 *
 * What a caller adds is what only it knows: WHICH FOLD computed the rows (the
 * generation's processor identity, ADR-0086) and the RESUME POSITION that belongs
 * to them (the serialized `LastSync` for the cut, opaque here as everywhere at the
 * seam).
 */

/**
 * How much history a snapshot carries (ADR-0095):
 *
 * - `'none'` (the default): the floor is the cut, so the document is the live rows
 *   and nothing else, ADR-0028's current-rows snapshot.
 * - a DEPTH `N`, a whole number of blocks: the floor is `N` blocks below the cut,
 *   clamped at the first block the generation recorded (below it the state was
 *   empty, and there is no recorded block to point a floor at). `0` is `'none'`.
 * - `'all'`: the floor is the first block the generation recorded.
 *
 * Like the cut, a floor that falls on a height carrying no logs of ours points at
 * the highest RECORDED block at or below it, whose rows ARE the rows as of that
 * height: so the installed floor may sit a little lower than asked, never higher.
 */
export type SnapshotHistory = 'none' | 'all' | number;

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
	/** How much history the document carries below the cut. Defaults to `'none'`. */
	readonly history?: SnapshotHistory;
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
 * The history asked for reaches below what the database still holds: a prune pass
 * (the folding deployment's `--retention`) has dropped versions it would need.
 *
 * Refused rather than silently shortened, because a snapshot whose floor is not
 * the one its publisher asked for is a publication that promises consumers a
 * history nobody decided on.
 */
export class HistoryNotRetainedError extends Error {
	readonly name = 'HistoryNotRetainedError';

	constructor(
		/** The history option asked for. */
		readonly history: SnapshotHistory,
		/** The floor block that history reaches down to. */
		readonly requested: number,
		/** The oldest block the database can still answer about. */
		readonly retainedFrom: number,
	) {
		super(
			`the history asked for (${typeof history === 'number' ? `a depth of ${history} blocks` : `\`${history}\``}) ` +
				`reaches down to block ${requested}, and this database retains history only from block ${retainedFrom}: ` +
				`the versions below that were pruned (the retention of the deployment that folded it). Ask for a floor ` +
				`at or above block ${retainedFrom}, or re-fold with a longer retention; it is refused rather than ` +
				`shortened, so a snapshot never carries a floor its publisher did not ask for.`,
		);
	}
}

/**
 * The state of one generation as of a block, as a format-2 snapshot carrying the
 * history asked for (`none` by default: the floor is the pointer).
 *
 * The document is a PULL stream: rows are read a page at a time as its consumer
 * asks for bytes, and written as they come, so neither side holds the state.
 *
 * Refuses a cut below every recorded block (there is no state to take there), a
 * depth that is not a whole number of blocks, and a floor below what the database
 * retains (`HistoryNotRetainedError`).
 */
export async function produceStateSnapshot(
	store: VersionedStateStore,
	options: ProduceStateSnapshotOptions,
): Promise<ProducedStateSnapshot> {
	const history = options.history ?? 'none';
	assertHistory(history);
	const pointer = await store.getBlockAtOrBelow(options.at);
	if (!pointer) {
		throw new Error(
			`there is no state to snapshot at block ${options.at}: this generation has recorded no block at or below it, ` +
				`so it has folded nothing up to that cut.`,
		);
	}
	const floor = await floorFor(store, options.at, pointer, history);
	const head: Omit<SnapshotHead, 'format'> = {
		processor: options.processor,
		savedAt: options.savedAt ?? new Date().toISOString(),
		takenAt: {number: pointer.number, hash: pointer.hash, timestamp: pointer.timestamp},
		floor: floor.number,
		...(options.cursor ? {cursor: options.cursor} : {}),
	};
	const document = encodeSnapshot(
		head,
		store.declarations.values(),
		blocksOf(store, floor, pointer.number, options.pageSize),
	);
	return {head: {format: ENTITY_SNAPSHOT_FORMAT, ...head}, document};
}

function assertHistory(history: SnapshotHistory): void {
	if (history === 'none' || history === 'all') return;
	if (typeof history !== 'number' || !Number.isSafeInteger(history) || history < 0) {
		throw new Error(
			`a snapshot's history is \`none\`, \`all\` or a depth in blocks, a whole number of at least 0: got ` +
				`${JSON.stringify(history)}`,
		);
	}
}

/**
 * The FLOOR block for a history option, refused where the database no longer
 * holds what reading it would need.
 *
 * The HEIGHT is measured from the cut (`at`), and the refusal is judged on it
 * (clamped at the first recorded block), not on the recorded block the floor then
 * points at: nothing changed between the two, so every version live at the
 * pointer is still live at that height, and a prune that kept the height kept
 * them.
 */
async function floorFor(
	store: VersionedStateStore,
	at: number,
	pointer: RecordedBlock,
	history: SnapshotHistory,
): Promise<RecordedBlock> {
	let height = at;
	if (history !== 'none' && history !== 0) {
		const start = (await firstRecordedBlock(store, pointer.number)) ?? pointer.number;
		height = history === 'all' ? start : Math.max(start, at - history);
	}
	const retainedFrom = await store.retainedFrom();
	if (retainedFrom !== undefined && height < retainedFrom) {
		throw new HistoryNotRetainedError(history, height, retainedFrom);
	}
	if (height >= pointer.number) return pointer;
	return (await store.getBlockAtOrBelow(height)) ?? pointer;
}

/** The first block the generation recorded, at or below `upTo`: where its state stops being empty. */
async function firstRecordedBlock(store: VersionedStateStore, upTo: number): Promise<number | undefined> {
	const blocks = store.recordedBlocksBetween(-1, upTo, {pageSize: 1});
	try {
		const first = await blocks.next();
		return first.done ? undefined : first.value.number;
	} finally {
		await blocks.return(undefined);
	}
}

/** The document's blocks: the live rows at the floor, then each later recorded block's changes. */
async function* blocksOf(
	store: VersionedStateStore,
	floor: RecordedBlock,
	cut: number,
	pageSize: number | undefined,
): AsyncGenerator<SnapshotBlockSource> {
	yield {block: pointerOf(floor), mutations: store.liveRowsAsOf(floor.number, {pageSize})};
	for await (const recorded of store.recordedBlocksBetween(floor.number, cut, {pageSize})) {
		yield {block: pointerOf(recorded), mutations: store.changesAt(recorded.number, {pageSize})};
	}
}

function pointerOf(block: RecordedBlock) {
	return {number: block.number, hash: block.hash, timestamp: block.timestamp};
}
