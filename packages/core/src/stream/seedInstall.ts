import type {Abi} from 'abitype';
import {logs} from 'named-logs';
import {defaultFromBlockOf} from '../internal/engine/utils.js';
import type {ExistingStream, IndexingSource, StoredLogEvent, UsedStreamConfig} from '../types.js';
import {parseStreamSeed, type StreamSeed} from './seed.js';

const namedLogger = logs('@etherfold/core');

/**
 * Where a published seed can be fetched from.
 *
 * A plain string, and deliberately not the snapshot path's
 * `{url, head}` object: a HEAD exists there so mirrors can be RANKED before any
 * body is downloaded, and there is nothing to rank here. The caller's ORDER is
 * the selection (ADR-0066), so failover walks the list and stops at the first
 * usable artifact. There is also no head ARTIFACT to fetch: a seed is published
 * as ONE compact document with no manifest beside it
 * (`work/notes/findings/what-a-published-stream-seed-costs-to-install.md`), so a
 * `head` option would name a document nothing emits.
 *
 * It is a string rather than a URL for the case that needs it most: a
 * BUILD-EMBEDDED artifact at a RELATIVE, hostless path, which is what the
 * reference deployment lists last so the app still starts when its snapshot host
 * is gone. `fetch` resolves that against the document's own base; a `URL` would
 * have had to be given one.
 */
export type StreamSeedLocation = string;

/** Why an install did not happen. DATA, so a host can render it rather than parse a log. */
export type NotInstalledReason =
	/** No location was given at all. */
	| 'no-locations'
	/** Every location failed to fetch. */
	| 'unreachable'
	/** Something was fetched and it is not a seed this build reads. */
	| 'unreadable-format'
	/**
	 * Every readable seed starts ABOVE the block this client asks from.
	 *
	 * Refused rather than ranked lower, which is where a stream's selection
	 * genuinely differs from a snapshot's (ADR-0063): the coverage `fromBlock`
	 * becomes the installed stream's `startBlock`, and `fetchFrom` CLEARS a
	 * subtree whose `startBlock` is above the block it was asked from -- so a
	 * seed that does not reach back would be deleted by the first load of the
	 * very client it was installed for.
	 */
	| 'does-not-reach-back'
	/**
	 * The subtree already holds a stream, and this install may not write into it
	 * (ADR-0067).
	 *
	 * A BARE emptiness test and deliberately nothing finer: a stream the client
	 * indexed itself and a half-written earlier install of this very seed are
	 * INDISTINGUISHABLE through this seam, so a discriminator cannot exist and a
	 * resume would duplicate events or leave a hole, silently. A caller that
	 * wants to replace what is there CLEARS it first, deliberately.
	 */
	| 'subtree-not-empty';

/**
 * What an install did, as DATA. Nothing here is thrown for an ordinary
 * condition: not finding a usable seed is a normal outcome a host acts on.
 */
export type StreamSeedInstallOutcome =
	| {
			readonly status: 'installed';
			/** Which location it came from, so a host can say where its history is from. */
			readonly from: string;
			/** How far the installed stream REACHES: the seed's coverage end, above its last event. */
			readonly at: number;
			/** How far back it reaches: what the keeper recorded as the stream's `startBlock`. */
			readonly reachesBackTo: number;
			readonly events: number;
			/** How many saves it took, which is how many SEGMENTS the keeper now holds. */
			readonly segments: number;
	  }
	| {readonly status: 'not-installed'; readonly reason: NotInstalledReason};

