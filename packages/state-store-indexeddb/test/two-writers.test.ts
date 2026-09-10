import 'fake-indexeddb/auto';
import {StoreWriterChangedError, type EntityDeclaration} from '@etherfold/state-store';
import {afterEach, describe, expect, it} from 'vitest';
import {IndexedDBStateStore} from '../src/index.js';
import {freshDatabaseName} from './utils/database.js';

/**
 * Two tabs on ONE database, on the substrate that makes it easiest.
 *
 * The seam's behaviour -- a second writer's claim refuses the first on every
 * mutating path, two databases never contend, a single writer notices nothing --
 * is asserted for every backend by `@etherfold/state-store-conformance`. What is
 * asserted here is what only this backend can be asked, and it is the property
 * ADR-0075 rests on: `readwrite` transactions SERIALISE across connections, so
 * the check and the write are one indivisible unit and there is no window for a
 * rival to land in. That is why nothing below uses a timer: the ordering is the
 * engine's to decide, and the guarantee holds whichever way it decides it.
 */

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text'}};

const block = (number: number) => ({number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12});
const owns = (id: string, owner: string) => ({type: 'upsert', entity: 'token', id: {id}, values: {owner}}) as const;

const open: IndexedDBStateStore[] = [];

/** Two handles on ONE database: what two tabs of one app have. */
function twoTabs(options: {retention?: {blocks: number}; finalityDepth?: number} = {}) {
	const databaseName = freshDatabaseName();
	const tabs = [
		new IndexedDBStateStore([TOKEN], {databaseName, ...options}),
		new IndexedDBStateStore([TOKEN], {databaseName, ...options}),
	] as const;
	open.push(...tabs);
	return tabs;
}

afterEach(async () => {
	// a browser cannot delete a database while a connection is open, and a test
	// that leaves one open blocks the next one
	for (const store of open.splice(0)) await store.close();
});

describe('two tabs writing one database', () => {
	it('lets exactly ONE of two concurrent writers go on writing, with no timer anywhere', async () => {
		const [a, b] = twoTabs();
		await Promise.all([a.migrate(), b.migrate()]);

		// both write in the same tick, at different heights, and neither has
		// claimed yet: a first write CLAIMS, so both of these land whichever order
		// IndexedDB serialises them in.
		const first = await Promise.allSettled([
			a.applyBlock(block(100), [owns('1', '0xa')]),
			b.applyBlock(block(101), [owns('1', '0xb')]),
		]);
		expect(first.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);

		// and now exactly one of them holds the store. WHICH one is the engine's
		// business; that only one of them may write is not.
		const second = await Promise.allSettled([
			a.applyBlock(block(102), [owns('1', '0xa')]),
			b.applyBlock(block(103), [owns('1', '0xb')]),
		]);
		expect(second.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const refused = second.find((result) => result.status === 'rejected') as PromiseRejectedResult;
		expect(refused.reason).toBeInstanceOf(StoreWriterChangedError);

		// the store holds one live version, not two truths
		const rows = await a.listCurrent('token', {id: '1'}, 10);
		expect(rows.rows).toHaveLength(1);
	});

	it('refuses the loser on every path once, and keeps refusing it', async () => {
		const [stale, holder] = await migrated(twoTabs());
		await stale.applyBlock(block(100), [owns('1', '0xa')], {key: 'lastSync', value: 'at 100'});
		await holder.applyBlock(block(101), [owns('1', '0xb')], {key: 'lastSync', value: 'at 101'});

		// a refusal is not a state a writer recovers from by trying again: the
		// claim is not re-minted, because a writer that could re-claim would let
		// two writers take the store in turns.
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(stale.writeCursor('lastSync', 'at 100')).rejects.toBeInstanceOf(StoreWriterChangedError);
		}
		expect(await holder.readCursor('lastSync')).toBe('at 101');
	});
});

describe('the transaction a prune runs in', () => {
	it('reads the tip INSIDE the transaction that deletes against it', async () => {
		const [store] = await migrated(twoTabs({retention: {blocks: 1}, finalityDepth: 1}));
		for (const n of [100, 101, 102]) await store.applyBlock(block(n), [owns('1', `0x${n}`)]);

		const opened = recordTransactions();
		const report = await store.prune();
		opened.stop();

		expect(report.versionsDeleted).toBeGreaterThan(0);
		// The floor a prune deletes against is computed from the tip, so a tip read
		// OUTSIDE this transaction is a read-then-write that merely LOOKS atomic:
		// another tab moves the tip, and versions inside the window go. No
		// behavioural assertion can see the difference, so the transaction itself is
		// what is pinned -- the same reason `listing-access-path.test.ts` records
		// requests rather than results.
		expect(opened.transactions[0]).toEqual({stores: ['versions', 'blocks', 'writer'], mode: 'readwrite'});
		expect(opened.transactions.filter((tx) => tx.mode === 'readonly' && tx.stores.includes('blocks'))).toEqual([]);
	});
});

/** Both handles migrated, exactly as two tabs of one app would open them. */
async function migrated<T extends readonly IndexedDBStateStore[]>(stores: T): Promise<T> {
	for (const store of stores) await store.migrate();
	return stores;
}

/** Every transaction opened until `stop()`: which stores, and in which mode. */
function recordTransactions() {
	const transactions: {stores: string[]; mode: string}[] = [];
	const prototype = IDBDatabase.prototype as unknown as {transaction: (...args: unknown[]) => IDBTransaction};
	const original = prototype.transaction;
	prototype.transaction = function patched(this: IDBDatabase, ...args: unknown[]) {
		const names = args[0];
		transactions.push({
			stores: Array.isArray(names) ? [...(names as string[])] : [String(names)],
			mode: (args[1] as string | undefined) ?? 'readonly',
		});
		return original.apply(this, args);
	};
	return {transactions, stop: () => (prototype.transaction = original)};
}
