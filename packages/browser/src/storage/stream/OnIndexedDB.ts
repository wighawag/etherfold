import {
	createSegmentedStream,
	resolveStreamConfig,
	streamDigestOf,
	type Abi,
	type ExistingStream,
	type IndexingSource,
	type StoredSegment,
	type StreamCursorRecord,
	type StreamSegmentPort,
	type UsedStreamConfig,
} from '@etherfold/core';
import {del, get, promisifyRequest, type UseStore} from 'idb-keyval';
import {logs} from 'named-logs';
import {keyvalStore} from '../keyval.js';

const namedLogger = logs('@etherfold/browser');

/** The leading literal, so the stream keyspace cannot be a prefix of another. */
const STREAM = 'stream';
/** The cursor record's own position in the subtree, beside the ordinals. */
const CURSOR = 'cursor';

/**
 * One stream's address, BY DIGEST: a HIERARCHICAL array key.
 *
 * ```
 * ['stream', <indexer-name>, <streamDigest>, <ordinal>]   a segment
 * ['stream', <indexer-name>, <streamDigest>, 'cursor']    the cursor record
 * ```
 *
 * An earlier design packed these components into one delimited STRING and then
 * needed an anchored regex, a cross-chain corruption hazard (`stream_tag_1` is a
 * prefix of `stream_tag_10_0`), a temp-name rule and an extra keeper operation.
 * All of that was a consequence of the flat namespace: comparing key ELEMENTS
 * cannot confuse chain `1` with chain `10`, so the hazard is gone rather than
 * withLegacyBlobProbe. There is no string-prefix matching anywhere below.
 *
 * The DIGEST level is `@etherfold/core`'s `streamDigestOf`: what the stream
 * CONTAINS -- its fetch filter and its stream config -- and nothing about who
 * indexed it. `chainId` is not a level of its own because that digest already
 * covers it (its block-0 skeleton entry hashes `chainId` and `genesisHash`), and
 * `<indexer-name>` is the caller-supplied discriminator, untouched here. This
 * level held a `chain-<chainId>` PLACEHOLDER while the digest was being built;
 * subtrees written under it are simply unreachable now, and disposing of them
 * belongs to the sweep in the generation registry, which is the only place that
 * can know which digests are registered.
 *
 * It is addressed BY THE DIGEST rather than by a `{source, config}` because that
 * sweep reaches subtrees it cannot resolve a source for: an orphan is a digest
 * and nothing else. `streamAddress` below is the same subtree for a caller that
 * has the source in hand.
 */
export function streamSubtree(name: string, digest: string) {
	const prefix: IDBValidKey[] = [STREAM, name, digest];
	return {
		prefix,
		cursor: [...prefix, CURSOR] as IDBValidKey,
		segment: (ordinal: number) => [...prefix, ordinal] as IDBValidKey,
		/**
		 * The two ranges, which are NOT the same and using the wrong one is a real bug.
		 *
		 * IndexedDB orders `number < string < array`. So the SUBTREE range, whose
		 * upper bound is an empty ARRAY, spans the `'cursor'` record along with the
		 * ordinals -- which is what `clear` wants and what keeps the cursor from being
		 * orphaned by a scoped delete. A SEGMENTS-ONLY read has to exclude the string
		 * bound, or a full ordered scan would come back with the cursor record sitting
		 * in it as though it were a segment.
		 *
		 * The subtree's LOWER bound is the prefix itself (exclusive) rather than
		 * ordinal `0`, so it spans every key below this digest whatever its last
		 * element is. That matters to the registry's sweep, which drops subtrees
		 * written by code that is GONE: what a dead digest rule put down there is not
		 * this module's to assume.
		 */
		segments: IDBKeyRange.bound([...prefix, 0], [...prefix, CURSOR], false, true),
		subtree: IDBKeyRange.bound(prefix, [...prefix, []], true, false),
	};
}

/**
 * Every key under ONE indexer name, whatever stream it belongs to.
 *
 * The range the registry's scoped listing of the digest level walks: the level
 * above the digest is the caller-supplied name, so one indexer can enumerate its
 * own streams without ever seeing another's.
 */
export function streamsUnder(name: string): IDBKeyRange {
	return IDBKeyRange.bound([STREAM, name], [STREAM, name, []], true, false);
}

/** Where the stream a `{source, config}` resolves to lives. See `streamSubtree`. */
export function streamAddress<ABI extends Abi>(
	name: string,
	source: IndexingSource<ABI>,
	streamConfig: UsedStreamConfig,
) {
	return streamSubtree(name, streamDigestOf(source, streamConfig));
}

/**
 * The five substrate operations, over one `UseStore` and one stream's subtree.
 *
 * The two writes are RAW `readwrite` transactions that read the cursor and write
 * both records, and NOT `get` followed by `setMany`: `setMany` opens its own
 * transaction, so the read would be a separate one, and two tabs saving at once
 * would both read next-ordinal `5`, both `put` segment `5`, and one batch would
 * be lost -- with the ordinals still CONTIGUOUS, so no later check could ever
 * detect it. IndexedDB serialises overlapping `readwrite` transactions on one
 * object store, across tabs, so that is all the mutual exclusion this needs.
 * `@etherfold/state-store-indexeddb`'s `idb.ts` is the repo's precedent,
 * including its rule that inside a transaction you may await only IndexedDB's
 * own promises.
 */
