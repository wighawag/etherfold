/**
 * WHERE DOES THE 63 us/event GO?
 *
 * The memo's option B proposes CACHING the decode. Before accepting that a
 * derivation must be stored to avoid a cost, it is worth knowing whether the
 * cost is intrinsic to decoding these bytes or is an artifact of how
 * `LogEventFetcher.decodeOnto` calls viem.
 *
 * `decodeOnto` USED TO call `decodeEventLog({abi: <every event of that address>,
 * data, topics})` once per event. viem must then find WHICH member the log's
 * `topic0` names, and it does that by walking the ABI and computing an event
 * selector (keccak over the canonical signature) for each candidate -- per call,
 * with no memoisation the fetcher supplies. If that is where the time goes, the
 * decode term is not a property of ABI decoding; it is a property of handing
 * viem a whole ABI 31,330 times.
 *
 * It was, and the preselection this measured has SHIPPED
 * (`work/tasks/done/decoding-preselects-the-event-by-topic0-instead-of-re-searching-the-abi.md`).
 * So this script now measures the SHIPPED path rather than a hand-rolled
 * equivalent of it, and it keeps the pre-change algorithm available through
 * PRODUCTION CODE so the published delta is production-to-production:
 *
 *   production            `LogEventFetcher.reparse` as it ships: preselected
 *   production whole-abi  the same `reparse` on the ADDRESS-AGNOSTIC route,
 *                         which deliberately does NOT preselect (ADR-0031), so
 *                         it still makes the pre-change whole-ABI call. Each
 *                         fetcher here holds exactly one contract, so that route
 *                         decodes against the same member list and differs only
 *                         in the search.
 *   whole-abi             bare viem, the address's full event list per call
 *   preselected           bare viem with a ONE-MEMBER abi, chosen by a
 *                         `${address}:${topic0}` map built ONCE outside the loop
 *   map-build             what building that map costs, so it is not hidden
 *
 * Every variant is asserted to produce IDENTICAL eventName/args on all 31,330
 * real logs, which is also the on-real-data check that the shipped preselection
 * is a pure optimisation.
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
// the SAME production code on its address-agnostic route, which does not
// preselect: this is the pre-change decode algorithm, measured through shipped
// code rather than through a transcription of it
const unpreselectedFetchers = new Map<string, any>();
for (const contract of source.contracts as any[]) {
	const address = (contract.address as string).toLowerCase();
	fetchers.set(address, new (LogEventFetcher as any)(dummyProvider, [contract], {}, undefined));
	unpreselectedFetchers.set(
		address,
		new (LogEventFetcher as any)(dummyProvider, [contract], {}, {parseAllEventsIrrespectiveOfAddresses: true}),
	);
}

function reparseThrough(pool: Map<string, any>, list: any[]): any[] {
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
		const reparsed = pool.get(address).reparse(group.events);
		for (let j = 0; j < reparsed.length; j++) out[group.indices[j]] = reparsed[j];
	}
	return out;
}

const productionReparse = (list: any[]) => reparseThrough(fetchers, list);
const productionReparseWholeAbi = (list: any[]) => reparseThrough(unpreselectedFetchers, list);

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
const viaProductionWhole = productionReparseWholeAbi(rawEvents);

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
	// the shipped preselection against the pre-change algorithm, both through
	// production: this is the pure-optimisation claim on real data
	if (
		canonical({eventName: viaProduction[i].eventName, args: viaProduction[i].args}) !==
		canonical({eventName: viaProductionWhole[i].eventName, args: viaProductionWhole[i].args})
	) {
		mismatches++;
	}
}
if (mismatches > 0) throw new Error(`${mismatches} decode mismatches between variants`);
console.log(`correctness: all ${rawEvents.length} events decode identically all four ways (${unknowns} unknown topic0)`);

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
const production = await repeat('production reparse (preselected, via LogEventFetcher)', () =>
	productionReparse(rawEvents),
);
const productionWholeAbi = await repeat('production reparse, unpreselected route (the pre-change algorithm)', () =>
	productionReparseWholeAbi(rawEvents),
);
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
	correctness: {allVariantsAgree: true, unknownTopic0: unknowns},
	timingsMs: {production, productionWholeAbi, wholeAbi, preselected, mapBuildMs},
	perEventUs: {
		production: (production.medianMs / rawEvents.length) * 1000,
		productionWholeAbi: (productionWholeAbi.medianMs / rawEvents.length) * 1000,
		wholeAbi: (wholeAbi.medianMs / rawEvents.length) * 1000,
		preselected: (preselected.medianMs / rawEvents.length) * 1000,
	},
	/** Production-to-production: the shipped path against the algorithm it replaced. */
	speedup: productionWholeAbi.medianMs / production.medianMs,
	abiSizes: Object.fromEntries([...abiPerAddress].map(([address, abi]) => [address, abi.length])),
};

fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(
	`\nproduction, unpreselected ${result.perEventUs.productionWholeAbi.toFixed(1)} us/event -> ` +
		`production, shipped ${result.perEventUs.production.toFixed(1)} us/event ` +
		`(${result.speedup.toFixed(1)}x)`,
);
console.log(`wrote ${OUT}`);
