import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import type {Abi} from 'abitype';
import {sourceHashesOf} from '../src/internal/engine/eventRanges.js';
import {resolveStreamConfig, streamConfigHashOf} from '../src/internal/engine/utils.js';
import {streamDigestOfSourceHashes} from '../src/stream/identity.js';
import {
	serializeStreamSeed,
	STREAM_SEED_FORMAT,
	streamSeedPayloadOf,
	type StreamSeed,
	type StreamSeedProducerKind,
} from '../src/stream/seed.js';
import {installStreamSeed, type NotInstalledReason} from '../src/stream/seedInstall.js';
import {createSegmentedStream} from '../src/stream/segments.js';
import type {IndexingSource, StoredLogEvent, UsedStreamConfig} from '../src/types.js';
import {makeLog, memorySegmentPort, SOURCE, START_BLOCK, streamOf} from './utils/streamCacheWorld.js';

// ---------------------------------------------------------------------------
// EVERY ADMISSION CHECK A CLIENT CAN MAKE ON ITS OWN, ALL OF THEM BEFORE THE
// FIRST WRITE
// ---------------------------------------------------------------------------
// The install itself is asserted in `streamSeedInstall.test.ts` and on the
// committed reference artifact in `streamSeedInstallReference.test.ts`. What is
// asserted HERE is what a client establishes about a downloaded document before
// it lets it become history: that it is for THIS stream (ADR-0064), that its
// bytes are the ones a build pinned when there is a pin (ADR-0066), that it does
// not contradict itself, and that it was not captured so close to the tip that
// it can describe a chain that did not happen (ADR-0065).
//
// Three properties run through all of it and are the reason these are one suite
// rather than four:
//
//  - every refusal is DATA with its reason, never a throw, because the reason is
//    the half an application renders;
//  - a refused seed writes NOTHING, asserted by reading the KEYSPACE rather than
//    by watching a spy, so a half-verified stream is unexpressible rather than a
//    state somebody has to define;
//  - and a refusal DELETES nothing either -- see the last describe, which is
//    about damage that does not happen.
//
// What is deliberately NOT here, and must not be added: chain anchoring, bloom
// consistency, publisher signing, and any attempt at OMISSION detection. A seed
// that simply leaves logs out is structurally perfect and passes every check
// below; detecting it needs the historical logs a public node will not serve,
// which is why the host a build names is trusted the way the build pipeline is
// (ADR-0065 as superseded in part by ADR-0066).
// ---------------------------------------------------------------------------

const A = '0x0000000000000000000000000000000000000001' as const;

const transfer = {
	type: 'event',
	name: 'Transfer',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'from', type: 'address'},
		{indexed: true, name: 'to', type: 'address'},
		{indexed: false, name: 'id', type: 'uint256'},
	],
} as const;

const approval = {
	type: 'event',
	name: 'Approval',
	anonymous: false,
	inputs: [
		{indexed: true, name: 'owner', type: 'address'},
		{indexed: true, name: 'approved', type: 'address'},
		{indexed: false, name: 'value', type: 'uint256'},
	],
} as const;

const sourceOf = (abi: readonly unknown[], overrides: Record<string, unknown> = {}): IndexingSource<Abi> =>
	({
		chainId: '1',
		contracts: [{address: A, abi, startBlock: START_BLOCK}],
		...overrides,
	}) as unknown as IndexingSource<Abi>;

/** What the client under test indexes: one contract, one event. */
const CLIENT_SOURCE = sourceOf([transfer]);
/** The SAME filter plus one more event: a publisher whose filter is a strict SUPERSET. */
const WIDER_SOURCE = sourceOf([transfer, approval]);
/** The same filter on another chain, which moves the block-0 SKELETON entry. */
const OTHER_CHAIN_SOURCE = sourceOf([transfer], {chainId: '10'});

const STREAM_CONFIG = resolveStreamConfig({finality: 12});

const COVERAGE = {fromBlock: START_BLOCK, toBlock: 150};
/** Far enough below the head its producer observed that a lost branch cannot be in it. */
const HEAD_AT_CAPTURE = 1_000_000;

