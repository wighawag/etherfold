/**
 * What does installing a published stream seed COST a browser, and where does
 * the cost sit?
 *
 * One question, measured on the narrowest real case: the committed
 * `stratagems-alpha1` capture, 31,332 real logs, in the two candidate wire
 * shapes (one document, or a manifest plus contiguous chunks).
 *
 * The install path is NOT re-derived here. It is imported from the spike that
 * pinned it (`docs/spikes/pin-the-seam-a-published-stream-arrives-through/install.mjs`,
 * ADR-0063), so what is measured is the install that was actually decided on,
 * and a later change to it moves these numbers rather than silently diverging
 * from them. The keeper is the real `keepStreamOnIndexedDB` from
 * `@etherfold/browser` on the browser's real IndexedDB.
 *
 * ## The memory instrument, and what it can and cannot see
 *
 * `performance.measureUserAgentSpecificMemory()` is the RIGHT instrument and is
 * NOT AVAILABLE here: it exists and throws `SecurityError: not available` in
 * this Chromium even cross-origin-isolated, which is a process-model condition a
 * spike cannot satisfy. So the measurement uses
 * `performance.memory.usedJSHeapSize` with Chromium's
 * `--enable-precise-memory-info` flag, which removes the quantisation that
 * otherwise pins the figure to a rounded constant (without it every sample here
 * read exactly 10,000,000 bytes and never moved). The driver cross-checks the
 * same moments over CDP with `Runtime.getHeapUsage`, so no conclusion rests on
 * one instrument. Both are CHROMIUM-ONLY: Firefox and WebKit report timings and
 * no heap figure at all, which is stated rather than papered over with a zero.
 *
 * Sampling is at phase BOUNDARIES, because `JSON.parse` blocks the thread and
 * nothing in the page can observe its interior. The consequence is stated in the
 * finding: the reported peak is the heap once a phase RETURNED, with its input
 * and output both alive, and the true intra-parse peak can only be higher.
 */
import type {CodeUnderTest, RunContext, RunResult, Timing} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {parseStreamFixture, resolveStreamConfig} from '@etherfold/core';
import {keepStreamOnIndexedDB} from '@etherfold/browser';
// The PINNED install path, imported rather than copied. It is prototype JS with
// no type declarations, deliberately: it is the artifact ADR-0063 left for this
// task to measure, not a published module.
// @ts-expect-error untyped prototype module from the seam spike
import {installStreamSeed} from '../../pin-the-seam-a-published-stream-arrives-through/install.mjs';

/** The capture's own stream config; a client must resolve to the same one. */
const STREAM_CONFIG = {finality: 12};

type MemorySample = {label: string; jsHeapBytes: number | null};

const timings: Timing[] = [];
const memory: MemorySample[] = [];
const errors: string[] = [];
let uaMemoryUnavailableBecause: string | null = null;

function jsHeap(): number | null {
	const perf = performance as Performance & {memory?: {usedJSHeapSize: number}};
	return perf.memory ? perf.memory.usedJSHeapSize : null;
}

/**
 * Try the standard API once per run, and RECORD why it declined rather than
 * silently reporting nothing. On a device where it works, this is the figure to
 * prefer, so the reason it is absent has to travel with the numbers.
 */
async function probeUaMemory(): Promise<void> {
	const perf = performance as Performance & {measureUserAgentSpecificMemory?: () => Promise<{bytes: number}>};
	if (!perf.measureUserAgentSpecificMemory) {
		uaMemoryUnavailableBecause = 'performance.measureUserAgentSpecificMemory is not implemented here';
		return;
	}
	try {
		await perf.measureUserAgentSpecificMemory();
		uaMemoryUnavailableBecause = null;
	} catch (error) {
		uaMemoryUnavailableBecause = `${(error as Error).name}: ${(error as Error).message}`;
	}
}

function sample(label: string): void {
	memory.push({label, jsHeapBytes: jsHeap()});
}

async function timed<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
	const started = performance.now();
	const value = await fn();
	timings.push({label, ms: performance.now() - started});
	return value;
}

