import {gzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {IndexerGeneration} from '../src/indexer.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import {serializeStreamSeed, STREAM_SEED_FORMAT, streamSeedPayloadOf, type StreamSeed} from '../src/stream/seed.js';
import {installStreamSeed, streamSeedPayloadFrom} from '../src/stream/seedInstall.js';
import {createSegmentedStream, type StreamCursorRecord, type StreamSegmentPort} from '../src/stream/segments.js';
import {STREAM_FIXTURE_FORMAT} from '../src/stream/fixture.js';
import type {ContextIdentifier, ExistingStream, StoredLastSync, StoredLogEvent} from '../src/types.js';
import {
	BRANCH_A,
	BRANCH_A_TIP,
	fakeChain,
	fakeProcessor,
	FINALITY,
	idOf,
	indexToTip,
	makeIndexer,
	makeLog,
	memorySegmentPort,
	memoryStream,
	nodeRefusingProvider,
	SOURCE,
	START_BLOCK,
} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// FETCHING A PUBLISHED SEED, AND INSTALLING IT THROUGH THE KEEPER SEAM
// ---------------------------------------------------------------------------
// The vertical slice: a list of locations in, an outcome out, and in between a
// run of ordinary `saveNewEvents` calls on the very `ExistingStream` a
// generation will be handed (ADR-0063). Two things it does NOT do, and both are
// asserted rather than assumed: it CHECKS nothing about the artifact (that is
// the admission task), and it never DESTROYS anything -- including on the
// refusal path, where the keeper's only read is a mutating one.
//
// Everything here runs against the segment port the segmentation rules
// themselves are asserted against (`utils/streamCacheWorld.ts`), so what an
// install writes is judged by what a real keeper would then hold and read back.
// The committed 31,332-event reference artifact is installed in
// `streamSeedInstallReference.test.ts`, on the same in-memory keeper.
// ---------------------------------------------------------------------------

const STREAM_CONFIG = resolveStreamConfig({finality: FINALITY});

/** Where the seed's events are, and a coverage claim that REACHES above them. */
const SEED_EVENTS: StoredLogEvent[] = [
	makeLog(100, '0xs100', 0),
	makeLog(100, '0xs100', 1),
	makeLog(102, '0xs102'),
	makeLog(104, '0xs104'),
	makeLog(110, '0xs110'),
	makeLog(112, '0xs112'),
];
/** Above the last event-bearing block (112), which is the point of a coverage claim. */
const COVERAGE_TO = 150;
/** The head the producer observed, well above what it captured. */
const HEAD_AT_CAPTURE = 1_000_000;

const REMOTE = 'https://seeds.example/stratagems.seed.json.gz';
/** No host at all: the artifact shipped inside the app's own build (story 12). */
const EMBEDDED = './stratagems.seed.json.gz';

/**
 * A context an ORDINARY indexing run wrote, rather than a literal.
 *
 * The publisher and the client are the same build in the deployment this
 * feature is for, so a real seed's stored context is exactly what a local run
 * produces -- which is also why nothing can tell a seeded stream from a
 * locally-indexed one (ADR-0067). Taking it from a run rather than writing one
 * down is what makes the load-path assertions below mean anything: a hand-made
 * context would fail `streamMatches` and every fold test would be asserting the
 * discard path.
 */
let ordinaryContext: ContextIdentifier | undefined;
async function contextOfAnOrdinaryRun(): Promise<ContextIdentifier> {
	if (ordinaryContext) return ordinaryContext;
	const stream = memoryStream();
	const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
	const {processor} = fakeProcessor();
	const indexer = makeIndexer(chain, processor, stream.keeper);
	await indexer.load();
	await indexToTip(indexer);
	ordinaryContext = (stream.cursor as StoredLastSync).context;
	return ordinaryContext;
}

async function seedOf(
	overrides: Partial<Pick<StreamSeed, 'coverage' | 'eventStream' | 'context' | 'chainHeadAtCapture'>> = {},
): Promise<StreamSeed> {
	return {
		format: STREAM_SEED_FORMAT,
		producer: {kind: 'capture', name: 'test/streamSeedInstall.test.ts', at: '2026-09-07T00:00:00.000Z'},
		chainHeadAtCapture: overrides.chainHeadAtCapture ?? HEAD_AT_CAPTURE,
		streamConfig: STREAM_CONFIG,
		// A LABEL, and this task verifies nothing: the digest check is the admission
		// task's, and writing a plausible value here would suggest otherwise.
		streamDigest: 'not-checked-until-the-admission-task',
		coverage: overrides.coverage ?? {fromBlock: START_BLOCK, toBlock: COVERAGE_TO},
		context: overrides.context ?? (await contextOfAnOrdinaryRun()),
		eventStream: overrides.eventStream ?? SEED_EVENTS,
	};
}

/** What a host serving the published `.gz` as OPAQUE bytes puts on the wire. */
function servedOpaque(seed: StreamSeed): Uint8Array {
	return new Uint8Array(gzipSync(Buffer.from(serializeStreamSeed(seed), 'utf-8')));
}

/**
 * What a host declaring `Content-Encoding: gzip` leaves in the caller's hands:
 * the runtime already inflated it, so `fetch` hands back the plain document.
 */
function servedTransparently(seed: StreamSeed): Uint8Array {
	return streamSeedPayloadOf(seed);
}

/** A fetch over a fixed routing table. A `Error` value is a location that cannot be reached. */
function servingFetch(routes: Record<string, Uint8Array | Error>) {
	const asked: string[] = [];
	const get = (async (input: unknown) => {
		const url = String(input);
		asked.push(url);
		const served = routes[url];
		if (served === undefined) {
			return new Response('no such artifact', {status: 404, statusText: 'Not Found'});
		}
		if (served instanceof Error) {
			throw served;
		}
		// re-wrapped so the chunk is a view over an `ArrayBuffer`, which is what a
		// `Response` body is typed to take
		return new Response(new Uint8Array(served), {status: 200});
	}) as typeof globalThis.fetch;
	return {asked, get};
}

/** A keeper over a fresh subtree, with the rows it holds. */
function freshKeeper() {
	const {port, rows} = memorySegmentPort();
	return {port, rows, keeper: createSegmentedStream<Abi>(port)};
}

/** The stored rows as text, so "nothing changed" is one comparison rather than a walk. */
function snapshotOf(rows: Map<string, unknown>): string {
	return JSON.stringify([...rows.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** The cursor record the keeper wrote, read from the rows rather than through the seam. */
function cursorRecord(rows: Map<string, unknown>): StreamCursorRecord<Abi> {
	return rows.get('cursor') as StreamCursorRecord<Abi>;
}

describe('one call fetches a seed from a list of locations and installs it', () => {
	it('reports an OUTCOME as data: where it came from, how far it reaches, and how much it wrote', async () => {
		const seed = await seedOf();
		const {keeper, rows} = freshKeeper();
		const {get, asked} = servingFetch({[REMOTE]: servedOpaque(seed)});

		const outcome = await installStreamSeed(keeper, [REMOTE], {
			source: SOURCE,
			streamConfig: STREAM_CONFIG,
			fetch: get,
		});

		expect(outcome).toEqual({
			status: 'installed',
			from: REMOTE,
			at: COVERAGE_TO,
			reachesBackTo: START_BLOCK,
			events: SEED_EVENTS.length,
			segments: 1,
		});
		expect(asked).toEqual([REMOTE]);
		expect([...rows.keys()].sort()).toEqual(['0', 'cursor']);
	});

	it('walks the ORDERED list past a mirror it cannot reach, and says which one it used', async () => {
		const seed = await seedOf();
		const {keeper} = freshKeeper();
		const {get, asked} = servingFetch({
			[REMOTE]: new TypeError('Failed to fetch'),
			'https://mirror.example/seed.json.gz': servedOpaque(seed),
		});

		const outcome = await installStreamSeed(keeper, [REMOTE, 'https://mirror.example/seed.json.gz'], {
			source: SOURCE,
			streamConfig: STREAM_CONFIG,
			fetch: get,
		});

		// logged and skipped, never thrown: one unreachable mirror must not decide
		// whether the app starts
		expect(outcome).toMatchObject({status: 'installed', from: 'https://mirror.example/seed.json.gz'});
		expect(asked).toEqual([REMOTE, 'https://mirror.example/seed.json.gz']);
	});

	it('reaches a BUILD-EMBEDDED artifact at a relative, hostless path listed LAST', async () => {
		// The shape the reference deployment ships (ADR-0066): the rolling remote
		// first, the copy that arrived in the same delivery as the code last. It
		// needs no host, no TLS relationship and no trust decision separate from the
		// app's own -- and a relative path is exactly what a location type can
		// quietly fail to accept, which is why it is asserted rather than assumed.
		const seed = await seedOf();
		const {keeper} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: new TypeError('Failed to fetch'), [EMBEDDED]: servedOpaque(seed)});

		const outcome = await installStreamSeed(keeper, [REMOTE, EMBEDDED], {
			source: SOURCE,
			streamConfig: STREAM_CONFIG,
			fetch: get,
		});

		expect(outcome).toMatchObject({status: 'installed', from: EMBEDDED, at: COVERAGE_TO});
	});

	it('takes a single location as readily as a list', async () => {
		const seed = await seedOf();
		const {keeper} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});

		expect(
			await installStreamSeed(keeper, REMOTE, {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get}),
		).toMatchObject({status: 'installed', from: REMOTE});
	});
});

