/**
 * The probe, bundled into a real browser page.
 *
 * ONE question, asked nine ways: can a single `multiEntry` index over a computed
 * array of `[field, value]` subkeys serve `where` and `orderBy` on ANY declared
 * field, without a `versionchange` per field?
 *
 * The spec says yes. "Convert a value to a multiEntry key" converts each item of
 * the array with "convert a value to a key", which accepts an Array exotic
 * object (recursing, and rejecting only cycles via the `seen` set), and "store a
 * record into an object store" then adds one index record per SUBKEY. So
 * `["price", 1234]` is a legal subkey. Engine behaviour in this corner has
 * historically diverged, which is the whole reason for measuring rather than
 * quoting.
 *
 * Nothing here imports etherfold: the question is about the ENGINE, and a probe
 * that went through the backend would be measuring the backend.
 */
import type {CodeUnderTest, RunContext, RunResult, Timing} from 'playwright-browser-harness/contract';
import {captureEnv, timed} from 'playwright-browser-harness/contract';

type Probe = {name: string; ok: boolean; detail: unknown};

const STORE = 'current';
const INDEX = 'ix';

/** A row as the layout would really store it: the whole row, plus computed keys. */
type Row = {values: Record<string, unknown>; ix?: IDBValidKey[]};

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('request failed'));
	});
}

function committed(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
		tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
	});
}

function open(name: string, withIndex: boolean): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(name, 1);
		req.onupgradeneeded = () => {
			const store = req.result.createObjectStore(STORE);
			// the whole proposal, in one line: the FIELD NAME is inside the KEY,
			// never in the key path, so a new declared field is data and not a
			// schema migration
			if (withIndex) store.createIndex(INDEX, INDEX, {multiEntry: true});
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('open failed'));
		req.onblocked = () => reject(new Error('open blocked'));
	});
}

function wipe(name: string): Promise<void> {
	return new Promise((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => resolve();
		req.onerror = () => resolve();
		req.onblocked = () => resolve();
	});
}

/** Big-endian fixed-width bytes: the sortable form a u256 needs. */
function beBytes(value: bigint, width = 8): Uint8Array {
	const out = new Uint8Array(width);
	let rest = value;
	for (let index = width - 1; index >= 0; index--) {
		out[index] = Number(rest & 0xffn);
		rest >>= 8n;
	}
	return out;
}

async function seed(db: IDBDatabase, rows: [string, Row][]): Promise<void> {
	const tx = db.transaction(STORE, 'readwrite');
	const store = tx.objectStore(STORE);
	for (const [key, row] of rows) store.put(row, key);
	await committed(tx);
}

function index(db: IDBDatabase): IDBIndex {
	return db.transaction(STORE, 'readonly').objectStore(STORE).index(INDEX);
}

/** The keys an index range yields, in the engine's own order. */
async function keysIn(db: IDBDatabase, range: IDBKeyRange): Promise<string[]> {
	return (await request(index(db).getAllKeys(range) as IDBRequest<IDBValidKey[]>)).map(String);
}

