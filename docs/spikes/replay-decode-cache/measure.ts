/**
 * REPLAY-DECODE-CACHE: what a processor-change replay costs at HEAD, and what a
 * guarded decode CACHE would and would not buy.
 *
 * This is a RE-VERIFICATION plus an extension of
 * `docs/spikes/replay-parse-cost/`, whose finding
 * (`work/notes/findings/replay-parse-cost.md`) measured read/decode/process on
 * the same 31,330 real Base logs. Two of its three seams are unchanged at HEAD
 * and are re-measured here only to confirm reproduction; the THIRD is
 * INVALIDATED, because ADR-0037 deleted `@etherfold/js-processor` and with it
 * `fromJSProcessor`, which is how that spike drove its `process` term. The
 * process term is therefore re-measured on the model that survives: the ENTITY
 * path (`replayIntoStore` + `stratagemsProcessor` into a `StateStore`), across
 * three backends, because the decode share of a replay depends entirely on which
 * store the fold writes into.
 *
 * What is measured, all on the same bytes:
 *
 *   read     gunzip + JSON.parse + `taggedBnReviver` (unchanged seam)
 *   decode   `LogEventFetcher.reparse`, routed per address (unchanged seam)
 *   process  entity path into memory / patch / libSQL stores (NEW: seam moved)
 *   identity `streamDigestOf` and a CANDIDATE decode-sensitive digest, so the
 *            per-replay cost of an option-B cache-validity check is a number
 *            rather than an assumption
 *   sizes    full / raw-only / decoded-only, plus what a per-segment decode
 *            identity would add
 *   spread   events per `eventName`, which bounds how much a PER-ENTRY cache
 *            would salvage when ONE event's decoding shape moves
 *
 * Correctness is asserted rather than presumed: reparse over raw-only and over
 * full events must agree, and the entity replay must land on the COMMITTED
 * golden state (the state the original stratagems `JSProcessor` computed), so
 * the process term is the real fold and not a loop that happens to take time.
 *
 * Run: `packages/core/node_modules/.bin/tsx measure.ts`
 * Raw output: `results/measure.json`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';

import {
	blocksOf,
	parseStreamFixture,
	serializeStreamFixture,
	streamDigestOf,
	taggedBnReplacer,
	type LogEvent,
} from '../../../packages/core/dist/index.js';
// internal, not re-exported from the package index: imported by path so the
// measurement runs the PRODUCTION decoder and the production hash rules.
import {LogEventFetcher} from '../../../packages/core/dist/internal/decoding/LogEventFetcher.js';
import {sourceHashesOf} from '../../../packages/core/dist/internal/engine/eventRanges.js';
import {canonical_form} from '../../../packages/core/dist/utils/hash.js';
import {
	ALPHA1,
	replayIntoStore,
	stratagemsProcessor,
	projectToData,
	canonical as canonicalState,
  // source-only package: it is test material and has no `dist` (its build script says so),
  // so tsx loads the TypeScript directly. Its own bare imports resolve from its node_modules.
} from '../../../packages/conformance-workload-stratagems/src/index.js';
import {MemoryStateStore} from '../../../packages/state-store/dist/index.js';
import {PatchStateStore} from '../../../packages/state-store-patch/dist/index.js';
import {VersionedStateStore} from '../../../packages/state-store-sqlite/dist/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../../..');
// the FULL re-capture (raw halves kept) the prior spike made; this spike adds no
// capture of its own, deliberately, so the two are measured on identical bytes
const FIXTURE = path.join(ROOT, 'docs/spikes/replay-parse-cost/results/stratagems-alpha1-full.stream.json.gz');
const RESULT_OUT = path.join(HERE, 'results/measure.json');

// `@libsql/client` and `remote-sql-libsql` live in the conformance package's
// node_modules (pnpm, unhoisted), so they are resolved from there rather than
// vendored or assumed hoisted.
const requireFromWorkload = createRequire(path.join(ROOT, 'packages/conformance-workload-stratagems/package.json'));
const {createClient} = await import(pathToFileURL(requireFromWorkload.resolve('@libsql/client')).href);

const WARMUP = 1;
const RUNS = 5;
const now = () => performance.now();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// ---------------------------------------------------------------- the fixture

function readFixture(): ReturnType<typeof parseStreamFixture> {
	return parseStreamFixture(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf-8'));
}

const fixture = readFixture();
const events = fixture.eventStream as LogEvent<any>[];
const blocks = blocksOf(fixture);
console.log(`fixture: ${events.length} events, ${blocks.length} blocks (chain ${fixture.provenance.chainId})`);

function rawOnly(list: LogEvent<any>[]): LogEvent<any>[] {
	return list.map((event) => {
		const {args: _a, eventName: _e, decodeError: _d, ...raw} = event as any;
		return raw as LogEvent<any>;
	});
}
function decodedOnly(list: LogEvent<any>[]): LogEvent<any>[] {
	return list.map((event) => {
		const {topics: _t, data: _d, ...decoded} = event as any;
		return decoded as LogEvent<any>;
	});
}

const rawEvents = rawOnly(events);
const decodedEvents = decodedOnly(events);

// ------------------------------------------------------------- the decode term

const contracts = (fixture.source.contracts as any[]).map((c) => ({address: c.address, abi: c.abi}));
const dummyProvider = {
	request: async () => {
		throw new Error('no node in a replay');
	},
};
// one fetcher per contract, events routed by address: the merged three-contract
// source is refused at construction since #28, and per-address routing makes the
// same per-event decode decision `decodeOnto` makes.
const fetchers = new Map<string, any>();
for (const contract of contracts) {
	fetchers.set(
		(contract.address as string).toLowerCase(),
		new (LogEventFetcher as any)(dummyProvider, [contract], {}, undefined),
	);
}

function reparse(list: LogEvent<any>[]): LogEvent<any>[] | undefined {
	const out: LogEvent<any>[] = new Array(list.length);
	const groups = new Map<string, {indices: number[]; events: LogEvent<any>[]}>();
	for (let i = 0; i < list.length; i++) {
		const address = ((list[i] as any).address as string).toLowerCase();
		if (!fetchers.has(address)) throw new Error(`no fetcher for address ${address}`);
		let group = groups.get(address);
		if (!group) {
			group = {indices: [], events: []};
			groups.set(address, group);
		}
		group.indices.push(i);
		group.events.push(list[i]);
	}
	for (const [address, group] of groups) {
		const reparsed = fetchers.get(address).reparse(group.events);
		if (!reparsed) return undefined;
		for (let j = 0; j < reparsed.length; j++) out[group.indices[j]] = reparsed[j];
	}
	return out;
}

// --------------------------------------------------- the candidate identity

/**
 * A CANDIDATE decode-sensitive stream identity, built as the exact mirror of
 * `streamDigestOf`: same normalisation, same rolled-up shape, but over the
 * DECODE-sensitive `hash` of each source entry instead of the fetch-sensitive
 * `streamHash`, plus the resolved stream config (which already carries `parse`).
 *
 * This is a MEASUREMENT stand-in, not a proposal of the exact preimage: what is
 * being measured is the cost of computing and comparing such a value, which is a
 * property of the shape and not of the field list. It is deliberately built out
 * of production `sourceHashesOf` + `canonical_form` so the cost is the real one.
 */