/**
 * Long tasks, where the engine actually implements them.
 *
 * SUPPORT is decided by `PerformanceObserver.supportedEntryTypes` and not by
 * whether `observe()` threw, because Firefox and WebKit accept the call and then
 * never emit an entry. Reporting that as `0 long tasks` would say "this engine
 * never blocked the main thread for 50 ms" about an engine that simply does not
 * measure it, which is the most flattering possible way to be wrong.
 */
function watchLongTasks(): () => {supported: boolean; count: number; totalMs: number; longestMs: number} {
	const types = (PerformanceObserver as unknown as {supportedEntryTypes?: string[]}).supportedEntryTypes ?? [];
	const supported = types.includes('longtask');
	const entries: number[] = [];
	let observer: PerformanceObserver | undefined;
	if (supported) {
		try {
			observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) entries.push(entry.duration);
			});
			observer.observe({entryTypes: ['longtask']});
		} catch {
			observer = undefined;
		}
	}
	return () => {
		observer?.disconnect();
		return {
			supported: supported && observer !== undefined,
			count: entries.length,
			totalMs: entries.reduce((n, ms) => n + ms, 0),
			longestMs: entries.length > 0 ? Math.max(...entries) : 0,
		};
	};
}

/**
 * CALIBRATE the heap instrument for LINEARITY, which is the property the
 * conclusions actually rest on.
 *
 * Every memory claim here is a MULTIPLE ("the parsed graph costs about 3.6x its
 * document"), so what must be true is that the counter moves in PROPORTION to
 * how much was allocated. That is testable without knowing a single object's
 * true size: allocate N objects, then 2N, and the deltas should differ by about
 * two. A ratio needs no assumption about per-object overhead and survives a
 * constant offset.
 *
 * Two things this had to learn the hard way, both recorded because they would
 * otherwise be re-discovered:
 *
 *  - a SINGLE large allocation is not tracked at all (`'x'.repeat(10_000_000)`
 *    moved the counter by 1,920 bytes), so calibrating against one big string
 *    reports that the instrument is dead when it is not;
 *  - a delta can come back NEGATIVE when garbage collection lands inside the
 *    window (a `JSON.parse` of 100,000 objects measured -10.8 MB once).
 *
 * So the workload here is many small objects, which is what parsing 31,332
 * events is, and a spoiled sample is REPORTED rather than smoothed away.
 */
function calibrateHeap(): {
	smallBytes: number;
	largeBytes: number;
	ratio: number | null;
	spoiledByGc: boolean;
} | null {
	if (jsHeap() === null) return null;
	const allocate = (count: number): number => {
		const before = jsHeap() as number;
		const holder: {rows: unknown[] | null} = {
			rows: Array.from({length: count}, (_unused, i) => ({i, s: `calibration-${i}`, t: i * 2})),
		};
		const delta = (jsHeap() as number) - before;
		holder.rows = null;
		return delta;
	};
	const smallBytes = allocate(100_000);
	const largeBytes = allocate(200_000);
	const spoiledByGc = smallBytes <= 0 || largeBytes <= 0;
	return {
		smallBytes,
		largeBytes,
		ratio: spoiledByGc ? null : Number((largeBytes / smallBytes).toFixed(3)),
		spoiledByGc,
	};
}

/** Fetch bytes and gunzip them, which is what a client does before it can parse anything. */
async function fetchText(url: string): Promise<{text: string; transferBytes: number}> {
	const response = await fetch(url);
	const packed = await response.arrayBuffer();
	const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
	const text = await new Response(stream).text();
	return {text, transferBytes: packed.byteLength};
}

/** A keeper at the address the client will read, which means its config is set first. */
function keeperFor(name: string) {
	const keeper = keepStreamOnIndexedDB(name);
	keeper.setStreamConfig(resolveStreamConfig(STREAM_CONFIG));
	return keeper;
}

/**
 * The keeper, with every `saveNewEvents` timed.
 *
 * This is what separates the install's two halves: what the SUBSTRATE costs
 * (IndexedDB transactions) from what the CONVERSION costs (batching plus
 * stripping each event's decoded half). The difference between the install's
 * total and this sum is the conversion, which is otherwise invisible.
 */
