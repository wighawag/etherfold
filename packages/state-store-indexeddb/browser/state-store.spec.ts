import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test, type Page} from '@playwright/test';
import {mountHarness} from 'playwright-browser-harness';
import {MemoryStateStore} from '@etherfold/state-store';
import {ID_ORDER_SEQUENCES, type DeclaredIdOrder, type IdOrder} from '@etherfold/state-store-conformance';
import {processor, runWorkload} from './workload.js';

/**
 * This backend, on the three engines it has to work on.
 *
 * The node tests run the same conformance suite under `fake-indexeddb`, which is
 * the IndexedDB API without a browser; what a shim cannot show is exactly what
 * this backend was chosen for. Chromium, Firefox and WebKit disagree about the
 * write path, and they are the only place a real reload, a real transaction
 * scheduler and (in `multi-tab.spec.ts`) four real tabs exist.
 *
 * Every run's numbers land in
 * `docs/spikes/indexeddb-row-backend-browser-default/results/browser-<project>.json`,
 * which is the evidence ADR-0024 points at.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '../../../docs/spikes/indexeddb-row-backend-browser-default/results');
const CUT = path.join(HERE, 'cut.ts');

type Row = Record<string, unknown>;
const collected: Row[] = [];

function record(row: Row): void {
	collected.push(row);
}

test.afterAll(async ({}, testInfo) => {
	if (collected.length === 0) return;
	fs.mkdirSync(RESULTS, {recursive: true});
	fs.writeFileSync(
		path.join(RESULTS, `browser-${testInfo.project.name}.json`),
		JSON.stringify({project: testInfo.project.name, ranAt: new Date().toISOString(), runs: collected}, null, 2),
	);
});

/**
 * The string order this backend's listings ascend in, per ENGINE and per read,
 * as measured on each engine (`id-order` below). `listCurrent` and `listAsOf`
 * walk a key range whose id columns are string keys, which the IndexedDB
 * specification compares by UTF-16 code unit; `MutationContext.list` re-sorts
 * with `compareIds`, JavaScript's `<`. Declared, not endorsed: which order the
 * listing SHOULD use is `the-listings-id-order-is-decided`'s question, and the
 * evidence is `docs/spikes/the-listings-id-order-per-backend/README.md`.
 */
const ID_ORDER_BY_ENGINE: Record<string, Required<DeclaredIdOrder>> = {
	chromium: {listCurrent: 'utf-16', listAsOf: 'utf-16', mutationContextList: 'utf-16'},
	firefox: {listCurrent: 'utf-16', listAsOf: 'utf-16', mutationContextList: 'utf-16'},
	webkit: {listCurrent: 'utf-16', listAsOf: 'utf-16', mutationContextList: 'utf-16'},
};

function idOrderOf(project: string): Required<DeclaredIdOrder> {
	const declared = ID_ORDER_BY_ENGINE[project];
	if (!declared) throw new Error(`no id order declared for the Playwright project ${JSON.stringify(project)}`);
	return declared;
}

/** A harness over the bundled code-under-test. IndexedDB needs no isolation. */
async function harnessFor(page: Page) {
	return mountHarness(page, {cut: CUT, coi: false});
}

test('passes the shared conformance suite, under every claim it makes', async ({page}, testInfo) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({
			phase: 'once',
			params: {
				case: 'conformance',
				tag: `conformance-${Date.now()}`,
				idOrder: idOrderOf(testInfo.project.name),
			},
		});
		record({
			project: testInfo.project.name,
			case: 'conformance',
			env: run.env,
			timings: run.timings,
			results: run.results,
			errors: run.errors,
		});

		expect(run.errors).toEqual([]);
		// the suite itself, not a browser-flavoured copy of it: the same cases the
		// SQL store, the patch store and the reference store are held to.
		expect(run.results.failures).toEqual([]);
		expect(run.results.passed as number).toBeGreaterThan(100);
	} finally {
		await harness.dispose();
	}
});

test("passes the shared accessor suite, the SQLite accessor's answers within the bound", async ({page}, testInfo) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({
			phase: 'once',
			params: {case: 'accessor-conformance', tag: `accessor-conformance-${Date.now()}`},
		});
		record({
			project: testInfo.project.name,
			case: 'accessor-conformance',
			env: run.env,
			timings: run.timings,
			results: run.results,
			errors: run.errors,
		});

		expect(run.errors).toEqual([]);
		// the accessor suite itself (ADR-0099), the one the SQLite accessor passes:
		// UTF-8 text order, numeric u256 order and null order are checked against
		// this engine's own key order and cursors, and the declared bound is held.
		expect(run.results.failures).toEqual([]);
		expect(run.results.passed as number).toBeGreaterThan(100);
	} finally {
		await harness.dispose();
	}
});

