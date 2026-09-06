/**
 * The two captured deployments, and which of them is the workload.
 *
 * **Read this before assuming `base` means "the Base deployment".** Stratagems
 * has TWO deployment folders on Base and both `.chain` files say `chainId:
 * 8453`. `deployments/base/` is an early one that saw 45 logs and was abandoned;
 * `deployments/alpha1/` is the LAUNCHED game. The spike's own task named the
 * `base/` addresses by mistake, which is why the correction is the first section
 * of `work/notes/findings/sqlite-in-the-browser.md`, and why both fixtures are
 * labelled here rather than left to a folder name to explain.
 *
 * `fixtures/README.md` carries the same labels for a reader who arrives at the
 * files instead of at this module.
 */
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {taggedBnReplacer, type StreamFixture} from '@etherfold/core';
import {loadStreamFixture} from './fixture-file.js';
import type {StratagemsABI} from '../vendor/stratagems/abi.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../fixtures');

export type WorkloadFixture = {
	/** How a test names it. */
	readonly name: string;
	/** Which stratagems deployment this is, in words, because the folder name misleads. */
	readonly deployment: string;
	/** The captured stream. `.gz` is gunzipped by `loadStreamFixture` on extension. */
	readonly streamPath: string;
	/**
	 * The state the ORIGINAL `JSProcessor` computed from that stream.
	 *
	 * A FROZEN expectation: the driver that could recompute it went with the
	 * free-form authoring path (ADR-0037). See `../fixtures/README.md`.
	 */
	readonly goldenStatePath: string;
	/** Roughly how big it is, so a reader knows which loop it belongs in. */
	readonly events: number;
	readonly blocks: number;
};

/**
 * The LAUNCHED game: the workload.
 *
 * Every log from Stratagems `0x5ab6d5bb8012fc60ab3653e025be4a59b4406ff2`, Gems
 * `0xb2d822732347e3dc60258dcf6cf0d4c7a432b678` and GemsGenerator
 * `0xb0855eaf94bf7f122af4f444141e83b7408cc7a7` on Base (chain 8453), blocks
 * 12,082,307 to 23,400,000, re-captured 2026-09-06 at chain head 50,968,313 (the
 * file's own `provenance` block is the authority; this comment is a summary):
 * 31,332 events in 1,042 event-bearing blocks. Stored GZIPPED (1.05 MB against
 * 33.8 MB of JSON, so the compressed form saves 33 MB in every working tree).
 * It carries the FULL log, `data` and `topics` included: they were omitted until
 * 2026-09-06 as the encoded form of the already-decoded `args`, which is sound
 * for a replay input and makes the file unusable as a SEED, since an event with
 * no raw log cannot be re-decoded and the load path clears such a stream
 * (ADR-0034, ADR-0063).
 */
export const ALPHA1: WorkloadFixture = {
	name: 'stratagems alpha1 (the LAUNCHED game)',
	deployment: 'contracts/deployments/alpha1, on Base (chain 8453)',
	streamPath: path.join(FIXTURES, 'stratagems-alpha1.stream.json.gz'),
	goldenStatePath: path.join(FIXTURES, 'stratagems-alpha1.state.json'),
	events: 31_332,
	blocks: 1_042,
};

/**
 * The ABANDONED early deployment: the fast smoke case, and NOTHING else.
 *
 * Stratagems `0xb99d938a722df8984722ab38732533130b4f3ec4` from block 11,681,933,
 * also on Base. It saw 45 logs across 10 blocks and was abandoned; the reward
 * events do not exist in its contracts at all, so ten of the thirteen handlers
 * cannot fire on it. It is kept because a case that fails on 31,332 real events
 * is a bug report nobody can read, and it is plain JSON because it is small
 * enough to read.
 */
export const BASE_ABANDONED: WorkloadFixture = {
	name: 'stratagems base (the ABANDONED early deployment)',
	deployment: 'contracts/deployments/base, on Base (chain 8453) -- NOT the launched game',
	streamPath: path.join(FIXTURES, 'stratagems-base.stream.json'),
	goldenStatePath: path.join(FIXTURES, 'stratagems-base.state.json'),
	events: 42,
	blocks: 9,
};

/** The captured stream, parsed by `@etherfold/core`'s own fixture parser. */
export function loadStream(fixture: WorkloadFixture): StreamFixture<StratagemsABI> {
	return loadStreamFixture<StratagemsABI>(fixture.streamPath);
}

/**
 * Key-sorted JSON, so two states that differ only in key ORDER compare equal.
 *
 * BigInts go out TAGGED (`taggedBnReplacer`, the core's one codec), which is
 * also what wrote the committed golden files, so a comparison is a string
 * comparison of two identically-produced renderings and a failure is a readable
 * diff rather than a deep-equal report.
 *
 * The tag matters HERE and not only on a read path. This used to render BigInts
 * with the `"123n"` suffix, under which `123n` and the string `"123n"` produce
 * the SAME text: two states that genuinely differ would compare equal, and the
 * oracle would report agreement it had not established. The goldens were
 * re-rendered when the tag landed; the states behind them did not change, which
 * is what `docs/spikes/tagged-bigint-codec-across-storage-adapters/` proves.
 */
export function canonical(value: unknown): string {
	return JSON.stringify(sortKeys(value), taggedBnReplacer, 2);
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
		return out;
	}
	return value;
}

/** The first places two canonical renderings diverge, so a failure names itself. */
export function firstDifferences(expected: string, actual: string, limit = 4): string[] {
	const left = expected.split('\n');
	const right = actual.split('\n');
	const diffs: string[] = [];
	for (let i = 0; i < Math.max(left.length, right.length) && diffs.length < limit; i++) {
		if (left[i] !== right[i]) diffs.push(`line ${i + 1}:\n  golden: ${left[i]}\n  store:  ${right[i]}`);
	}
	return diffs;
}