describe('what is refused, and what a refusal costs', () => {
	it('NO LOCATIONS at all is its own reason, and asks nothing of the network', async () => {
		const {keeper, rows} = freshKeeper();
		const {get, asked} = servingFetch({});

		expect(await installStreamSeed(keeper, [], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get})).toEqual({
			status: 'not-installed',
			reason: 'no-locations',
		});
		expect(asked).toEqual([]);
		expect(rows.size).toBe(0);
	});

	it('reports every location being unreachable as data, rather than raising the last failure', async () => {
		const {keeper, rows} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: new TypeError('Failed to fetch')});

		expect(
			await installStreamSeed(keeper, [REMOTE, 'https://gone.example/seed.json.gz'], {
				source: SOURCE,
				streamConfig: STREAM_CONFIG,
				fetch: get,
			}),
		).toEqual({status: 'not-installed', reason: 'unreachable'});
		expect(rows.size).toBe(0);
	});

	it('an HTTP error is a location that did not answer, not a document', async () => {
		const {keeper} = freshKeeper();
		// nothing is routed, so the fake host answers 404 with an HTML-ish body: a
		// loader that read the body as a document would report an unreadable FORMAT
		// and hide the fact that this mirror is simply not serving the artifact
		const {get} = servingFetch({});

		expect(
			await installStreamSeed(keeper, [REMOTE], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get}),
		).toEqual({status: 'not-installed', reason: 'unreachable'});
	});

	it('an UNREADABLE FORMAT is a refusal reason, not a throw out of the parser', async () => {
		const {keeper, rows} = freshKeeper();
		// a CAPTURE handed to the seed reader: the two documents have their own
		// format numbers precisely so this is a refusal rather than a half-parse
		const fixtureShaped = new TextEncoder().encode(JSON.stringify({format: STREAM_FIXTURE_FORMAT, eventStream: []}));
		const {get} = servingFetch({[REMOTE]: fixtureShaped, [EMBEDDED]: new TextEncoder().encode('{ truncated')});

		expect(
			await installStreamSeed(keeper, [REMOTE, EMBEDDED], {
				source: SOURCE,
				streamConfig: STREAM_CONFIG,
				fetch: get,
			}),
		).toEqual({status: 'not-installed', reason: 'unreadable-format'});
		expect(rows.size).toBe(0);
	});

	it('a seed that does not REACH BACK to the block this client reads from is refused', async () => {
		// Refused rather than ranked lower, which is where a stream's selection
		// differs from a snapshot's: its coverage start becomes the stream's
		// `startBlock`, and a stream starting above the block the client asks from is
		// CLEARED by the first load -- so installing it would be writing something
		// designed to be deleted.
		const tooLate = await seedOf({coverage: {fromBlock: START_BLOCK + 1, toBlock: COVERAGE_TO}});
		const {keeper, rows} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(tooLate)});

		expect(
			await installStreamSeed(keeper, [REMOTE], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get}),
		).toEqual({status: 'not-installed', reason: 'does-not-reach-back'});
		expect(rows.size).toBe(0);
	});

	it('walks PAST one that does not reach back to one that does', async () => {
		const tooLate = await seedOf({coverage: {fromBlock: START_BLOCK + 1, toBlock: COVERAGE_TO}});
		const reaching = await seedOf();
		const {keeper} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(tooLate), [EMBEDDED]: servedOpaque(reaching)});

		expect(
			await installStreamSeed(keeper, [REMOTE, EMBEDDED], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get}),
		).toMatchObject({status: 'installed', from: EMBEDDED});
	});

	it('honours the block the CALLER says it reads from, over the source`s own start', async () => {
		// A caller that will ask from lower than the source's earliest `startBlock`
		// states so; the default is the number a fresh generation's `load()` uses.
		const seed = await seedOf();
		const {keeper} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});

		expect(
			await installStreamSeed(keeper, [REMOTE], {
				source: SOURCE,
				streamConfig: STREAM_CONFIG,
				reachBackTo: START_BLOCK - 1,
				fetch: get,
			}),
		).toEqual({status: 'not-installed', reason: 'does-not-reach-back'});
	});
});

