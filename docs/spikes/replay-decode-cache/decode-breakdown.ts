/**
 * WHERE DOES THE 63 us/event GO?
 *
 * The memo's option B proposes CACHING the decode. Before accepting that a
 * derivation must be stored to avoid a cost, it is worth knowing whether the
 * cost is intrinsic to decoding these bytes or is an artifact of how
 * `LogEventFetcher.decodeOnto` calls viem.
 *
 * `decodeOnto` calls `decodeEventLog({abi: <every event of that address>, data,
 * topics})` once per event. viem must then find WHICH member the log's `topic0`
 * names, and it does that by walking the ABI and computing an event selector
 * (keccak over the canonical signature) for each candidate -- per call, with no
 * memoisation the fetcher supplies. If that is where the time goes, the decode
 * term is not a property of ABI decoding; it is a property of handing viem a
 * whole ABI 31,330 times.
 *
 * Three variants over the SAME 31,330 real logs, all producing IDENTICAL args
 * (asserted, not assumed):
 *
 *   whole-abi      what production does: the address's full event list per call
 *   preselected    the same viem call with a ONE-MEMBER abi, chosen by a
 *                  topic0 -> AbiEvent map built ONCE outside the loop
 *   map-build      what building that map costs, so it is not hidden
 *
 * This measures a REFACTOR (memoise a lookup), not a cache of a derivation:
 * nothing is stored, nothing can go stale, and the map is rebuilt from the
 * source every time a fetcher is constructed.
 *
 * Run: `packages/core/node_modules/.bin/tsx decode-breakdown.ts`
 * Raw output: `results/decode-breakdown.json`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';

import {parseStreamFixture, taggedBnReplacer, type LogEvent} from '../../../packages/core/dist/index.js';
import {LogEventFetcher} from '../../../packages/core/dist/internal/decoding/LogEventFetcher.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../../..');
const FIXTURE = path.join(ROOT, 'docs/spikes/replay-parse-cost/results/stratagems-alpha1-full.stream.json.gz');
const OUT = path.join(HERE, 'results/decode-breakdown.json');

// viem is resolved from `@etherfold/core`'s own node_modules, through its ESM
// entry, so this measures the EXACT decoder instance the production fetcher
// uses rather than a second copy pnpm might have placed elsewhere.
const viemCjs = createRequire(path.join(ROOT, 'packages/core/package.json')).resolve('viem');
const viemEsm = viemCjs.replace(`${path.sep}_cjs${path.sep}`, `${path.sep}_esm${path.sep}`);
const {decodeEventLog, toEventSelector} = await import(pathToFileURL(viemEsm).href);

const fixture = parseStreamFixture(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf-8'));
const events = fixture.eventStream as LogEvent<any>[];
const source = fixture.source as any;

const WARMUP = 1;
const RUNS = 5;
const now = () => performance.now();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// ------------------------------------------------------------- the raw inputs

const rawEvents = events.map((event) => {
	const {args: _a, eventName: _e, decodeError: _d, ...raw} = event as any;
	return raw;
});

/** address -> every event member of its ABI: exactly what `decodeOnto` hands viem. */
const abiPerAddress = new Map<string, any[]>();
for (const contract of source.contracts as any[]) {
	abiPerAddress.set(
		(contract.address as string).toLowerCase(),
		(contract.abi as any[]).filter((m) => m.type === 'event'),
	);
}

// ------------------------------------------------------------ production path

const dummyProvider = {request: async () => Promise.reject(new Error('no node'))};
const fetchers = new Map<string, any>();
for (const contract of source.contracts as any[]) {
	fetchers.set(
		(contract.address as string).toLowerCase(),
		new (LogEventFetcher as any)(dummyProvider, [contract], {}, undefined),
	);
}

function productionReparse(list: any[]): any[] {
	const out: any[] = new Array(list.length);
	const groups = new Map<string, {indices: number[]; events: any[]}>();
	for (let i = 0; i < list.length; i++) {
		const address = (list[i].address as string).toLowerCase();
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
		for (let j = 0; j < reparsed.length; j++) out[group.indices[j]] = reparsed[j];
	}
	return out;
}

// ------------------------------------------------------- the three variants

/** viem with the WHOLE address ABI, per event: the shape production is in. */
function decodeWholeAbi(list: any[]): {eventName: string; args: unknown}[] {
	const out: {eventName: string; args: unknown}[] = new Array(list.length);
	for (let i = 0; i < list.length; i++) {
		const event = list[i];
		const abi = abiPerAddress.get((event.address as string).toLowerCase())!;
		const decoded = decodeEventLog({abi, data: event.data, topics: event.topics});
		out[i] = {eventName: decoded.eventName as string, args: decoded.args};
	}
	return out;
}