async function probes(name: string, timings: Timing[]): Promise<{probes: Probe[]; cost: Record<string, number>}> {
	const found: Probe[] = [];
	const record = (probeName: string, ok: boolean, detail: unknown) => found.push({name: probeName, ok, detail});

	await wipe(name);
	let db: IDBDatabase;
	try {
		db = await open(name, true);
		record('A. createIndex multiEntry is accepted', true, {version: db.version});
	} catch (error) {
		record('A. createIndex multiEntry is accepted', false, `${(error as Error).message}`);
		return {probes: found, cost: {}};
	}

	// Four rows carrying two indexed fields each, plus one row carrying NONE.
	await seed(db, [
		['t1', {values: {price: 10, owner: '0xaa'}, ix: [['price', 10], ['owner', '0xaa']]}],
		['t2', {values: {price: 2, owner: '0xbb'}, ix: [['price', 2], ['owner', '0xbb']]}],
		['t3', {values: {price: 30, owner: '0xaa'}, ix: [['price', 30], ['owner', '0xaa']]}],
		['t4', {values: {price: 9, owner: '0xcc'}, ix: [['price', 9], ['owner', '0xcc']]}],
		// no `ix` at all: the partial-index case. The key path does not evaluate to
		// a key, so per spec this record is in NO index entry.
		['t5', {values: {price: 999, owner: '0xdd'}}],
	]);

	// B. an ARRAY subkey is a real, addressable index key
	try {
		const exact = await keysIn(db, IDBKeyRange.only(['price', 30]));
		record('B. an array subkey is addressable', exact.length === 1 && exact[0] === 't3', exact);
	} catch (error) {
		record('B. an array subkey is addressable', false, `${(error as Error).message}`);
	}

	// C. one field is a BUCKET: the `[...prefix, []]` upper bound `startingWith`
	// already relies on, one level down
	try {
		const bucket = await keysIn(db, IDBKeyRange.bound(['price'], ['price', []]));
		record('C. a field is a range-scannable bucket', bucket.join() === 't2,t4,t1,t3', bucket);
	} catch (error) {
		record('C. a field is a range-scannable bucket', false, `${(error as Error).message}`);
	}

	// D. a `where` is a bound on that bucket, and the order is the VALUE's order,
	// so an `orderBy` rides the index instead of sorting in memory
	try {
		const gt9 = await keysIn(db, IDBKeyRange.bound(['price', 9], ['price', []], true, false));
		record('D. where + orderBy ride the index', gt9.join() === 't1,t3', gt9);
	} catch (error) {
		record('D. where + orderBy ride the index', false, `${(error as Error).message}`);
	}

	// E. buckets do not bleed into each other
	try {
		const owners = await keysIn(db, IDBKeyRange.bound(['owner'], ['owner', []]));
		record('E. buckets are disjoint', owners.join() === 't1,t3,t2,t4', owners);
	} catch (error) {
		record('E. buckets are disjoint', false, `${(error as Error).message}`);
	}

	// F. the PARTIAL-index property: a record whose key path yields no key is in
	// no index entry at all. This is the same mechanism UPPER_INDEX already uses
	// (`upper: null` is not a valid key), and it is what would keep an index over
	// `current` to exactly the live set.
	try {
		const all = await request(index(db).count());
		const rows = await request(db.transaction(STORE, 'readonly').objectStore(STORE).count());
		record('F. a keyless record is not indexed', all === 8 && rows === 5, {indexEntries: all, rows});
	} catch (error) {
		record('F. a keyless record is not indexed', false, `${(error as Error).message}`);
	}

	// G. BINARY subkeys sort bytewise, which is what makes a sortable big-endian
	// u256 orderable at all: as decimal TEXT, "10" sorts before "9".
	try {
		const tx = db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		for (const [key, value] of [
			['b-nine', 9n],
			['b-ten', 10n],
			['b-big', 2n ** 63n + 7n],
		] as [string, bigint][]) {
			store.put({values: {bal: String(value)}, ix: [['bal', beBytes(value)]]} satisfies Row, key);
		}
		await committed(tx);
		const ordered = await keysIn(db, IDBKeyRange.bound(['bal'], ['bal', []]));
		const asText = ['9', '10', String(2n ** 63n + 7n)].sort();
		record('G. binary subkeys sort bytewise', ordered.join() === 'b-nine,b-ten,b-big', {
			binaryOrder: ordered,
			decimalTextOrderWouldBe: asText,
		});
	} catch (error) {
		record('G. binary subkeys sort bytewise', false, `${(error as Error).message}`);
	}

	// H. duplicate subkeys collapse (the spec's "no item equal to key already in
	// keys"), so a row is not double-counted by a filter
	try {
		await seed(db, [['dup', {values: {}, ix: [['tag', 'x'], ['tag', 'x'], ['tag', 'y']]}]]);
		const tagged = await keysIn(db, IDBKeyRange.bound(['tag'], ['tag', []]));
		record('H. duplicate subkeys collapse', tagged.join() === 'dup,dup', tagged);
	} catch (error) {
		record('H. duplicate subkeys collapse', false, `${(error as Error).message}`);
	}

	// I. an EMPTY computed array adds nothing (a row with no indexed field)
	try {
		const before = await request(index(db).count());
		await seed(db, [['empty', {values: {}, ix: []}]]);
		const after = await request(index(db).count());
		record('I. an empty key array indexes nothing', before === after, {before, after});
	} catch (error) {
		record('I. an empty key array indexes nothing', false, `${(error as Error).message}`);
	}

	db.close();

	// The write cost of maintaining it, against the same puts with no index.
	// ADR-0024's consequences note the shipped `lower`/`upper` indexes were added
	// AFTER the 45.6 ms/block measurement and never re-measured, so a third index
	// lands on an already-unmeasured regression.
	const cost: Record<string, number> = {};
	for (const [label, withIndex] of [
		['withoutIndex', false],
		['withIndex', true],
	] as [string, boolean][]) {
		const costName = `${name}-cost-${label}`;
		await wipe(costName);
		const costDb = await open(costName, withIndex);
		const rows: [string, Row][] = [];
		for (let n = 0; n < 2000; n++) {
			rows.push([
				`k${n}`,
				{
					values: {price: n, owner: `0x${n % 97}`, rarity: n % 5},
					ix: [['price', n], ['owner', `0x${n % 97}`], ['rarity', n % 5]],
				},
			]);
		}
		await timed(label, timings, async () => {
			// 20 batches of 100, so the shape is a block-sized write rather than one
			// giant transaction
			for (let start = 0; start < rows.length; start += 100) {
				await seed(costDb, rows.slice(start, start + 100));
			}
		});
		cost[label] = timings.filter((t) => t.label === label).at(-1)?.ms ?? -1;
		costDb.close();
		await wipe(costName);
	}
	cost.overheadPercent =
		cost.withoutIndex > 0 ? Math.round(((cost.withIndex - cost.withoutIndex) / cost.withoutIndex) * 100) : -1;

	await wipe(name);
	return {probes: found, cost};
}

const cut: CodeUnderTest = {
	name: 'multientry-over-computed-field-keys',
	async run(ctx: RunContext): Promise<RunResult> {
		const timings: Timing[] = [];
		const errors: string[] = [];
		let results: Record<string, unknown> = {};
		try {
			const name = `${(ctx.params.tag as string) ?? 'multientry'}-probe`;
			const {probes: found, cost} = await probes(name, timings);
			results = {
				probes: found,
				passed: found.filter((probe) => probe.ok).length,
				total: found.length,
				failed: found.filter((probe) => !probe.ok).map((probe) => probe.name),
				cost,
			};
		} catch (error) {
			errors.push(`${(error as Error).message}`);
		}
		return {results, timings, errors, env: captureEnv()};
	},
};

export default cut;