export type StreamSeedInstallOptions<ABI extends Abi> = {
	/** The source the client indexes: it is what ADDRESSES the subtree, and it is never the seed's. */
	readonly source: IndexingSource<ABI>;
	/**
	 * The RESOLVED stream config, which this install SETS on the keeper before it
	 * addresses anything at all (ADR-0067).
	 *
	 * An argument rather than whatever a previous caller left configured, so the
	 * subtree this reads and writes is a function of what it was handed. Pass
	 * `resolveStreamConfig(config)` -- the same value `IndexerGeneration.reinit`
	 * hands over -- and never the config as a user spelled it, or the digest half
	 * of the address is a different one from the client's.
	 */
	readonly streamConfig: UsedStreamConfig;
	/**
	 * The block the client will ask this stream FROM, which a seed must reach
	 * back to or be refused.
	 *
	 * Defaults to the source's own earliest `startBlock`, which is exactly what a
	 * fresh generation's `load()` asks for (`defaultFromBlock`), so the ordinary
	 * caller states nothing. Give it explicitly when the client will ask from
	 * somewhere else.
	 */
	readonly reachBackTo?: number;
	/**
	 * How many events one save carries, at most. Defaults to 1,000.
	 *
	 * Batches are cut on BLOCK boundaries, so a batch reaches this size and then
	 * ends at the next block change; nothing in the keeper requires that, but a
	 * segment holding half a block is a segment whose cursor cannot honestly say
	 * which blocks it covers.
	 */
	readonly maxEventsPerBatch?: number;
	/** Injectable for tests and for a host with its own retry/timeout policy. */
	readonly fetch?: typeof globalThis.fetch;
};

/** How many events one save carries by default. See `maxEventsPerBatch`. */
const DEFAULT_MAX_EVENTS_PER_BATCH = 1000;

/**
 * The block the EMPTINESS PROBE asks from, and the whole reason the probe is
 * safe.
 *
 * `ExistingStream` exposes exactly one read and that read MUTATES: `fetchFrom`
 * CLEARS the entire subtree when the stored cursor's `startBlock` is above the
 * block it was asked from, and it does so before answering. A probe asking from
 * the seed's own (low) coverage start -- the number this task otherwise puts in
 * front of you -- is exactly the shape that fires it on a client that already
 * holds a stream starting higher. That client would lose its whole cached stream
 * to a call whose only purpose was to decide the seed cannot be installed, which
 * contradicts the refusal this module returns.
 *
 * No stored `startBlock` can be above `Number.MAX_SAFE_INTEGER`, so asking from
 * there cannot reach that branch, whatever is stored. The keeper's OTHER
 * clearing branches (segments with no cursor record, a gap in the ordinals, a
 * segment that does not parse) are damage repair the keeper owns, and defeating
 * them is not this module's business: each of them leaves an EMPTY subtree,
 * which is exactly what this probe then reports.
 */
const PROBE_FROM_BLOCK = Number.MAX_SAFE_INTEGER;

/**
 * FETCH a published stream seed from the locations a caller named, and INSTALL
 * it by writing through the public keeper seam.
 *
 * ## THIS CALL VERIFIES NOTHING YET
 *
 * It is deliberately NOT exported from `@etherfold/core` while that is true. It
 * treats whatever it fetched as already trusted: it does not check that the seed
 * is for THIS stream (its digest, ADR-0064), that its bytes match a pin
 * (ADR-0066), that its events are coherent, or that the capture was taken far
 * enough below the chain head (ADR-0065). Those are the ADMISSION checks; they
 * all run BEFORE the first write once they land, and the export lands with
 * them, so that a public entry point never means "fetched and hoped".
 *
 * ## What installing IS
 *
 * A run of ordinary `saveNewEvents` calls and nothing else (ADR-0063). There is
 * no new keeper operation, no substrate access and no second copy of the
 * segmentation rules: `createSegmentedStream` already owns which ordinal a
 * segment takes, what the cursor record holds, that the stream's `startBlock` is
 * the first save's `lastFromBlock`, and which batches are refused as a hole. All
 * this adds is block arithmetic, and it has three rules -- see `writeSeed`.
 *
 * ## What it REFUSES, and what a refusal costs
 *
 * Refusals come back as DATA (`NotInstalledReason`), never as a throw, because
 * every one of them is an ordinary condition a host renders. A refusal writes
 * NOTHING and, just as importantly, DELETES nothing: the emptiness probe is
 * built so that refusing an install can never be what destroys the stream it
 * refused (`PROBE_FROM_BLOCK`).
 *
 * What DOES throw is the keeper failing mid-install, or declining a batch that
 * continues exactly what this call itself just wrote. Neither is an ordinary
 * condition: the second can only mean something else wrote into this subtree
 * while the install was running, which the one-writer rule forbids.
 *
 * ## Trust is the LOCATION, and it is the caller's (ADR-0066)
 *
 * The loader fetches from the locations it was given, in order, and nowhere
 * else, so there is no origin check to make and no allowlist to build. Where
 * those locations come from is the application's business and the application's
 * risk -- a build constant, an environment variable, or a query parameter.
 * A RELATIVE, hostless path is a first-class member of the list and is the one
 * needing no host at all: an artifact shipped inside the application's own
 * build, ordinarily listed LAST so the app still starts when its remote is gone.
 *
 * ```ts
 * const outcome = await installStreamSeed(keeper, [
 *   'https://seeds.example/stratagems.seed.json.gz',
 *   './stratagems.seed.json.gz',
 * ], {source, streamConfig: resolveStreamConfig({finality: 12})});
 * ```
 */