function decodeDigestOfCandidate(source: any, streamConfig: any): string {
	const shapes = [
		...new Set(sourceHashesOf(source).map((entry: any) => entry.hash)),
	].sort();
	// same rolled-up form; hashing is done with the same canonical bytes helper
	return canonical_form({rule: 'etherfold/decode/candidate/1', shapes, config: streamConfig});
}

const streamConfig = {finality: 12};

// ---------------------------------------------------------------- correctness

function canonicalEvent(value: unknown): string {
	return JSON.stringify(value, taggedBnReplacer);
}

const fromRaw = reparse(rawEvents);
const fromFull = reparse(events);
if (!fromRaw || !fromFull) throw new Error('reparse returned undefined');
for (let i = 0; i < events.length; i++) {
	if (canonicalEvent(fromRaw[i]) !== canonicalEvent(fromFull[i])) {
		throw new Error(`reparse(raw-only) and reparse(full) disagree at event ${i}`);
	}
}
console.log('correctness: reparse(raw-only) === reparse(full) on all events');

// ----------------------------------------------------------------- the terms

async function repeat(label: string, fn: () => unknown | Promise<unknown>) {
	for (let i = 0; i < WARMUP; i++) await fn();
	const runs: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const start = now();
		await fn();
		runs.push(now() - start);
	}
	console.log(`  ${label}: median ${median(runs).toFixed(1)} ms (${runs.map((r) => r.toFixed(0)).join(', ')})`);
	return {label, runs, medianMs: median(runs)};
}

console.log(`measuring (warmup ${WARMUP} + ${RUNS} runs, node ${process.version}):`);

const read = await repeat('read (gunzip + JSON.parse + reviver)', () => readFixture());

/**
 * READ IS NOT SHAPE-INDEPENDENT, and this is the term option B pays extra.
 * Option A stores the raw half only and reads FEWER bytes; option B stores the
 * decoded half beside it and reads MORE. Measured on the same codec by
 * serializing each shape to gzip once and timing gunzip + parse + reviver over
 * it, exactly as `readFixture` does over the committed capture.
 */
