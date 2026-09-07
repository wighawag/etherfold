/**
 * THE COMMITTED REFERENCE SEED: the artifact, not the function.
 *
 * `fixtures/stratagems-alpha1.seed.json.gz` is a DELIVERABLE. The loader and the
 * admission tasks install exactly this file and pin exactly the values printed
 * below, so what is asserted here is that the file says what it claims and that
 * the two halves of the pin (which bytes, which algorithm) cannot drift apart
 * silently: a disagreement about the byte domain fails HERE rather than in
 * somebody's browser, where each side's own tests would still be green because
 * each hashes with its own function.
 *
 * The pinned literals are the ones `scripts/emit-stream-seed.ts` PRINTED. That
 * matters: a test recomputing an expected value with the helper it is verifying
 * asserts nothing, so the hash below is recomputed through `node:crypto` -- an
 * independent implementation of the same primitive -- and compared against a
 * literal a human read off the producer's output.
 */
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
	resolveStreamConfig,
	streamDigestOf,
	streamDigestOfSourceHashes,
	streamSeedPayloadOf,
	type StoredLogEvent,
} from '@etherfold/core';
import {
	ALPHA1,
	ALPHA1_STREAM_CONFIG,
	alpha1SeedInputs,
	loadStream,
	loadStreamSeed,
	streamSeedFrom,
	streamSeedPayloadAt,
} from '../src/index.js';

/** What `pnpm --filter @etherfold/conformance-workload-stratagems emit:seed` printed. */
const PRINTED = {
	streamDigest: '222f9f7167d2edf981cdcbe9e10c50ec',
	contentHash: 'sha256:956652dae87511829b67d743abe815aa83a11271199ba80a316b36ff40c919ad',
};

/**
 * The shape the wire measurement predicts, in MEBIbytes as that finding states
 * them: 0.54 MiB gzipped and 20.1 MiB raw for these 31,332 events
 * (`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`).
 *
 * A generous band, because what it is guarding is a SHAPE change and not a byte
 * count: publishing the decoded half again (0.81 MiB / 26.5 MiB), or indenting
 * the document (1.05 MiB / 33.8 MiB), lands far outside it. A number that lands
 * outside for another reason is a finding to report rather than a fixture to
 * re-baseline.
 */
const PREDICTED = {gzippedMiB: 0.54, rawMiB: 20.1, tolerance: 0.15};

const seedPath = ALPHA1.seedPath!;