describe('how the published GZIPPED document becomes an envelope', () => {
	it('inflates an OPAQUE `.gz` itself, which is what a real host serves', async () => {
		const seed = await seedOf();
		const {keeper, rows} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});

		expect(
			await installStreamSeed(keeper, [REMOTE], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get}),
		).toMatchObject({status: 'installed'});
		expect(cursorRecord(rows).lastToBlock).toBe(COVERAGE_TO);
	});

	it('accepts a body the TRANSPORT already decoded (`Content-Encoding: gzip`), landing identically', async () => {
		const seed = await seedOf();
		const opaque = freshKeeper();
		const transparent = freshKeeper();

		await installStreamSeed(opaque.keeper, [REMOTE], {
			source: SOURCE,
			streamConfig: STREAM_CONFIG,
			fetch: servingFetch({[REMOTE]: servedOpaque(seed)}).get,
		});
		await installStreamSeed(transparent.keeper, [REMOTE], {
			source: SOURCE,
			streamConfig: STREAM_CONFIG,
			fetch: servingFetch({[REMOTE]: servedTransparently(seed)}).get,
		});

		// ADR-0066 makes the hash transport-invariant precisely so the arrangement
		// decides nothing; what must be true is that both arrangements end at the
		// same stream.
		expect(snapshotOf(transparent.rows)).toEqual(snapshotOf(opaque.rows));
	});

	it('holds the DECOMPRESSED payload octets in both arrangements, which is the domain a hash is over', async () => {
		// The pin the admission task's integrity check inherits (ADR-0066): the
		// octets after any transfer decoding and before `JSON.parse`, never the
		// gzipped file and never a re-serialised parse. Detected from the gzip magic
		// number rather than from a header, because a runtime that decoded
		// transparently removes `Content-Encoding` from what a script can see.
		const seed = await seedOf();
		const published = streamSeedPayloadOf(seed);

		expect(Buffer.from(await streamSeedPayloadFrom(servedOpaque(seed)))).toEqual(Buffer.from(published));
		expect(Buffer.from(await streamSeedPayloadFrom(servedTransparently(seed)))).toEqual(Buffer.from(published));
	});
});

