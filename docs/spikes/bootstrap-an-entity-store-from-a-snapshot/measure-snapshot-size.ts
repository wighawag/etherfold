/**
 * How big is a snapshot of the REAL workload, and how does it compare with just
 * replaying the stream?
 *
 * The question `bootstrap-an-entity-store-from-a-snapshot` had to answer before
 * choosing what goes IN a snapshot: current rows only (small, and the store's
 * history floors at the snapshot block) or rows plus version history (bigger,
 * and the store gets a real as-of window). If a full-history snapshot approaches
 * the size of the gzipped event stream, then a client downloading one is paying
 * stream-sized bytes for something it could have derived from the stream itself,
 * and the argument for carrying history collapses into an argument about what
 * the client is really being saved.
 *
 * Run it (from anywhere; the imports resolve through the workload package):
 *
 *   pnpm --filter @etherfold/conformance-workload-stratagems exec \
 *     tsx ../../docs/spikes/bootstrap-an-entity-store-from-a-snapshot/measure-snapshot-size.ts
 *
 * It writes `results/snapshot-size.json` next to this file and prints a table.
 * Nothing here is a test: it is a measurement, and its output is committed so
 * the numbers in ADR-0028 can be checked rather than trusted.
 *
 * ## What it measures, honestly
 *
 * - **current rows**: exactly what `StateSnapshot.rows` carries -- the LIVE row
 *   of every business key the run touched, as the upserts that reproduce it,
 *   inside the real envelope.
 * - **every version**: the same rows plus every superseded version the store
 *   still holds, in the same encoding, as the CEILING a full-history snapshot
 *   would have to pay. It is a ceiling and not a proposal: no such envelope
 *   exists, because the seam has no way to install a version range (a version is
 *   what applying a block produces), so this number exists to be compared
 *   against, not to be shipped.
 * - **the stream**: the committed capture, as it is on disk and gunzipped, which
 *   is the alternative a client always has.
 *
 * Reaching into `MemoryStateStore`'s private version map for the ceiling is a
 * spike liberty, and it is the reason this is a script in `docs/spikes/` rather
 * than a helper in a package: there is no seam read that enumerates versions,
 * deliberately (ADR-0021), and inventing one to measure with would be inventing
 * the very surface the measurement is meant to argue about.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
// relative, not by package name: this file lives outside any package, so a bare
// specifier has no `node_modules` to resolve through.
import {MemoryStateStore, type Mutation} from '../../../packages/state-store/src/index.js';
import {ALPHA1, loadStream} from '../../../packages/conformance-workload-stratagems/src/fixtures.js';
import {stratagemsProcessor} from '../../../packages/conformance-workload-stratagems/src/processor.js';
import {replayIntoStore} from '../../../packages/conformance-workload-stratagems/src/replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, 'results');

/**
 * The `"123n"` convention the storage adapters wrote when this FIRST ran, kept
 * so the originally committed numbers stay reproducible.
 *
 * The adapters have since moved to the tagged form below. Both are measured now,
 * rather than one replacing the other: the `suffix` figures are what the earlier
 * `results/` and anything quoting them (ADR-0028) refer to, and the `tagged`
 * figures are what the repo actually writes today.
 */
function bnReplacer(_key: string, value: unknown): unknown {
	return typeof value === 'bigint' ? `${value}n` : value;
}

/**
 * The TAGGED convention every storage adapter writes today
 * (`docs/spikes/tagged-bigint-codec-across-storage-adapters/`).
 *
 * It is more verbose per value, so the raw bytes must come out larger. Whether
 * that survives GZIP was the open question, and it is worth measuring rather
 * than assuming either way: the tag is a fixed string repeated once per BigInt,
 * which is the most compressible thing there is.
 */
function taggedReplacer(_key: string, value: unknown): unknown {
	return typeof value === 'bigint' ? {__bigint__: `${value}`} : value;
}

type Sizes = {bytes: number; gzipped: number};

function sizesWith(value: unknown, replacer: (key: string, value: unknown) => unknown): Sizes {
	const text = JSON.stringify(value, replacer);
	return {bytes: Buffer.byteLength(text), gzipped: gzipSync(Buffer.from(text), {level: 9}).length};
}

/** Both encodings, so a reader can see which number they are quoting. */
function sizes(value: unknown): Sizes & {suffix: Sizes; tagged: Sizes} {
	const suffix = sizesWith(value, bnReplacer);
	const tagged = sizesWith(value, taggedReplacer);
	// the top-level `bytes`/`gzipped` stay the SUFFIX form so the shape of
	// `results/snapshot-size.json` and every existing reading of it is unchanged
	return {...suffix, suffix, tagged};
}

