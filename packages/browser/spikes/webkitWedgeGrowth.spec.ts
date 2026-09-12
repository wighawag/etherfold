import {createServer, type Server} from 'node:http';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test, type Page} from '@playwright/test';

/**
 * WHAT A TERMINATED WORKER HAS TO HAVE BEEN DOING BEFORE THE DATABASE WEDGES.
 *
 * `webkitWedge.spec.ts` asked whether a terminated worker's open `readwrite`
 * transaction blocks the next writer and answered NO on all three engines. That
 * answer is real, and it is not the product's case: interrogating an actual
 * wedge from `restartsAndResumes.spec.ts` shows a far larger effect than the one
 * that probe looked for. On a wedged database, from the tab as much as from the
 * replacement worker:
 *
 * - `indexedDB.open` SUCCEEDS and reports every object store;
 * - EVERY transaction then hangs -- `readonly` as much as `readwrite`, on any
 *   object store -- with no `complete`, no `abort` and no `error`, ever;
 * - an UNRELATED database in the same origin is completely healthy;
 * - a PAGE RELOAD does not clear it, and a `deleteDatabase` issued afterwards
 *   never runs.
 *
 * So what has to be reproduced is not "the next writer queues behind a dead
 * transaction". It is "ONE database can never run a transaction again". This
 * probe keeps the substrate raw -- no etherfold, no seam, no port, just
 * `indexedDB` and `Worker` -- and varies what the doomed worker was doing.
 *
 * ## The answer
 *
 * The ingredient is a `readonly` transaction IN FLIGHT ALONGSIDE the `readwrite`
 * one at the moment of `terminate()`. One transaction at a time never wedges,
 * however it is shaped and wherever it is killed; two overlapping ones wedge the
 * database permanently, a few percent of the time, on WebKit only. It needs
 * neither the product's five object stores nor its indexes nor its access
 * pattern: two stores, a `put` loop and a `get` loop are enough.
 *
 * Two variants exist to decide what the PRODUCT can do about it, and both answer
 * the same way at 0/200: the overlapping read has to belong to the context that
 * DIES (a reader tab's does not do it), and a store whose reads awaited their
 * transaction's COMMIT rather than just their request never produces the overlap
 * in the first place.
 *
 * The DETECTOR is the tab, because the wedge is not writer-specific: after the
 * kill the tab opens the database and asks for a `readonly` transaction. If that
 * never settles, the database is wedged.
 *
 * Run: `ITER=200 pnpm --filter @etherfold/browser exec playwright test --config spikes/playwright.config.ts webkitWedgeGrowth`
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '../../../docs/spikes/webkit-terminated-worker-wedges-indexeddb/results');

/** How long a step waits before it is called wedged. The product case never recovered, not even across a reload. */
const PATIENCE = 4000;

const ITERATIONS = Number(process.env.ITER ?? '60');
/** Which variants to run, by name; unset runs them all. */
const ONLY = process.env.VARIANTS?.split(',').map((name) => name.trim());

type Variant = {
	name: string;
	/** `one`/`two` plain stores, or the product's five with the same three indexes. */
	schema: 'one' | 'two' | 'product';
	/**
	 * What the doomed worker's PRIMARY loop is: the first probe's never-committing
	 * hold, `applyBlock`-shaped transactions, one `put` each, or a read and a write
	 * that are each awaited to COMMIT before the next begins, so no two transactions
	 * of this worker's are ever in flight together.
	 */
	writes: 'hold' | 'fold' | 'puts' | 'sequential';
	/** What ELSE is in flight at the same time, and WHERE. */
	alongside: 'nothing' | 'readonly' | 'readwrite' | 'readonly-in-tab';
	/** `announce` kills on a write announcement, as the product does; `jitter` kills at a random point. */
	killAt: 'announce' | 'jitter';
	/**
	 * HOW it dies. `terminate` is `Worker.terminate()` from the page, which is what
	 * `dedicatedWorkerHost`'s `close` does when the port concludes a death.
	 * `self-close` asks the worker to call `self.close()` instead, which is the
	 * graceful shutdown a port COULD ask for first -- and whether that is safer is
	 * the difference between a mitigation we can ship and one we cannot.
	 */
	kill?: 'terminate' | 'self-close';
};