const EVENTS: StoredLogEvent[] = [
	makeLog(100, '0xs100', 0),
	makeLog(100, '0xs100', 1),
	makeLog(102, '0xs102'),
	makeLog(110, '0xs110'),
];

const LOCATION = 'https://seeds.example/stratagems.seed.json.gz';

type SeedOverrides = Partial<Omit<StreamSeed, 'format' | 'producer'>> & {producerKind?: StreamSeedProducerKind};

/**
 * A seed AS A PUBLISHER WOULD EMIT ONE for `source` under `streamConfig`: its
 * stored context, its config hash and its digest label all agreeing.
 *
 * Built rather than written down, because the admission pass VERIFIES the label
 * against the document's own fields: a hand-written digest would make every case
 * below fail on internal incoherence long before it reached the check it is
 * about.
 */
function seedFor(
	source: IndexingSource<Abi>,
	streamConfig: UsedStreamConfig,
	overrides: SeedOverrides = {},
): StreamSeed {
	const context = overrides.context ?? {
		source: sourceHashesOf(source),
		config: streamConfigHashOf(streamConfig),
		processor: 'the-publisher-s-own',
	};
	const {producerKind, ...rest} = overrides;
	return {
		format: STREAM_SEED_FORMAT,
		producer: {
			kind: producerKind ?? 'capture',
			name: 'test/streamSeedAdmission.test.ts',
			at: '2026-09-07T00:00:00.000Z',
		},
		chainHeadAtCapture: HEAD_AT_CAPTURE,
		streamConfig,
		streamDigest: streamDigestOfSourceHashes(context.source, streamConfig),
		coverage: COVERAGE,
		context,
		eventStream: EVENTS,
		...rest,
	};
}

/** What a host serving the published `.gz` as OPAQUE bytes puts on the wire. */
const servedOpaque = (seed: StreamSeed) => new Uint8Array(gzipSync(Buffer.from(serializeStreamSeed(seed), 'utf-8')));
/** What `Content-Encoding: gzip` leaves in a caller's hands: the runtime already inflated it. */
const servedTransparently = (seed: StreamSeed) => streamSeedPayloadOf(seed);

/** One location, one document, and a record of whether it was ever asked for. */
function serving(bytes: Uint8Array) {
	const asked: string[] = [];
	const get = (async (input: unknown) => {
		asked.push(String(input));
		return new Response(new Uint8Array(bytes), {status: 200});
	}) as typeof globalThis.fetch;
	return {asked, get};
}

/** A keeper over a fresh subtree, with the rows it holds. */
function freshKeeper() {
	const {port, rows} = memorySegmentPort();
	return {port, rows, keeper: createSegmentedStream<Abi>(port)};
}

/** The stored rows as text, so "nothing changed" is one comparison rather than a walk. */
const snapshotOf = (rows: Map<string, unknown>) =>
	JSON.stringify([...rows.entries()].sort((a, b) => a[0].localeCompare(b[0])));

type Offered = {
	source?: IndexingSource<Abi>;
	streamConfig?: UsedStreamConfig;
	expectedContentHash?: string;
	bytes?: Uint8Array;
};

/** Offer a seed to a client with an EMPTY subtree, and hand back what it did and what it wrote. */
async function offer(seed: StreamSeed | undefined, options: Offered = {}) {
	const {keeper, rows} = freshKeeper();
	const bytes = options.bytes ?? servedOpaque(seed as StreamSeed);
	const {get, asked} = serving(bytes);
	const outcome = await installStreamSeed(keeper, [LOCATION], {
		source: options.source ?? CLIENT_SOURCE,
		streamConfig: options.streamConfig ?? STREAM_CONFIG,
		...(options.expectedContentHash === undefined ? {} : {expectedContentHash: options.expectedContentHash}),
		fetch: get,
	});
	return {outcome, rows, asked, keeper};
}

/** Refused, with this reason, and NOTHING written: the two halves of every case below. */
async function refuses(reason: NotInstalledReason, seed: StreamSeed | undefined, options: Offered = {}) {
	const {outcome, rows} = await offer(seed, options);
	expect(outcome).toEqual({status: 'not-installed', reason});
	// read the KEYSPACE, not a spy: what makes a half-verified stream
	// unexpressible is that the checks precede the first `saveNewEvents`, and only
	// the stored rows can say so
	expect([...rows.keys()]).toEqual([]);
	return outcome;
}