function kb(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)} KB`;
}

const started = Date.now();
const store = new MemoryStateStore(stratagemsProcessor.entities);
await store.migrate();

const stream = loadStream(ALPHA1);
const report = await replayIntoStore(store, stratagemsProcessor, stream.eventStream);

// --- what a snapshot of CURRENT rows carries ---------------------------------

const rows: Mutation[] = [];
for (const [entity, byKey] of report.touched) {
	for (const id of byKey.values()) {
		const row = await store.getCurrent<Record<string, unknown>>(entity, id);
		if (!row) continue; // deleted: simply absent from a snapshot
		const values: Record<string, unknown> = {};
		for (const [column, value] of Object.entries(row)) {
			if (!column.startsWith('_')) values[column] = value;
		}
		rows.push({type: 'upsert', entity, id, values});
	}
}

const snapshot = {
	format: 1,
	processor: 'measured',
	savedAt: new Date().toISOString(),
	takenAt: {number: report.tip, hash: '0x0', timestamp: 0},
	cursor: {key: 'lastSync', value: '{}'},
	rows,
};

// --- the CEILING: the same encoding, every version the store still holds ------

type PrivateVersion = {values: Record<string, unknown>; lower: number; upper: number | null};
type PrivateRow = {entity: string; id: readonly string[]; versions: PrivateVersion[]};
const versionMap = (store as unknown as {rows: Map<string, PrivateRow>}).rows;

const allVersions: unknown[] = [];
let versionCount = 0;
for (const row of versionMap.values()) {
	const declaration = store.declarations.get(row.entity);
	if (!declaration) continue;
	for (const version of row.versions) {
		versionCount++;
		const values: Record<string, unknown> = {};
		for (const [column, value] of Object.entries(version.values)) {
			if (!declaration.id.includes(column)) values[column] = value;
		}
		const id: Record<string, unknown> = {};
		declaration.id.forEach((column, index) => (id[column] = row.id[index]));
		allVersions.push({entity: row.entity, id, values, lower: version.lower, upper: version.upper});
	}
}
const withHistory = {...snapshot, rows: undefined, versions: allVersions};

// --- the alternative a client always has -------------------------------------

const streamGzipped = fs.statSync(ALPHA1.streamPath).size;
const streamRaw = Buffer.byteLength(JSON.stringify(stream, bnReplacer));
const streamRawTagged = Buffer.byteLength(JSON.stringify(stream, taggedReplacer));

const current = sizes(snapshot);
const full = sizes(withHistory);

const result = {
	measuredAt: new Date().toISOString(),
	workload: {
		fixture: ALPHA1.name,
		events: report.events,
		eventBearingBlocks: report.blocks,
		mutations: report.mutations,
		tip: report.tip,
		liveRows: rows.length,
		versions: versionCount,
	},
	snapshotOfCurrentRows: current,
	snapshotOfEveryVersion: full,
	capturedStream: {gzippedOnDisk: streamGzipped, rawJson: streamRaw, rawJsonTagged: streamRawTagged},
	ratios: {
		versionsPerLiveRow: +(versionCount / rows.length).toFixed(2),
		fullHistoryOverCurrentRows: +(full.gzipped / current.gzipped).toFixed(2),
		currentRowsOverGzippedStream: +(current.gzipped / streamGzipped).toFixed(2),
		fullHistoryOverGzippedStream: +(full.gzipped / streamGzipped).toFixed(2),
	},
	tookSeconds: +((Date.now() - started) / 1000).toFixed(1),
};

fs.mkdirSync(RESULTS, {recursive: true});
fs.writeFileSync(path.join(RESULTS, 'snapshot-size.json'), `${JSON.stringify(result, null, 2)}\n`);

console.log(`${ALPHA1.name}: ${report.events} events, ${rows.length} live rows, ${versionCount} versions`);
console.log(`| what a client downloads              | raw       | gzipped   |`);
console.log(`| ----------------------------------- | --------: | --------: |`);
console.log(`| snapshot of CURRENT rows            | ${kb(current.bytes)} | ${kb(current.gzipped)} |`);
console.log(`| snapshot of EVERY version (ceiling) | ${kb(full.bytes)} | ${kb(full.gzipped)} |`);
console.log(`| the captured stream                 | ${kb(streamRaw)} | ${kb(streamGzipped)} |`);
console.log(`written to ${path.join(RESULTS, 'snapshot-size.json')}`);
