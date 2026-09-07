import type {Abi} from 'abitype';
import {logs} from 'named-logs';
import {sourceHashesOf} from '../internal/engine/eventRanges.js';
import {defaultFromBlockOf, sourceInvalidationOf, streamConfigHashOf} from '../internal/engine/utils.js';
import type {ExistingStream, IndexingSource, SourceHashEntry, StoredLogEvent, UsedStreamConfig} from '../types.js';
import {streamDigestOfSourceHashes} from './identity.js';
import {parseStreamSeed, pinnedStreamSeedContentHash, streamSeedContentHash, type StreamSeed} from './seed.js';

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
	| 'subtree-not-empty'
	/**
	 * The seed DECLARES a chain this client does not index (ADR-0064).
	 *
	 * Structurally subsumed by the digest -- `chainId` and `genesisHash` are hashed
	 * into the block-0 skeleton entry -- and reported separately anyway, because
	 * telling a developer who pointed at the wrong chain that "an entry was added
	 * at block 0" is useless. Only a seed that DECLARES its chain can be given
	 * this reason; one that does not is still refused, as a direction below.
	 */
	| 'chain-mismatch'
	/**
	 * The resolved stream CONFIGS differ (ADR-0064).
	 *
	 * Also subsumed by the digest and also reported separately: the config decides
	 * what is STORED (`alwaysFetchTimestamps`, `alwaysFetchTransactions`,
	 * `parse.filters`) as much as the filter does, and "your finality is 12 and the
	 * publisher's is 64" is a thing a developer can act on where a moved digest is
	 * not. It is the same `stream-config` the invalidation model names.
	 */
	| 'stream-config'
	/**
	 * The digests differ and the seed is strictly WIDER: this client indexes LESS
	 * than the publisher does.
	 *
	 * Refused even though the invalidation model calls such a stream reusable
	 * (ADR-0064): that tolerance is about a LOCAL cache whose extra events the
	 * client itself fetched under its own earlier filter. A downloaded superset is
	 * not that. Its extra events would be stored under the CLIENT's digest,
	 * re-folded by every later generation, and delivered to a processor that
	 * implements `handleUnparsedEvent`.
	 *
	 * The DIRECTION is data and the INFERENCE from it belongs to the application.
	 * Nothing here claims the client is out of date: a deliberately narrower client
	 * is indistinguishable from a stale one, and only the application can tell.
	 */
	| 'seed-covers-more'
	/**
	 * The digests differ and the seed LACKS something this client indexes, at or
	 * below the coverage it claims (ADR-0064).
	 *
	 * The other half of the pair, and equally free of inference: an application may
	 * render "this seed is older than this build", the loader may not.
	 */
	| 'seed-covers-less'
	/**
	 * The bytes do not match the content hash the CALLER pinned (ADR-0066).
	 *
	 * Only reachable when a caller supplied one, which only an IMMUTABLE,
	 * release-tied artifact can have: a build cannot know the hash of a ROLLING
	 * artifact, and rolling is how this is deployed.
	 */
	| 'integrity-mismatch'
	/**
	 * The seed contradicts ITSELF: its events are out of order, one block number
	 * carries two hashes, a `(blockHash, logIndex)` repeats, an event sits outside
	 * the coverage it claims, a retraction has no application before it or
	 * contradicts the declared producer, or its digest label is not what its own
	 * fields produce (ADR-0065).
	 *
	 * ONE reason for all of them, because they are one question -- is this document
	 * internally consistent -- and an application renders the same thing for every
	 * answer. WHICH rule failed is LOGGED, since that is a publisher's debugging
	 * problem and not a user's.
	 */
	| 'incoherent'
	/**
	 * The capture reaches closer to the head its producer OBSERVED than `finality`
	 * (ADR-0065).
	 *
	 * The stream analogue of the snapshot path's `inside-reorg-window`, and the
	 * check most easily missed because what it catches leaves NO trace: a capture
	 * taken near the tip can record a branch that later lost and be perfectly
	 * coherent while describing a chain that did not happen. It needs no node --
	 * the artifact carries the observed head and the client has its own resolved
	 * `finality`.
	 */
	| 'inside-reorg-window';

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
	/**
	 * An OPTIONAL content hash the caller pins, VERBATIM as the producer PRINTED
	 * it: the algorithm prefix and 64 lowercase hex characters, which is the one
	 * rendering `streamSeedContentHash` emits (see it for why the algorithm travels
	 * in front of the digits).
	 *
	 * ## Optional, and that is the decision rather than a convenience (ADR-0066)
	 *
	 * A build cannot pin the hash of a ROLLING artifact, and rolling is how this is
	 * deployed -- the reference deployment held one web build against a snapshot
	 * republished every hour, so an artifact a pin would have had to name did not
	 * exist when the build was made. Where an artifact IS immutable and
	 * release-tied, a pin is the strongest thing available and is supported.
	 *
	 * ## What it is over, and what that buys
	 *
	 * SHA-256 over the DECOMPRESSED payload octets: the bytes after any transfer
	 * decoding and before `JSON.parse`. That domain is TRANSPORT-INVARIANT, so
	 * there is no rule about how a host serves the file -- opaque `.gz` and
	 * `Content-Encoding: gzip` reach the same value -- and the same pin holds
	 * across mirrors that disagree about encoding.
	 *
	 * ## What it is NOT
	 *
	 * Not an admission CREDENTIAL when it is fetched from where the artifact is. A
	 * hash served beside a seed proves nothing an attacker holding that host cannot
	 * forge; it is a LABEL for early rejection, and TLS already covers transport.
	 * A pin is worth what the place it came FROM is worth, which is the build.
	 *
	 * A value not in that rendering RAISES rather than refusing, before anything is
	 * fetched: a malformed pin is a mistake in the caller's own source, and
	 * reported as an integrity mismatch it would point at the artifact instead
	 * (`pinnedStreamSeedContentHash`).
	 */
	readonly expectedContentHash?: string;
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
 * FETCH a published stream seed from the locations a caller named, CHECK
 * everything a client can establish on its own, and INSTALL it by writing
 * through the public keeper seam.
 *
 * ## THE TRUST CONTRACT, which is the thing to read before using this
 *
 * **The CALLER names the locations and OWNS that choice** (ADR-0066). This
 * fetches from the list it was given, in order, and nowhere else, so there is no
 * origin check to make and no allowlist to build. Where those locations come
 * from is the application's business and the application's risk: a build
 * constant, an environment variable, or a query parameter -- and an app that
 * accepts a RUNTIME OVERRIDE (a `?snapshot=` style parameter) has decided to
 * accept a seed from wherever that override points, which nothing here can see
 * or judge. Ordinarily the list comes from the BUILD, and TLS to a named host is
 * what the client relies on.
 *
 * **A content hash is OPTIONAL** (`expectedContentHash`), because only an
 * IMMUTABLE, release-tied artifact can have one pinned: a build cannot know the
 * hash of a ROLLING artifact, which is how this is deployed.
 *
 * **OMISSION is NOT defended against, and that is the uncomfortable half.** A
 * seed that simply LEAVES LOGS OUT is structurally perfect: it passes every
 * check below, and detecting it would need the historical logs a public node
 * will not serve. So a compromise of the named host poisons every client that
 * fetches from it, SILENTLY -- and because a stored stream is re-folded by every
 * later generation, the poison is inherited by generations that downloaded
 * nothing. **The named host must therefore be trusted the way the BUILD PIPELINE
 * is trusted.** The mechanism that would close this is a SIGNATURE against a
 * build-pinned key, which is named and deliberately not built (ADR-0066).
 *
 * ## What it CHECKS, all of it before the first write
 *
 * Every mandatory check precedes the first `saveNewEvents`, which is what makes
 * a half-verified stream unexpressible rather than a state somebody has to
 * define (ADR-0065). In order, and each is a refusal reason:
 *
 *  1. **Integrity**, when a hash was pinned: over the decompressed octets,
 *     before the parse.
 *  2. **Readability**: a document this build's reader accepts.
 *  3. **Identity** (ADR-0064): EXACT stream-digest equality, computed by the
 *     client from the artifact's own resolved config and stored context. A
 *     publisher whose filter is a strict SUPERSET is refused, and the refusal
 *     names the DIRECTION.
 *  4. **Reach-back**: the seed covers the block this client reads from.
 *  5. **Coherence** (ADR-0065): O(n) over the events, needing no node.
 *  6. **Capture depth** (ADR-0065): the coverage ends at least `finality` blocks
 *     below the head the producer observed.
 *
 * What is deliberately NOT checked: chain anchoring and bloom consistency (half
 * a defence against half the threat -- a bloom proves FABRICATION, never
 * OMISSION), and omission itself, which is impossible within the premise rather
 * than deferred.
 *
 * The EMPTINESS gate (ADR-0067) runs before all of them and before any fetch, so
 * none of the checks above is ever reached against a subtree that already holds
 * a stream -- which is why no seed a client downloads can be what costs it its
 * history, and why a client that already has a stream pays no download to be
 * told it may not install over it.
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
 * What DOES throw is a malformed `expectedContentHash`, the keeper failing
 * mid-install, or the keeper declining a batch that continues exactly what this
 * call itself just wrote. None is an ordinary condition: the first is a mistake
 * in the caller's own source, and the last can only mean something else wrote
 * into this subtree while the install was running, which the one-writer rule
 * forbids.
 *
 * ## A RELATIVE, hostless path is a first-class location
 *
 * An artifact shipped inside the application's own build, ordinarily listed LAST
 * so the app still starts when its remote is unreachable or gone. It needs no
 * host, no TLS relationship and no trust decision separate from the app's own,
 * because it arrives in the same delivery as the code that reads it.
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
	// Raised before anything is fetched, and before the emptiness probe: a pin that
	// is not in the rendering a producer prints is a mistake in the CALLER's source,
	// and every location would otherwise refuse with an integrity mismatch that
	// points at the artifact.
	const expectedContentHash =
		options.expectedContentHash === undefined ? undefined : pinnedStreamSeedContentHash(options.expectedContentHash);
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
	// Computed ONCE for the whole walk rather than per location: the client's own
	// identity does not depend on which mirror answered, and `sourceHashesOf` walks
	// every contract's every event.
	const client = clientIdentityOf(options.source, options.streamConfig);

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

		// FIRST of the admission checks, and before the parse, because the pin is over
		// exactly these octets (ADR-0066): after any transfer decoding, before
		// `JSON.parse`, and never over a re-serialisation of the parsed value.
		if (expectedContentHash !== undefined) {
			const actual = streamSeedContentHash(payload);
			if (actual !== expectedContentHash) {
				namedLogger.error(
					`the document at ${location} hashes to ${actual} and this build pinned ${expectedContentHash}, so it is ` +
						`not the artifact this build was released against.`,
				);
				reasons.add('integrity-mismatch');
				continue;
			}
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

		const notForThisStream = identityRefusalOf(seed, options.source, client);
		if (notForThisStream) {
			namedLogger.warn(`ignoring the stream seed at ${location}: ${notForThisStream.why}`);
			reasons.add(notForThisStream.reason);
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

		const incoherence = incoherenceOf(seed);
		if (incoherence) {
			namedLogger.error(`ignoring the stream seed at ${location}: it contradicts itself -- ${incoherence}`);
			reasons.add('incoherent');
			continue;
		}

		const depth = seed.chainHeadAtCapture - seed.coverage.toBlock;
		if (depth < options.streamConfig.finality) {
			namedLogger.error(
				`ignoring the stream seed at ${location}: it reaches to ${seed.coverage.toBlock} and its producer observed a ` +
					`head of ${seed.chainHeadAtCapture}, ${depth} block(s) of margin against a finality of ` +
					`${options.streamConfig.finality}. A capture taken that close to the tip can record a branch that later ` +
					`lost, and it leaves no trace: it carries no retraction and is perfectly coherent.`,
			);
			reasons.add('inside-reorg-window');
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

/** What the CLIENT is, as the identity check needs it: computed once per install. */
type ClientIdentity = {
	readonly sourceHashes: readonly SourceHashEntry[];
	readonly configHash: string;
	readonly digest: string;
};

function clientIdentityOf<ABI extends Abi>(
	source: IndexingSource<ABI>,
	streamConfig: UsedStreamConfig,
): ClientIdentity {
	const sourceHashes = sourceHashesOf(source);
	return {
		sourceHashes,
		configHash: streamConfigHashOf(streamConfig),
		digest: streamDigestOfSourceHashes(sourceHashes, streamConfig),
	};
}

/**
 * WHETHER THIS SEED IS FOR THIS STREAM, and if not, which way the two disagree.
 *
 * ## Admission is EXACT digest equality, and the digest is RECOMPUTED
 *
 * The client computes the publisher's 128-bit digest from the artifact's own
 * resolved config and its own stored context (`streamDigestOfSourceHashes`), and
 * compares it with its own. Nothing here trusts a claim: the seed's
 * `streamDigest` is a LABEL, worth carrying so a manifest can be rejected before
 * a body is downloaded, and it is VERIFIED rather than believed -- a label that
 * disagrees with the document carrying it makes the document incoherent.
 *
 * Comparing the seed's `context.config` instead would be a 32-bit comparison at
 * the one boundary where the input is not ours, which is exactly the weakness
 * the digest was widened to 128 bits to avoid (ADR-0064).
 *
 * ## Why a SUPERSET is refused, which is the surprising half
 *
 * `verdictOn` runs the stream half with `removalInvalidates: false`, so a
 * publisher's extra entries are IGNORED and the stream verdict reads VALID. That
 * tolerance is about a LOCAL cache the client already owns, whose extra events
 * it fetched itself under its own earlier filter. A downloaded superset is not
 * that, and its extra events would be stored under the CLIENT's digest, re-folded
 * by every later generation, and handed to a processor implementing
 * `handleUnparsedEvent`. So the verdict is not the admission rule here; it is
 * what NAMES the direction once the digests have already disagreed.
 *
 * ## The order of the three, which is what makes a refusal useful
 *
 * Chain, then config, then direction. Each earlier one is subsumed by the digest
 * and reported anyway, because a digest that moved says nothing a developer can
 * act on: the chain and the config are the two mistakes with an obvious remedy.
 */
function identityRefusalOf<ABI extends Abi>(
	seed: StreamSeed,
	source: IndexingSource<ABI>,
	client: ClientIdentity,
): {reason: NotInstalledReason; why: string} | undefined {
	const published = streamDigestOfSourceHashes(seed.context.source, seed.streamConfig);
	if (seed.streamDigest !== published) {
		return {
			reason: 'incoherent',
			why:
				`it labels itself ${seed.streamDigest} while its own context and resolved config produce ${published}. ` +
				`The label is verified, never trusted, so a document disagreeing with itself is refused before it is compared ` +
				`with anything.`,
		};
	}
	const publishedConfigHash = streamConfigHashOf(seed.streamConfig);
	if (seed.context.config !== publishedConfigHash) {
		return {
			reason: 'incoherent',
			why:
				`its stored context was written under stream config ${seed.context.config} while it declares the resolved ` +
				`config ${publishedConfigHash}, so it claims a stream identity its own events were not captured under.`,
		};
	}

	if (published === client.digest) {
		return undefined;
	}

	if (seed.chain && (seed.chain.chainId !== source.chainId || genesisDiffers(seed.chain.genesisHash, source))) {
		return {
			reason: 'chain-mismatch',
			why: `it was captured on chain ${seed.chain.chainId} and this client indexes chain ${source.chainId}.`,
		};
	}

	if (publishedConfigHash !== client.configHash) {
		return {
			reason: 'stream-config',
			why:
				`it was captured under a different resolved stream config (${JSON.stringify(seed.streamConfig)}), which ` +
				`decides what is STORED as much as the filter does.`,
		};
	}

	// The verdict is taken AT the seed's coverage end, which is what "an added entry
	// at or below the seed's coverage" means: an entry starting above what the seed
	// reaches had nothing to say inside it.
	const verdict = sourceInvalidationOf(
		[...client.sourceHashes],
		client.configHash,
		seed.coverage.toBlock,
		seed.context,
	).stream;
	if (verdict.valid) {
		return {
			reason: 'seed-covers-more',
			why:
				`its filter is strictly WIDER than this client's, so installing it would store events under this client's ` +
				`digest that this client never asked for. Which of the two is out of date is not something this can know.`,
		};
	}
	return {
		reason: 'seed-covers-less',
		why:
			`it LACKS something this client indexes, from block ${verdict.invalidFromBlock} (${verdict.reason}). Which of ` +
			`the two is out of date is not something this can know.`,
	};
}

/** Only compared when BOTH sides state one: absence is "not stated", never "differs". */
function genesisDiffers<ABI extends Abi>(declared: string | undefined, source: IndexingSource<ABI>): boolean {
	return declared !== undefined && source.genesisHash !== undefined && declared !== source.genesisHash;
}

/**
 * WHETHER THE SEED CONTRADICTS ITSELF, in ONE pass over the events and with no
 * node in the loop (ADR-0065).
 *
 * Returns what is wrong, for the LOG, or `undefined`. The caller turns it into
 * the single `incoherent` reason: which rule failed is a publisher's debugging
 * problem, and an application renders the same thing for all of them.
 *
 * O(n) in time and in memory, deliberately, because a seed is downloaded before
 * it is checked and a check costing more than the parse would be paid on every
 * start. Two maps carry the whole of it: one block hash per block number, and
 * the state of each `(blockHash, logIndex)`.
 *
 * ## Why the ordering rules are stated over APPLICATIONS
 *
 * A RETRACTION repeats a coordinate by definition: it is an append-only fact
 * about an event already in the stream, which a replay HONOURS (ADR-0042,
 * ADR-0006). Read literally over every event, "strictly increasing
 * `(blockNumber, logIndex)`" and "no duplicate `(blockHash, logIndex)`" would
 * ban the very artifact ADR-0065 refuses to ban -- a seed derived from a
 * server's append-only emission stream. So those two rules are asserted over the
 * applications, and a retraction is held to its own rule instead: it must be
 * preceded by an application of the same coordinate that is still standing, and
 * the artifact's DECLARED producer must admit one at all. A seed that says it
 * came from a `capture` and carries a retraction contradicts its own provenance,
 * which is sharper than a blanket ban and leaves the stored-stream artifact
 * buildable.
 *
 * The block-hash rule and the coverage rule apply to EVERY event, retractions
 * included: a retraction carries the hash of what it retracts, so it introduces
 * no second hash, and an event outside the claimed coverage is outside it
 * whichever way it arrived.
 */
function incoherenceOf(seed: StreamSeed): string | undefined {
	const admitsRetractions = seed.producer.kind === 'stored-stream';
	const hashAtBlock = new Map<number, string>();
	/** `(blockHash, logIndex)` -> is the event STANDING (applied and not retracted). */
	const standing = new Map<string, boolean>();
	let previousBlock = -1;
	let previousLogIndex = -1;

	for (const event of seed.eventStream) {
		// THE SHAPE FIRST, because every rule below is a COMPARISON and a comparison
		// against `undefined` is FALSE rather than a refusal. An event with no
		// `blockNumber` would pass coverage containment, the ordering rule and the
		// duplicate rule alike -- all three vacuously -- and be INSTALLED, and a stored
		// stream is re-folded by every later generation, so that is permanent. The
		// reader types what IT does arithmetic on (`parseStreamSeed`); these are the
		// fields only this pass touches, so this is where they are typed.
		if (
			!event ||
			typeof event !== 'object' ||
			typeof event.blockNumber !== 'number' ||
			typeof event.logIndex !== 'number' ||
			typeof event.blockHash !== 'string'
		) {
			return `an event that is not one: every entry must carry a numeric blockNumber and logIndex and a string blockHash`;
		}
		const at = `block ${event.blockNumber}, log ${event.logIndex}`;
		if (event.blockNumber < seed.coverage.fromBlock || event.blockNumber > seed.coverage.toBlock) {
			return `an event at ${at} sits outside the coverage it claims (${seed.coverage.fromBlock} to ${seed.coverage.toBlock})`;
		}

		const known = hashAtBlock.get(event.blockNumber);
		if (known === undefined) {
			hashAtBlock.set(event.blockNumber, event.blockHash);
		} else if (known !== event.blockHash) {
			// two hashes at one height is an UNRECONCILED reorg: one of the two branches
			// never happened, and nothing in the document says which
			return `block ${event.blockNumber} carries two block hashes (${known} and ${event.blockHash})`;
		}

		const coordinate = `${event.blockHash}:${event.logIndex}`;
		if (event.removed) {
			if (!admitsRetractions) {
				return `a retraction at ${at}, from an artifact declaring the producer kind '${seed.producer.kind}', which fetches canonical historical ranges and cannot produce one`;
			}
			if (standing.get(coordinate) !== true) {
				return `a retraction at ${at} with no standing application of the same (blockHash, logIndex) before it`;
			}
			standing.set(coordinate, false);
			continue;
		}

		if (standing.has(coordinate)) {
			return `a duplicate (blockHash, logIndex) at ${at}`;
		}
		standing.set(coordinate, true);

		if (
			event.blockNumber < previousBlock ||
			(event.blockNumber === previousBlock && event.logIndex <= previousLogIndex)
		) {
			return `an event at ${at} does not come after block ${previousBlock}, log ${previousLogIndex}`;
		}
		previousBlock = event.blockNumber;
		previousLogIndex = event.logIndex;
	}
	return undefined;
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

/**
 * The most specific thing that went wrong, when several did.
 *
 * Ordered by what it tells the person who has to act. A seed that was READ and
 * found to be for another stream says something about the BUILD; one that was
 * read and found rotten says something about the PUBLISHER; and "could not be
 * reached" says only that a mirror was down, which is the least of them and so
 * the fallback.
 */
function pickReason(reasons: ReadonlySet<NotInstalledReason>): NotInstalledReason {
	for (const reason of [
		'chain-mismatch',
		'stream-config',
		'seed-covers-less',
		'seed-covers-more',
		'does-not-reach-back',
		'inside-reorg-window',
		'incoherent',
		'integrity-mismatch',
		'unreadable-format',
		'unreachable',
	] as const) {
		if (reasons.has(reason)) return reason;
	}
	return 'unreachable';
}