describe('the committed reference stream seed', () => {
	it('parses as a seed and declares the digest it can be checked to have', () => {
		const seed = loadStreamSeed(seedPath);

		// The label is VERIFIED, never trusted: recomputed from the artifact's own
		// stored context and its own resolved config, which is exactly what a
		// client does before it compares the result against its own digest.
		expect(seed.streamDigest).toBe(streamDigestOfSourceHashes(seed.context.source, seed.streamConfig));
		expect(seed.streamDigest).toBe(PRINTED.streamDigest);
		expect(seed.streamConfig).toEqual(resolveStreamConfig(ALPHA1_STREAM_CONFIG));
	});

	it('is internally consistent with what it claims: coverage, order and its own producer declaration', () => {
		const seed = loadStreamSeed(seedPath);

		expect(seed.eventStream).toHaveLength(ALPHA1.events);
		expect(seed.coverage.fromBlock).toBeLessThanOrEqual(seed.eventStream[0].blockNumber);
		expect(seed.eventStream[seed.eventStream.length - 1].blockNumber).toBeLessThanOrEqual(seed.coverage.toBlock);
		// The coverage claim REACHES above the last event-bearing block, which is
		// the whole point of carrying it (ADR-0055): a quiet range moves the cursor
		// without adding a row, and a seed that cut it short would make a client
		// re-scan every quiet block at the end of the capture.
		expect(seed.coverage.toBlock).toBeGreaterThan(seed.eventStream[seed.eventStream.length - 1].blockNumber);

		// Walked in plain JS and reported as ONE failure: 31,332 assertions would
		// cost more than the parse they are checking, and a matcher's diff over an
		// array that size is unreadable anyway.
		let previous = -1;
		const outOfOrder: number[] = [];
		const retracted: number[] = [];
		for (const event of seed.eventStream) {
			if (event.blockNumber < previous) outOfOrder.push(event.blockNumber);
			previous = event.blockNumber;
			// It says it came from a CAPTURE, and a capture fetches canonical
			// historical ranges, so it cannot have produced a retraction. That rule
			// is stated against the declaration rather than as a blanket ban
			// (ADR-0065), so it is asserted against the declaration too.
			if (event.removed) retracted.push(event.blockNumber);
		}
		expect({outOfOrder, retracted}).toEqual({outOfOrder: [], retracted: []});
		expect(seed.producer.kind).toBe('capture');
		// Deep enough below the head its producer observed that a branch which
		// later lost cannot be in it: 27.5M blocks of margin.
		expect(seed.chainHeadAtCapture - seed.coverage.toBlock).toBeGreaterThan(seed.streamConfig.finality);
	});

	it('carries the STORED half only, raw log included', () => {
		const seed = loadStreamSeed(seedPath);

		// Plain `if`/`throw` for the same reason as above: this walks every one of
		// the 31,332 events, and what a failure has to say is WHICH event.
		for (const event of seed.eventStream as StoredLogEvent[]) {
			if ('args' in event || 'eventName' in event || 'decodeError' in event) {
				throw new Error(`the seed carries a decoded half at block ${event.blockNumber}, log ${event.logIndex}`);
			}
			// And it must still carry what a client re-decodes FROM: an event with no
			// `topics`/`data` is refused by `reparse` and the load path answers by
			// CLEARING the stream, so such a file is a replay input and not a seed.
			if (!event.topics || event.data === undefined) {
				throw new Error(`the seed lacks a raw log at block ${event.blockNumber}, log ${event.logIndex}`);
			}
		}
	});

	it('reproduces the content hash the producer printed, over the DECLARED byte domain', () => {
		// The domain is ADR-0066's: the DECOMPRESSED octets, as they exist after any
		// transfer decoding and before `JSON.parse`. Recomputed here with
		// `node:crypto` rather than with the helper under test, and compared against
		// the literal the producer printed.
		const payload = streamSeedPayloadAt(seedPath);
		expect(`sha256:${createHash('sha256').update(payload).digest('hex')}`).toBe(PRINTED.contentHash);
	});

	it('matches the capture it came from, event for event and bound for bound', () => {
		const capture = loadStream(ALPHA1);
		const seed = loadStreamSeed(seedPath);

		expect(seed.eventStream).toHaveLength(capture.eventStream.length);
		// The COVERAGE is the capture's cursor, which is what the install writes as
		// the stream's `startBlock` and as its reach (ADR-0063's first and third
		// block rules), and not where the events happen to begin and end.
		expect(seed.coverage).toEqual({
			fromBlock: capture.lastSync.lastFromBlock,
			toBlock: capture.lastSync.lastToBlock,
		});
		expect(seed.context).toEqual(capture.lastSync.context);
		expect(seed.chainHeadAtCapture).toBe(capture.provenance.chainHeadAtCapture);
		expect(seed.producer.name).toBe(capture.provenance.capturedBy);
	});

	it('is the artifact the producer emits from the committed capture', () => {
		// So a capture re-taken without re-emitting, or an envelope field added
		// without re-emitting, fails here rather than leaving a committed artifact
		// that quietly describes something else. It works because the emit is
		// DETERMINISTIC: the seed is dated by when its events were produced.
		const capture = loadStream(ALPHA1);
		const emitted = streamSeedFrom(capture, alpha1SeedInputs(capture));

		// `Buffer.equals`, not a matcher: a structural comparison of two 21 MB byte
		// arrays is minutes of work and a diff nobody could read.
		const produced = Buffer.from(streamSeedPayloadOf(emitted));
		const committed = streamSeedPayloadAt(seedPath);
		expect({bytes: produced.byteLength, matches: produced.equals(committed)}).toEqual({
			bytes: committed.byteLength,
			matches: true,
		});
		// ... and the digest taken from the ENTRIES is the one the source itself
		// produces, on a real 31,332-event capture and not only on a fabricated one.
		expect(emitted.streamDigest).toBe(streamDigestOf(capture.source, resolveStreamConfig(ALPHA1_STREAM_CONFIG)));
	});

	it('is the size the wire-shape measurement predicts', () => {
		const gzippedMiB = fs.statSync(seedPath).size / 1_048_576;
		const rawMiB = streamSeedPayloadAt(seedPath).byteLength / 1_048_576;

		const off = (actual: number, predicted: number) => Math.abs(actual - predicted) / predicted;
		if (
			off(gzippedMiB, PREDICTED.gzippedMiB) > PREDICTED.tolerance ||
			off(rawMiB, PREDICTED.rawMiB) > PREDICTED.tolerance
		) {
			throw new Error(
				`the reference seed is ${gzippedMiB.toFixed(2)} MiB gzipped and ${rawMiB.toFixed(2)} MiB raw, where the ` +
					`measurement predicts ${PREDICTED.gzippedMiB} and ${PREDICTED.rawMiB}. That is a SHAPE change (a decoded ` +
					`half published, an indented document, a different compression level) and is a finding to report, not a ` +
					`number to re-baseline.`,
			);
		}
	});
});