describe('identity: a seed that is not for THIS stream is refused, and the refusal names a DIRECTION', () => {
	it('admits a seed whose digest EQUALS this client`s, computed from the artifact`s own fields', async () => {
		const {outcome, rows} = await offer(seedFor(CLIENT_SOURCE, STREAM_CONFIG));

		expect(outcome).toMatchObject({status: 'installed', from: LOCATION, events: EVENTS.length});
		expect([...rows.keys()].sort()).toEqual(['0', 'cursor']);
	});

	it('VERIFIES the digest label rather than trusting it: a seed disagreeing with itself is refused', async () => {
		// The label is worth carrying -- a manifest can be rejected before a body is
		// downloaded -- and it costs nothing to distrust, because the client recomputes
		// it from the resolved config and stored context the artifact carries. A
		// document that lies about itself never reaches the comparison with the client.
		const lying = {...seedFor(CLIENT_SOURCE, STREAM_CONFIG), streamDigest: '00000000000000000000000000000000'};

		await refuses('incoherent', lying);
	});

	it('refuses a seed whose stored CONTEXT was written under a config it does not declare', async () => {
		// Internally inconsistent in the one way a producer's own emit-time check
		// exists to prevent: the events were captured under one config and the artifact
		// claims another, so it asserts a stream identity no client running that
		// capture can match.
		const seed = seedFor(CLIENT_SOURCE, STREAM_CONFIG, {
			context: {
				source: sourceHashesOf(CLIENT_SOURCE),
				config: streamConfigHashOf(resolveStreamConfig({finality: 64})),
				processor: 'the-publisher-s-own',
			},
		});

		await refuses('incoherent', seed);
	});

	it('refuses a seed whose stored context is not a LIST of entries, rather than throwing out of the loader', async () => {
		// The identity check ITERATES these entries to recompute the publisher's digest,
		// so a document carrying something else reached `entries.map` and left a
		// `TypeError` escaping a PUBLIC entry point -- an unhandled rejection on an app's
		// boot path instead of the explanation ADR-0064 exists to give it. Every refusal
		// is data, including this one, and the door is where the shape is typed.
		const notAList = {
			...seedFor(CLIENT_SOURCE, STREAM_CONFIG),
			context: {source: 'not-a-list', config: streamConfigHashOf(STREAM_CONFIG), processor: ''},
		} as unknown as StreamSeed;

		await refuses('unreadable-format', notAList);
	});

	it('names a CHAIN mismatch separately, because "an entry was added at block 0" is useless', async () => {
		// Structurally subsumed by the digest -- `chainId` and `genesisHash` are hashed
		// into the block-0 skeleton entry -- and reported separately anyway, which is
		// the whole point of the seed DECLARING its chain (ADR-0064).
		const seed = seedFor(OTHER_CHAIN_SOURCE, STREAM_CONFIG, {chain: {chainId: '10'}});

		await refuses('chain-mismatch', seed);
	});

	it('falls back to a DIRECTION for a foreign chain the seed did not declare', async () => {
		// The reference artifact predates the declaration, so this is the ordinary
		// case for anything published before it: the digest still refuses, and only
		// the sharper reason is unavailable. It must never read as "admitted".
		const seed = seedFor(OTHER_CHAIN_SOURCE, STREAM_CONFIG);

		await refuses('seed-covers-less', seed);
	});

	it('names a STREAM-CONFIG mismatch separately, since the config decides what is STORED', async () => {
		const seed = seedFor(CLIENT_SOURCE, resolveStreamConfig({finality: 64}));

		await refuses('stream-config', seed);
	});

	it('refuses a publisher SUPERSET as `seed-covers-more`, even though the stream verdict calls it reusable', async () => {
		// The surprising half of ADR-0064. `verdictOn` runs the stream half with
		// `removalInvalidates: false`, so the publisher's extra entries are IGNORED and
		// the stream reads VALID -- a tolerance about a LOCAL cache whose extra events
		// the client fetched itself. A DOWNLOADED superset is not that: its extra
		// events would be stored under the CLIENT's digest, re-folded by every later
		// generation, and handed to a processor implementing `handleUnparsedEvent`.
		const seed = seedFor(WIDER_SOURCE, STREAM_CONFIG);

		const outcome = await refuses('seed-covers-more', seed, {source: CLIENT_SOURCE});

		// and the outcome carries the direction and NOTHING ELSE: the loader reports
		// which way the two disagree and never infers "you are out of date", which it
		// cannot know -- a deliberately narrower client is indistinguishable from a
		// stale one, and only the application can tell them apart
		expect(Object.keys(outcome).sort()).toEqual(['reason', 'status']);
	});

	it('refuses a seed that LACKS what this client indexes as `seed-covers-less`', async () => {
		const seed = seedFor(CLIENT_SOURCE, STREAM_CONFIG);

		const outcome = await refuses('seed-covers-less', seed, {source: WIDER_SOURCE});

		expect(Object.keys(outcome).sort()).toEqual(['reason', 'status']);
	});

	it('asserts BOTH directions against the same pair of sources, so neither is an artefact of its fixture', async () => {
		const narrow = await offer(seedFor(CLIENT_SOURCE, STREAM_CONFIG), {source: WIDER_SOURCE});
		const wide = await offer(seedFor(WIDER_SOURCE, STREAM_CONFIG), {source: CLIENT_SOURCE});

		expect([narrow.outcome, wide.outcome]).toEqual([
			{status: 'not-installed', reason: 'seed-covers-less'},
			{status: 'not-installed', reason: 'seed-covers-more'},
		]);
	});
});

