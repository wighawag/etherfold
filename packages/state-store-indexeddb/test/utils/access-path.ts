/**
 * What the store ASKED IndexedDB for, recorded so it can be asserted.
 *
 * The behaviour of a listing (ascending id order, the limit, `truncated`,
 * as-of) is the seam's and is asserted for every backend by
 * `@etherfold/state-store-conformance`. What only this backend can be asked is
 * the ACCESS PATH, and no amount of behavioural testing can see the difference
 * between a bounded range scan and a scan of the whole store that filters and
 * sorts afterwards: both return the same rows.
 *
 * So the requests themselves are recorded. This is the IndexedDB equivalent of
 * `EXPLAIN QUERY PLAN`, which is what `@etherfold/state-store-sqlite` pins its
 * listing with.
 */

export type RecordedRequest = {
	/** `openCursor`, `get`, `getAll`, ... */
	method: string;
	/** Which object store or index it was issued against. */
	on: string;
	/** The query it was given: a key, an `IDBKeyRange`, or `null` for "everything". */
	query: unknown;
};

export type AccessLog = {
	requests: RecordedRequest[];
	/** How many records the cursors actually walked over. */
	recordsVisited: number;
	stop(): void;
};

const OBJECT_STORE_METHODS = ['openCursor', 'openKeyCursor', 'get', 'getKey', 'getAll', 'getAllKeys', 'count'] as const;

/**
 * Record every read a block of code issues, until `stop()`.
 *
 * It patches the prototypes rather than wrapping the store, because the point is
 * to see what reaches IndexedDB itself: a store that quietly read everything and
 * filtered in JavaScript would be invisible from the outside and obvious here.
 */
export function recordAccess(): AccessLog {
	const log: AccessLog = {requests: [], recordsVisited: 0, stop};
	const restore: (() => void)[] = [];

	for (const holder of [IDBObjectStore, IDBIndex]) {
		for (const method of OBJECT_STORE_METHODS) {
			const prototype = holder.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
			const original = prototype[method];
			if (typeof original !== 'function') continue;
			prototype[method] = function patched(this: IDBObjectStore | IDBIndex, ...args: unknown[]) {
				const query = args[0] ?? null;
				log.requests.push({method, on: this.name, query: query instanceof IDBKeyRange ? query : readable(query)});
				return original.apply(this, args);
			};
			restore.push(() => (prototype[method] = original));
		}
	}

	const cursorPrototype = IDBCursor.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const originalContinue = cursorPrototype.continue;
	cursorPrototype.continue = function patched(this: IDBCursor, ...args: unknown[]) {
		log.recordsVisited++;
		return originalContinue.apply(this, args);
	};
	restore.push(() => (cursorPrototype.continue = originalContinue));

	function stop(): void {
		for (const undo of restore.splice(0)) undo();
	}

	return log;
}

/** The cursor requests, which is what a range scan shows up as. */
export function cursors(log: AccessLog): RecordedRequest[] {
	return log.requests.filter((request) => request.method === 'openCursor' || request.method === 'openKeyCursor');
}

/** The bounds of a recorded `IDBKeyRange`, as plain values a test can compare. */
export function boundsOf(query: unknown): {lower: unknown; upper: unknown; lowerOpen: boolean; upperOpen: boolean} {
	const range = query as IDBKeyRange;
	if (!(range instanceof IDBKeyRange)) {
		throw new Error(`expected an IDBKeyRange, got ${JSON.stringify(query)}`);
	}
	return {
		lower: readable(range.lower),
		upper: readable(range.upper),
		lowerOpen: range.lowerOpen,
		upperOpen: range.upperOpen,
	};
}

/**
 * A key with every binary part decoded back to its string.
 *
 * Id columns are keyed by their UTF-8 BYTES (`idKey` in `keys.ts`), so a
 * recorded key is decoded here to read as the ids it asked for. What the bytes
 * ARE, and the order they give, is `key-layout.test.ts`'s subject, not an
 * access path's.
 */
export function readable(key: unknown): unknown {
	if (Array.isArray(key)) return key.map(readable);
	if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) return new TextDecoder().decode(key as ArrayBuffer);
	return key;
}
