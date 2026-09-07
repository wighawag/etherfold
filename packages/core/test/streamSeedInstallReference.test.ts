import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {IndexerGeneration} from '../src/indexer.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import {parseStreamFixture} from '../src/stream/fixture.js';
import {installStreamSeed} from '../src/stream/seedInstall.js';
import {createSegmentedStream, type StreamCursorRecord} from '../src/stream/segments.js';
import type {LogEvent} from '../src/types.js';
import {memorySegmentPort, nodeRefusingProvider} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// THE COMMITTED REFERENCE ARTIFACT, INSTALLED AND FOLDED
// ---------------------------------------------------------------------------
// Everything else about the install is asserted on synthetic events; this is the
// case that runs it on a REAL published shape: the 31,332-log seed the producer
// task emitted from the launched game's capture, fetched the way a real host
// serves it (the `.gz` as opaque bytes) and folded with a provider that throws
// on any call but `eth_chainId`.
//
// It reads the artifact WHERE THE PRODUCER PUT IT, through a repo-root-relative
// URL, as core's repo-wide checks already do: the seed is a deliverable and a
// second copy of it would be a second thing to keep true.
//
// It runs on core's in-memory keeper and NOT under `fake-indexeddb`, on purpose:
// that shim's write cost grows as roughly `mutations^2`
// (`work/notes/observations/fake-indexeddb-write-cost-grows-quadratically.md`),
// so 31,332 events through it is not a slow test but an unfinishable one.
// ---------------------------------------------------------------------------

const ROOT = new URL('../../../', import.meta.url).pathname;
const FIXTURES = `${ROOT}packages/conformance-workload-stratagems/fixtures`;
/** Where the producer committed it (`ALPHA1.seedPath`). */
const SEED_FILE = `${FIXTURES}/stratagems-alpha1.seed.json.gz`;
/** The capture it was emitted from, read for the SOURCE the seed deliberately does not carry. */
const CAPTURE_FILE = `${FIXTURES}/stratagems-alpha1.stream.json.gz`;

/**
 * The config that capture was taken under (`ALPHA1_STREAM_CONFIG`).
 *
 * Stated rather than derived, and safe to state: the capture records
 * `streamConfigHashOf` of it, the seed's context carries that hash, and a wrong
 * number here fails the load path's `streamMatches` check -- so the fold below
 * would report an empty state instead of quietly passing.
 */
const STREAM_CONFIG = resolveStreamConfig({finality: 12});

/** What the producer's own suite pins about this artifact, restated as what an install must land on. */
const REFERENCE = {events: 31_332, from: 12_082_307, to: 23_400_000, lastEventBlock: 23_303_136};

const LOCATION = 'https://seeds.example/stratagems-alpha1.seed.json.gz';

/** A host serving the published file OPAQUE, which is the arrangement a real one produces. */
function servingTheCommittedFile() {
	const bytes = readFileSync(SEED_FILE);
	return (async () => new Response(bytes, {status: 200})) as typeof globalThis.fetch;
}

function theCapture() {
	return parseStreamFixture(gunzipSync(readFileSync(CAPTURE_FILE)).toString('utf-8'));
}

/** Folds nothing and remembers exactly what it was handed. */
function countingProcessor() {
	const seen = {events: 0, batches: 0, undecoded: 0, firstBlock: 0, lastBlock: 0};
	return {
		seen,
		processor: {
			getVersionHash: () => 'reference-install-test',
			getCodeFingerprint: () => undefined,
			load: async () => undefined,
			process: async (eventStream: LogEvent<Abi>[]) => {
				seen.batches++;
				for (const event of eventStream) {
					seen.events++;
					seen.firstBlock ||= event.blockNumber;
					seen.lastBlock = event.blockNumber;
					// re-decoded on the way through, against the source running NOW: a stored
					// event carries no decoded half at all, so an event reaching a processor
					// with neither an `eventName` nor a `decodeError` never went through the
					// decoder
					if (!('eventName' in event) && !('decodeError' in event)) seen.undecoded++;
				}
				return seen.events;
			},
			reset: async () => {},
			clear: async () => {},
		} as any,
	};
}

describe('the committed reference seed, installed through the keeper seam', () => {
	it('installs 31,332 real events and reports where it reached', async () => {
		const capture = theCapture();
		const {port, rows} = memorySegmentPort();
		const keeper = createSegmentedStream<Abi>(port);

		const outcome = await installStreamSeed(keeper, [LOCATION], {
			source: capture.source,
			streamConfig: STREAM_CONFIG,
			fetch: servingTheCommittedFile(),
		});

		expect(outcome).toMatchObject({
			status: 'installed',
			from: LOCATION,
			at: REFERENCE.to,
			reachesBackTo: REFERENCE.from,
			events: REFERENCE.events,
		});
		// the three block rules, on the real artifact: it reaches back to the
		// CAPTURE's own `fromBlock` (so the first load serves it rather than clearing
		// it), and it claims the coverage END, above its last event-bearing block
		const cursor = rows.get('cursor') as StreamCursorRecord<Abi>;
		expect(cursor.startBlock).toBe(REFERENCE.from);
		expect(cursor.lastToBlock).toBe(REFERENCE.to);
		expect(REFERENCE.lastEventBlock).toBeLessThan(cursor.lastToBlock);
		expect(cursor.nextOrdinal).toBe((outcome as {segments: number}).segments);
	});

	it('is then folded by a generation with `eth_chainId` as the ONLY call the node sees', async () => {
		const capture = theCapture();
		const {port} = memorySegmentPort();
		const keeper = createSegmentedStream<Abi>(port);
		await installStreamSeed(keeper, [LOCATION], {
			source: capture.source,
			streamConfig: STREAM_CONFIG,
			fetch: servingTheCommittedFile(),
		});

		// enforced by a provider that THROWS on anything else, rather than by
		// counting calls afterwards
		const {calls, provider} = nodeRefusingProvider(capture.source.chainId);
		const folding = countingProcessor();
		const generation = new IndexerGeneration<Abi, number>(provider, folding.processor, capture.source, {
			stream: {finality: 12},
			keepStream: keeper,
		});

		const lastSync = await generation.load();

		expect(calls).toEqual(['eth_chainId']);
		expect({
			events: folding.seen.events,
			undecoded: folding.seen.undecoded,
			lastBlock: folding.seen.lastBlock,
		}).toEqual({events: REFERENCE.events, undecoded: 0, lastBlock: REFERENCE.lastEventBlock});
		// and the fold resumes from where the CAPTURE reached, not from its last
		// event: the quiet blocks at the end of it are not re-scanned
		expect(lastSync.lastToBlock).toBe(REFERENCE.to);
	});
});
