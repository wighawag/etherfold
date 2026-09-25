import {
	openGenerationRegistry,
	SLOT_NAMES,
	type GenerationCaps,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
	type GenerationRegistryPort,
	type GenerationRegistryState,
	type GenerationSlots,
	type SlotName,
} from '@etherfold/core';
import {promisifyRequest, type UseStore} from 'idb-keyval';
import {keyvalStore} from '../keyval.js';
import {streamsUnder, streamSubtree} from '../stream/OnIndexedDB.js';

/** The leading literal, so the registry keyspace cannot be a prefix of another. */
const GENERATION = 'generation';
/** The generation records' own level, beside the slots. */
const ENTRY = 'entry';
/**
 * THE STREAM RECORDS' own level: every stream this indexer holds, folded or not.
 *
 * A stream OUTLIVES every fold over it (ADR-0087), so what the sweep compares
 * against is not "which streams do the generations name" any more. These records
 * are what makes a deliberately-KEPT stream distinguishable from a PRE-GENERATION
 * ORPHAN across a reload: the kept one has a record here, the orphan never did.
 */
const KEPT = 'kept';

/**
 * The registry's address under one indexer name: HIERARCHICAL array keys, in the
 * same object store the streams live in.
 *
 * ```
 * ['generation', <indexer-name>, 'canonical']                          a SLOT
 * ['generation', <indexer-name>, 'successor']                          a SLOT
 * ['generation', <indexer-name>, 'predecessor']                        a SLOT
 * ['generation', <indexer-name>, 'entry', <streamDigest>, <processor>]  a generation
 * ['generation', <indexer-name>, 'kept', <streamDigest>]               a STREAM this indexer holds
 * ```
 *
 * The two halves of a generation's identity are two KEY ELEMENTS and never one
 * delimited string, for the reason the stream address is hierarchical (ADR-0036):
 * elements compare element by element, so no rendering of one component can be
 * read as another's. It also makes "every generation on this stream" -- what
 * reaping asks -- a scoped range rather than a scan.
 *
 * A SLOT IS ONE SMALL RECORD BESIDE THE ENTRIES and never a field on one, which
 * is ADR-0084's rule expressed as an address: a slot is an ASSIGNMENT pointing at
 * a generation, so the same content under two slots stays ONE entry, one
 * keyspace and one fold. `canonical` was the first of them and is unchanged;
 * `successor` and `predecessor` sit at the same level under their own names.
 *
 * Each slot key sits OUTSIDE the entry range: the range's upper bound is
 * `[..., 'entry', []]`, which is below every key whose third element is another
 * literal, so a scoped read of the generations picks up none of them whichever
 * way the names happen to sort. That is the same trap the stream subtree's two
 * ranges carry, and the same fix.
 */
export function generationAddress(name: string) {
	const prefix: IDBValidKey[] = [GENERATION, name];
	return {
		prefix,
		/** WHERE one slot's assignment lives. One record per slot per indexer, by construction. */
		slot: (slot: SlotName) => [...prefix, slot] as IDBValidKey,
		canonical: [...prefix, 'canonical'] as IDBValidKey,
		entry: (id: GenerationId) => [...prefix, ENTRY, id.stream, id.processor] as IDBValidKey,
		/** Every generation record under this name, and nothing else. */
		entries: IDBKeyRange.bound([...prefix, ENTRY], [...prefix, ENTRY, []], true, false),
		/** WHERE the record that this indexer holds one stream lives. */
		kept: (digest: string) => [...prefix, KEPT, digest] as IDBValidKey,
		/** Every stream record under this name, and nothing else. Same bound trick as `entries`. */
		keptStreams: IDBKeyRange.bound([...prefix, KEPT], [...prefix, KEPT, []], true, false),
	};
}

/**
 * The five substrate operations, over one `UseStore` and ONE named indexer.
 *
 * `commit` is a RAW `readwrite` transaction that reads the records, applies the
 * registry's decision and writes, and NOT a read followed by a write: two tabs
 * that both read "one generation, a cap of two" and then both wrote would leave
 * three generations under a cap of two, with nothing afterwards able to detect
 * it. IndexedDB serialises overlapping `readwrite` transactions on one object
 * store, across tabs, so that is all the mutual exclusion this needs. It is the
 * same rule the stream keeper's commit follows, including its one constraint:
 * inside a transaction you may await only IndexedDB's own promises.
 */