export async function installStreamSeed<ABI extends Abi>(
	keepStream: ExistingStream<ABI>,
	locations: StreamSeedLocation | readonly StreamSeedLocation[],
	options: StreamSeedInstallOptions<ABI>,
): Promise<StreamSeedInstallOutcome> {
	const all = Array.isArray(locations) ? (locations as readonly StreamSeedLocation[]) : [locations as string];
	if (all.length === 0) {
		return {status: 'not-installed', reason: 'no-locations'};
	}

	// FIRST, and before ANY call that addresses a subtree -- the probe below
	// included, not merely before the first write. A keeper resolves the address
	// from the source it is handed on every call plus the config it was last
	// GIVEN, so a probe run before this would inspect one subtree while the
	// install wrote another (ADR-0067).
	keepStream.setStreamConfig?.(options.streamConfig);

	if (!(await subtreeIsEmpty(keepStream, options.source))) {
		namedLogger.info(
			`not installing a stream seed: this subtree already holds a stream. Nothing here can tell a stream this ` +
				`client indexed itself from a half-written install of the seed being offered, so an install that is not ` +
				`into an EMPTY subtree would duplicate events or leave a hole, silently. Clear it first if you mean to ` +
				`replace it.`,
		);
		return {status: 'not-installed', reason: 'subtree-not-empty'};
	}

	const get = options.fetch ?? globalThis.fetch;
	const reachBackTo = options.reachBackTo ?? defaultFromBlockOf(options.source);
	const reasons = new Set<NotInstalledReason>();

	for (const location of all) {
		let payload: Uint8Array;
		try {
			payload = await fetchSeedPayload(get, location);
		} catch (error) {
			// logged and skipped, never thrown: one unreachable location must not
			// decide whether the app starts.
			namedLogger.error(`could not fetch a stream seed from ${location}, trying the next location`, error);
			reasons.add('unreachable');
			continue;
		}

		let seed: StreamSeed;
		try {
			seed = parseStreamSeed(new TextDecoder().decode(payload));
		} catch (error) {
			// `parseStreamSeed` THROWS, by design, and this is the one place that
			// conversion happens: a truncated file, a fixture handed to the wrong
			// reader and a future format are all one refusal a client can explain.
			namedLogger.error(`the document at ${location} is not a stream seed this build reads`, error);
			reasons.add('unreadable-format');
			continue;
		}

		if (seed.coverage.fromBlock > reachBackTo) {
			namedLogger.warn(
				`ignoring the stream seed at ${location}: it reaches back to ${seed.coverage.fromBlock} and this client ` +
					`reads its stream from ${reachBackTo}, so the stream it installed would be CLEARED by the first load.`,
			);
			reasons.add('does-not-reach-back');
			continue;
		}

		const segments = await writeSeed(keepStream, options.source, seed, options.maxEventsPerBatch);
		namedLogger.info(
			`installed a stream seed from ${location}: ${seed.eventStream.length} event(s) as ${segments} segment(s), ` +
				`covering ${seed.coverage.fromBlock} to ${seed.coverage.toBlock}`,
		);
		return {
			status: 'installed',
			from: location,
			at: seed.coverage.toBlock,
			reachesBackTo: seed.coverage.fromBlock,
			events: seed.eventStream.length,
			segments,
		};
	}

	return {status: 'not-installed', reason: pickReason(reasons)};
}