describe('integrity: an OPTIONAL content hash, over the decompressed octets', () => {
	/** What the producer would have PRINTED, recomputed with an INDEPENDENT implementation. */
	const printedFor = (seed: StreamSeed) =>
		`sha256:${createHash('sha256').update(streamSeedPayloadOf(seed)).digest('hex')}`;

	it('admits an install with NO expected hash, because a ROLLING artifact cannot have one pinned', async () => {
		// The default and the ordinary case (ADR-0066): a build cannot know the hash of
		// an artifact republished every hour, and `bootstrapFromSnapshot`, the path
		// that already ships and works, verifies no hash at all.
		const {outcome} = await offer(seedFor(CLIENT_SOURCE, STREAM_CONFIG));

		expect(outcome).toMatchObject({status: 'installed'});
	});

	it('admits a seed whose bytes MATCH the hash the caller pinned', async () => {
		const seed = seedFor(CLIENT_SOURCE, STREAM_CONFIG);

		const {outcome} = await offer(seed, {expectedContentHash: printedFor(seed)});

		expect(outcome).toMatchObject({status: 'installed'});
	});

	it('refuses a seed whose bytes do NOT match, and writes nothing', async () => {
		const seed = seedFor(CLIENT_SOURCE, STREAM_CONFIG);
		const somebodyElses = seedFor(CLIENT_SOURCE, STREAM_CONFIG, {coverage: {fromBlock: START_BLOCK, toBlock: 151}});

		await refuses('integrity-mismatch', seed, {expectedContentHash: printedFor(somebodyElses)});
	});

	it('is TRANSPORT-INVARIANT: opaque and `Content-Encoding: gzip` land on the same pin', async () => {
		// The whole reason the domain is the DECOMPRESSED octets, so it is asserted
		// rather than assumed: GitHub Pages, CloudFront, Cloudflare and IPFS gateways
		// each decide transfer encoding themselves, and a rule forbidding one of them
		// is a rule a publisher cannot enforce and a client cannot rely on.
		const seed = seedFor(CLIENT_SOURCE, STREAM_CONFIG);
		const pin = printedFor(seed);

		const opaque = await offer(seed, {expectedContentHash: pin, bytes: servedOpaque(seed)});
		const transparent = await offer(seed, {expectedContentHash: pin, bytes: servedTransparently(seed)});

		expect([opaque.outcome, transparent.outcome].map((outcome) => outcome.status)).toEqual(['installed', 'installed']);
		expect(snapshotOf(transparent.rows)).toBe(snapshotOf(opaque.rows));
	});

	it('RAISES on a pin that is not in the rendering a producer prints, before anything is fetched', async () => {
		// A malformed pin is a mistake in the CALLER's own source, not an ordinary
		// condition: reported as data it would arrive as an integrity mismatch from
		// every location, pointing a developer at the artifact and the host when the
		// fault is in their build. The bare-hex form is the one this actually catches,
		// since that is what an earlier, withdrawn rendering said.
		const seed = seedFor(CLIENT_SOURCE, STREAM_CONFIG);
		const {get, asked} = serving(servedOpaque(seed));
		const bareHex = createHash('sha256').update(streamSeedPayloadOf(seed)).digest('hex');

		await expect(
			installStreamSeed(freshKeeper().keeper, [LOCATION], {
				source: CLIENT_SOURCE,
				streamConfig: STREAM_CONFIG,
				expectedContentHash: bareHex,
				fetch: get,
			}),
		).rejects.toThrow('not a stream seed content hash');
		expect(asked).toEqual([]);
	});
});