function timingKeeper(keeper: any) {
	const write = {calls: 0, ms: 0};
	return {
		write,
		wrapped: {
			...keeper,
			saveNewEvents: async (source: any, batch: any) => {
				const started = performance.now();
				const outcome = await keeper.saveNewEvents(source, batch);
				write.ms += performance.now() - started;
				write.calls++;
				return outcome;
			},
		},
	};
}

/** What the keeper actually holds afterwards, read back through its own seam. */
async function storedState(keeper: any, source: any, fromBlock: number) {
	const stored = await keeper.fetchFrom(source, fromBlock);
	if (!stored) return {present: false, events: 0, lastToBlock: null, startBlock: null};
	return {
		present: true,
		events: stored.eventStream.length,
		lastToBlock: stored.lastSync.lastToBlock,
		startBlock: stored.lastSync.lastFromBlock,
	};
}

async function runSingle(params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const url = String(params.url);
	const maxEvents = Number(params.maxEvents ?? 1000);
	/**
	 * Which parser, and it is an AXIS rather than a detail.
	 *
	 * `parseStreamFixture` runs the tagged-BigInt revive over every decoded
	 * argument in the document. An install then STRIPS every one of those fields
	 * before a byte reaches the keeper, so on the seeding path that work is
	 * bought and thrown away. Measuring both is what turns that from an argument
	 * into a number.
	 */
	const parser = String(params.parse ?? 'fixture');
	const name = `single-${Date.now()}`;

	// STARTED FIRST, so it spans fetch, parse AND install. An earlier version
	// started it just before the install and reported zero long tasks for a
	// 448 ms parse, which was true of what it watched and useless.
	const stopLongTasks = watchLongTasks();
	sample('baseline');
	// A HOLDER, so the string can be dropped and the drop can be measured. The
	// single-document shape's whole memory question is whether the source text
	// and the object graph have to be alive at the same time, and they do.
	const held: {text: string | null} = {text: null};
	const fetched = await timed('fetch+gunzip', () => fetchText(url));
	held.text = fetched.text;
	const rawBytes = fetched.text.length;
	sample('after fetch+gunzip (the text alive)');

	const fixture = await timed(`parse (${parser})`, () =>
		parser === 'fixture' ? parseStreamFixture(held.text as string) : JSON.parse(held.text as string),
	);
	sample('after parse (text AND objects alive: the peak this shape forces)');

	held.text = null;
	await new Promise((resolve) => setTimeout(resolve, 250));
	sample('after dropping the text (objects alive)');

	const keeper = keeperFor(name);
	const {write, wrapped} = timingKeeper(keeper);
	const outcome = await timed('install', () => installStreamSeed(wrapped, fixture.source, fixture, {maxEvents}));
	const longTasks = stopLongTasks();
	sample('after install');

	const stored = await storedState(keeper, fixture.source, fixture.provenance.fromBlock);
	return {
		shape: 'single',
		url,
		parser,
		maxEvents,
		transferBytes: fetched.transferBytes,
		rawBytes,
		events: fixture.eventStream.length,
		segments: outcome.batches,
		declinedAt: outcome.declinedAt ?? null,
		keeperWrites: write,
		longTasks,
		stored,
	};
}