describe('the three block rules, asserted through what they cause', () => {
	it('reaches back to the CAPTURE`s own fromBlock, so the first load serves it instead of clearing it', async () => {
		const seed = await seedOf();
		const {keeper, rows} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});
		await installStreamSeed(keeper, [REMOTE], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get});

		// what a fresh generation's `load()` asks for
		const fetched = await keeper.fetchFrom(SOURCE, START_BLOCK);

		expect(fetched).toBeDefined();
		expect(rows.size).toBeGreaterThan(0);
		expect(cursorRecord(rows).startBlock).toBe(START_BLOCK);
	});

	it('claims the coverage END, above the last event-bearing block', async () => {
		const seed = await seedOf();
		const {keeper, rows} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});
		await installStreamSeed(keeper, [REMOTE], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get});

		const fetched = await keeper.fetchFrom(SOURCE, START_BLOCK);

		// a quiet range moves the cursor without adding a row, so the rows cannot say
		// how far the stream REACHES: cut this short and the client re-scans every
		// quiet block at the end of the capture
		expect(fetched?.lastSync.lastToBlock).toBe(COVERAGE_TO);
		expect(SEED_EVENTS[SEED_EVENTS.length - 1].blockNumber).toBeLessThan(COVERAGE_TO);
		expect(cursorRecord(rows).latestBlock).toBe(HEAD_AT_CAPTURE);
	});

	it('is not DECLINED at any batch: every event is stored once, in stream order', async () => {
		const seed = await seedOf();
		const {keeper, rows} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});

		const outcome = await installStreamSeed(keeper, [REMOTE], {
			source: SOURCE,
			streamConfig: STREAM_CONFIG,
			maxEventsPerBatch: 2,
			fetch: get,
		});

		const fetched = await keeper.fetchFrom(SOURCE, START_BLOCK);
		expect(fetched?.eventStream.map(idOf)).toEqual(SEED_EVENTS.map(idOf));
		// one segment per accepted save, and a declined one would leave the count
		// short with the events silently missing
		expect(outcome).toMatchObject({status: 'installed', segments: 3});
		expect(cursorRecord(rows).nextOrdinal).toBe(3);
	});

	it('cuts batches on BLOCK boundaries, so no segment holds half a block', async () => {
		const seed = await seedOf();
		const {keeper, rows} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});
		await installStreamSeed(keeper, [REMOTE], {
			source: SOURCE,
			streamConfig: STREAM_CONFIG,
			maxEventsPerBatch: 2,
			fetch: get,
		});

		// nothing in the keeper requires it, but a segment holding half a block is a
		// segment whose cursor cannot honestly say which blocks it covers
		const seen = new Set<number>();
		for (const [key, value] of rows) {
			if (key === 'cursor') continue;
			const blocks = new Set((value as {events: StoredLogEvent[]}).events.map((event) => event.blockNumber));
			for (const block of blocks) {
				expect(seen.has(block)).toBe(false);
				seen.add(block);
			}
		}
	});

	it('writes the SEED`s own context, verbatim', async () => {
		// The client's own hashes would make the load path's `streamMatches` check
		// compare the client against itself, discarding a structural defence for
		// nothing.
		const published = {...(await contextOfAnOrdinaryRun()), processor: 'the-publisher-s-own'};
		const seed = await seedOf({context: published});
		const {keeper, rows} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});

		await installStreamSeed(keeper, [REMOTE], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get});

		expect(cursorRecord(rows).context).toEqual(published);
	});

	it('installs a seed with NO events as the cursor record alone', async () => {
		// A covered but QUIET range. Writing nothing at all would leave the subtree
		// empty and every one of those blocks re-scanned.
		const seed = await seedOf({eventStream: []});
		const {keeper, rows} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});

		expect(
			await installStreamSeed(keeper, [REMOTE], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get}),
		).toMatchObject({status: 'installed', events: 0, segments: 1});
		expect([...rows.keys()]).toEqual(['cursor']);
		expect(cursorRecord(rows)).toMatchObject({startBlock: START_BLOCK, lastToBlock: COVERAGE_TO, nextOrdinal: 0});
	});
});