const BASE: Omit<Variant, 'name'> = {schema: 'product', writes: 'fold', alongside: 'nothing', killAt: 'announce'};

const VARIANTS: Variant[] = [
	// --- one transaction at a time, which is what the first probe tested --------
	{name: 'one-store-hold', ...BASE, schema: 'one', writes: 'hold'},
	{name: 'product-fold', ...BASE},
	{name: 'product-fold-jitter', ...BASE, killAt: 'jitter'},
	// --- two transactions in flight ---------------------------------------------
	{name: 'product-fold-plus-readonly', ...BASE, alongside: 'readonly'},
	{name: 'product-fold-plus-readonly-jitter', ...BASE, alongside: 'readonly', killAt: 'jitter'},
	// --- and now stripped of everything the product added -----------------------
	{name: 'two-stores-puts-plus-readonly', ...BASE, schema: 'two', writes: 'puts', alongside: 'readonly'},
	{
		name: 'two-stores-puts-plus-readonly-jitter',
		...BASE,
		schema: 'two',
		writes: 'puts',
		alongside: 'readonly',
		killAt: 'jitter',
	},
	{name: 'two-stores-puts-plus-readwrite', ...BASE, schema: 'two', writes: 'puts', alongside: 'readwrite'},
	{name: 'two-stores-puts-alone', ...BASE, schema: 'two', writes: 'puts', alongside: 'nothing'},
	// --- the two that decide whether the PRODUCT can do anything about it --------
	// Does the overlapping read have to be in the DYING context, or does a reader
	// tab's transaction wedge the database just as well? If the latter, no backend
	// change can avoid this.
	{
		name: 'worker-writes-tab-reads-jitter',
		...BASE,
		schema: 'two',
		writes: 'puts',
		alongside: 'readonly-in-tab',
		killAt: 'jitter',
	},
	// And if it does have to be in the dying context: is a store whose reads await
	// their transaction's COMMIT (rather than just their request's success) safe?
	{name: 'sequential-no-overlap-jitter', ...BASE, schema: 'two', writes: 'sequential', killAt: 'jitter'},
	// Is it `terminate()` that does it, or any abrupt end of the worker?
	{
		name: 'two-stores-puts-plus-readonly-self-close',
		...BASE,
		schema: 'two',
		writes: 'puts',
		alongside: 'readonly',
		killAt: 'jitter',
		kill: 'self-close',
	},
];