/** Build the `${address}:${topic0}` -> AbiEvent map. Measured separately so it is not free by omission. */
function buildSelectorMap(): Map<string, any> {
	const map = new Map<string, any>();
	for (const [address, abi] of abiPerAddress) {
		for (const member of abi) {
			if (member.anonymous) continue;
			map.set(`${address}:${toEventSelector(member)}`, member);
		}
	}
	return map;
}

/** viem with a ONE-MEMBER abi, preselected from the map. Same call, same decoder. */
function decodePreselected(list: any[], map: Map<string, any>): {eventName: string; args: unknown}[] {
	const out: {eventName: string; args: unknown}[] = new Array(list.length);
	for (let i = 0; i < list.length; i++) {
		const event = list[i];
		const member = map.get(`${(event.address as string).toLowerCase()}:${event.topics[0]}`);
		if (!member) {
			out[i] = {eventName: '<unknown>', args: undefined};
			continue;
		}
		const decoded = decodeEventLog({abi: [member], data: event.data, topics: event.topics});
		out[i] = {eventName: decoded.eventName as string, args: decoded.args};
	}
	return out;
}

// ---------------------------------------------------------------- correctness

const canonical = (value: unknown) => JSON.stringify(value, taggedBnReplacer);
const selectorMap = buildSelectorMap();
const viaWhole = decodeWholeAbi(rawEvents);
const viaPre = decodePreselected(rawEvents, selectorMap);
const viaProduction = productionReparse(rawEvents);

let mismatches = 0;
let unknowns = 0;
for (let i = 0; i < rawEvents.length; i++) {
	if (viaPre[i].eventName === '<unknown>') {
		unknowns++;
		continue;
	}
	if (canonical(viaWhole[i]) !== canonical(viaPre[i])) mismatches++;
	if (canonical({eventName: viaProduction[i].eventName, args: viaProduction[i].args}) !== canonical(viaWhole[i])) {
		mismatches++;
	}
}
if (mismatches > 0) throw new Error(`${mismatches} decode mismatches between variants`);
console.log(`correctness: all ${rawEvents.length} events decode identically all three ways (${unknowns} unknown topic0)`);

// ----------------------------------------------------------------- the timings

async function repeat(label: string, fn: () => unknown) {
	for (let i = 0; i < WARMUP; i++) fn();
	const runs: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const start = now();
		fn();
		runs.push(now() - start);
	}
	console.log(`  ${label}: median ${median(runs).toFixed(1)} ms (${runs.map((r) => r.toFixed(0)).join(', ')})`);
	return {label, runs, medianMs: median(runs)};
}

console.log(`measuring (warmup ${WARMUP} + ${RUNS} runs):`);
const production = await repeat('production reparse (whole-abi, via LogEventFetcher)', () => productionReparse(rawEvents));
const wholeAbi = await repeat('viem decodeEventLog, whole address ABI per call', () => decodeWholeAbi(rawEvents));
const preselected = await repeat('viem decodeEventLog, ONE-member abi preselected by topic0', () =>
	decodePreselected(rawEvents, selectorMap),
);

// the map build, per fetcher construction and NOT per event
const mapRuns: number[] = [];
for (let i = 0; i < 200; i++) {
	const start = now();
	buildSelectorMap();
	mapRuns.push(now() - start);
}
const mapBuildMs = median(mapRuns);
console.log(`  selector map build: median ${mapBuildMs.toFixed(3)} ms (once per fetcher, not per event)`);

const result = {
	measuredAt: new Date().toISOString(),
	commit: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {encoding: 'utf-8'}).trim(),
	runtime: {node: process.version, cpu: os.cpus()[0].model, machine: `${os.type()} ${os.release()}`},
	events: rawEvents.length,
	correctness: {allThreeAgree: true, unknownTopic0: unknowns},
	timingsMs: {production, wholeAbi, preselected, mapBuildMs},
	perEventUs: {
		production: (production.medianMs / rawEvents.length) * 1000,
		wholeAbi: (wholeAbi.medianMs / rawEvents.length) * 1000,
		preselected: (preselected.medianMs / rawEvents.length) * 1000,
	},
	speedup: production.medianMs / preselected.medianMs,
	abiSizes: Object.fromEntries([...abiPerAddress].map(([address, abi]) => [address, abi.length])),
};

fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(
	`\nproduction ${result.perEventUs.production.toFixed(1)} us/event -> ` +
		`preselected ${result.perEventUs.preselected.toFixed(1)} us/event ` +
		`(${result.speedup.toFixed(1)}x)`,
);
console.log(`wrote ${OUT}`);
