// DOES A MODULE WORKER RECEIVE HMR UNDER VITE?
//
// Run from the repo root, after `pnpm install`:
//
//   node docs/spikes/a-worker-host-takes-a-hot-updated-processor/measure-worker-hmr.mjs
//
// It builds a throwaway Vite root in the OS temp directory holding the shape the
// browser reference has (a tab that starts a `{type: 'module'}` worker, a worker
// that imports a processor module), serves it with the Vite the reference uses,
// drives it in the Chromium the reference's Playwright uses, edits the processor
// module on disk, and records what each side saw:
//
//   - whether `import.meta.hot` is DEFINED inside the worker at all;
//   - whether the worker's own `import.meta.hot.accept('./processor.js', ...)`
//     callback FIRES with the edited module;
//   - whether the TAB's `import.meta.hot.accept('./processor.js', ...)` fires
//     when the tab imports the same module (the other design), and what a tab
//     that imports the module WITHOUT accepting it does to the worker's update;
//   - whether the page was fully reloaded (a marker set on `window` from outside
//     the page's code survives only if it was not).
//
// Nothing here is shipped; the finding it backs is
// `work/notes/findings/a-module-worker-receives-hmr-under-vite.md`.
import {createRequire} from 'node:module';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const reference = resolve('examples/browser-reference');
const require = createRequire(join(reference, 'package.json'));
const {createServer} = require('vite');
const {chromium} = require('@playwright/test');

const processor = (value) => `export const tokenProcessor = {value: ${value}, onTransfer() { return ${value}; }};\n`;

/**
 * Four scenarios, over who IMPORTS the processor module and who ACCEPTS it:
 *
 * - `worker-accepts`: only the worker imports it, and accepts it;
 * - `tab-accepts`: both import it, only the tab accepts it (the "tab tells the host" design);
 * - `worker-accepts-tab-imports`: both import it, only the worker accepts it (the reference's
 *   shape, where the tab imports the processor module for its entity declarations);
 * - `both-accept`: both import it, and both accept it;
 * - `shared-worker-accepts`: `worker-accepts`, with the worker a SharedWorker.
 */
async function measure(scenario) {
	const root = mkdtempSync(join(tmpdir(), 'worker-hmr-'));
	writeFileSync(join(root, 'processor.js'), processor(1));
	writeFileSync(
		join(root, 'index.html'),
		`<!doctype html><html><body><pre id="log"></pre><script type="module" src="./main.js"></script></body></html>`,
	);
	writeFileSync(
		join(root, 'main.js'),
		[
			`window.__log = [];`,
			scenario !== 'worker-accepts' && scenario !== 'shared-worker-accepts' ? `import {tokenProcessor} from './processor.js';` : ``,
			scenario === 'shared-worker-accepts'
				? `const worker = new SharedWorker(new URL('./worker.js', import.meta.url), {type: 'module'}).port; worker.start();`
				: `const worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});`,
			`worker.onmessage = (e) => window.__log.push(e.data);`,
			scenario === 'tab-accepts' || scenario === 'both-accept'
				? `if (import.meta.hot) import.meta.hot.accept('./processor.js', (m) => window.__log.push({side: 'tab', event: 'accepted', value: m?.tokenProcessor.value, url: new URL('./processor.js', import.meta.url).href}));`
				: ``,
			`window.__log.push({side: 'tab', event: 'started', hot: typeof import.meta.hot});`,
		].join('\n'),
	);
	writeFileSync(
		join(root, 'worker.js'),
		[
			`import {tokenProcessor} from './processor.js';`,
			// A SharedWorker posts on the port of the tab that connected; a dedicated one on its own scope.
			scenario === 'shared-worker-accepts'
				? `let port; const post = (m) => port ? port.postMessage(m) : pending.push(m); const pending = []; self.onconnect = (e) => { port = e.ports[0]; port.start(); for (const m of pending.splice(0)) port.postMessage(m); };`
				: `const post = (m) => self.postMessage(m);`,
			`post({side: 'worker', event: 'started', hot: typeof import.meta.hot, value: tokenProcessor.value});`,
			scenario !== 'tab-accepts'
				? `if (import.meta.hot) import.meta.hot.accept('./processor.js', (m) => post({side: 'worker', event: 'accepted', value: m?.tokenProcessor.value}));`
				: ``,
		].join('\n'),
	);

	const server = await createServer({root, logLevel: 'silent', server: {port: 0}});
	await server.listen();
	const url = server.resolvedUrls.local[0];
	const browser = await chromium.launch();
	const page = await browser.newPage();
	const console = [];
	page.on('console', (m) => console.push(m.text()));
	page.on('pageerror', (e) => console.push(`pageerror: ${e}`));
	await page.goto(url);
	await page.waitForFunction(() => window.__log.some((l) => l.side === 'worker' && l.event === 'started'));
	// A marker set from OUTSIDE the page's own code survives only if the page was not reloaded.
	await page.evaluate(() => (window.__survivor = 'not-reloaded'));
	writeFileSync(join(root, 'processor.js'), processor(2));
	await page.waitForTimeout(3000);
	const after = await page.evaluate(() => ({log: window.__log ?? null, reloaded: window.__survivor !== 'not-reloaded'}));
	await browser.close();
	await server.close();
	rmSync(root, {recursive: true, force: true});
	return {scenario, ...after, console};
}

const results = [];
for (const scenario of ['worker-accepts', 'tab-accepts', 'worker-accepts-tab-imports', 'both-accept', 'shared-worker-accepts']) {
	results.push(await measure(scenario));
}
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