test('runs the same processor as node, and lands on the same rows', async ({page}, testInfo) => {
	// the SAME processor object, run here against the seam's reference store
	const memory = new MemoryStateStore(processor.entities);
	await memory.migrate();
	const expected = await runWorkload(memory);

	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'processor', tag: `processor-${Date.now()}`}});
		record({
			project: testInfo.project.name,
			case: 'processor',
			env: run.env,
			timings: run.timings,
			results: run.results,
			errors: run.errors,
		});

		expect(run.errors).toEqual([]);
		const inTab = run.results as unknown as Awaited<ReturnType<typeof runWorkload>> & {
			reference: Awaited<ReturnType<typeof runWorkload>>;
		};

		// one processor, two runtimes, two backends, one answer -- including the
		// versions, since `_lower` and `_upper` are compared with the values.
		expect(inTab.afterIndexing).toEqual(expected.afterIndexing);
		expect(inTab.afterRetraction).toEqual(expected.afterRetraction);
		expect(inTab.afterReplacement).toEqual(expected.afterReplacement);
		expect(inTab.listing).toEqual(expected.listing);
		expect(inTab.reference.afterReplacement).toEqual(expected.afterReplacement);

		// the canonical reorg bug: the accumulated counter goes back DOWN when the
		// block that raised it is retracted.
		expect(inTab.counterBefore).toBe(5);
		expect(inTab.counterAfterRetraction).toBe(4);
		expect(inTab.counterAfterReplacement).toBe(5);
	} finally {
		await harness.dispose();
	}
});

test('answers a listing with an IDBKeyRange cursor on this engine', async ({page}, testInfo) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'access-path', tag: `access-${Date.now()}`}});
		record({
			project: testInfo.project.name,
			case: 'access-path',
			env: run.env,
			results: run.results,
			errors: run.errors,
		});

		expect(run.errors).toEqual([]);
		const opened = run.results.opened as {on: string; lower: unknown; upper: unknown}[];
		expect(opened).toHaveLength(1);
		expect(opened[0].on).toBe('current');
		expect(opened[0].lower).toEqual(['placement', '7']);
		// `[]` sorts after every string in IndexedDB's key order, so this bound is
		// "the prefix and its descendants" and nothing else.
		expect(opened[0].upper).toEqual(['placement', '7', []]);
		// four children of epoch 7 among 200 rows: the store walked four, not 200
		expect(run.results.rows).toBe(4);
		expect(run.results.visited).toBe(4);
	} finally {
		await harness.dispose();
	}
});

test('ascends each listing in the id order declared for this engine', async ({page}, testInfo) => {
	const harness = await harnessFor(page);
	try {
		const run = await harness.run({phase: 'once', params: {case: 'id-order', tag: `id-order-${Date.now()}`}});
		record({
			project: testInfo.project.name,
			case: 'id-order',
			env: run.env,
			results: run.results,
			errors: run.errors,
		});

		expect(run.errors).toEqual([]);
		const declared = idOrderOf(testInfo.project.name);
		const expected = (order: IdOrder) => ID_ORDER_SEQUENCES[order];
		// each read on its own line, so a change names the read that moved
		expect(run.results.listCurrent, 'listCurrent').toEqual(expected(declared.listCurrent));
		expect(run.results.listAsOf, 'listAsOf').toEqual(expected(declared.listAsOf));
		expect(run.results.mutationContextList, 'MutationContext.list').toEqual(expected(declared.mutationContextList));
	} finally {
		await harness.dispose();
	}
});

test('keeps its rows across a real reload, and starts cold without reading them', async ({page}, testInfo) => {
	const harness = await harnessFor(page);
	const tag = `persist-${Date.now()}`;
	try {
		const written = await harness.run({phase: 'write', params: {tag}});
		expect(written.errors).toEqual([]);

		// a reload is the only honest cold start: it is what a user does
		await harness.reload();
		const read = await harness.run({phase: 'read', params: {tag}});
		record({
			project: testInfo.project.name,
			case: 'persistence',
			env: read.env,
			timings: [...written.timings, ...read.timings],
			results: {written: written.results, read: read.results},
			errors: [...written.errors, ...read.errors],
		});

		expect(read.errors).toEqual([]);
		expect(read.results.current).toMatchObject({owner: '0x139', transferCount: 40});
		// and the history is there too, which the whole-state blob cannot answer at all
		expect(read.results.historical).toMatchObject({owner: '0x120', transferCount: 21});
	} finally {
		await harness.dispose();
	}
});