describe('structural coherence: each rule with its own failing artifact', () => {
	const eventsWith = (events: StoredLogEvent[]) => seedFor(CLIENT_SOURCE, STREAM_CONFIG, {eventStream: events});

	it('refuses OUT-OF-ORDER pairs', async () => {
		await refuses('incoherent', eventsWith([makeLog(100, '0xs100', 1), makeLog(100, '0xs100', 0)]));
	});

	it('refuses a BLOCK NUMBER that goes backwards, which is the other half of the ordering rule', async () => {
		// The case above varies `logIndex` inside ONE block, so it exercises only the
		// second half of ADR-0065's rule ("`(blockNumber, logIndex)` strictly
		// increasing") and leaves the first ("block numbers non-decreasing") unpinned:
		// deleting the block-number comparison keeps every other case green.
		await refuses('incoherent', eventsWith([makeLog(102, '0xs102', 0), makeLog(100, '0xs100', 0)]));
	});

	it('refuses an ENTRY THAT IS NOT AN EVENT, rather than comparing against `undefined`', async () => {
		// Every rule in the pass is a COMPARISON, and a comparison against `undefined`
		// is FALSE rather than a refusal -- so an event missing its `blockNumber` would
		// satisfy coverage containment, ordering and the duplicate rule ALL vacuously
		// and be INSTALLED. A stored stream is re-folded by every later generation, so
		// that install is permanent. The shape is checked before anything is compared.
		const noBlockNumber = {blockHash: '0xs100', logIndex: 0} as unknown as StoredLogEvent;
		await refuses('incoherent', eventsWith([noBlockNumber]));

		const notAnObject = null as unknown as StoredLogEvent;
		await refuses('incoherent', eventsWith([notAnObject]));

		const blockNumberAsText = {...makeLog(100, '0xs100', 0), blockNumber: '100'} as unknown as StoredLogEvent;
		await refuses('incoherent', eventsWith([blockNumberAsText]));
	});

	it('refuses a block number carrying TWO block hashes, which is an unreconciled reorg', async () => {
		await refuses('incoherent', eventsWith([makeLog(100, '0xs100', 0), makeLog(100, '0xother', 1)]));
	});

	it('refuses a DUPLICATE (blockHash, logIndex), even at two different block numbers', async () => {
		// The shape the ordering rule cannot see: both events are in order and each
		// block number carries one hash, and the same log is still in the stream twice.
		await refuses('incoherent', eventsWith([makeLog(100, '0xsame', 0), makeLog(101, '0xsame', 0)]));
	});

	it('refuses an event OUTSIDE the coverage the artifact claims', async () => {
		await refuses('incoherent', eventsWith([makeLog(100, '0xs100', 0), makeLog(COVERAGE.toBlock + 1, '0xabove')]));
	});

	it('refuses a RETRACTION that contradicts the declared producer', async () => {
		// A `capture` fetches canonical historical ranges and cannot produce one, so a
		// seed that says `capture` and carries a `removed` event contradicts its own
		// provenance. That is sharper than a blanket ban -- and the ban is what the
		// next case exists to prove was not written.
		const applied = makeLog(100, '0xs100', 0);
		await refuses('incoherent', eventsWith([applied, {...applied, removed: true}]));
	});

	it('refuses a retraction with NO application of the same coordinate before it', async () => {
		const orphan = {...makeLog(100, '0xs100', 0), removed: true};
		await refuses(
			'incoherent',
			seedFor(CLIENT_SOURCE, STREAM_CONFIG, {eventStream: [orphan], producerKind: 'stored-stream'}),
		);
	});

	it('ADMITS a legitimate retraction from a producer that admits one', async () => {
		// A seed derived from a server's append-only emission stream legitimately
		// carries apply/retract pairs (ADR-0006), and folding one is correct behaviour
		// rather than damage: a replay HONOURS the verdicts the stream carries
		// (ADR-0042). A blanket ban on `removed` would forbid this artifact, which is
		// why the rule is stated against the DECLARATION instead.
		const applied = makeLog(102, '0xs102', 0);
		const seed = seedFor(CLIENT_SOURCE, STREAM_CONFIG, {
			producerKind: 'stored-stream',
			eventStream: [makeLog(100, '0xs100', 0), applied, {...applied, removed: true}],
		});

		const {outcome} = await offer(seed);

		expect(outcome).toMatchObject({status: 'installed', events: 3});
	});

	it('admits the ordinary coherent capture, so the rules are not vacuously refusing everything', async () => {
		const {outcome} = await offer(eventsWith(EVENTS));

		expect(outcome).toMatchObject({status: 'installed'});
	});
});

