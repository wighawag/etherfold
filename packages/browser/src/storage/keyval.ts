import {createStore, type UseStore} from 'idb-keyval';

/**
 * `idb-keyval`'s DEFAULT database and object store, re-derived.
 *
 * `defaultGetStore` is module-private, so naming the two strings is the ONLY way
 * to get a `UseStore` -- the escape hatch `createStore` returns, and the only
 * route to a key RANGE -- over the very store the bare `get`/`set` calls reach.
 * That is load-bearing rather than incidental. A keeper that quietly opened a
 * store of its own would make "an unrelated key in the same store survives
 * `clear`" vacuous, and it would remove the whole ground for banning
 * `idb-keyval`'s `clear()`, which is dangerous exactly BECAUSE the stream shares
 * one store with everything else this package writes.
 *
 * It lives in a module of its own because the stream keeper is no longer the
 * only thing addressing that store: the generation registry keeps its records
 * beside them and SWEEPS stream subtrees nothing claims, and a registry holding
 * a second connection to the same database would be a second opinion about what
 * is stored.
 */
export const KEYVAL_DATABASE = 'keyval-store';
export const KEYVAL_OBJECT_STORE = 'keyval';

/**
 * `idb-keyval`'s default store, opened once for this package.
 *
 * Memoised the way `idb-keyval` memoises its own, so a page holding several
 * named indexers does not hold one IndexedDB connection per keeper.
 */
let sharedStore: UseStore | undefined;
export function keyvalStore(): UseStore {
	if (!sharedStore) {
		sharedStore = createStore(KEYVAL_DATABASE, KEYVAL_OBJECT_STORE);
	}
	return sharedStore;
}