export function generationRegistryPortOnIndexedDB(
	name: string,
	options: {
		store?: UseStore;
		dropState: (id: GenerationId) => Promise<void>;
		readStateCursor?: (id: GenerationId) => Promise<number | undefined>;
	},
): GenerationRegistryPort {
	const store = options.store ?? keyvalStore();
	const address = generationAddress(name);

	const stateOf = (records: unknown[], assigned: unknown[]): GenerationRegistryState => {
		const slots: {-readonly [Name in SlotName]?: GenerationId} = {};
		SLOT_NAMES.forEach((name, index) => {
			const held = assigned[index] as GenerationId | undefined;
			if (held) {
				slots[name] = held;
			}
		});
		return {generations: records as GenerationRecord[], slots: slots as GenerationSlots, keptStreams: []};
	};

	/** The entries, the stream records and every slot record, as the ONE read both `read` and `commit` make. */
	const readState = (objectStore: IDBObjectStore): Promise<GenerationRegistryState> =>
		Promise.all([
			promisifyRequest<unknown[]>(objectStore.getAll(address.entries)),
			promisifyRequest<unknown[]>(objectStore.getAll(address.keptStreams)),
			...SLOT_NAMES.map((name) => promisifyRequest<unknown>(objectStore.get(address.slot(name)))),
		]).then(([records, kept, ...assigned]) => ({
			...stateOf(records as unknown[], assigned),
			keptStreams: (kept as {stream?: string}[]).map((record) => record?.stream).filter((one): one is string => !!one),
		}));

	return {
		async read() {
			return store('readonly', (objectStore) => readState(objectStore));
		},

		async commit(plan) {
			return store(
				'readwrite',
				(objectStore) =>
					new Promise<void>((resolve, reject) => {
						readState(objectStore).then((current) => {
							try {
								const write = plan(current);
								if (!write) {
									resolve();
									return;
								}
								// A TAB RETAINS NO CODE (ADR-0089), so a write carrying a bundle is
								// REFUSED before anything is written, rather than stored or silently
								// dropped: nothing on this runtime registers with one, and the day
								// something does is a day this should fail loudly.
								if (write.bundle !== undefined) {
									refuseRetainedBundle(name);
								}
								for (const id of write.remove ?? []) {
									objectStore.delete(address.entry(id));
								}
								if (write.put) {
									objectStore.put(write.put, address.entry(write.put));
								}
								for (const name of SLOT_NAMES) {
									const assigned = write.slots?.[name];
									// ABSENT leaves it, `null` CLEARS it, an identity assigns it.
									if (assigned === undefined) continue;
									if (assigned === null) {
										objectStore.delete(address.slot(name));
										continue;
									}
									// ONE small record per slot, and the whole of promotion. It carries
									// the identity alone: a copy of the record here would be a second
									// opinion about a generation the entry level already holds.
									objectStore.put({stream: assigned.stream, processor: assigned.processor}, address.slot(name));
								}
								// THE STREAM RECORDS, recorded before they are forgotten, so a commit that
								// does both ends with the stream gone: an ASKED-FOR deletion wins over a
								// registration in the same write.
								if (write.keepStream !== undefined) {
									objectStore.put({stream: write.keepStream}, address.kept(write.keepStream));
								}
								for (const digest of write.forgetStreams ?? []) {
									objectStore.delete(address.kept(digest));
								}
								resolve(promisifyRequest(objectStore.transaction));
							} catch (error) {
								reject(error);
							}
						}, reject);
					}),
			);
		},

		/**
		 * The stream digests present under this name, as a SCOPED LISTING of ONE
		 * LEVEL.
		 *
		 * A key cursor over the name's range that JUMPS to the next digest as soon
		 * as it has seen one, so this costs one read per stream rather than one per
		 * segment -- which is what makes running it on every open free, and it is
		 * what the hierarchical address bought. `[..., digest, []]` is above every
		 * key in that digest's subtree, because IndexedDB orders an array after any
		 * number or string.
		 */
		async listStreamDigests() {
			return store(
				'readonly',
				(objectStore) =>
					new Promise<string[]>((resolve, reject) => {
						const digests: string[] = [];
						const request = objectStore.openKeyCursor(streamsUnder(name));
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const cursor = request.result;
							if (!cursor) {
								resolve(digests);
								return;
							}
							const digest = (cursor.key as IDBValidKey[])[2];
							if (typeof digest === 'string') {
								digests.push(digest);
							}
							// no duplicate is possible: this jump lands ABOVE every key of the
							// digest just seen, so each one is visited exactly once
							cursor.continue(['stream', name, digest, []] as IDBValidKey);
						};
					}),
			);
		},

		async dropStreamSubtree(digest) {
			// A scoped `delete` per key in ONE transaction, never `idb-keyval`'s
			// `clear()`, which wipes the WHOLE object store and with it every other
			// stream, every other indexer name and this registry's own records.
			return store('readwrite', (objectStore) =>
				promisifyRequest<IDBValidKey[]>(objectStore.getAllKeys(streamSubtree(name, digest).subtree)).then((keys) => {
					for (const key of keys) {
						objectStore.delete(key);
					}
					return promisifyRequest(objectStore.transaction).then(() => keys.length);
				}),
			);
		},

		dropState(id) {
			return options.dropState(id);
		},

		async readStateCursor(id) {
			return options.readStateCursor?.(id);
		},

		/**
		 * NOTHING, for every generation, and that is this runtime's answer rather than a
		 * gap: a tab holds no `predecessor` and could instantiate retained bytes only
		 * through a service worker (ADR-0089), so it stores none (ADR-0092 does not apply
		 * here) and `commit` refuses a write that carries one.
		 */
		async readBundle() {
			return undefined;
		},
	};
}