/** The doomed worker. Builds the schema, starts what is asked of it, and waits to be killed. */
const WORKER_A = `
const post = (message) => self.postMessage(message);

function build(db, schema) {
	if (!db.objectStoreNames.contains('seam')) db.createObjectStore('seam');
	if (schema === 'one') return;
	if (!db.objectStoreNames.contains('cursors')) db.createObjectStore('cursors');
	if (schema === 'two') return;
	if (!db.objectStoreNames.contains('current')) db.createObjectStore('current');
	if (!db.objectStoreNames.contains('versions')) {
		const versions = db.createObjectStore('versions');
		versions.createIndex('lower', 'lower');
		versions.createIndex('upper', 'upper');
	}
	if (!db.objectStoreNames.contains('blocks')) {
		const blocks = db.createObjectStore('blocks', {keyPath: 'number'});
		blocks.createIndex('hash', 'hash', {unique: true});
	}
}

const scopeOf = (schema) => (schema === 'product' ? ['current', 'versions', 'blocks', 'cursors', 'seam'] : ['seam']);

const request = (req) => new Promise((resolve, reject) => {
	req.onsuccess = () => resolve(req.result);
	req.onerror = () => reject(req.error);
});
const committed = (tx) => new Promise((resolve, reject) => {
	tx.oncomplete = () => resolve();
	tx.onerror = () => reject(tx.error);
	tx.onabort = () => reject(tx.error || new Error('aborted'));
});

/** The first probe: ONE transaction kept alive for ever by chaining a request from each success. */
function hold(db, schema) {
	const tx = db.transaction(scopeOf(schema), 'readwrite');
	const store = tx.objectStore('seam');
	let n = 0;
	const again = () => {
		const req = store.put({n: n++}, 'held');
		req.onsuccess = () => {
			if (n === 1) post({holding: true});
			again();
		};
	};
	again();
}

/** A SECOND transaction always in flight, on a DIFFERENT object store. */
function alongside(db, mode) {
	if (mode === 'nothing') return;
	const step = () => {
		const tx = db.transaction('cursors', mode);
		const store = tx.objectStore('cursors');
		const req = mode === 'readonly' ? store.get('sync') : store.put(Date.now(), 'beat');
		req.onsuccess = () => setTimeout(step, 0);
		req.onerror = () => setTimeout(step, 0);
	};
	step();
}

/**
 * A read and a write, each awaited to COMMIT before the next begins, so this
 * worker never has two transactions in flight. This is what a store whose read
 * methods awaited \`committed(tx)\` would produce.
 */
async function sequential(db) {
	for (let n = 0; ; n++) {
		const read = db.transaction('cursors', 'readonly');
		read.objectStore('cursors').get('sync');
		await committed(read);
		post({wrote: 'starting', block: n});
		const write = db.transaction('seam', 'readwrite');
		write.objectStore('seam').put(n, 'row');
		try {
			await committed(write);
		} catch (error) {
			post({foldError: String(error)});
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/** One \`readwrite\` transaction with a single \`put\` in it, over and over. */
async function puts(db) {
	for (let n = 0; ; n++) {
		post({wrote: 'starting', block: n});
		const tx = db.transaction('seam', 'readwrite');
		const settled = committed(tx);
		tx.objectStore('seam').put(n, 'row');
		try {
			await settled;
		} catch (error) {
			post({foldError: String(error)});
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/**
 * The product: a stream of transactions shaped like \`applyBlock\` -- the writer
 * token first, then the block checks, then the row writes, then the cursor --
 * each announced BEFORE it is opened, exactly as \`announcingWrites\` does.
 */
async function fold(db, schema) {
	const token = 'A-' + Math.random().toString(36).slice(2);
	for (let block = 100; ; block++) {
		post({wrote: 'starting', block});
		const tx = db.transaction(scopeOf(schema), 'readwrite');
		const settled = committed(tx);
		try {
			const seam = tx.objectStore('seam');
			seam.put(token, 'writer');
			if (schema === 'product') {
				const blocks = tx.objectStore('blocks');
				const current = tx.objectStore('current');
				const versions = tx.objectStore('versions');
				await request(blocks.get(block));
				await request(blocks.index('hash').getKey('0x' + block));
				await request(blocks.openCursor(null, 'prev'));
				for (let row = 0; row < 8; row++) {
					const key = ['token', 'holder-' + row];
					const previous = await request(current.get(key));
					if (previous) versions.put({lower: previous.lower, upper: block, values: previous.values}, [...key, previous.lower]);
					current.put({lower: block, values: {n: block + row}}, key);
					versions.put({lower: block, upper: null, values: {n: block + row}}, [...key, block]);
				}
				blocks.put({number: block, hash: '0x' + block, timestamp: block});
				tx.objectStore('cursors').put(String(block), 'sync');
			} else {
				await request(seam.get('writer'));
				seam.put(String(block), 'row-' + block);
			}
			await settled;
		} catch (error) {
			post({foldError: String(error)});
			return;
		}
		post({wrote: 'landed', block});
		// The product does not fold in a tight loop: it fetches, folds, and waits.
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

self.onmessage = (event) => {
	if (event.data.shutdown) return self.close();
	const {name, schema, writes, alongside: mode} = event.data;
	const open = indexedDB.open(name, 1);
	open.onupgradeneeded = () => build(open.result, schema);
	open.onerror = () => post({openError: String(open.error)});
	open.onsuccess = () => {
		const db = open.result;
		if (schema !== 'one' && mode !== 'readonly-in-tab') alongside(db, mode);
		post({ready: true});
		if (writes === 'hold') hold(db, schema);
		else if (writes === 'puts') puts(db);
		else if (writes === 'sequential') sequential(db);
		else fold(db, schema);
	};
};
`;

let server: Server;
let origin: string;

