import type {CodeUnderTest, RunContext, RunResult, Timing} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {openForWriting, type StateStoreBackend} from '@etherfold/state-store';
import {IndexedDBStateStore} from '@etherfold/state-store-indexeddb';

/**
 * WHAT THE WEBKIT WORKAROUND COSTS, on each engine, measured on the SHIPPED
 * store rather than on a model of it.
 *
 * The workaround for the wedge in
 * `work/notes/findings/webkit-does-not-abort-a-terminated-workers-indexeddb-transaction.md`
 * is "never have two transactions open at once", and it has two halves that cost
 * different things:
 *
 * 1. **Every read awaits its transaction's COMMIT** rather than returning when
 *    its request succeeds. That is `IndexedDBStateStore`'s `oneTransactionAtATime`
 *    option, and it is a per-read price paid on every engine.
 * 2. **Operations are serialised**, so a read cannot overlap the fold's write.
 *    That is a throughput price, and it is only visible under CONCURRENCY.
 *
 * Half 2 is measured here with a SPIKE-LOCAL decorator rather than a product
 * change, because half 1 has to exist first for half 2 to mean anything: a
 * decorator that releases its turn when a read METHOD returns still leaves that
 * read's transaction committing under the next one. The decorator below is
 * therefore only correct on top of the option, which is itself the finding.
 *
 * The numbers this produces are DELTAS against the same store with the option
 * off. They are not comparable with ADR-0024's absolute figures, which were
 * measured on a prototype with a different schema and a different workload.
 */

/** A realistic-ish entity: an id plus a handful of fields. */
const ENTITIES = [
	{name: 'holder', id: ['bucket', 'account'], fields: {balance: 'text', updated: 'integer', note: 'text'}},
] as const;

type Params = {
	rows?: number;
	blocks?: number;
	reads?: number;
	listings?: number;
};

/** Serialise every call, so the store never has two operations in flight. */
function oneAtATime<T extends StateStoreBackend>(store: T): T {
	let queue: Promise<unknown> = Promise.resolve();
	return new Proxy(store, {
		get(target, property) {
			const value = Reflect.get(target, property) as unknown;
			if (typeof value !== 'function') return value;
			return (...args: unknown[]) => {
				const mine = queue.then(
					() => (value as (...rest: unknown[]) => unknown).apply(target, args),
					() => (value as (...rest: unknown[]) => unknown).apply(target, args),
				);
				// the QUEUE must not be poisoned by a caller's rejection; the caller
				// still gets its own.
				queue = mine.then(
					() => undefined,
					() => undefined,
				);
				return mine;
			};
		},
	}) as T;
}

/** A COMPOSITE id, so `listCurrent` has a real prefix to range over rather than a whole-store scan. */
const BUCKETS = 20;
const idOf = (n: number) => ({bucket: `b${n % BUCKETS}`, account: `0x${n.toString(16).padStart(40, '0')}`});

/** Fill a store with `rows` live rows written over `blocks` blocks. */
async function fill(store: StateStoreBackend, rows: number, blocks: number): Promise<void> {
	const writable = await openForWriting(store);
	const perBlock = Math.max(1, Math.ceil(rows / blocks));
	let written = 0;
	for (let block = 1; block <= blocks; block++) {
		const mutations = [];
		for (let n = 0; n < perBlock && written < rows; n++, written++) {
			mutations.push({
				type: 'upsert' as const,
				entity: 'holder',
				id: idOf(written),
				values: {balance: String(written * 7), updated: block, note: 'x'.repeat(32)},
			});
		}
		await writable.applyBlock(
			{number: block, hash: `0x${block.toString(16).padStart(64, '0')}`, timestamp: block},
			mutations,
			{
				key: 'sync',
				value: JSON.stringify({lastToBlock: block}),
			},
		);
	}
}

/** A seeded, fixed sample, so both candidates read exactly the same rows. */
function sample(rows: number, count: number): {bucket: string; account: string}[] {
	const picked: {bucket: string; account: string}[] = [];
	const stride = Math.max(1, Math.floor(rows / count));
	for (let n = 0; n < rows && picked.length < count; n += stride) picked.push(idOf(n));
	return picked;
}

type Measurement = {
	usPerPointRead: number;
	usPerListing: number;
	usPerCursorRead: number;
	usPerAsOfRead: number;
	concurrentMsPerBlock: number;
	concurrentUsPerRead: number;
	concurrentReadsServed: number;
};

/**
 * THE INSTRUMENT HAS TO BE THE THING BEING MEASURED.
 *
 * The harness bundles `@etherfold/state-store-indexeddb` through its package
 * exports, which point at `dist/`. A `src/` edit that has not been rebuilt is
 * therefore INVISIBLE here: the run completes, both candidates are the same
 * store, and the difference reported is whatever the spike-local decorator does
 * on its own. That happened once and the numbers looked entirely plausible.
 *
 * So the build is checked rather than assumed, against a private member the
 * option added. A stale bundle fails loudly instead of quietly measuring
 * nothing.
 */
