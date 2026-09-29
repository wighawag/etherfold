/**
 * The three lines of IndexedDB plumbing every method here needs, and nothing
 * more.
 *
 * IndexedDB is an event API, and a store written against it directly reads as
 * callbacks inside callbacks. These wrappers turn a request into a promise and a
 * transaction into a promise, which is safe for exactly one reason worth stating
 * because getting it wrong is silent: awaiting a promise that is resolved from
 * an IndexedDB event handler continues in the SAME microtask checkpoint, so the
 * transaction is still active and further requests may be made on it. Awaiting
 * anything else (a fetch, a timer, another transaction) lets the transaction
 * auto-commit underneath the code that thinks it still owns it, and a
 * half-applied block or a half-reverted reorg is the worst outcome this store
 * has.
 *
 * So: inside a transaction, await only the helpers in this file.
 */

/** One request, as a promise that settles in the request's own event. */
export function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/** The transaction, as a promise that settles when it commits or gives up. */
export function committed(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
	});
}

/** What a cursor walk does with one record, and whether it wants the next one. */
export type CursorStep<T extends IDBCursor> = (cursor: T) => 'continue' | 'stop';

/**
 * Walk a cursor to the end, or until the step says to stop.
 *
 * Driven entirely from the success event rather than by awaiting each step, so
 * that a walk which also WRITES (the two legs of `revertTo`, the prune) issues
 * every one of its requests while the transaction is unambiguously active. The
 * step function is synchronous for the same reason: there is nothing it could
 * legitimately await.
 */
export function walk<T extends IDBCursor>(req: IDBRequest<T | null>, step: CursorStep<T>): Promise<void> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) return resolve();
			let next: 'continue' | 'stop';
			try {
				next = step(cursor);
			} catch (error) {
				return reject(error);
			}
			if (next === 'stop') return resolve();
			cursor.continue();
		};
		req.onerror = () => reject(req.error);
	});
}

/**
 * Open (and, the first time, create) a database.
 *
 * `upgrade` runs inside the version change and is told the version the database
 * was at before it, `0` for one that did not exist.
 */
export function openDatabase(
	name: string,
	version: number,
	upgrade: (db: IDBDatabase, transaction: IDBTransaction, oldVersion: number) => void,
	factory: IDBFactory = indexedDB,
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = factory.open(name, version);
		req.onupgradeneeded = (event) => upgrade(req.result, req.transaction as IDBTransaction, event.oldVersion);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () =>
			reject(
				new Error(
					`opening IndexedDB database ${JSON.stringify(name)} is blocked by another connection holding an older ` +
						`version of it. Close the other tab, or reload it.`,
				),
			);
	});
}

/**
 * Delete a database, so a caller starts cold.
 *
 * Not part of the seam (nothing at the seam knows what a database is), and here
 * because a test, a hard reset or an app offering "clear my local index" needs
 * it and should not have to hand-roll the request dance.
 */
export function deleteDatabase(name: string, factory: IDBFactory = indexedDB): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = factory.deleteDatabase(name);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
		// blocked means another connection is still open; the deletion completes as
		// soon as it closes, and reporting success here would be a lie a caller
		// cannot check, so it is an error naming the cause.
		req.onblocked = () =>
			reject(new Error(`deleting IndexedDB database ${JSON.stringify(name)} is blocked by an open connection.`));
	});
}