/**
 * Whether this subtree holds NOTHING: no cursor record and no segments.
 *
 * The whole rule (ADR-0067), and a bare one on purpose. See `PROBE_FROM_BLOCK`
 * for why asking from there is the thing that makes this read non-destructive.
 */
async function subtreeIsEmpty<ABI extends Abi>(
	keepStream: ExistingStream<ABI>,
	source: IndexingSource<ABI>,
): Promise<boolean> {
	return (await keepStream.fetchFrom(source, PROBE_FROM_BLOCK)) === undefined;
}

/**
 * The OCTETS a fetched seed is, whichever way its host served it.
 *
 * ## The two arrangements, and why the answer is the same bytes
 *
 * A seed is published as ONE gzipped document, and a host may deliver it either
 * way: OPAQUE (`.gz` as bytes, no `Content-Encoding`), in which case this
 * inflates it, or with `Content-Encoding: gzip`, in which case the runtime
 * already inflated it transparently and what arrives is the JSON text. Both are
 * handled, and both end at the SAME octets: the decompressed payload, after any
 * transfer decoding and before `JSON.parse`. That is exactly the domain
 * `streamSeedContentHash` is defined over (ADR-0066), so an integrity check
 * hashes what this function returns and lands on the value the producer printed,
 * whichever way the artifact was served.
 *
 * ## Detected from the BYTES and not from a header
 *
 * The gzip magic number (`1f 8b`) says what arrived; headers do not. A browser
 * that decoded transparently REMOVES `Content-Encoding` from what a script can
 * see, hosts disagree about `Content-Type` for a `.gz`, and a gateway may
 * re-compress an opaque file of its own accord. The sniff is unambiguous because
 * a JSON document cannot begin with those two bytes.
 *
 * Exactly ONE layer is peeled. A host that both serves the gzipped FILE and
 * applies gzip transfer encoding is already handled by that -- the runtime
 * removes the transfer layer and this removes the file's own -- and looping
 * further would be guessing at a shape nothing publishes.
 */
export async function streamSeedPayloadFrom(received: Uint8Array): Promise<Uint8Array> {
	if (received.length < 2 || received[0] !== 0x1f || received[1] !== 0x8b) {
		return received;
	}
	// Typed as the `BufferSource` a `DecompressionStream` writable takes, rather
	// than as `Uint8Array`: the two differ only in which buffer type they are
	// generic over, and that difference is the whole of the friction here.
	const compressed = new ReadableStream<BufferSource>({
		start(controller) {
			// COPIED rather than cast: what a `DecompressionStream` accepts is a view
			// over an `ArrayBuffer` and not over any buffer at all, and this copy is of
			// the COMPRESSED bytes (half a megabyte for the reference artifact).
			controller.enqueue(new Uint8Array(received));
			controller.close();
		},
	});
	const inflated = compressed.pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(inflated).arrayBuffer());
}

/** One location fetched, down to the octets a seed IS. Raises, and the caller skips the location. */
async function fetchSeedPayload(get: typeof globalThis.fetch, location: string): Promise<Uint8Array> {
	const response = await get(location);
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}
	return streamSeedPayloadFrom(new Uint8Array(await response.arrayBuffer()));
}

/**
 * The seed's events cut into BATCHES, each a whole number of blocks.
 *
 * A block is never split across two saves. Nothing in the keeper requires it,
 * since a read concatenates the segments and filters by block, but a segment
 * holding half a block is a segment whose cursor cannot honestly say which
 * blocks it covers -- and the cursor is what the client resumes from.
 */
function batchesOf(eventStream: readonly StoredLogEvent[], maxEvents: number): StoredLogEvent[][] {
	const batches: StoredLogEvent[][] = [];
	let current: StoredLogEvent[] = [];
	for (let i = 0; i < eventStream.length; i++) {
		const event = eventStream[i];
		const previous = eventStream[i - 1];
		const boundary = previous !== undefined && previous.blockNumber !== event.blockNumber;
		if (boundary && current.length >= maxEvents) {
			batches.push(current);
			current = [];
		}
		current.push(event);
	}
	if (current.length > 0) {
		batches.push(current);
	}
	return batches;
}