test.beforeAll(async () => {
	server = createServer((_request, response) => {
		response.writeHead(200, {'content-type': 'text/html'});
		response.end('<!doctype html><meta charset="utf-8"><title>probe</title>');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

test.afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('what a terminated worker has to have been doing before the database wedges', async ({page}, testInfo) => {
	test.setTimeout(60 * 60 * 1000);
	await page.goto(origin);

	const wanted = VARIANTS.filter((variant) => !ONLY || ONLY.includes(variant.name));
	const outcome: Record<string, unknown> = {engine: testInfo.project.name, iterations: ITERATIONS, variants: {}};

	for (const variant of wanted) {
		const runs: string[] = [];
		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			// A fresh page per iteration, so a wedged database is never what the next
			// iteration reads and no connection survives into it.
			await page.goto(origin);
			const database = `grow-${variant.name}-${Date.now()}-${iteration}`;
			const result = await page.evaluate(
				async ([sourceA, name, spec, patience]) => {
					const {schema, writes, alongside, killAt, kill: how} = spec as Variant;
					const urlA = URL.createObjectURL(new Blob([sourceA as string], {type: 'text/javascript'}));

					// (1) The doomed worker takes the database and starts working.
					const a = new Worker(urlA);
					let announced = 0;
					let isReady!: () => void;
					// The schema is the WORKER's to create, so the tab must not open the
					// database until it exists, or it wins the race and creates an empty one.
					const ready = new Promise<void>((resolve) => (isReady = resolve));
					let kill!: () => void;
					const killed = new Promise<void>((resolve) => {
						kill = () => {
							if (how === 'self-close') a.postMessage({shutdown: true});
							else a.terminate();
							resolve();
						};
						a.onmessage = (event: MessageEvent) => {
							const said = event.data as {ready?: boolean; holding?: boolean; wrote?: string};
							if (said.ready) isReady();
							if (said.holding === true) return kill();
							if (said.wrote === 'starting') announced++;
							if (killAt === 'announce' && said.wrote === 'starting' && announced >= 3) kill();
						};
					});
					a.postMessage({name, schema, writes, alongside});

					// The overlapping read, run by the TAB on a connection of its own, so
					// that the transaction in flight at the kill belongs to a context that
					// SURVIVES it.
					let tabReader: IDBDatabase | undefined;
					if (alongside === 'readonly-in-tab') {
						await ready;
						tabReader = await new Promise<IDBDatabase>((resolve, reject) => {
							const open = indexedDB.open(name as string, 1);
							open.onsuccess = () => resolve(open.result);
							open.onerror = () => reject(open.error);
						});
						const step = () => {
							if (!tabReader) return;
							const tx = tabReader.transaction('cursors', 'readonly');
							const req = tx.objectStore('cursors').get('sync');
							req.onsuccess = () => setTimeout(step, 0);
							req.onerror = () => setTimeout(step, 0);
						};
						step();
					}

					if (killAt === 'jitter') {
						// Somewhere in the run rather than at a point chosen for us: the
						// product's kill lands wherever a message round trip puts it. Scheduled
						// only once everything that is supposed to be in flight IS.
						void ready.then(() => setTimeout(kill, 5 + Math.floor(Math.random() * 60)));
					}

					const started = await Promise.race([
						killed.then(() => 'killed'),
						new Promise<string>((r) => setTimeout(() => r('never-started'), patience as number)),
					]);
					if (started !== 'killed') return {step: 'never-started'};
					if (tabReader) {
						const reader = tabReader;
						tabReader = undefined;
						reader.close();
					}

					// (2) THE DETECTOR: can the TAB run a transaction on that database at
					// all? The product wedge hangs `readonly` as hard as `readwrite`, so
					// the cheapest question is also the sharpest one.
					const within = <T>(work: Promise<T>): Promise<T | 'WEDGED'> =>
						Promise.race([work, new Promise<'WEDGED'>((r) => setTimeout(() => r('WEDGED'), patience as number))]);

					const db = await within(
						new Promise<IDBDatabase>((resolve, reject) => {
							const open = indexedDB.open(name as string, 1);
							open.onsuccess = () => resolve(open.result);
							open.onerror = () => reject(open.error);
							open.onblocked = () => reject(new Error('open blocked'));
						}).catch((error: Error) => `open-failed:${error.message}` as never),
					);
					if (typeof db === 'string') return {step: db};

					const read = await within(
						new Promise<string>((resolve) => {
							const tx = db.transaction('seam', 'readonly');
							const req = tx.objectStore('seam').get('writer');
							req.onsuccess = () => resolve('read-ok');
							tx.onabort = () => resolve('read-aborted');
							tx.onerror = () => resolve('read-error');
						}),
					);
					if (read === 'WEDGED') {
						// IS IT THIS DATABASE OR THE WHOLE ORIGIN? An unrelated database,
						// created and written from scratch, right now.
						const unrelated = await within(
							new Promise<string>((resolve, reject) => {
								const open = indexedDB.open(`${name as string}-unrelated`, 1);
								open.onupgradeneeded = () => open.result.createObjectStore('rows');
								open.onerror = () => reject(open.error);
								open.onsuccess = () => {
									const other = open.result;
									const tx = other.transaction('rows', 'readwrite');
									tx.oncomplete = () => {
										other.close();
										resolve('ok');
									};
									tx.onabort = () => resolve('aborted');
									tx.objectStore('rows').put('ok', 'ok');
								};
							}).catch(() => 'failed'),
						);
						return {step: 'WEDGED-readonly', unrelated};
					}

					const wrote = await within(
						new Promise<string>((resolve) => {
							const tx = db.transaction('seam', 'readwrite');
							tx.oncomplete = () => resolve('write-ok');
							tx.onabort = () => resolve('write-aborted');
							tx.onerror = () => resolve('write-error');
							tx.objectStore('seam').delete('writerClaim');
						}),
					);
					db.close();
					return {step: wrote === 'WEDGED' ? 'WEDGED-readwrite' : wrote};
				},
				[WORKER_A, database, variant, PATIENCE] as const,
			);
			if ((result.step as string).startsWith('WEDGED')) {
				// WHAT RECOVERS IT? A reload is what the first probe claimed, untested.
				// A brand new PAGE in the same context is the next thing a user would do
				// -- close the tab, open it again -- and it is the difference between
				// "annoying" and "this origin's index is gone until the browser restarts".
				const canStillRead = async (where: Page) =>
					where.evaluate(
						async ([name, patience]) => {
							const within = <T>(work: Promise<T>): Promise<T | 'WEDGED'> =>
								Promise.race([work, new Promise<'WEDGED'>((r) => setTimeout(() => r('WEDGED'), patience as number))]);
							const db = await within(
								new Promise<IDBDatabase>((resolve, reject) => {
									const open = indexedDB.open(name as string, 1);
									open.onsuccess = () => resolve(open.result);
									open.onerror = () => reject(open.error);
									open.onblocked = () => reject(new Error('open blocked'));
								}).catch((error: Error) => `open-failed:${error.message}` as never),
							);
							if (typeof db === 'string') return db;
							return within(
								new Promise<string>((resolve) => {
									const tx = db.transaction('seam', 'readonly');
									tx.objectStore('seam').get('writer').onsuccess = () => resolve('read-ok');
									tx.onabort = () => resolve('read-aborted');
								}),
							);
						},
						[database, PATIENCE] as const,
					);

				await page.reload({waitUntil: 'load'});
				const afterReload = await canStillRead(page);

				// A DIFFERENT TAB, sharing the origin's storage and this browser's
				// IndexedDB backend, but with no page state in common with the one that
				// was there when the worker died.
				const fresh = await page.context().newPage();
				await fresh.goto(origin);
				const inANewTab = await canStillRead(fresh);
				await fresh.close();

				runs.push(`${result.step}(unrelated=${result.unrelated},afterReload=${afterReload},inANewTab=${inANewTab})`);
			} else {
				runs.push(result.step as string);
			}
		}
		const wedged = runs.filter((run) => run.startsWith('WEDGED')).length;
		(outcome.variants as Record<string, unknown>)[variant.name] = {wedged, of: ITERATIONS, runs: tally(runs)};
		// eslint-disable-next-line no-console
		console.log(
			`GROW ${testInfo.project.name} ${variant.name}: wedged ${wedged}/${ITERATIONS} ${JSON.stringify(tally(runs))}`,
		);
	}

	mkdirSync(RESULTS, {recursive: true});
	writeFileSync(join(RESULTS, `growth-${testInfo.project.name}.json`), `${JSON.stringify(outcome, null, 2)}\n`);
	expect(outcome.variants).toBeTruthy();
});

function tally(runs: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const run of runs) counts[run] = (counts[run] ?? 0) + 1;
	return counts;
}
