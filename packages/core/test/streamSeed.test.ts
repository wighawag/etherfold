import {createHash} from 'node:crypto';
import {gunzipSync, gzipSync} from 'node:zlib';
import type {Abi} from 'abitype';
import {describe, expect, it} from 'vitest';
import {sourceHashesOf} from '../src/internal/engine/eventRanges.js';
import {resolveStreamConfig} from '../src/internal/engine/utils.js';
import {STREAM_FIXTURE_FORMAT} from '../src/stream/fixture.js';
import {streamDigestOf, streamDigestOfSourceHashes} from '../src/stream/identity.js';
import {
	parseStreamSeed,
	serializeStreamSeed,
	STREAM_SEED_FORMAT,
	streamSeedContentHash,
	streamSeedPayloadOf,
	type StreamSeed,
} from '../src/stream/seed.js';
import type {IndexingSource, StoredLogEvent} from '../src/types.js';

// ---------------------------------------------------------------------------
// THE PUBLISHED SEED ENVELOPE
// ---------------------------------------------------------------------------
// A seed is what a client is handed by somebody else, so every property here is
// about establishing WHAT it is without trusting the host that served it: its
// own format number (so the wrong document is refused rather than half-parsed),
// its resolved config and its digest label (so the client recomputes the
// identity rather than believing it), and a content hash over a byte domain BOTH
// ends agree on (ADR-0066) -- which is a contract with the loader, so it is
// asserted here rather than left to each side's own helper.
// ---------------------------------------------------------------------------

const ERC20_ABI = [
	{
		type: 'event',
		name: 'Transfer',
		inputs: [
			{indexed: true, name: 'from', type: 'address'},
			{indexed: true, name: 'to', type: 'address'},
			{indexed: false, name: 'value', type: 'uint256'},
		],
	},
] as const satisfies Abi;

const TOKEN = '0x0000000000000000000000000000000000000abc' as const;

const SOURCE: IndexingSource<typeof ERC20_ABI> = {
	chainId: '8453',
	contracts: [{abi: ERC20_ABI, address: TOKEN, startBlock: 100}],
};

function storedEvent(blockNumber: number, logIndex: number): StoredLogEvent {
	return {
		blockNumber,
		blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
		transactionIndex: 0,
		removed: false,
		address: TOKEN,
		data: '0x00',
		topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
		transactionHash: `0x${logIndex.toString(16).padStart(64, '0')}`,
		logIndex,
		extra: undefined,
	} as StoredLogEvent;
}

function seedOf(overrides: Partial<StreamSeed> = {}): StreamSeed {
	const streamConfig = resolveStreamConfig({finality: 12});
	return {
		format: STREAM_SEED_FORMAT,
		producer: {
			kind: 'capture',
			name: 'test/streamSeed.test.ts',
			at: '2026-09-07T00:00:00.000Z',
		},
		chainHeadAtCapture: 1_000_000,
		streamConfig,
		streamDigest: streamDigestOf(SOURCE, streamConfig),
		coverage: {fromBlock: 100, toBlock: 220},
		context: {source: sourceHashesOf(SOURCE), config: 'cfg', processor: ''},
		eventStream: [storedEvent(101, 0), storedEvent(210, 3)],
		...overrides,
	};
}

describe('the seed envelope', () => {
	it('carries its OWN format number, which is not the fixture format', () => {
		// A seed is not a fixture: it carries the stored half only, a resolved
		// config and a digest label, and none of that is what format 2 describes.
		// Sharing the number would let each reader half-parse the other's document.
		expect(STREAM_SEED_FORMAT).not.toBe(STREAM_FIXTURE_FORMAT);
	});

	it('round-trips through its compact serialization', () => {
		const seed = seedOf();
		const text = serializeStreamSeed(seed);

		// COMPACT: the artifact is published, not read by hand, and the measurement
		// that chose this shape measured the compact one.
		expect(text.includes('\n')).toBe(false);
		expect(parseStreamSeed(text)).toEqual(seed);
	});

	it('refuses a document whose format it does not read, and a fixture is one such', () => {
		expect(() => parseStreamSeed(JSON.stringify({...seedOf(), format: STREAM_SEED_FORMAT + 1}))).toThrow(
			/unsupported stream seed format/,
		);
		expect(() => parseStreamSeed(JSON.stringify({format: STREAM_FIXTURE_FORMAT, eventStream: []}))).toThrow(
			/unsupported stream seed format/,
		);
		expect(() => parseStreamSeed('[]')).toThrow(/not a stream seed/);
	});

	it('refuses a seed missing what a client must check it against', () => {
		const {streamConfig: _dropped, ...withoutConfig} = seedOf();
		expect(() => parseStreamSeed(JSON.stringify(withoutConfig))).toThrow(/not a stream seed/);
	});
});

describe('the content hash a build pins', () => {
	it('is SHA-256 over the payload octets, self-describing about the algorithm', () => {
		const seed = seedOf();
		const payload = streamSeedPayloadOf(seed);
		const independent = createHash('sha256').update(payload).digest('hex');

		// Self-describing: a build pastes this literal, and a reader can tell which
		// function produced it without consulting a document.
		expect(streamSeedContentHash(payload)).toBe(`sha256:${independent}`);
		expect(streamSeedContentHash(payload)).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it('is over the DECOMPRESSED octets, so how a host served the file cannot change it', () => {
		// ADR-0066: the client hashes what it holds AFTER any transfer decoding and
		// BEFORE `JSON.parse`, which is exactly the UTF-8 of the compact document.
		const seed = seedOf();
		const payload = streamSeedPayloadOf(seed);
		expect(new TextDecoder().decode(payload)).toBe(serializeStreamSeed(seed));

		// So a publisher that gzips the file, and a host that sets
		// `Content-Encoding: gzip` on top of it, both leave the client holding the
		// same octets -- which is why this domain imposes no rule on how the artifact
		// is served, where a hash of the compressed file would.
		expect(streamSeedContentHash(gunzipSync(gzipSync(payload)))).toBe(streamSeedContentHash(payload));
	});
});

describe('the digest rule, expressed over the entries a seed carries', () => {
	it('is the same rule whether it starts from a source or from its hash entries', () => {
		// A seed has no `IndexingSource`: it carries the source HASH ENTRIES in its
		// stored context. Expressing the existing rule over those entries is what
		// lets a client recompute the publisher's digest -- and it must be the same
		// function, or the address a seed installs under is not the one it claims.
		const config = resolveStreamConfig({finality: 12});
		expect(streamDigestOfSourceHashes(sourceHashesOf(SOURCE), config)).toBe(streamDigestOf(SOURCE, config));
	});
});