async function runChunked(params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const base = String(params.base);
	const maxEvents = Number(params.maxEvents ?? 1000);
	/** Stop after this many chunks, to measure a resumable install honestly. */
	const stopAfter = params.stopAfter === undefined ? undefined : Number(params.stopAfter);
	const name = String(params.name ?? `chunked-${Date.now()}`);

	const stopLongTasks = watchLongTasks();
	sample('baseline');
	const manifestText = await timed('fetch manifest', async () => (await fetch(`${base}/manifest.json`)).text());
	const manifest = JSON.parse(manifestText);
	const keeper = keeperFor(name);
	const {write, wrapped} = timingKeeper(keeper);

	// Where a resumed install PICKS UP, asked of the keeper and of nothing else.
	// This is the claim ADR-0063 makes about resumability, exercised: the cursor
	// already says how far the stream reaches, so a client needs no record of
	// which chunks it installed.
	const before = await storedState(keeper, manifest.source, manifest.coverage.fromBlock);
	const resumeFrom = before.present ? (before.lastToBlock as number) + 1 : manifest.coverage.fromBlock;
	const todo = manifest.chunks.filter((chunk: any) => chunk.fromBlock >= resumeFrom);
	const planned = stopAfter === undefined ? todo : todo.slice(0, stopAfter);

	let transferBytes = 0;
	let rawBytes = 0;
	let events = 0;
	let segments = 0;
	let declinedAt: number | null = null;
	let fetchMs = 0;
	let parseMs = 0;
	let installMs = 0;

	const started = performance.now();
	for (let i = 0; i < planned.length; i++) {
		const chunk = planned[i];
		let at = performance.now();
		const {text, transferBytes: bytes} = await fetchText(`${base}/${chunk.file}`);
		fetchMs += performance.now() - at;
		transferBytes += bytes;
		rawBytes += text.length;

		at = performance.now();
		const body = JSON.parse(text);
		parseMs += performance.now() - at;
		events += body.eventStream.length;

		at = performance.now();
		// A chunk is a fixture-shaped slice: the header lives once, in the
		// manifest, so the install path takes exactly what it takes for the whole
		// document and needs no second code path.
		const outcome = await installStreamSeed(
			wrapped,
			manifest.source,
			{
				provenance: {fromBlock: body.fromBlock},
				lastSync: {...manifest.lastSync, lastToBlock: body.toBlock},
				eventStream: body.eventStream,
			},
			{maxEvents},
		);
		installMs += performance.now() - at;
		segments += outcome.batches;
		if (outcome.declinedAt !== undefined) declinedAt = outcome.declinedAt;
		// Per chunk, because the peak of this shape is whatever ONE chunk costs,
		// and the whole claim is that it does not grow with the artifact.
		sample(`after chunk ${i + 1}/${planned.length}`);
	}
	timings.push({label: 'all chunks (fetch+gunzip+parse+install)', ms: performance.now() - started});
	timings.push({label: 'chunks: fetch+gunzip', ms: fetchMs});
	timings.push({label: 'chunks: parse', ms: parseMs});
	timings.push({label: 'chunks: install', ms: installMs});
	const longTasks = stopLongTasks();
	sample('after install');

	const stored = await storedState(keeper, manifest.source, manifest.coverage.fromBlock);
	return {
		shape: 'chunked',
		base,
		maxEvents,
		chunksAvailable: manifest.chunks.length,
		chunksInstalled: planned.length,
		resumedFrom: before.present ? resumeFrom : null,
		manifestBytes: manifestText.length,
		transferBytes,
		rawBytes,
		events,
		segments,
		declinedAt,
		keeperWrites: write,
		longTasks,
		stored,
		coverage: manifest.coverage,
	};
}

const cut: CodeUnderTest = {
	name: 'install a published stream seed',
	async run(ctx: RunContext): Promise<RunResult> {
		timings.length = 0;
		memory.length = 0;
		errors.length = 0;
		let results: Record<string, unknown> = {};
		let calibration: ReturnType<typeof calibrateHeap> = null;
		try {
			await probeUaMemory();
			calibration = calibrateHeap();
			const mode = String(ctx.params.mode);
			results = mode === 'single' ? await runSingle(ctx.params) : await runChunked(ctx.params);
		} catch (error) {
			errors.push(`${(error as Error).message}\n${(error as Error).stack ?? ''}`);
		}
		const heaps = memory.map((one) => one.jsHeapBytes).filter((n): n is number => typeof n === 'number');
		const baseline = heaps.length > 0 ? heaps[0] : null;
		return {
			results: {
				...results,
				memory,
				heapCalibration: calibration,
				heapInstrument: jsHeap() === null ? 'none' : 'performance.memory (needs --enable-precise-memory-info)',
				uaMemoryUnavailableBecause,
				peakHeapBytes: heaps.length > 0 ? Math.max(...heaps) : null,
				peakHeapAboveBaselineBytes: heaps.length > 0 && baseline !== null ? Math.max(...heaps) - baseline : null,
			},
			timings,
			errors,
			env: captureEnv(),
		};
	},
	async reset() {
		const databases = await (indexedDB as IDBFactory & {databases?: () => Promise<{name?: string}[]>}).databases?.();
		for (const database of databases ?? []) {
			if (database.name) indexedDB.deleteDatabase(database.name);
		}
	},
};

export default cut;