describe('the install carries its own ADDRESS', () => {
	it('sets the RESOLVED config on the keeper before ANY call that addresses a subtree', async () => {
		// Including the emptiness probe, and not merely before the first write: a
		// keeper resolves the subtree from the source plus the config it was last
		// GIVEN, so a probe run before this would inspect one subtree while the
		// install wrote another (ADR-0067).
		const seed = await seedOf();
		const inner = freshKeeper();
		const calls: string[] = [];
		const keeper: ExistingStream<Abi> = {
			fetchFrom: (source, fromBlock) => {
				calls.push(`fetchFrom(${fromBlock})`);
				return inner.keeper.fetchFrom(source, fromBlock);
			},
			saveNewEvents: (source, stream) => {
				calls.push('saveNewEvents');
				return inner.keeper.saveNewEvents(source, stream);
			},
			clear: (source) => {
				calls.push('clear');
				return inner.keeper.clear(source);
			},
			setStreamConfig: (streamConfig) => {
				calls.push(`setStreamConfig(${streamConfig.finality})`);
			},
		};
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});

		await installStreamSeed(keeper, [REMOTE], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get});

		expect(calls[0]).toBe(`setStreamConfig(${FINALITY})`);
		// ...and the whole install is that seam and nothing else: no substrate
		// access, no new operation, and never a CLEAR, which is the one call that
		// could destroy what it was handed
		expect(new Set(calls)).toEqual(
			new Set([`setStreamConfig(${FINALITY})`, `fetchFrom(${Number.MAX_SAFE_INTEGER})`, 'saveNewEvents']),
		);
	});
});