describe('capture depth: a capture taken inside the reorg window is refused', () => {
	// The check most easily missed, because what it catches leaves NO trace: a
	// capture taken close to the tip can record a branch that later LOST and be
	// perfectly coherent while simply describing a chain that did not happen. It
	// needs no node -- the artifact carries the head its producer observed and the
	// client already has the resolved `finality` it runs under.
	//
	// It needs a SYNTHETIC artifact: the committed reference capture sits about
	// 27.5M blocks below its observed head, so it cannot exercise this.
	const atDepth = (depth: number) =>
		seedFor(CLIENT_SOURCE, STREAM_CONFIG, {chainHeadAtCapture: COVERAGE.toBlock + depth});

	it('refuses a capture ONE block shallower than finality', async () => {
		await refuses('inside-reorg-window', atDepth(STREAM_CONFIG.finality - 1));
	});

	it('admits one exactly `finality` blocks below the observed head', async () => {
		const {outcome} = await offer(atDepth(STREAM_CONFIG.finality));

		expect(outcome).toMatchObject({status: 'installed'});
	});

	it('refuses a capture claiming to reach ABOVE the head its producer observed', async () => {
		await refuses('inside-reorg-window', atDepth(-1));
	});

	it('reads the finality the CLIENT runs under, so a shallower client refuses what a deeper one takes', async () => {
		// Both sides run the same resolved config by then -- a differing one is already
		// a `stream-config` refusal -- so this is one number read from one place.
		const shallow = resolveStreamConfig({finality: 1});
		const seed = seedFor(CLIENT_SOURCE, shallow, {chainHeadAtCapture: COVERAGE.toBlock + 1});

		expect((await offer(seed, {streamConfig: shallow})).outcome).toMatchObject({status: 'installed'});
	});
});