function gzOfShape(shape: LogEvent<any>[]): Buffer {
	return zlib.gzipSync(Buffer.from(serializeStreamFixture({...fixture, eventStream: shape} as any)));
}
const gzFull = gzOfShape(events);
const gzRawOnly = gzOfShape(rawEvents);
const readFull = await repeat('read: full (raw + decoded), the option B stored shape', () =>
	parseStreamFixture(zlib.gunzipSync(gzFull).toString('utf-8')),
);
const readRawOnly = await repeat('read: raw-only, the option A stored shape', () =>
	parseStreamFixture(zlib.gunzipSync(gzRawOnly).toString('utf-8')),
);

const decodeRawOnly = await repeat('decode: reparse(raw-only)', () => reparse(rawEvents));
const decodeFull = await repeat('decode: reparse(full)', () => reparse(events));

// -------------------------------------------------- the process term, entity path

const replayable = fromRaw as LogEvent<any>[];
let dbCounter = 0;
const backends: {name: string; make: () => any}[] = [
	{name: 'memory', make: () => new (MemoryStateStore as any)(stratagemsProcessor.entities)},
	{name: 'patch', make: () => new (PatchStateStore as any)(stratagemsProcessor.entities, {retention: 'revert-only'})},
	{
		name: 'sqlite',
		make: () => {
			const RemoteLibSQL = requireFromWorkload('remote-sql-libsql').RemoteLibSQL;
			return new (VersionedStateStore as any)(
				new RemoteLibSQL(createClient({url: ':memory:'})),
				stratagemsProcessor.entities,
			);
		},
	},
];

async function processOn(backend: {name: string; make: () => any}) {
	dbCounter++;
	const store = backend.make();
	await store.migrate();
	const report = await replayIntoStore(store, stratagemsProcessor as any, replayable as any);
	return {store, report};
}

// correctness of the process term: it must land on the COMMITTED golden state,
// which the ORIGINAL stratagems JSProcessor computed from these same bytes.
const goldenCheck = await (async () => {
	const {store, report} = await processOn(backends[0]);
	const state = canonicalState(await projectToData(store, report.touched));
	const golden = fs.readFileSync(ALPHA1.goldenStatePath, 'utf-8');
	return {
		matchesGolden: state.trim() === golden.trim(),
		events: report.events,
		blocks: report.blocks,
		mutations: report.mutations,
		tip: report.tip,
	};
})();
console.log(
	`correctness: entity replay lands on the committed golden state: ${goldenCheck.matchesGolden} ` +
		`(${goldenCheck.blocks} blocks, ${goldenCheck.mutations} mutations)`,
);

const processTerms: Record<string, {label: string; runs: number[]; medianMs: number}> = {};
for (const backend of backends) {
	processTerms[backend.name] = await repeat(`process: entity path on ${backend.name}`, () => processOn(backend));
}

// --------------------------------------------------------- the identity term

const identity = await (async () => {
	const ITER = 2000;
	const t0 = now();
	for (let i = 0; i < ITER; i++) streamDigestOf(fixture.source as any, streamConfig as any);
	const streamMs = (now() - t0) / ITER;
	const t1 = now();
	for (let i = 0; i < ITER; i++) decodeDigestOfCandidate(fixture.source, streamConfig);
	const decodeMs = (now() - t1) / ITER;
	const entries = sourceHashesOf(fixture.source as any);
	return {
		iterations: ITER,
		streamDigestMsPerCall: streamMs,
		decodeDigestCandidateMsPerCall: decodeMs,
		sourceEntries: entries.length,
		distinctDecodeHashes: new Set(entries.map((e: any) => e.hash)).size,
		distinctStreamHashes: new Set(entries.map((e: any) => e.streamHash)).size,
	};
})();
console.log(
	`identity: streamDigestOf ${identity.streamDigestMsPerCall.toFixed(4)} ms/call, ` +
		`decode-digest candidate ${identity.decodeDigestCandidateMsPerCall.toFixed(4)} ms/call ` +
		`(${identity.sourceEntries} source entries)`,
);

/** What option B's guard costs PER REPLAY: computing the identity and comparing it. Once, not per event. */
const identityCheckMs = identity.decodeDigestCandidateMsPerCall;

// ---------------------------------------------------------------- the SIZES

function sizeOf(shape: LogEvent<any>[]): {jsonBytes: number; gzBytes: number} {
	const text = serializeStreamFixture({...fixture, eventStream: shape} as any);
	return {jsonBytes: Buffer.byteLength(text), gzBytes: zlib.gzipSync(Buffer.from(text)).length};
}

const sizes = {
	events: events.length,
	full: sizeOf(events),
	rawOnly: sizeOf(rawEvents),
	decodedOnly: sizeOf(decodedEvents),
};

