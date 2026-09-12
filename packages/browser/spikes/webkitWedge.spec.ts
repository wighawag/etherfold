import {createServer, type Server} from 'node:http';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from '@playwright/test';

/**
 * WHAT A TERMINATED WORKER'S INDEXEDDB TRANSACTION DOES TO THE NEXT WRITER, and
 * WHICH RECOVERIES ACTUALLY WORK.
 *
 * `@etherfold/browser`'s restart-and-resume case showed that on WebKit a worker
 * terminated while holding an open `readwrite` transaction leaves that
 * transaction holding the object store, so the replacement worker's claim never
 * lands. That was discovered through a product stack several layers deep. This
 * probe strips all of it away -- no etherfold, no store seam, no port, just
 * `indexedDB` and a `Worker` -- so the behaviour is attributable to the engine
 * and nothing else, and so the RECOVERY question can be answered rather than
 * assumed.
 *
 * The wedge is made DETERMINISTIC here, unlike in the product case where it
 * depends on `terminate()` racing a commit: the worker keeps its transaction
 * alive by issuing a fresh `put` from each request's `onsuccess`, which is what
 * stops IndexedDB auto-committing it, and only then says it is safe to kill.
 *
 * ## What is asked, in order
 *
 * 1. Does a `readwrite` transaction from a NEW connection start at all?
 * 2. Does a `readonly` one? (is this writers-only, or is the whole database gone)
 * 3. Does `deleteDatabase` get through, or is it blocked too?
 * 4. Does a PAGE RELOAD clear it -- the claim the finding originally made
 *    WITHOUT testing it, which is the one this probe exists to settle.
 *
 * Run: `pnpm --filter @etherfold/browser exec playwright test --config spikes/playwright.config.ts`
 *
 * It lives HERE rather than beside its results in `docs/spikes/` for one blunt
 * reason: `docs/` is not a pnpm workspace member, so a spec there cannot resolve
 * `@playwright/test` without a standalone install of its own. The EVIDENCE it
 * writes still lives in the spike directory, which is the part a reader needs to
 * find.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '../../../docs/spikes/webkit-terminated-worker-wedges-indexeddb/results');

/** How long a step waits before it is called wedged. Generous: the product case never recovered in 100 s. */
const PATIENCE = 8000;

/**
 * The worker: open the database, then hold ONE `readwrite` transaction open for
 * ever by chaining a new request from each completion, so it can never commit.
 */
const WORKER_SOURCE = `
self.onmessage = async (event) => {
  const {name} = event.data;
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore('rows');
  open.onsuccess = () => {
    const db = open.result;
    const tx = db.transaction('rows', 'readwrite');
    const store = tx.objectStore('rows');
    let n = 0;
    const again = () => {
      // A fresh request from inside the success handler keeps the transaction
      // ACTIVE; IndexedDB only auto-commits once no request is outstanding.
      const req = store.put({n: n++}, 'held');
      req.onsuccess = () => {
        if (n === 1) self.postMessage({holding: true});
        again();
      };
    };
    again();
  };
};
`;

/** Race a promise against the patience budget, so a wedge is a VALUE and not a hung test. */
function withinPatience<T>(work: Promise<T>): Promise<T | 'wedged'> {
	return Promise.race([work, new Promise<'wedged'>((resolve) => setTimeout(() => resolve('wedged'), PATIENCE))]);
}

let server: Server;
let origin: string;

