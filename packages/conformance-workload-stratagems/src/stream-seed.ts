/**
 * THE SEED PRODUCER: reducing a captured stream to a PUBLISHED artifact.
 *
 * ## Why it lives here, and what that does and does not deliver
 *
 * Outside `@etherfold/core` on purpose: the strip it applies
 * (`storedStreamOf`) is EXPORTED from that package precisely so that something
 * outside it can apply the one implementation of the rule instead of copying the
 * three-key destructure, which is what the exploration's spike had to do and
 * what ADR-0060 exists to prevent. And here rather than in some new package,
 * because this is the material that already owns the committed capture and its
 * fixture IO -- the seed file convention below is the same convention
 * `fixture-file.ts` states, gzip chosen by the extension, for the same reason.
 *
 * Be clear about what that placement means: the PUBLISHED capability for a third
 * party is the envelope (`StreamSeed`), the exported strip and the digest rule,
 * all of which are `@etherfold/core`'s. Only the emit SCRIPT is ours. That is
 * the intended reading of a spec that keeps the publishing pipeline (CI,
 * hosting, retention, who may publish) out of scope, so nothing here schedules,
 * uploads or retains anything: it turns a capture into one file and prints what
 * a build would pin.
 *
 * The reference artifact this emits is committed beside the capture it came
 * from; `scripts/emit-stream-seed.ts` is what re-emits it, and
 * `test/reference-seed.test.ts` is what keeps it honest.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type {Abi, ProvidedStreamConfig, StreamFixture, StreamSeed, StreamSeedProducer} from '@etherfold/core';
import {
	parseStreamSeed,
	resolveStreamConfig,
	STREAM_SEED_FORMAT,
	storedStreamOf,
	streamConfigHashOf,
	streamDigestOfSourceHashes,
	streamSeedContentHash,
	streamSeedPayloadOf,
} from '@etherfold/core';

/**
 * What a publisher must state, beyond the capture itself.
 *
 * All three are INPUTS rather than things recovered from the fixture, and each
 * for its own reason. The stream CONFIG cannot be recovered at all: a capture
 * records only the 32-bit `streamConfigHashOf` of it, and a client needs the
 * resolved object to compute the 128-bit digest (ADR-0064). The observed head
 * and the producer declaration are TYPED FIELDS of the seed envelope, where a
 * capture carries them only as free-form provenance keys -- so a caller may read
 * them from there as a convenience (`ALPHA1`'s does), and this function does not
 * depend on their being there.
 */
export type StreamSeedInputs = {
	/**
	 * The stream config the capture was taken under, resolved before it is
	 * stored. Checked against the capture's own hash below, and the emit is
	 * REFUSED when they disagree.
	 */
	streamConfig: ProvidedStreamConfig;
	/** What produced the events, typed, because the retraction rule is stated against it (ADR-0065). */
	producer: StreamSeedProducer;
	/** The chain head the producer OBSERVED, which the capture-depth check reads. */
	chainHeadAtCapture: number;
};

/**
 * A captured stream as a publishable seed.
 *
 * ## The refusal, which is the load-bearing half
 *
 * A capture records `lastSync.context.config`: `streamConfigHashOf` of the
 * config its run resolved, and exactly what `captureStream` writes. So a config
 * handed in here is hashed the same way and must AGREE, or nothing is emitted.
 * Without that check the artifact is internally consistent and still wrong -- it
 * claims a stream identity no client running that capture's config can match --
 * and because everything in it agrees with everything else in it, no test of the
 * artifact could see the mistake. It would surface as a refusal in somebody
 * else's browser.
 *
 * It THROWS rather than reporting data, because the audience is a PUBLISHER
 * running a script and not a client deciding whether to install: refusal-as-data
 * exists so an application can say something true to a user (ADR-0040,
 * ADR-0064), and there is no user here.
 *
 * ## What is copied verbatim, and why
 *
 * The stored `context` is the SEED's own, so a client's load-time
 * `streamMatches` check compares itself against the publisher rather than
 * against itself. The COVERAGE is the capture's cursor and not its first and
 * last event: the first value becomes the installed stream's `startBlock` and
 * the last is above the final event-bearing block, both of which ADR-0063 makes
 * load-bearing.
 */