function refuseAStaleBuild(): void {
	const prototype = IndexedDBStateStore.prototype as unknown as Record<string, unknown>;
	if (typeof prototype.commitIfSerialising !== 'function') {
		throw new Error(
			'the bundled @etherfold/state-store-indexeddb has no `oneTransactionAtATime` support, so this would ' +
				'measure the decorator alone. Run `pnpm --filter @etherfold/state-store-indexeddb build` first.',
		);
	}
}

async function measure(
	label: string,
	databaseName: string,
	serialise: boolean,
	params: Required<Params>,
	timings: Timing[],
): Promise<Measurement> {
	const raw = new IndexedDBStateStore(ENTITIES, {databaseName, oneTransactionAtATime: serialise});
	await raw.migrate();
	const store = serialise ? oneAtATime(raw) : raw;

	const filling = performance.now();
	await fill(store, params.rows, params.blocks);
	timings.push({label: `${label}:fill`, ms: performance.now() - filling});

	const ids = sample(params.rows, params.reads);

	// --- reads with NOTHING else going on: the per-read price of half 1 --------
	const pointStart = performance.now();
	for (const id of ids) await store.getCurrent('holder', id);
	const usPerPointRead = ((performance.now() - pointStart) * 1000) / ids.length;

	const listStart = performance.now();
	for (let n = 0; n < params.listings; n++) await store.listCurrent('holder', {bucket: `b${n % BUCKETS}`}, 100);
	const usPerListing = ((performance.now() - listStart) * 1000) / params.listings;

	const cursorStart = performance.now();
	for (let n = 0; n < params.reads; n++) await store.readCursor('sync');
	const usPerCursorRead = ((performance.now() - cursorStart) * 1000) / params.reads;

	const asOfStart = performance.now();
	const asOfAt = Math.max(1, Math.floor(params.blocks / 2));
	for (const id of ids) await store.getAsOf('holder', id, asOfAt);
	const usPerAsOfRead = ((performance.now() - asOfStart) * 1000) / ids.length;

	// --- reads WHILE a fold writes: the throughput price of half 2 -------------
	// This is the shape that matters in the product -- a tab reading over the port
	// while the host folds -- and the only one where serialising can hurt.
	const writable = await openForWriting(store);
	let served = 0;
	let stop = false;
	const readingHard = (async () => {
		while (!stop) {
			await store.getCurrent('holder', ids[served % ids.length]);
			served++;
		}
	})();

	const concurrentStart = performance.now();
	const foldBlocks = 150;
	for (let block = params.blocks + 1; block <= params.blocks + foldBlocks; block++) {
		await writable.applyBlock(
			{number: block, hash: `0x${block.toString(16).padStart(64, '0')}`, timestamp: block},
			[
				{
					type: 'upsert',
					entity: 'holder',
					id: idOf(block % params.rows),
					values: {balance: String(block), updated: block, note: 'y'.repeat(32)},
				},
			],
			{key: 'sync', value: JSON.stringify({lastToBlock: block})},
		);
	}
	const concurrentMs = performance.now() - concurrentStart;
	stop = true;
	await readingHard;

	await raw.close();
	return {
		usPerPointRead: +usPerPointRead.toFixed(1),
		usPerListing: +usPerListing.toFixed(1),
		usPerCursorRead: +usPerCursorRead.toFixed(1),
		usPerAsOfRead: +usPerAsOfRead.toFixed(1),
		concurrentMsPerBlock: +(concurrentMs / foldBlocks).toFixed(3),
		concurrentUsPerRead: +((concurrentMs * 1000) / Math.max(1, served)).toFixed(1),
		concurrentReadsServed: served,
	};
}

const cut: CodeUnderTest = {
	name: 'commit-wait-cost',
	async run(ctx: RunContext): Promise<RunResult> {
		const timings: Timing[] = [];
		const errors: string[] = [];
		const given = ctx.params as Params;
		const params: Required<Params> = {
			rows: given.rows ?? 4000,
			blocks: given.blocks ?? 200,
			reads: given.reads ?? 400,
			listings: given.listings ?? 50,
		};
		refuseAStaleBuild();
		const tag = `commit-wait-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const results: Record<string, unknown> = {params};

		try {
			// The ORDER is alternated by the caller across repeats, so a warm-up
			// advantage cannot be mistaken for a difference between the candidates.
			const first = (ctx.params as {first?: string}).first === 'serialised';
			if (first) {
				results.serialised = await measure('serialised', `${tag}-s`, true, params, timings);
				results.asShipped = await measure('as-shipped', `${tag}-n`, false, params, timings);
			} else {
				results.asShipped = await measure('as-shipped', `${tag}-n`, false, params, timings);
				results.serialised = await measure('serialised', `${tag}-s`, true, params, timings);
			}
		} catch (error) {
			errors.push(`${(error as Error)?.name}: ${(error as Error)?.message}`);
		}

		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