/** A registration that tried to retain code in a tab, refused. See `readBundle` above. */
function refuseRetainedBundle(name: string): never {
	throw new Error(
		`the generation registry for '${name}' is a BROWSER registry, and a browser tab retains no processor code ` +
			`(ADR-0089): it holds no predecessor, and could instantiate stored bytes only through a service worker. So a ` +
			`registration carrying a bundle is refused here rather than stored. Retaining a generation's bundle is a Node ` +
			`deployment's (ADR-0092).`,
	);
}

/**
 * What a BROWSER holds by default: the previous generation, and the new one.
 *
 * Two, transiently, and not N. A browser keeps the previous generation only
 * until the new one is promoted, which is exactly what story 1 needs (the app
 * keeps rendering while the successor builds) and what makes the revert of story
 * 4 available for as long as the reconfigure is fresh. A server or a CLI should
 * be far more generous, because keeping generations to inspect, A/B-test and
 * revert is the POINT there; that runtime sets its own, and this constant is not
 * it.
 *
 * It is a CONFIGURED number, and the one thing it must never be is derived from
 * `navigator.storage.estimate()`: WebKit does not implement it, `quota` varies
 * four-fold between engines and moves between runs on one engine, and with a
 * real quota forced down to 8 MB it still reported 6.45 GB of headroom while
 * writes were failing (`work/notes/findings/browser-storage-headroom-for-generations.md`).
 * Nothing in this package consults it. The measured size is what makes two
 * comfortable anyway: 31,332 real logs occupy roughly 2 MB stored, because
 * IndexedDB compresses event payloads six- to ten-fold.
 */
export const BROWSER_GENERATION_CAPS: GenerationCaps = {maxGenerations: 2, maxStreams: 2};

export type BrowserGenerationRegistryOptions = {
	/**
	 * How this deployment drops the state store a generation folded into.
	 *
	 * Required, and injected rather than derived, because WHERE a generation's
	 * state lives is decided by the container above `StateStore` -- a later task
	 * -- and a registry that invented a database-naming convention here would
	 * fork one the rest of the system does not share. On the IndexedDB default
	 * that is `indexedDB.deleteDatabase(...)` of whatever the host named it.
	 */
	dropState: (id: GenerationId) => Promise<void>;
	/**
	 * How far the fold in one generation's state got (`lastToBlock`), for a
	 * generation the asker holds no fold for -- `dropState`'s READ sibling, and
	 * injected for the same reason (see `GenerationRegistryPort.readStateCursor`).
	 *
	 * OPTIONAL here and REQUIRED of nobody on this runtime, which is a statement
	 * about which container reads it rather than an exception to "every host that
	 * names the tables supplies it". A tab runs the CHAIN-FACING container, whose
	 * promotion trigger reads the cursor each held ENGINE publishes, so nothing here
	 * asks -- and a required option nothing consults would be accepted and ignored.
	 * A RECEIVING container over this port (`ReceivingIndexer`, what a server and the
	 * CLI fold through) is the one that asks, and it cannot promote on its own
	 * without it: absent, every position reads as NOT READABLE and the pointer stays
	 * where it is.
	 */
	readStateCursor?: (id: GenerationId) => Promise<number | undefined>;
	/** Overrides for `BROWSER_GENERATION_CAPS`. */
	caps?: Partial<GenerationCaps>;
	/**
	 * The `idb-keyval` store to keep the records in. Defaults to the shared one,
	 * which is the one the stream keeper writes into -- deliberately, since the
	 * sweep has to SEE those subtrees.
	 */
	store?: UseStore;
};

/**
 * Open the generation registry for one named indexer, in IndexedDB.
 *
 * Opening it SWEEPS every stream subtree under this name that no registered
 * generation claims, which is how a placeholder-era subtree -- unreachable,
 * counted against no cap, and beyond the reach of ordinary reaping because it
 * has no generation whose departure could fire it -- is finally disposed of. The
 * sweep is scoped to this name's level of the address, so another indexer's
 * streams are not merely spared, they are never enumerated.
 */
export function openGenerationRegistryOnIndexedDB(
	name: string,
	options: BrowserGenerationRegistryOptions,
): Promise<GenerationRegistry> {
	return openGenerationRegistry(generationRegistryPortOnIndexedDB(name, options), {
		...BROWSER_GENERATION_CAPS,
		...options.caps,
	});
}
