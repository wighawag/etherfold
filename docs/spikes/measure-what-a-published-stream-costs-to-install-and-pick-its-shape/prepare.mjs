/**
 * Build the ARTIFACTS the measurement compares, once, offline.
 *
 * Three shapes of the same 31,332-log capture, so "chunked is better" can be a
 * comparison instead of an assertion:
 *
 *   single/         the fixture exactly as COMMITTED: one gzipped document, and
 *                   INDENTED, because `saveStreamFixture` indents by default (a
 *                   committed fixture is read by humans and diffed).
 *   single-compact/ the same document with the indentation gone, which is what a
 *                   PUBLISHER would actually emit. Both are measured, because
 *                   quoting the committed file's size as the seed's size charges
 *                   a published artifact for 7 MB of whitespace it would not
 *                   carry, and comparing an indented single document against
 *                   compact chunks would flatter chunking for free.
 *   single-stored/  the same again with each event's DECODED half removed, which
 *                   is what a seed actually needs: installing strips `args`,
 *                   `eventName` and `decodeError` before anything reaches the
 *                   keeper (ADR-0060), so a published seed that carries them is
 *                   shipping bytes the client throws away.
 *   chunks-<n>/     a MANIFEST plus one gzipped document per <n>-ish events, each
 *                   carrying a contiguous block range and nothing else.
 *   chunks-stored-<n>/  the two ideas combined, which is the shape the
 *                   measurement ends up recommending.
 *
 * Everything is gzipped, because anything serving a 34 MB JSON document without
 * compression is not a candidate. Both forms are written to disk so the harness
 * serves BYTES rather than building them in the page: a measurement that
 * included the cost of generating the artifact would be measuring the publisher.
 *
 *   node prepare.mjs
 *
 * ## Why a chunk carries no `source`
 *
 * A `StreamFixture` carries the `IndexingSource` it was captured for, which for
 * this workload is three contracts and their ABIs: 62 KB of the document. Per
 * chunk that is duplication proportional to the chunk COUNT, so the shared
 * header lives ONCE in the manifest and a chunk is `{fromBlock, toBlock,
 * eventStream}`. The measurement reports what that header costs, so the other
 * choice can be priced rather than argued about.
 *
 * ## Why the ranges are contiguous and closed
 *
 * ADR-0063: installing writes through the keeper seam, which REFUSES a batch
 * that would leave a hole and treats an overlap as a tip re-scan. So chunk k
 * starts at chunk k-1's `toBlock + 1`, the first starts at the capture's own
 * `fromBlock`, and the last ends at the capture's own `lastToBlock` (above its
 * last event-bearing block, which is the coverage claim that stops a seeded
 * client re-scanning the quiet tail). A chunk is therefore installable by the
 * SAME install path as the whole document, with no special case, which is worth
 * knowing before anyone designs a second one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const FIXTURE = path.join(REPO, 'packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz');
const ASSETS = path.join(HERE, 'assets');

/** The chunk sizes measured. Two, so per-chunk overhead shows up as a TREND. */
const CHUNK_SIZES = [4000, 1000];

/**
 * ONE EVENT as the keeper stores it: the raw log the node reported, with the
 * decoded half gone.
 *
 * The same three keys `storedEventOf` drops (`@etherfold/core`'s internal strip,
 * and the copy of it in the seam spike's `install.mjs`). A publisher that emits
 * this shape is emitting what the client will store; a publisher that emits the
 * decoded half is paying transfer, parse and heap for fields that are deleted on
 * the way in and re-derived on the way out (ADR-0034).
 */
const storedEventOf = ({args: _a, eventName: _e, decodeError: _d, ...raw}) => raw;

const gz = fs.readFileSync(FIXTURE);
const text = zlib.gunzipSync(gz).toString('utf-8');
const fixture = JSON.parse(text);
const events = fixture.eventStream;

fs.rmSync(ASSETS, {recursive: true, force: true});
fs.mkdirSync(path.join(ASSETS, 'single'), {recursive: true});

// The single-document form is the committed bytes, copied verbatim. Not
// re-serialised: re-serialising would measure this script's JSON writer rather
// than the artifact anybody would actually publish.
fs.writeFileSync(path.join(ASSETS, 'single', 'stream.json.gz'), gz);

// The same document, compact. `JSON.parse` then `JSON.stringify` is a faithful
// compaction here and not a re-encode: the file's BigInts are already the tagged
// `{"__bigint__": "..."}` OBJECTS, and nothing revives them, so every value
// round-trips as itself and only the whitespace goes.
fs.mkdirSync(path.join(ASSETS, 'single-compact'), {recursive: true});
const compactText = JSON.stringify(fixture);
const compactGz = zlib.gzipSync(compactText, {level: 9});
fs.writeFileSync(path.join(ASSETS, 'single-compact', 'stream.json.gz'), compactGz);

// The same document again, with every event's decoded half removed.
fs.mkdirSync(path.join(ASSETS, 'single-stored'), {recursive: true});
const storedText = JSON.stringify({...fixture, eventStream: events.map(storedEventOf)});
const storedGz = zlib.gzipSync(storedText, {level: 9});
fs.writeFileSync(path.join(ASSETS, 'single-stored', 'stream.json.gz'), storedGz);