test.beforeAll(async () => {
	// A real origin, because IndexedDB is unavailable on an opaque one.
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

test('what survives a worker terminated mid-transaction', async ({page}, testInfo) => {
	await page.goto(origin);

	const database = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	// (1) A worker takes the database and holds a `readwrite` transaction open.
	await page.evaluate(
		async ([source, name]) => {
			const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
			const worker = new Worker(url);
			(window as never as {probeWorker: Worker}).probeWorker = worker;
			await new Promise<void>((resolve) => {
				worker.onmessage = (event: MessageEvent) => {
					if ((event.data as {holding?: boolean}).holding) resolve();
				};
				worker.postMessage({name});
			});
		},
		[WORKER_SOURCE, database] as const,
	);

	// (2) Kill it while that transaction is open and can never have committed.
	await page.evaluate(() => (window as never as {probeWorker: Worker}).probeWorker.terminate());

	// (3) Now ask what the TAB can still do with that database.
	const afterTheKill = await page.evaluate(
		async ([name, patience]) => {
			const within = <T>(work: Promise<T>): Promise<T | 'wedged'> =>
				Promise.race([work, new Promise<'wedged'>((r) => setTimeout(() => r('wedged'), patience as number))]);

			const open = (): Promise<IDBDatabase> =>
				new Promise((resolve, reject) => {
					const request = indexedDB.open(name as string, 1);
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
					request.onblocked = () => reject(new Error('open blocked'));
				});

			const connection = await within(open());
			if (connection === 'wedged') return {connected: 'wedged'};

			const write = within(
				new Promise<string>((resolve, reject) => {
					const tx = connection.transaction('rows', 'readwrite');
					tx.oncomplete = () => resolve('ok');
					tx.onerror = () => reject(tx.error);
					tx.onabort = () => resolve('aborted');
					tx.objectStore('rows').put({from: 'tab'}, 'tab');
				}),
			);
			const read = within(
				new Promise<string>((resolve, reject) => {
					const tx = connection.transaction('rows', 'readonly');
					const req = tx.objectStore('rows').get('held');
					req.onsuccess = () => resolve('ok');
					req.onerror = () => reject(tx.error);
					tx.onabort = () => resolve('aborted');
				}),
			);

			const wrote = await write;
			const readBack = await read;

			connection.close();
			return {connected: 'ok', readwrite: wrote, readonly: readBack};
		},
		[database, PATIENCE] as const,
	);

	// (3b) THE SAME QUESTION, ASKED BY A SECOND WORKER rather than by the tab.
	// This is what the product actually does -- a REPLACEMENT WORKER takes the
	// store -- and it is the only structural difference left between this probe and
	// the case that wedges, so it is asked separately rather than assumed to be the
	// same as the tab's answer.
	const bySecondWorker = await page.evaluate(
		async ([name, patience]) => {
			const source = `
				self.onmessage = (event) => {
					const {name} = event.data;
					const open = indexedDB.open(name, 1);
					open.onsuccess = () => {
						const db = open.result;
						const tx = db.transaction('rows', 'readwrite');
						tx.oncomplete = () => self.postMessage({readwrite: 'ok'});
						tx.onabort = () => self.postMessage({readwrite: 'aborted'});
						tx.onerror = () => self.postMessage({readwrite: 'error'});
						tx.objectStore('rows').put({from: 'worker2'}, 'worker2');
					};
					open.onerror = () => self.postMessage({readwrite: 'open-error'});
					open.onblocked = () => self.postMessage({readwrite: 'open-blocked'});
				};
			`;
			const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
			const worker = new Worker(url);
			return Promise.race([
				new Promise<string>((resolve) => {
					worker.onmessage = (event: MessageEvent) => resolve((event.data as {readwrite: string}).readwrite);
					worker.postMessage({name});
				}),
				new Promise<string>((r) => setTimeout(() => r('wedged'), patience as number)),
			]);
		},
		[database, PATIENCE] as const,
	);

	// (3c) Can the database be DELETED at all -- the blunt recovery an app could
	// offer ("clear my local index")? Asked last of the pre-reload steps, because
	// it destroys what the steps above read.
	const deleteDatabase = await page.evaluate(
		async ([name, patience]) =>
			Promise.race([
				new Promise<string>((resolve) => {
					const request = indexedDB.deleteDatabase(name as string);
					request.onsuccess = () => resolve('ok');
					request.onerror = () => resolve('error');
					request.onblocked = () => resolve('blocked');
				}),
				new Promise<string>((r) => setTimeout(() => r('wedged'), patience as number)),
			]),
		[database, PATIENCE] as const,
	);

	// (4) THE RELOAD, which is the recovery the finding claimed without testing.
	await page.reload({waitUntil: 'load'});
	const afterReload = await page.evaluate(
		async ([name, patience]) => {
			const within = <T>(work: Promise<T>): Promise<T | 'wedged'> =>
				Promise.race([work, new Promise<'wedged'>((r) => setTimeout(() => r('wedged'), patience as number))]);
			const connection = await within(
				new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open(name as string, 1);
					request.onupgradeneeded = () => {
						if (!request.result.objectStoreNames.contains('rows')) request.result.createObjectStore('rows');
					};
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
					request.onblocked = () => reject(new Error('open blocked'));
				}),
			);
			if (connection === 'wedged') return {connected: 'wedged'};
			const wrote = await within(
				new Promise<string>((resolve, reject) => {
					const tx = connection.transaction('rows', 'readwrite');
					tx.oncomplete = () => resolve('ok');
					tx.onerror = () => reject(tx.error);
					tx.onabort = () => resolve('aborted');
					tx.objectStore('rows').put({from: 'after-reload'}, 'after-reload');
				}),
			);
			return {connected: 'ok', readwrite: wrote};
		},
		[database, PATIENCE] as const,
	);

	const outcome = {engine: testInfo.project.name, afterTheKill, bySecondWorker, deleteDatabase, afterReload};
	mkdirSync(RESULTS, {recursive: true});
	writeFileSync(join(RESULTS, `${testInfo.project.name}.json`), `${JSON.stringify(outcome, null, 2)}\n`);
	// eslint-disable-next-line no-console
	console.log(`PROBE ${testInfo.project.name}: ${JSON.stringify(outcome)}`);

	// The probe RECORDS; it asserts only that it got far enough to have an answer.
	expect(outcome.afterTheKill).toBeTruthy();
	expect(outcome.afterReload).toBeTruthy();
});