export function streamSeedFrom<ABI extends Abi>(fixture: StreamFixture<ABI>, inputs: StreamSeedInputs): StreamSeed {
	const streamConfig = resolveStreamConfig(inputs.streamConfig);
	const configHash = streamConfigHashOf(streamConfig);
	const capturedHash = fixture.lastSync.context.config;
	if (configHash !== capturedHash) {
		throw new Error(
			`refusing to emit a stream seed: the capture was captured under ${capturedHash}, not under ${configHash} ` +
				`(a seed published under a config its capture was not taken under claims a stream identity no client can match)`,
		);
	}

	return {
		format: STREAM_SEED_FORMAT,
		producer: inputs.producer,
		chainHeadAtCapture: inputs.chainHeadAtCapture,
		streamConfig,
		streamDigest: streamDigestOfSourceHashes(fixture.lastSync.context.source, streamConfig),
		coverage: {fromBlock: fixture.lastSync.lastFromBlock, toBlock: fixture.lastSync.lastToBlock},
		context: fixture.lastSync.context,
		// THE ONE implementation of the strip, reached through the package entry
		// rather than copied (ADR-0060, and the export ADR-0063 asked for).
		eventStream: storedStreamOf(fixture.eventStream),
	};
}

/**
 * What emitting one produced: everything a publisher has to PRINT, and nothing
 * that is in the file.
 *
 * The content hash is here rather than in the envelope because a document cannot
 * contain a hash of itself. A build PINS this value (optionally, and only for an
 * immutable release-tied artifact -- ADR-0066 makes the trust anchor the host a
 * build names, since a rolling artifact's hash cannot be known when the build is
 * made), and a client recomputes it over the same octets.
 */
export type EmittedStreamSeed = {
	path: string;
	/** The stream this seed is for, as the client will recompute it. */
	streamDigest: string;
	/** `sha256:<hex>` over the DECOMPRESSED payload octets (ADR-0066). */
	contentHash: string;
	/** The size of those octets: what the client parses. */
	payloadBytes: number;
	/** The size on the wire: what the client downloads. */
	fileBytes: number;
	events: number;
};

/** Whether this path is a gzipped one, the same extension convention `fixture-file.ts` states. */
function isGzipped(filePath: string): boolean {
	return filePath.endsWith('.gz');
}

/**
 * Write a seed as ONE compact gzipped document, and report what to pin.
 *
 * The hash is taken over the payload BEFORE compression, and that ordering is
 * the decision rather than an implementation detail: a host that serves the file
 * with `Content-Encoding: gzip` makes `fetch` decompress transparently, so a
 * hash of the compressed bytes could not be recomputed from anything the client
 * holds, and a rule forbidding that header is one most hosts will not honour.
 * Hashing the decompressed octets is transport-invariant (ADR-0066).
 *
 * Compressed at level 9, which is both the right trade and the reproducible one:
 * a published artifact is written once and downloaded by everybody, and it is
 * what the wire-shape measurement used, so the size this emits is the size that
 * finding predicts (0.53 MiB against 0.60 MiB at zlib's default level 6) rather
 * than a number 12% off it for no stated reason.
 */
export function saveStreamSeed(filePath: string, seed: StreamSeed): EmittedStreamSeed {
	const folder = path.dirname(filePath);
	if (folder && !fs.existsSync(folder)) {
		fs.mkdirSync(folder, {recursive: true});
	}
	const payload = streamSeedPayloadOf(seed);
	const file = isGzipped(filePath) ? zlib.gzipSync(payload, {level: 9}) : payload;
	fs.writeFileSync(filePath, file);
	return {
		path: filePath,
		streamDigest: seed.streamDigest,
		contentHash: streamSeedContentHash(payload),
		payloadBytes: payload.byteLength,
		fileBytes: file.byteLength,
		events: seed.eventStream.length,
	};
}

/**
 * Read a seed back, gunzipping when the path says so, refusing what is not one.
 *
 * The gunzip here is the local counterpart of the transfer decoding a browser
 * does: what comes out of it is exactly the octet domain the content hash is
 * over, which is why a caller verifying a committed artifact reads those bytes
 * rather than re-serializing what this returns.
 */
export function loadStreamSeed(filePath: string): StreamSeed {
	const text = streamSeedPayloadAt(filePath).toString('utf-8');
	try {
		return parseStreamSeed(text);
	} catch (err) {
		throw new Error(`${filePath}: ${(err as Error).message}`);
	}
}

/** The DECOMPRESSED octets of a seed file: the bytes its content hash is taken over. */
export function streamSeedPayloadAt(filePath: string): Buffer {
	const file = fs.readFileSync(filePath);
	return isGzipped(filePath) ? zlib.gunzipSync(file) : file;
}