const summary = {
	fixture: {
		events: events.length,
		rawBytes: Buffer.byteLength(text),
		gzipBytes: gz.length,
		compactRawBytes: Buffer.byteLength(compactText),
		compactGzipBytes: compactGz.length,
		storedRawBytes: Buffer.byteLength(storedText),
		storedGzipBytes: storedGz.length,
		fromBlock: fixture.provenance.fromBlock,
		lastToBlock: fixture.lastSync.lastToBlock,
		lastEventBlock: events[events.length - 1].blockNumber,
	},
	// What a chunk would ADD if it carried the fixture header instead of the
	// manifest carrying it once. Reported so the other design is priced.
	sharedHeaderRawBytes: Buffer.byteLength(
		JSON.stringify({
			format: fixture.format,
			provenance: fixture.provenance,
			source: fixture.source,
			lastSync: fixture.lastSync,
		}),
	),
	chunkSets: [],
};

/** Both chunk sets: as captured (decoded), and stripped to what the keeper stores. */
const CHUNK_SETS = [
	...CHUNK_SIZES.map((size) => ({size, stored: false, dir: `chunks-${size}`})),
	{size: 4000, stored: true, dir: 'chunks-stored-4000'},
];

for (const set of CHUNK_SETS) {
	const size = set.size;
	const dir = path.join(ASSETS, set.dir);
	fs.mkdirSync(dir, {recursive: true});

	/** Cut on BLOCK boundaries: a chunk whose range ends mid-block could not state one. */
	const groups = [];
	let current = [];
	for (let i = 0; i < events.length; i++) {
		const boundary = i > 0 && events[i - 1].blockNumber !== events[i].blockNumber;
		if (boundary && current.length >= size) {
			groups.push(current);
			current = [];
		}
		current.push(events[i]);
	}
	if (current.length > 0) groups.push(current);

	const chunks = [];
	let from = fixture.provenance.fromBlock;
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];
		const last = i === groups.length - 1;
		const toBlock = last ? fixture.lastSync.lastToBlock : group[group.length - 1].blockNumber;
		const file = `${String(i).padStart(4, '0')}.json.gz`;
		const body = JSON.stringify({fromBlock: from, toBlock, eventStream: set.stored ? group.map(storedEventOf) : group});
		const packed = zlib.gzipSync(body, {level: 9});
		fs.writeFileSync(path.join(dir, file), packed);
		chunks.push({file, fromBlock: from, toBlock, events: group.length, rawBytes: Buffer.byteLength(body), gzipBytes: packed.length});
		from = toBlock + 1;
	}

	// The shared header, ONCE. Deliberately NOT a frozen field list: two later
	// decisions (a seed's own identity, and what a client verifies before
	// folding) will add to this, and a shape that could not carry them would be
	// re-opened. `format` names the manifest's own shape so a reader can refuse
	// one it does not understand, exactly as `STREAM_FIXTURE_FORMAT` does.
	const manifest = {
		format: 1,
		fixtureFormat: fixture.format,
		provenance: fixture.provenance,
		source: fixture.source,
		lastSync: fixture.lastSync,
		coverage: {fromBlock: fixture.provenance.fromBlock, toBlock: fixture.lastSync.lastToBlock},
		chunks: chunks.map(({file, fromBlock, toBlock, events}) => ({file, fromBlock, toBlock, events})),
	};
	const manifestText = JSON.stringify(manifest);
	fs.writeFileSync(path.join(dir, 'manifest.json'), manifestText);

	summary.chunkSets.push({
		name: set.dir,
		size,
		stored: set.stored,
		chunks: chunks.length,
		manifestRawBytes: Buffer.byteLength(manifestText),
		totalRawBytes: chunks.reduce((n, c) => n + c.rawBytes, 0),
		totalGzipBytes: chunks.reduce((n, c) => n + c.gzipBytes, 0) + Buffer.byteLength(manifestText),
		largestChunkGzipBytes: Math.max(...chunks.map((c) => c.gzipBytes)),
		largestChunkRawBytes: Math.max(...chunks.map((c) => c.rawBytes)),
	});
}

fs.mkdirSync(path.join(HERE, 'results'), {recursive: true});
fs.writeFileSync(path.join(HERE, 'results', 'artifacts.json'), `${JSON.stringify(summary, null, 2)}\n`);

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
console.log(`single (as committed, indented): ${mb(summary.fixture.rawBytes)} raw, ${mb(summary.fixture.gzipBytes)} gzipped`);
console.log(`single (compact, publishable):   ${mb(summary.fixture.compactRawBytes)} raw, ${mb(summary.fixture.compactGzipBytes)} gzipped`);
console.log(`single (compact, STORED-only):   ${mb(summary.fixture.storedRawBytes)} raw, ${mb(summary.fixture.storedGzipBytes)} gzipped`);
for (const set of summary.chunkSets) {
	console.log(
		`${set.name}: ${set.chunks} chunks, ${mb(set.totalRawBytes)} raw, ${mb(set.totalGzipBytes)} gzipped ` +
			`(largest chunk ${mb(set.largestChunkGzipBytes)} gzipped), manifest ${(set.manifestRawBytes / 1024).toFixed(1)} KB`,
	);
}
console.log(`a chunk carrying the fixture header instead would add ${(summary.sharedHeaderRawBytes / 1024).toFixed(1)} KB EACH`);