function portOver<ABI extends Abi>(
	name: string,
	store: UseStore,
	streamConfig: () => UsedStreamConfig,
): StreamSegmentPort<ABI> {
	const addressOf = (source: IndexingSource<ABI>) => streamAddress(name, source, streamConfig());

	return {
		async readCursor(source) {
			const address = addressOf(source);
			return store('readonly', (objectStore) =>
				promisifyRequest<StreamCursorRecord<ABI> | undefined>(objectStore.get(address.cursor)),
			);
		},

		async readSegments(source) {
			const address = addressOf(source);
			// A KEY RANGE, never `keys()`: that reads every key in the store, so with
			// several streams it costs O(store) per load rather than O(stream).
			// `getAllKeys` and `getAll` answer in key order, which for this range is
			// ORDINAL order, which is APPEND order.
			return store('readonly', (objectStore) =>
				Promise.all([
					promisifyRequest<IDBValidKey[]>(objectStore.getAllKeys(address.segments)),
					promisifyRequest<unknown[]>(objectStore.getAll(address.segments)),
				]).then(([keys, values]) =>
					keys.map((key, i): StoredSegment => ({ordinal: (key as IDBValidKey[])[3] as number, value: values[i]})),
				),
			);
		},

		async commitSegmentWithCursor(source, allocate) {
			const address = addressOf(source);
			return store(
				'readwrite',
				(objectStore) =>
					new Promise<void>((resolve, reject) => {
						const request = objectStore.get(address.cursor);
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							try {
								const commit = allocate(request.result as StreamCursorRecord<ABI> | undefined);
								if (!commit) {
									resolve();
									return;
								}
								objectStore.put(commit.segment, address.segment(commit.ordinal));
								objectStore.put(commit.cursor, address.cursor);
								resolve(promisifyRequest(objectStore.transaction));
							} catch (error) {
								reject(error);
							}
						};
					}),
			);
		},

		async writeCursorOnly(source, next) {
			const address = addressOf(source);
			return store(
				'readwrite',
				(objectStore) =>
					new Promise<void>((resolve, reject) => {
						const request = objectStore.get(address.cursor);
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							try {
								const record = next(request.result as StreamCursorRecord<ABI> | undefined);
								if (!record) {
									resolve();
									return;
								}
								objectStore.put(record, address.cursor);
								resolve(promisifyRequest(objectStore.transaction));
							} catch (error) {
								reject(error);
							}
						};
					}),
			);
		},

		async clearSubtree(source) {
			const address = addressOf(source);
			// A scoped `delete` per key in ONE transaction, never `idb-keyval`'s
			// `clear()`, which wipes the WHOLE object store and with it every other
			// stream and every other keeper's rows. That is a capability, not the
			// implementation of `ExistingStream.clear`.
			return store('readwrite', (objectStore) =>
				promisifyRequest<IDBValidKey[]>(objectStore.getAllKeys(address.subtree)).then((keys) => {
					for (const key of keys) {
						objectStore.delete(key);
					}
					return promisifyRequest(objectStore.transaction).then(() => keys.length);
				}),
			);
		},
	};
}

/**
 * The cached event stream, as an APPEND-ONLY log of segments in IndexedDB.
 *
 * A save writes its BATCH as a new segment at the next ordinal, together with
 * the cursor record, in ONE transaction, and nothing already written is ever
 * touched again -- so appending costs the batch and not the history. The shipped
 * keeper read the whole stream, concatenated and wrote all of it back on every
 * `saveNewEvents`, which made a backfill quadratic and charged an EMPTY batch the
 * same price purely to move `lastSync`.
 *
 * The rules are `@etherfold/core`'s `createSegmentedStream`; this module supplies
 * the substrate: the address, the key ranges and the transaction. `store` is
 * injectable so a test can WRAP the object store and count the work a save does,
 * which is the only honest place to measure it now that the commit is a raw
 * transaction rather than a call to `set`.
 */
export function keepStreamOnIndexedDB<ABI extends Abi>(
	name: string,
	options: {store?: UseStore} = {},
): ExistingStream<ABI> & {setStreamConfig: (streamConfig: UsedStreamConfig) => void} {
	const store = options.store ?? keyvalStore();
	/**
	 * The config half of the stream's IDENTITY, which the indexer hands over in
	 * its `reinit` (`setStreamConfig`) before it asks for anything.
	 *
	 * It starts at the RESOLVED DEFAULT rather than at nothing, so a keeper driven
	 * directly -- a test, a tool -- addresses the same stream an indexer given no
	 * `stream` config would, instead of a fourth thing. It is a single mutable
	 * value on purpose: one keeper serves one indexer, and a reconfigure MOVES it
	 * to the new stream, which is exactly what leaves the old subtree intact.
	 */
	let streamConfig = resolveStreamConfig(undefined);
	const segmented = createSegmentedStream<ABI>(portOver<ABI>(name, store, () => streamConfig));

	return {
		...segmented,
		setStreamConfig(next) {
			streamConfig = next;
		},
	};
}