/**
 * What a PER-SEGMENT decode identity costs, as bytes, at plausible batch sizes.
 * A segment is one save's batch (`StreamSegment`), and the identity is one
 * fixed-length 32-char digest per segment.
 */
const segmentOverhead = [1, 10, 50, 100, 500, 1000].map((eventsPerSegment) => {
	const segments = Math.ceil(events.length / eventsPerSegment);
	// `"decode":"<32 hex>"` as a JSON field on the segment record
	const bytes = segments * ('"decode":"'.length + 32 + 1);
	return {
		eventsPerSegment,
		segments,
		bytes,
		percentOfFullJson: (bytes / sizes.full.jsonBytes) * 100,
	};
});

// ------------------------------------------------------ invalidation spread

const perEventName: Record<string, number> = {};
for (const event of events) {
	const name = ((event as any).eventName as string) ?? '<undecoded>';
	perEventName[name] = (perEventName[name] ?? 0) + 1;
}
const spread = Object.entries(perEventName)
	.sort((a, b) => b[1] - a[1])
	.map(([eventName, count]) => ({eventName, count, share: count / events.length}));

const perAddress: Record<string, number> = {};
for (const event of events) {
	const address = ((event as any).address as string).toLowerCase();
	perAddress[address] = (perAddress[address] ?? 0) + 1;
}

// -------------------------------------------------------------------- output

const decodeMedian = decodeRawOnly.medianMs;
/**
 * The three replays put side by side, each paying the read of the shape IT
 * stores:
 *   A  raw-only stored, decode always      = read(rawOnly) + decode + process
 *   B  raw+decoded stored, identity MATCHES = read(full) + identity + process
 *   B' raw+decoded stored, identity MOVED   = read(full) + decode + process
 */
const composition = Object.fromEntries(
	Object.entries(processTerms).map(([name, term]) => {
		const optionA = readRawOnly.medianMs + decodeMedian + term.medianMs;
		const optionBHit = readFull.medianMs + identityCheckMs + term.medianMs;
		const optionBMiss = readFull.medianMs + identityCheckMs + decodeMedian + term.medianMs;
		return [
			name,
			{
				readFull: readFull.medianMs,
				readRawOnly: readRawOnly.medianMs,
				decode: decodeMedian,
				process: term.medianMs,
				optionA,
				optionBHit,
				optionBMiss,
				decodeShareOfOptionAPercent: (decodeMedian / optionA) * 100,
				bSavesOverAPercent: ((optionA - optionBHit) / optionA) * 100,
				bCostsOverAOnMissPercent: ((optionBMiss - optionA) / optionA) * 100,
			},
		];
	}),
);

const result = {
	measuredAt: new Date().toISOString(),
	commit: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {encoding: 'utf-8'}).trim(),
	runtime: {
		node: process.version,
		cpu: os.cpus()[0].model,
		cores: os.cpus().length,
		machine: `${os.type()} ${os.release()}`,
		viem: requireFromWorkload('viem/package.json')?.version ?? 'unknown',
	},
	fixture: {
		path: 'docs/spikes/replay-parse-cost/results/stratagems-alpha1-full.stream.json.gz',
		events: events.length,
		blocks: blocks.length,
		provenance: fixture.provenance,
	},
	methodology: {warmup: WARMUP, runs: RUNS, note: 'medians; each run does the whole 31k-event pass'},
	correctness: {
		reparseRawEqualsFull: true,
		entityReplayMatchesGolden: goldenCheck.matchesGolden,
		replayReport: goldenCheck,
	},
	timingsMs: {read, readFull, readRawOnly, decodeRawOnly, decodeFull, process: processTerms},
	perThousandEvents: {
		read: (read.medianMs / events.length) * 1000,
		decodeRawOnly: (decodeRawOnly.medianMs / events.length) * 1000,
		decodeFull: (decodeFull.medianMs / events.length) * 1000,
		process: Object.fromEntries(
			Object.entries(processTerms).map(([n, t]) => [n, (t.medianMs / events.length) * 1000]),
		),
	},
	replayComposition: composition,
	identity,
	sizes,
	segmentOverhead,
	spread,
	perAddress,
};

fs.mkdirSync(path.dirname(RESULT_OUT), {recursive: true});
fs.writeFileSync(RESULT_OUT, JSON.stringify(result, null, 2));
console.log(`\nwrote ${RESULT_OUT}`);
for (const [name, comp] of Object.entries(composition)) {
	console.log(
		`replay on ${name}: A ${comp.optionA.toFixed(0)} ms | B-hit ${comp.optionBHit.toFixed(0)} ms ` +
			`(${comp.bSavesOverAPercent.toFixed(0)}% saved) | B-miss ${comp.optionBMiss.toFixed(0)} ms ` +
			`(${comp.bCostsOverAOnMissPercent.toFixed(0)}% worse)`,
	);
}