describe('a subtree that is not EMPTY is refused, whatever it holds', () => {
	/**
	 * A stream this client indexed ITSELF, opened well ABOVE the seed's coverage
	 * start.
	 *
	 * This is the input the refusal must not destroy, and it is reached the
	 * ordinary way: index, lose the stream (a self-clear, an eviction) while the
	 * STATE survives, then index on. The second run resumes from the state's
	 * cursor, so the new subtree's `startBlock` is that resume point rather than
	 * the source's first block.
	 */
	async function locallyIndexedAbove() {
		const {port, rows} = memorySegmentPort();
		const keeper = createSegmentedStream<Abi>(port);
		const store = {};
		const chain = fakeChain([...BRANCH_A], BRANCH_A_TIP);
		const first = fakeProcessor(store);
		const indexer = makeIndexer(chain, first.processor, keeper);
		await indexer.load();
		await indexToTip(indexer);

		await keeper.clear(SOURCE);
		const later = [...BRANCH_A, makeLog(106, '0xa106'), makeLog(108, '0xa108')];
		chain.serve(later, 109);
		const second = makeIndexer(chain, fakeProcessor(store).processor, keeper);
		await second.load();
		await indexToTip(second);

		return {rows, keeper, startBlock: cursorRecord(rows).startBlock};
	}

	it('leaves a locally indexed stream INTACT: the refusal must not be what deletes it', async () => {
		// The sharpest trap in the install, and the reason the probe asks from a
		// block no stored cursor can start above: `fetchFrom` CLEARS the whole
		// subtree when the stored `startBlock` is above the block it was asked from,
		// and the seed's own (low) coverage start is exactly the number that fires
		// it. A refusal that deleted the stream it refused would be worse than the
		// install it declined to make.
		const {rows, keeper, startBlock} = await locallyIndexedAbove();
		expect(startBlock).toBeGreaterThan(START_BLOCK);
		const before = snapshotOf(rows);
		const seed = await seedOf();
		const {get, asked} = servingFetch({[REMOTE]: servedOpaque(seed)});

		const outcome = await installStreamSeed(keeper, [REMOTE], {
			source: SOURCE,
			streamConfig: STREAM_CONFIG,
			fetch: get,
		});

		expect(outcome).toEqual({status: 'not-installed', reason: 'subtree-not-empty'});
		expect(snapshotOf(rows)).toBe(before);
		// and it is still a STREAM, not merely bytes: it reads back from where it
		// reaches, cursor and segments together
		expect(await keeper.fetchFrom(SOURCE, startBlock)).toBeDefined();
		// nothing was even downloaded: the client already has a stream
		expect(asked).toEqual([]);
	});

	it('refuses a FOREIGN stream by the same bare test, with no discriminator', async () => {
		// A stream written by something else entirely. There is deliberately nothing
		// finer than "is it empty" (ADR-0067): a locally-indexed stream and this
		// seed's own prefix are indistinguishable through this seam, so any
		// discriminator would be a guess.
		const {rows, keeper} = freshKeeper();
		await keeper.saveNewEvents(SOURCE, {
			eventStream: [makeLog(100, '0xf100')],
			lastSync: {
				context: {source: [{startBlock: 0, hash: 'somebody-else'}], config: 'other', processor: 'other'},
				latestBlock: 200,
				lastFromBlock: START_BLOCK,
				lastToBlock: 120,
				unconfirmedBlocks: [],
			},
		});
		const before = snapshotOf(rows);
		const seed = await seedOf();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});

		expect(
			await installStreamSeed(keeper, [REMOTE], {source: SOURCE, streamConfig: STREAM_CONFIG, fetch: get}),
		).toEqual({status: 'not-installed', reason: 'subtree-not-empty'});
		expect(snapshotOf(rows)).toBe(before);
	});
});