describe('a refusal writes nothing and DELETES nothing', () => {
	it('leaves an EXISTING stream exactly as it was, and does not even download', async () => {
		// The property this whole family rests on, asserted on the input that actually
		// breaks: a subtree already holding a stream. The keeper's only read MUTATES --
		// `fetchFrom` CLEARS a subtree whose stored `startBlock` is above the block it
		// was asked from -- so a refusal path that inspected the stream before giving up
		// could delete the very history it declined to replace. The install inherits the
		// probe the previous task built (it asks from a block no cursor can start above)
		// and adds NO second inspection, which is what this asserts: the checks landed
		// here are reached only on a subtree that was already empty, so no seed a client
		// downloads can be what costs it its history.
		const {keeper, rows} = freshKeeper();
		await keeper.saveNewEvents(SOURCE, {
			eventStream: [makeLog(200, '0xlocal200')],
			lastSync: {
				context: {source: [{startBlock: 0, hash: 'indexed-here'}], config: 'local', processor: 'local'},
				latestBlock: 260,
				lastFromBlock: 200,
				lastToBlock: 250,
				unconfirmedBlocks: [],
			},
		});
		const before = snapshotOf(rows);
		// a seed that would fail on IDENTITY, so the refusal that does happen is the
		// one this ordering guarantees rather than an accident of the artifact
		const foreign = seedFor(WIDER_SOURCE, STREAM_CONFIG);
		const {get, asked} = serving(servedOpaque(foreign));

		const outcome = await installStreamSeed(keeper, [LOCATION], {
			source: CLIENT_SOURCE,
			streamConfig: STREAM_CONFIG,
			expectedContentHash: `sha256:${'0'.repeat(64)}`,
			fetch: get,
		});

		expect(outcome).toEqual({status: 'not-installed', reason: 'subtree-not-empty'});
		expect(snapshotOf(rows)).toBe(before);
		// segments and cursor still read back as a STREAM, not merely as bytes
		expect(streamOf(await keeper.fetchFrom(SOURCE, 200))).toBeDefined();
		expect(snapshotOf(rows)).toBe(before);
		// and nothing was fetched at all: a client that already holds a stream pays
		// no download to be told it may not install over it
		expect(asked).toEqual([]);
	});

	it('writes NOTHING on every refusal reason a fetched document can produce', async () => {
		// One table rather than an assertion buried in each case above, because what
		// is being claimed is a property of the PATH and not of any one check: every
		// mandatory check precedes the first `saveNewEvents`, so there is no
		// half-installed seed to define.
		const applied = makeLog(100, '0xs100', 0);
		const cases: {reason: NotInstalledReason; offered: Offered; seed?: StreamSeed}[] = [
			{reason: 'unreadable-format', offered: {bytes: new TextEncoder().encode('{ truncated')}},
			{
				reason: 'integrity-mismatch',
				seed: seedFor(CLIENT_SOURCE, STREAM_CONFIG),
				offered: {expectedContentHash: `sha256:${'0'.repeat(64)}`},
			},
			{
				reason: 'chain-mismatch',
				seed: seedFor(OTHER_CHAIN_SOURCE, STREAM_CONFIG, {chain: {chainId: '10'}}),
				offered: {},
			},
			{reason: 'stream-config', seed: seedFor(CLIENT_SOURCE, resolveStreamConfig({finality: 64})), offered: {}},
			{reason: 'seed-covers-more', seed: seedFor(WIDER_SOURCE, STREAM_CONFIG), offered: {}},
			{reason: 'seed-covers-less', seed: seedFor(CLIENT_SOURCE, STREAM_CONFIG), offered: {source: WIDER_SOURCE}},
			{
				reason: 'does-not-reach-back',
				seed: seedFor(CLIENT_SOURCE, STREAM_CONFIG, {coverage: {fromBlock: START_BLOCK + 1, toBlock: 150}}),
				offered: {},
			},
			{
				reason: 'incoherent',
				seed: seedFor(CLIENT_SOURCE, STREAM_CONFIG, {eventStream: [applied, {...applied, removed: true}]}),
				offered: {},
			},
			{
				reason: 'inside-reorg-window',
				seed: seedFor(CLIENT_SOURCE, STREAM_CONFIG, {chainHeadAtCapture: COVERAGE.toBlock}),
				offered: {},
			},
		];

		const seen: {reason: NotInstalledReason; wrote: string[]}[] = [];
		for (const one of cases) {
			const {outcome, rows} = await offer(one.seed, one.offered);
			seen.push({
				reason: (outcome as {reason: NotInstalledReason}).reason,
				wrote: [...rows.keys()],
			});
		}

		expect(seen).toEqual(cases.map((one) => ({reason: one.reason, wrote: []})));
	});
});
