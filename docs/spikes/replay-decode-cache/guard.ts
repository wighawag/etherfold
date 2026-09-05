/**
 * IS A DECODE-SENSITIVE IDENTITY A SOUND CACHE-VALIDITY KEY?
 *
 * Option B in the memo caches decoded `args` beside the raw log under an
 * identity, reusing the cache when the identity matches and reparsing from the
 * stored raw log when it does not. That is only sound if the identity MOVES on
 * every change that changes what a log decodes to, and STAYS STILL on the
 * changes that do not. This script does not argue that; it mutates a real source
 * four ways and reports what each digest does, decoding a real log under each.
 *
 * The four mutations, and what each must do:
 *
 *   1. RENAME A NON-INDEXED PARAMETER  -- the case the whole two-digest split
 *      exists for. `topic0` hashes types and not names, so the FETCH is
 *      untouched and the DECODE moves: stream digest must NOT move, decode
 *      digest MUST move, and the decoded `args` must genuinely differ.
 *   2. ADD A VIEW FUNCTION  -- an ABI regeneration that changes nothing indexed.
 *      Neither digest may move, or every regenerated ABI is a cache miss.
 *   3. ADD A NEW EVENT  -- widens the fetch filter. BOTH must move (the stream
 *      because there is history it never fetched; the decode because ADR-0034's
 *      implication runs one way).
 *   4. PROCESSOR-ONLY CHANGE  -- the case option B exists to make free. The
 *      source is untouched, so neither digest may move.
 *
 * Run: `packages/core/node_modules/.bin/tsx guard.ts`
 * Raw output: `results/guard.json`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

import {parseStreamFixture, streamDigestOf, taggedBnReplacer} from '../../../packages/core/dist/index.js';
import {LogEventFetcher} from '../../../packages/core/dist/internal/decoding/LogEventFetcher.js';
import {sourceHashesOf} from '../../../packages/core/dist/internal/engine/eventRanges.js';
import {canonical_form, simple_hash} from '../../../packages/core/dist/utils/hash.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../../..');
const FIXTURE = path.join(ROOT, 'docs/spikes/replay-parse-cost/results/stratagems-alpha1-full.stream.json.gz');
const OUT = path.join(HERE, 'results/guard.json');

const fixture = parseStreamFixture(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf-8'));
const streamConfig = {finality: 12} as any;

/** The same candidate identity `measure.ts` times: the decode mirror of `streamDigestOf`. */
function decodeDigestCandidate(source: any): string {
	const shapes = [...new Set(sourceHashesOf(source).map((entry: any) => entry.hash))].sort();
	return simple_hash({rule: 'etherfold/decode/candidate/1', shapes, config: streamConfig});
}
/** The WIRE identity, whole-source and 32-bit, kept whole deliberately (ADR-0034). */
function wireIdentity(source: any): string {
	return simple_hash({source, config: streamConfig});
}

function digestsOf(source: any) {
	return {
		stream: streamDigestOf(source, streamConfig),
		decode: decodeDigestCandidate(source),
		wire: wireIdentity(source),
	};
}

const clone = (value: unknown) => JSON.parse(JSON.stringify(value));

// ------------------------------------------------------------ a real log to decode

const dummyProvider = {request: async () => Promise.reject(new Error('no node'))};
/** Decode one real log under a given source, so a digest claim is checked against an actual `args`. */
function decodeSample(source: any, sampleAddress: string): unknown {
	const contract = (source.contracts as any[]).find(
		(c) => (c.address as string).toLowerCase() === sampleAddress.toLowerCase(),
	);
	const fetcher = new (LogEventFetcher as any)(dummyProvider, [contract], {}, undefined);
	const sample = (fixture.eventStream as any[]).find(
		(event) => (event.address as string).toLowerCase() === sampleAddress.toLowerCase(),
	);
	const {args: _a, eventName: _e, decodeError: _d, ...raw} = sample;
	const [decoded] = fetcher.reparse([raw]);
	return JSON.parse(JSON.stringify({eventName: decoded.eventName, args: decoded.args}, taggedBnReplacer));
}

// pick a contract with a real event stream and an event carrying a NON-INDEXED input
const source = fixture.source as any;
const target = (() => {
	for (const contract of source.contracts as any[]) {
		for (const member of contract.abi as any[]) {
			if (member.type !== 'event') continue;
			const input = (member.inputs as any[]).find((i) => !i.indexed && i.name);
			if (input) return {address: contract.address as string, eventName: member.name as string, param: input.name as string};
		}
	}
	throw new Error('no event with a named non-indexed input in this source');
})();

const baseline = digestsOf(source);
const baselineArgs = decodeSample(source, target.address);

// --------------------------------------------------------------- 1. rename a param

