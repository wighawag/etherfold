/**
 * The driver: serve every policy with the header REALLY SET, open each page in each engine
 * that will launch here, and write the matrix to results/.
 *
 * One run = one (engine, delivery, policy) triple. A fresh browser CONTEXT per triple,
 * because the service-worker mechanism registers a worker and a leftover controller from
 * the previous policy would answer under the next one, which would be a measurement of the
 * spike and not of the browser.
 */
import {chromium, firefox, webkit} from 'playwright';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSpikeServer, POLICIES} from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8099);
const ENGINES = {chromium, firefox, webkit};

function listen(server, port) {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, resolve);
	});
}

async function runOne(context, base, delivery, policyKey) {
	const page = await context.newPage();
	const console_ = [];
	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') console_.push(message.text());
	});
	page.on('pageerror', (error) => console_.push(`pageerror: ${error.message}`));

	const path = delivery === 'header' ? 'p' : 'm';
	let results;
	try {
		await page.goto(`${base}/${path}/${policyKey}/?policy=${policyKey}`, {waitUntil: 'domcontentloaded'});
		// A FUNCTION, never a string. A string is delivered to the page as `Runtime.evaluate`,
		// which the very policies under test forbid, so the string form reported "blocked" for
		// six of the eight policies -- the driver being refused, not the mechanism. The first
		// version of this spike did exactly that, and the instrument has to be cleared before
		// any row of the matrix is believed.
		await page.waitForFunction(() => window.__spikeDone === true, undefined, {timeout: 120000});
		results = await page.evaluate(() => window.__spikeResults);
	} catch (error) {
		// A harness that never reports is itself a RESULT: it means the policy blocked the
		// page's own runner, which is what a real app's code would be in that position.
		results = {harnessNeverReported: String(error).split('\n')[0]};
	}
	await page.close();
	return {delivery, policy: policyKey, csp: POLICIES[policyKey], results, console: console_};
}

async function runEngine(name, base) {
	const engine = ENGINES[name];
	let browser;
	try {
		browser = await engine.launch();
	} catch (error) {
		const why = String(error).split('\n').slice(0, 3).join(' ').trim();
		console.log(`  ${name}: CANNOT LAUNCH HERE -- ${why}`);
		return {engine: name, launched: false, why};
	}
	const runs = [];
	for (const delivery of ['header', 'meta']) {
		for (const policyKey of Object.keys(POLICIES)) {
			const context = await browser.newContext();
			const run = await runOne(context, base, delivery, policyKey);
			await context.close();
			runs.push(run);
			const doc = run.results.document ?? [];
			const summary = doc.map((row) => `${row.mechanism}=${row.ok && row.proof?.ran ? 'ran' : 'no'}`).join(' ');
			console.log(`  ${name} ${delivery} ${policyKey}: ${summary || 'harness never reported'}`);
		}
	}
	const version = browser.version();
	await browser.close();
	return {engine: name, launched: true, version, runs};
}

const server = createSpikeServer();
await listen(server, PORT);
const base = `http://localhost:${PORT}`;
console.log(`serving ${base}`);

mkdirSync(join(here, 'results'), {recursive: true});
const wanted = process.argv.slice(2).filter((argument) => argument in ENGINES);
for (const name of wanted.length ? wanted : Object.keys(ENGINES)) {
	const report = await runEngine(name, base);
	writeFileSync(
		join(here, `results/csp-${name}.json`),
		JSON.stringify({measuredAt: new Date().toISOString(), ...report}, null, '\t') + '\n',
	);
}
server.close();