/**
 * The install itself: N ordinary saves, and three block rules that are the whole
 * of its arithmetic. Each rule is forced by something the keeper or the load
 * path already does (ADR-0063).
 *
 *  1. **The FIRST batch's `lastFromBlock` is the seed's COVERAGE start**, never
 *     its first event's block. The keeper writes that value once as the stream's
 *     `startBlock`, and `fetchFrom` clears the whole subtree when `startBlock` is
 *     above the block asked for -- so a stream claiming to start at its first
 *     EVENT would be deleted on first load by a client whose source starts
 *     earlier, which is the ordinary case.
 *  2. **Each later batch continues the previous one exactly**, `lastFromBlock =
 *     previous lastToBlock + 1`. Above that the keeper REFUSES the batch as a
 *     hole; below it is an overlap the keeper accepts as an ordinary tip
 *     re-scan, which here would silently duplicate events -- the engine's own
 *     writer de-duplicates with `streamRemainderOf` and an installer has no such
 *     thing.
 *  3. **The LAST batch's `lastToBlock` is the seed's COVERAGE end**, above its
 *     last event-bearing block. The rows cannot say how far a stream REACHES,
 *     because a quiet range moves the cursor without adding one (ADR-0055); cut
 *     it short and the client re-scans every quiet block at the end of the
 *     capture, which on a public node is exactly the fetch it cannot make.
 *
 * Two more things it writes, neither of them the client's own. The `context` is
 * the SEED's, VERBATIM: writing the client's hashes would make the load path's
 * `streamMatches` check compare the client against itself, discarding a
 * structural defence for nothing. And `latestBlock` is the chain head the
 * PRODUCER observed, because that field is the observed tip rather than progress
 * through it -- a stream stored with `latestBlock` 0 sends `getFromBlock` back to
 * the source's start block on the next load, which is the re-scan this whole
 * exercise exists to avoid.
 *
 * A seed with NO events is still installed, as a single empty save: that writes
 * the cursor record alone (the keeper's `writeCursorOnly` path), which is how a
 * covered but quiet range is expressed. Writing nothing at all would leave the
 * subtree empty and the range re-scanned.
 */
async function writeSeed<ABI extends Abi>(
	keepStream: ExistingStream<ABI>,
	source: IndexingSource<ABI>,
	seed: StreamSeed,
	maxEventsPerBatch = DEFAULT_MAX_EVENTS_PER_BATCH,
): Promise<number> {
	const batches = seed.eventStream.length > 0 ? batchesOf(seed.eventStream, maxEventsPerBatch) : [[]];
	let previousTo: number | undefined;
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		const last = i === batches.length - 1;
		const lastFromBlock = previousTo === undefined ? seed.coverage.fromBlock : previousTo + 1;
		const lastToBlock = last ? seed.coverage.toBlock : batch[batch.length - 1].blockNumber;
		const outcome = await keepStream.saveNewEvents(source, {
			eventStream: batch,
			lastSync: {
				context: seed.context,
				latestBlock: seed.chainHeadAtCapture,
				lastFromBlock,
				lastToBlock,
				unconfirmedBlocks: [],
			},
		});
		if (outcome === 'declined') {
			// Not an ordinary condition and so not a refusal: this batch continues
			// exactly what the save before it wrote into a subtree this call found
			// EMPTY, so a decline means something else wrote here while the install
			// was running -- which the one-writer rule forbids. What is stored stays a
			// contiguous prefix with an honest cursor; clear it and install again.
			throw new Error(
				`the stream keeper declined batch ${i + 1} of ${batches.length} (blocks ${lastFromBlock} to ` +
					`${lastToBlock}) of a seed installed into a subtree this call found EMPTY. Another writer must have ` +
					`written into it while the install was running.`,
			);
		}
		previousTo = lastToBlock;
	}
	return batches.length;
}

/** The most specific thing that went wrong, when several did. */
function pickReason(reasons: ReadonlySet<NotInstalledReason>): NotInstalledReason {
	for (const reason of ['does-not-reach-back', 'unreadable-format', 'unreachable'] as const) {
		if (reasons.has(reason)) return reason;
	}
	return 'unreachable';
}
