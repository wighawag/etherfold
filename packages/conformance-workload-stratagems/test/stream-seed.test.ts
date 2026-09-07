/**
 * THE PRODUCER: emitting a published stream seed from a captured stream.
 *
 * It lives in this package, and this suite is where the rules it enforces are
 * pinned. Two of them are about damage that does not happen and are therefore
 * asserted rather than described: an emitted seed carries NO decoded half (the
 * install strips it anyway, ADR-0060, and publishing it costs a third of the
 * artifact), and a seed CANNOT be emitted under a stream config its capture was
 * not taken under -- which would produce an internally consistent artifact
 * claiming a stream identity no client running that capture's config can match,
 * a mistake that would otherwise surface as a refusal in somebody else's
 * browser.
 *
 * The committed reference artifact has its own suite (`reference-seed.test.ts`),
 * because what is asserted there is a FILE and not a function.
 */
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {describe, expect, it} from 'vitest';
import type {Abi, StreamFixture} from '@etherfold/core';
import {
	resolveStreamConfig,
	STREAM_FIXTURE_FORMAT,
	STREAM_SEED_FORMAT,
	streamConfigHashOf,
	streamDigestOfSourceHashes,
	streamSeedContentHash,
} from '@etherfold/core';
import {loadStreamSeed, saveStreamSeed, streamSeedFrom} from '../src/stream-seed.js';

/** `{finality: 12}` resolved, hashed: what a capture taken under it records. */
const CAPTURED_UNDER = {finality: 12};

const PRODUCER = {
	kind: 'capture',
	name: 'test/stream-seed.test.ts',
	at: '2026-09-07T00:00:00.000Z',
} as const;

function decodedEvent(blockNumber: number, logIndex: number) {
	return {
		blockNumber,
		blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
		transactionIndex: 0,
		removed: false,
		address: '0x0000000000000000000000000000000000000abc',
		data: '0x00',
		topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
		transactionHash: `0x${logIndex.toString(16).padStart(64, '0')}`,
		logIndex,
		extra: undefined,
		// The decoded half a capture holds and a seed must not publish.
		eventName: 'Transfer',
		args: {value: 2n ** 200n},
	};
}

/**
 * A capture, as `captureStream` writes one: the cursor's `context.config` is
 * `streamConfigHashOf` of the config the run resolved, and that is the value the
 * producer's emit-time check compares against.
 */
function capture(configHash: string): StreamFixture<Abi> {
	return {
		format: STREAM_FIXTURE_FORMAT,
		provenance: {
			capturedAt: '2026-09-06T00:00:00.000Z',
			chainId: '8453',
			fromBlock: 100,
			toBlock: 220,
			chainHeadAtCapture: 1_000_000,
			capturedBy: 'test/stream-seed.test.ts',
		},
		source: {chainId: '8453', contracts: [{abi: [] as unknown as Abi, address: '0x01', startBlock: 100}]},
		lastSync: {
			context: {source: [{startBlock: 0, hash: 'h1', streamHash: 's1'}], config: configHash, processor: ''},
			latestBlock: 220,
			lastFromBlock: 100,
			lastToBlock: 220,
			unconfirmedBlocks: [],
		},
		eventStream: [decodedEvent(101, 0), decodedEvent(210, 3)] as any,
	};
}

/** A capture taken under `CAPTURED_UNDER`, hashed the way `captureStream` hashes it. */
function capturedFixture(): StreamFixture<Abi> {
	return capture(streamConfigHashOf(CAPTURED_UNDER));
}

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'etherfold-seed-'));
}

describe('a seed emitted from a captured stream', () => {
	it('carries the STORED half of each event and nothing an ABI made of it', () => {
		const seed = streamSeedFrom(capturedFixture(), {
			streamConfig: CAPTURED_UNDER,
			producer: PRODUCER,
			chainHeadAtCapture: 1_000_000,
		});

		expect(seed.format).toBe(STREAM_SEED_FORMAT);
		expect(seed.eventStream).toHaveLength(2);
		for (const event of seed.eventStream) {
			expect(event).not.toHaveProperty('args');
			expect(event).not.toHaveProperty('eventName');
			expect(event).not.toHaveProperty('decodeError');
			// ... and it still carries the raw log, without which it is a replay
			// input and not a seed at all (ADR-0034, ADR-0063).
			expect(event.topics.length).toBeGreaterThan(0);
			expect(event.data).toBe('0x00');
		}
	});

	it('carries the RESOLVED config, its own digest label, its coverage and its typed declarations', () => {
		const fixture = capturedFixture();
		const seed = streamSeedFrom(fixture, {
			streamConfig: CAPTURED_UNDER,
			producer: PRODUCER,
			chainHeadAtCapture: 1_000_000,
		});

		// RESOLVED, so the digest a client computes from it is the one the engine
		// reaches -- not whichever spelling the publisher happened to hand over.
		expect(seed.streamConfig).toEqual(resolveStreamConfig(CAPTURED_UNDER));
		expect(seed.streamDigest).toBe(streamDigestOfSourceHashes(seed.context.source, seed.streamConfig));
		// The COVERAGE is the capture's cursor, not its first and last event.
		expect(seed.coverage).toEqual({fromBlock: 100, toBlock: 220});
		expect(seed.context).toEqual(fixture.lastSync.context);
		expect(seed.producer).toEqual(PRODUCER);
		expect(seed.chainHeadAtCapture).toBe(1_000_000);
	});

	it('REFUSES a config the capture was not taken under, naming both hashes', () => {
		// Without this the artifact is internally consistent and still wrong: it
		// claims a stream identity no client running that capture's config can
		// match, and the mistake surfaces in somebody else's browser.
		expect(() =>
			streamSeedFrom(capturedFixture(), {
				streamConfig: {finality: 17},
				producer: PRODUCER,
				chainHeadAtCapture: 1_000_000,
			}),
		).toThrow(/captured under .*, not under /);
	});
});

describe('a seed on disk', () => {
	it('is one COMPACT gzipped document whose printed content hash reproduces from its bytes', () => {
		const file = path.join(tempDir(), 'seed.json.gz');
		const seed = streamSeedFrom(capturedFixture(), {
			streamConfig: CAPTURED_UNDER,
			producer: PRODUCER,
			chainHeadAtCapture: 1_000_000,
		});
		const emitted = saveStreamSeed(file, seed);

		// Gzipped on disk...
		expect(() => JSON.parse(fs.readFileSync(file, 'utf-8'))).toThrow();
		expect(emitted.fileBytes).toBeLessThan(emitted.payloadBytes);
		// ... compact underneath ...
		const payload = zlib.gunzipSync(fs.readFileSync(file));
		expect(payload.toString('utf-8').includes('\n')).toBe(false);
		// ... and the hash the producer printed is the hash of the DECOMPRESSED
		// octets, recomputed here through an independent implementation of the
		// same primitive rather than through the helper being verified.
		expect(emitted.contentHash).toBe(`sha256:${createHash('sha256').update(payload).digest('hex')}`);
		expect(emitted.contentHash).toBe(streamSeedContentHash(payload));

		expect(loadStreamSeed(file)).toEqual(seed);
	});
});
