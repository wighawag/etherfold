/**
 * Is the pinned seam REAL, or merely plausible?
 *
 * ONE question: can a published capture be installed into a stream keeper
 * through the PUBLIC keeper seam alone, and then folded by a generation with no
 * node in the loop and no re-scan from the start block?
 *
 * The answer is the deliverable (see the ADR and the README beside this file).
 * This file is the evidence, and it is prototype code: it asserts, it prints,
 * and it is not wired into anything shipped.
 *
 *   node docs/spikes/pin-the-seam-a-published-stream-arrives-through/spike.mjs
 *
 * `pnpm build` first: it imports the built `dist/` of `@etherfold/core` and
 * `@etherfold/browser` by relative path, which is what lets a spike outside the
 * workspace run against the real packages instead of a copy of them.
 *
 * WHY THE NODE HARNESS. The keeper is the real `keepStreamOnIndexedDB` on
 * `fake-indexeddb`, so the address arithmetic, the segment writes and the cursor
 * record are the shipped ones. The TIMINGS it prints are worthless and are
 * labelled as such: `fake-indexeddb` is a shim whose write cost is known to grow
 * quadratically (`work/notes/observations/fake-indexeddb-write-cost-grows-quadratically.md`),
 * and cost in a real browser is the next task's whole subject. What this spike
 * establishes is CORRECTNESS of the seam, not its price.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

await import(`${REPO}/packages/browser/node_modules/fake-indexeddb/auto/index.mjs`);
const {IndexerGeneration, parseStreamFixture, resolveStreamConfig, streamDigestOf} = await import(
	`${REPO}/packages/core/dist/index.js`
);
const {keepStreamOnIndexedDB, keyvalStore, streamAddress} = await import(`${REPO}/packages/browser/dist/index.js`);
const {installStreamSeed} = await import(`${HERE}/install.mjs`);

const FIXTURE = `${REPO}/packages/conformance-workload-stratagems/fixtures/stratagems-alpha1.stream.json.gz`;
/** The capture's own stream config, which the client must resolve to as well. */
const STREAM_CONFIG = {finality: 12};