const renamed = clone(source);
for (const contract of renamed.contracts as any[]) {
	if ((contract.address as string).toLowerCase() !== target.address.toLowerCase()) continue;
	for (const member of contract.abi as any[]) {
		if (member.type === 'event' && member.name === target.eventName) {
			for (const input of member.inputs as any[]) {
				if (!input.indexed && input.name === target.param) input.name = `${input.name}Renamed`;
			}
		}
	}
}
const renamedDigests = digestsOf(renamed);
const renamedArgs = decodeSample(renamed, target.address);

// ----------------------------------------------------------- 2. add a view function

const regenerated = clone(source);
(regenerated.contracts as any[])[0].abi.push({
	type: 'function',
	name: 'aViewAddedByRegeneration',
	stateMutability: 'view',
	inputs: [],
	outputs: [{name: '', type: 'uint256'}],
});
const regeneratedDigests = digestsOf(regenerated);

// ------------------------------------------------------------------ 3. add an event

const widened = clone(source);
(widened.contracts as any[])[0].abi.push({
	type: 'event',
	name: 'ASpecificallyNewEvent',
	anonymous: false,
	inputs: [{name: 'who', type: 'address', indexed: true}],
});
const widenedDigests = digestsOf(widened);

// -------------------------------------------------------- 4. a processor-only change

// nothing about the SOURCE changes; the processor's version hash is not an input
// to either digest, which is the whole point.
const processorOnlyDigests = digestsOf(clone(source));

// ---------------------------------------------------------------------- verdicts

const cases = [
	{
		name: 'rename a NON-INDEXED parameter (decode-only ABI change)',
		digests: renamedDigests,
		streamMoved: renamedDigests.stream !== baseline.stream,
		decodeMoved: renamedDigests.decode !== baseline.decode,
		wireMoved: renamedDigests.wire !== baseline.wire,
		argsChanged: JSON.stringify(renamedArgs) !== JSON.stringify(baselineArgs),
		mustBe: {streamMoved: false, decodeMoved: true, argsChanged: true},
	},
	{
		name: 'add a VIEW FUNCTION (ABI regeneration, nothing indexed moves)',
		digests: regeneratedDigests,
		streamMoved: regeneratedDigests.stream !== baseline.stream,
		decodeMoved: regeneratedDigests.decode !== baseline.decode,
		wireMoved: regeneratedDigests.wire !== baseline.wire,
		argsChanged: false,
		mustBe: {streamMoved: false, decodeMoved: false, argsChanged: false},
	},
	{
		name: 'add a NEW EVENT (the fetch filter widens)',
		digests: widenedDigests,
		streamMoved: widenedDigests.stream !== baseline.stream,
		decodeMoved: widenedDigests.decode !== baseline.decode,
		wireMoved: widenedDigests.wire !== baseline.wire,
		argsChanged: false,
		mustBe: {streamMoved: true, decodeMoved: true, argsChanged: false},
	},
	{
		name: 'a PROCESSOR-ONLY change (the case option B exists for)',
		digests: processorOnlyDigests,
		streamMoved: processorOnlyDigests.stream !== baseline.stream,
		decodeMoved: processorOnlyDigests.decode !== baseline.decode,
		wireMoved: processorOnlyDigests.wire !== baseline.wire,
		argsChanged: false,
		mustBe: {streamMoved: false, decodeMoved: false, argsChanged: false},
	},
];

const failures: string[] = [];
for (const item of cases) {
	for (const [key, expected] of Object.entries(item.mustBe)) {
		if ((item as any)[key] !== expected) failures.push(`${item.name}: ${key} was ${(item as any)[key]}, expected ${expected}`);
	}
}

const result = {
	measuredAt: new Date().toISOString(),
	commit: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {encoding: 'utf-8'}).trim(),
	target,
	baseline: {digests: baseline, sampleArgs: baselineArgs},
	renamedSampleArgs: renamedArgs,
	cases,
	failures,
	canonicalFormNote: canonical_form({probe: 1}),
};

fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

console.log(`target: ${target.eventName}.${target.param} at ${target.address}`);
console.log(`baseline: stream=${baseline.stream} decode=${baseline.decode} wire=${baseline.wire}`);
for (const item of cases) {
	console.log(
		`  ${item.name}\n    stream ${item.streamMoved ? 'MOVED' : 'still'} | ` +
			`decode ${item.decodeMoved ? 'MOVED' : 'still'} | wire ${item.wireMoved ? 'MOVED' : 'still'} | ` +
			`args ${item.argsChanged ? 'CHANGED' : 'same'}`,
	);
}
console.log(failures.length === 0 ? '\nALL EXPECTATIONS HELD' : `\nFAILURES:\n${failures.join('\n')}`);
console.log(`wrote ${OUT}`);