describe('an install interrupted partway is CLEARED and redone, never resumed', () => {
	/** A port whose commits stop landing, which is what a closed tab does to an install. */
	function stoppingAfter(port: StreamSegmentPort<Abi>, saves: number): StreamSegmentPort<Abi> {
		let made = 0;
		return {
			...port,
			async commitSegmentWithCursor(source, allocate) {
				if (made++ >= saves) {
					throw new Error('the tab went away');
				}
				return port.commitSegmentWithCursor(source, allocate);
			},
		};
	}

	it('refuses the prefix through the ORDINARY entry point, leaves it intact, and lands identically once cleared', async () => {
		const seed = await seedOf();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});
		const options = {source: SOURCE, streamConfig: STREAM_CONFIG, maxEventsPerBatch: 2, fetch: get} as const;

		// the uninterrupted install, for comparison
		const whole = freshKeeper();
		await installStreamSeed(whole.keeper, [REMOTE], options);

		// and the interrupted one: two segments land and the third write never does
		const {port, rows} = memorySegmentPort();
		const interrupted = createSegmentedStream<Abi>(stoppingAfter(port, 2));
		await expect(installStreamSeed(interrupted, [REMOTE], options)).rejects.toThrow('the tab went away');
		const prefix = snapshotOf(rows);
		expect([...rows.keys()].sort()).toEqual(['0', '1', 'cursor']);

		// what the next visit finds: the same call, against the subtree the closed
		// tab left behind
		const keeper = createSegmentedStream<Abi>(port);
		expect(await installStreamSeed(keeper, [REMOTE], options)).toEqual({
			status: 'not-installed',
			reason: 'subtree-not-empty',
		});
		// a prefix is a contiguous stream with an honest cursor, so it is SAFE to
		// clear -- and refusing it must not be what clears it
		expect(snapshotOf(rows)).toBe(prefix);

		// the caller clears, deliberately, and installs again
		await keeper.clear(SOURCE);
		expect(await installStreamSeed(keeper, [REMOTE], options)).toMatchObject({status: 'installed', segments: 3});
		expect(snapshotOf(rows)).toBe(snapshotOf(whole.rows));
	});
});

describe('a generation folds the seeded stream with no node in the loop', () => {
	it('asks the node for `eth_chainId` and nothing else, and folds every event', async () => {
		const seed = await seedOf();
		const {keeper} = freshKeeper();
		const {get} = servingFetch({[REMOTE]: servedOpaque(seed)});
		await installStreamSeed(keeper, [REMOTE], {
			source: SOURCE,
			streamConfig: STREAM_CONFIG,
			maxEventsPerBatch: 2,
			fetch: get,
		});

		// A provider that THROWS on anything else, rather than a count taken
		// afterwards: a call that should not happen fails AT the call.
		const {calls, provider} = nodeRefusingProvider(SOURCE.chainId);
		const folding = fakeProcessor();
		const generation = new IndexerGeneration<Abi, string[]>(provider, folding.processor, SOURCE, {
			stream: {finality: FINALITY},
			keepStream: keeper,
		});
		(generation as any).logEventFetcher = {
			getLogEvents: async () => {
				throw new Error('THE NODE WAS CALLED: eth_getLogs');
			},
			reparse: (events: StoredLogEvent[]) => events.map((event) => ({...event})),
		};

		const lastSync = await generation.load();

		expect(calls).toEqual(['eth_chainId']);
		expect(folding.state).toEqual(SEED_EVENTS.map(idOf));
		// the fold picked up the stream's COVERAGE, so indexing resumes above the
		// capture rather than re-scanning its quiet tail
		expect(lastSync.lastToBlock).toBe(COVERAGE_TO);
	});
});