function loadFixture() {
	return parseStreamFixture(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf-8'));
}

/**
 * A provider that answers the ONE call `load()` legitimately makes and refuses
 * every other, so "no node in the loop" is enforced rather than asserted
 * afterwards.
 */
function refusingProvider(chainId) {
	const calls = [];
	return {
		calls,
		provider: {
			async request({method}) {
				calls.push(method);
				if (method === 'eth_chainId') {
					return `0x${Number(chainId).toString(16)}`;
				}
				throw new Error(`THE NODE WAS CALLED: ${method}`);
			},
		},
	};
}

/** A processor that folds nothing but remembers exactly what it was handed. */
function countingProcessor() {
	const seen = {events: 0, blocks: 0, firstBlock: undefined, lastBlock: undefined, decoded: 0, raw: 0};
	return {
		seen,
		processor: {
			getVersionHash: () => 'spike-processor-v1',
			getCodeFingerprint: () => undefined,
			load: async () => undefined,
			process: async (eventStream) => {
				seen.blocks++;
				for (const event of eventStream) {
					seen.events++;
					seen.firstBlock ??= event.blockNumber;
					seen.lastBlock = event.blockNumber;
					if (event.eventName !== undefined || event.decodeError !== undefined) seen.decoded++;
					if (event.topics !== undefined && event.data !== undefined) seen.raw++;
				}
				return seen.events;
			},
			reset: async () => {},
			clear: async () => {},
		},
	};
}

/** Every key stored under one stream's subtree, so a claim about what was written is checkable. */
async function subtreeKeys(name, source, streamConfig) {
	const address = streamAddress(name, source, streamConfig);
	return keyvalStore()('readonly', (objectStore) => {
		const request = objectStore.getAllKeys(address.subtree);
		return new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	});
}

async function foldWith(name, source, keeper, chainId) {
	const {calls, provider} = refusingProvider(chainId);
	const {seen, processor} = countingProcessor();
	const generation = new IndexerGeneration(provider, processor, source, {stream: STREAM_CONFIG, keepStream: keeper});
	const lastSync = await generation.load();
	return {calls, seen, lastSync};
}

const results = {ranAt: new Date().toISOString(), node: process.version, cases: {}};
const say = (line) => {
	process.stdout.write(`${line}\n`);
};

// ---------------------------------------------------------------------------
// CASE 1: install through the seam, then fold with no node
// ---------------------------------------------------------------------------
{
	const fixture = loadFixture();
	const source = fixture.source;
	const streamConfig = resolveStreamConfig(STREAM_CONFIG);
	const name = 'seeded';

	const keeper = keepStreamOnIndexedDB(name);
	// The config half of the stream's identity, which the keeper is never handed
	// on a call. An indexer sets this in `reinit`; an installer has to do the same
	// or it writes the seed to a DIFFERENT subtree from the one the client reads.
	keeper.setStreamConfig(streamConfig);

	const started = Date.now();
	const outcome = await installStreamSeed(keeper, source, fixture, {maxEvents: 1000});
	const installMs = Date.now() - started;

	const keys = await subtreeKeys(name, source, streamConfig);
	const folded = await foldWith(name, source, keeper, source.chainId);

	const digest = streamDigestOf(source, streamConfig);
	results.cases.installThenFold = {
		fixtureEvents: fixture.eventStream.length,
		batches: outcome.batches,
		declinedAt: outcome.declinedAt,
		streamDigest: digest,
		keysWritten: keys.length,
		hasCursorRecord: keys.some((key) => key[3] === 'cursor'),
		segmentOrdinals: keys.filter((key) => typeof key[3] === 'number').length,
		nodeCalls: folded.calls,
		eventsFolded: folded.seen.events,
		blocksFolded: folded.seen.blocks,
		firstBlockFolded: folded.seen.firstBlock,
		lastBlockFolded: folded.seen.lastBlock,
		eventsCarryingADecodedHalf: folded.seen.decoded,
		eventsCarryingTheRawLog: folded.seen.raw,
		cursorAfterLoad: {
			lastFromBlock: folded.lastSync.lastFromBlock,
			lastToBlock: folded.lastSync.lastToBlock,
			latestBlock: folded.lastSync.latestBlock,
		},
		captureCoverage: {
			fromBlock: fixture.provenance.fromBlock,
			lastToBlock: fixture.lastSync.lastToBlock,
			lastEventBlock: fixture.eventStream[fixture.eventStream.length - 1].blockNumber,
		},
		installMsOnFakeIndexedDB: installMs,
	};

	const c = results.cases.installThenFold;
	say(`CASE 1  install through the seam, then fold with no node`);
	say(`  installed ${c.fixtureEvents} events as ${c.batches} segments + 1 cursor record (${c.keysWritten} keys)`);
	say(`  stream digest ${c.streamDigest}`);
	say(`  node calls during load: ${JSON.stringify(c.nodeCalls)}`);
	say(`  folded ${c.eventsFolded} events over ${c.blocksFolded} blocks, ${c.firstBlockFolded} -> ${c.lastBlockFolded}`);
	say(`  cursor after load: lastToBlock ${c.cursorAfterLoad.lastToBlock} (capture reached ${c.captureCoverage.lastToBlock})`);
	say(`  events reaching the processor with a decoded half: ${c.eventsCarryingADecodedHalf}`);

	const failures = [];
	if (c.declinedAt !== undefined) failures.push(`the keeper declined batch ${c.declinedAt}`);
	if (c.nodeCalls.some((method) => method !== 'eth_chainId')) failures.push('a node call other than eth_chainId');
	if (c.eventsFolded !== c.fixtureEvents) failures.push(`folded ${c.eventsFolded} of ${c.fixtureEvents} events`);
	if (c.cursorAfterLoad.lastToBlock !== c.captureCoverage.lastToBlock)
		failures.push(`cursor stopped at ${c.cursorAfterLoad.lastToBlock}, not the capture's ${c.captureCoverage.lastToBlock}`);
	if (c.eventsCarryingADecodedHalf !== c.fixtureEvents) failures.push('events reached the processor undecoded');
	if (!c.hasCursorRecord) failures.push('no cursor record beside the segments');
	c.failures = failures;
	say(failures.length === 0 ? `  OK\n` : `  FAILED: ${failures.join('; ')}\n`);
}

// ---------------------------------------------------------------------------
// CASE 2: a second generation over the same keeper, still with no node
// ---------------------------------------------------------------------------
{
	const fixture = loadFixture();
	const source = fixture.source;
	const streamConfig = resolveStreamConfig(STREAM_CONFIG);
	const name = 'seeded';

	const keeper = keepStreamOnIndexedDB(name);
	keeper.setStreamConfig(streamConfig);
	const folded = await foldWith(name, source, keeper, source.chainId);
	const keys = await subtreeKeys(name, source, streamConfig);

	results.cases.reload = {
		nodeCalls: folded.calls,
		eventsFolded: folded.seen.events,
		keysStillStored: keys.length,
		cursorLastToBlock: folded.lastSync.lastToBlock,
	};
	const c = results.cases.reload;
	say(`CASE 2  a fresh generation over the SAME keeper (the reload / second tab)`);
	say(`  node calls: ${JSON.stringify(c.nodeCalls)}; events folded: ${c.eventsFolded}; keys still stored: ${c.keysStillStored}`);
	const failures = [];
	if (c.nodeCalls.some((method) => method !== 'eth_chainId')) failures.push('a node call other than eth_chainId');
	if (c.eventsFolded !== fixture.eventStream.length) failures.push('the fold did not see the whole stream again');
	if (c.keysStillStored === 0) failures.push('the subtree was cleared');
	c.failures = failures;
	say(failures.length === 0 ? `  OK\n` : `  FAILED: ${failures.join('; ')}\n`);
}

// ---------------------------------------------------------------------------
// CASE 3: the NEGATIVE control -- a seed with no raw log is refused and cleared
// ---------------------------------------------------------------------------
// Until 2026-09-06 the committed capture itself was this case: it omitted `data`
// and `topics` as the encoded form of the `args` it already carried, which is
// sound for a REPLAY input and fatal for a SEED. `reparse` refuses an event with
// no raw log to decode (ADR-0034), and the load path answers that by CLEARING
// the subtree. A seed must carry what the node said; nothing else is a stream.
{
	const fixture = loadFixture();
	const source = fixture.source;
	const streamConfig = resolveStreamConfig(STREAM_CONFIG);
	const name = 'seeded-without-raw-logs';

	const stripped = {
		...fixture,
		eventStream: fixture.eventStream.map(({data: _data, topics: _topics, ...event}) => event),
	};

	const keeper = keepStreamOnIndexedDB(name);
	keeper.setStreamConfig(streamConfig);
	await installStreamSeed(keeper, source, stripped, {maxEvents: 1000});
	const keysBefore = await subtreeKeys(name, source, streamConfig);
	const folded = await foldWith(name, source, keeper, source.chainId);
	const keysAfter = await subtreeKeys(name, source, streamConfig);

	results.cases.strippedIsRefused = {
		keysAfterInstall: keysBefore.length,
		keysAfterLoad: keysAfter.length,
		eventsFolded: folded.seen.events,
		cursorLastToBlock: folded.lastSync.lastToBlock,
	};
	const c = results.cases.strippedIsRefused;
	say(`CASE 3  NEGATIVE CONTROL: a seed whose events carry no raw log`);
	say(`  keys after install: ${c.keysAfterInstall}; after load: ${c.keysAfterLoad}; events folded: ${c.eventsFolded}`);
	const failures = [];
	if (c.keysAfterInstall === 0) failures.push('nothing was installed, so the control proves nothing');
	if (c.keysAfterLoad !== 0) failures.push('the subtree was NOT cleared, so the raw-log rule did not fire');
	if (c.eventsFolded !== 0) failures.push('events were folded out of a stream that cannot be re-decoded');
	c.failures = failures;
	say(failures.length === 0 ? `  OK (refused and cleared, as ADR-0034 requires)\n` : `  FAILED: ${failures.join('; ')}\n`);
}

fs.mkdirSync(`${HERE}/results`, {recursive: true});
fs.writeFileSync(`${HERE}/results/seam.json`, `${JSON.stringify(results, null, 2)}\n`);

const failed = Object.values(results.cases).some((one) => one.failures.length > 0);
say(`results written to docs/spikes/pin-the-seam-a-published-stream-arrives-through/results/seam.json`);
if (failed) {
	say(`\nAT LEAST ONE CASE FAILED`);
	process.exitCode = 1;
}
