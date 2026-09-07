import {sha256} from 'viem';
import type {ContextIdentifier, StoredLogEvent, UsedStreamConfig} from '../types.js';

/**
 * The on-disk format version of a PUBLISHED STREAM SEED.
 *
 * ## Why a seed has its own number, and does not borrow `STREAM_FIXTURE_FORMAT`
 *
 * A seed is not a fixture, and the two documents differ in what they CARRY. A
 * fixture is a CAPTURE: it holds decoded events, so a replay does not re-run the
 * decoder, and it holds the `IndexingSource` those events were decoded against.
 * A seed holds the STORED half only (the install strips the decoded half anyway,
 * ADR-0060, and publishing it costs a third of the artifact for bytes the client
 * parses and discards), plus the three things a client needs to establish what
 * the artifact IS without trusting the host that served it: the RESOLVED stream
 * config (ADR-0064), the digest as a label it VERIFIES, and a typed declaration
 * of what produced it (ADR-0065).
 *
 * Sharing one number would let each reader HALF-PARSE the other's document --
 * a fixture read as a seed carries no resolved config and no digest, and a seed
 * read as a fixture has no `source` and no decoded half. Two numbers is what
 * makes each of those a refusal.
 *
 * ## Why it is 1
 *
 * Nothing preceded it. ADR-0063 is explicit that `STREAM_FIXTURE_FORMAT` is
 * untouched by this work, so this sequence starts fresh rather than continuing
 * the fixture's.
 */
export const STREAM_SEED_FORMAT = 1;

/**
 * WHAT KIND of thing produced a seed's events, which is a rule and not a label.
 *
 * ADR-0065 states the retraction rule against this declaration rather than
 * banning retractions outright: `captureStream` fetches canonical historical
 * ranges and so cannot produce one, while a seed derived from a SERVER's stored
 * emission stream legitimately carries apply/retract pairs (that table is
 * append-only, retractions included, ADR-0006). So a seed that says `capture`
 * and carries a `removed` event contradicts its own declaration and is refused
 * on that, which is sharper than a blanket ban and leaves the stored-stream
 * artifact buildable.
 *
 * The check itself belongs to the loader's admission pass; what lives here is
 * the field it is stated against.
 */
export type StreamSeedProducerKind = 'capture' | 'stored-stream';

/**
 * A TYPED declaration of what produced a seed.
 *
 * Typed, and not a free-form provenance bag, because a rule is stated against it
 * (above) and because the retraction refusal cannot be written against a key
 * that may or may not be there. `StreamFixtureProvenance` is deliberately the
 * opposite -- free-form beyond four fields, since what makes a CAPTURE
 * trustworthy is domain-specific -- and a seed is the one document where this
 * particular fact is load-bearing rather than informative.
 */
export type StreamSeedProducer = {
	/** Which mechanism produced the events, and therefore which retraction rule applies. */
	kind: StreamSeedProducerKind;
	/** What ran, in enough detail that a reader can go and look at it. */
	name: string;
	/**
	 * ISO-8601, when that ran.
	 *
	 * When the EVENTS were produced, not when the file was written. All three
	 * fields describe one thing -- the production of the events -- and dating the
	 * emit instead would also make the artifact non-deterministic, so re-emitting
	 * an unchanged capture would move the content hash a build had pinned.
	 */
	at: string;
};

/**
 * How far a seed REACHES, which is not where its events are.
 *
 * The client-side counterpart of the stored stream's coverage claim (ADR-0055),
 * and it is load-bearing at both ends. `fromBlock` becomes the installed
 * stream's `startBlock`, and a seed claiming its first EVENT's block instead
 * would be CLEARED on first load by a client whose source starts earlier -- the
 * ordinary case, since a contract's `startBlock` is routinely below the first
 * log it emitted. `toBlock` is above the last event-bearing block, because a
 * quiet range moves the cursor without adding a row; cut it short and the client
 * re-scans every quiet block at the end of the capture, which on a public node
 * is exactly the fetch it cannot make (ADR-0063).
 */
export type StreamSeedCoverage = {
	fromBlock: number;
	toBlock: number;
};

/**
 * A PUBLISHED STREAM SEED: a stream a client can install without ever asking a
 * node for a historical log.
 *
 * There is deliberately no ABI type parameter, and that is the shape of the
 * thing rather than an omission: every event here is a `StoredLogEvent`, which
 * is what the node said and nothing an ABI made of it, so there is no decoded
 * half for an ABI to type.
 *
 * ## What it does NOT carry
 *
 * **Its own integrity hash.** A document cannot contain a hash of itself. The
 * client hashes the octets it received (`streamSeedContentHash`) and compares
 * them against a value a build pinned; the producer's job is to PRINT that hash,
 * not to embed it (ADR-0065, as superseded on the trust anchor by ADR-0066).
 *
 * **An `IndexingSource`.** A client computes the publisher's digest from the
 * source HASH ENTRIES in `context` plus `streamConfig`
 * (`streamDigestOfSourceHashes`), so shipping the ABIs would be shipping bytes
 * nothing reads. It also could not be trusted if it were here: the digest is
 * recomputed, never believed.
 */
export type StreamSeed = {
	format: typeof STREAM_SEED_FORMAT;
	/** What produced it, typed, because the retraction rule is stated against it (ADR-0065). */
	producer: StreamSeedProducer;
	/**
	 * The chain head the producer OBSERVED when it took the events.
	 *
	 * The capture-depth check reads it: a capture taken close to the tip can
	 * record a branch that later lost, and it leaves NO trace -- no retraction,
	 * perfectly coherent, simply describing a chain that did not happen. This is
	 * the stream analogue of the snapshot path's `inside-reorg-window` refusal,
	 * and it needs no node precisely because this number travels with the
	 * artifact.
	 */
	chainHeadAtCapture: number;
	/**
	 * The RESOLVED stream config the events were captured under.
	 *
	 * Resolved (`resolveStreamConfig`) rather than as some publisher spelled it,
	 * for the same reason every other site resolves before hashing: an unset
	 * `finality` and the default written out are ONE config everywhere else, and
	 * a seed carrying the unresolved form would compute a digest no client
	 * reaches. It is here at all because a client cannot compute the publisher's
	 * 128-bit digest without it, and comparing the 32-bit `context.config`
	 * instead would reintroduce exactly the weakness the digest was widened to
	 * avoid, at the one boundary where the input is not ours (ADR-0064).
	 */
	streamConfig: UsedStreamConfig;
	/**
	 * The stream digest, as a LABEL the client verifies rather than trusts.
	 *
	 * Worth carrying even though it is recomputable from the two fields above: a
	 * manifest can be fetched and a seed rejected BEFORE its body is downloaded,
	 * and a label the client recomputes costs nothing to distrust.
	 */
	streamDigest: string;
	/** How far this seed reaches, from and to. */
	coverage: StreamSeedCoverage;
	/**
	 * The seed's OWN stored context: the source hash entries the identity check
	 * reads, plus the 32-bit config hash and the processor slot as the capture
	 * wrote them.
	 *
	 * It is installed VERBATIM (ADR-0063). Writing the client's own hashes
	 * instead would make the load path's `streamMatches` check compare the client
	 * against itself, discarding a structural defence for nothing.
	 */
	context: ContextIdentifier;
	/** Every event, in stream order, stripped to what the node said (ADR-0060). */
	eventStream: StoredLogEvent[];
};

/**
 * A seed as text: COMPACT, always.
 *
 * A fixture is indented because it is read and diffed by humans; a seed is a
 * PUBLISHED artifact that is fetched, parsed and thrown away, and the
 * measurement that chose this wire shape measured the compact form (26.5 MB
 * against 33.8 MB before the stored-only strip;
 * `work/notes/findings/what-a-published-stream-seed-costs-to-install.md`). So
 * indentation is not a parameter here: a producer that indented would emit a
 * different byte domain for the same seed and move the hash a build pinned.
 *
 * No BigInt codec, and its absence is the point: the stored half has no decoded
 * `uint256` in it, so a seed parses with a plain `JSON.parse` and pays none of
 * the tagged-BigInt revive a fixture does (160 ms of a 470 ms desktop install,
 * bought purely to be discarded).
 */
export function serializeStreamSeed(seed: StreamSeed): string {
	return JSON.stringify(seed);
}

/**
 * The OCTETS a seed's content hash is taken over: the compact document, UTF-8.
 *
 * This function exists so that "which bytes" is one decision made once. The
 * producer hashes what it is about to publish and the loader hashes what it
 * received, and if those two disagree every pinned install refuses with an
 * integrity mismatch while each side's own tests pass.
 */
export function streamSeedPayloadOf(seed: StreamSeed): Uint8Array {
	return new TextEncoder().encode(serializeStreamSeed(seed));
}

/**
 * The CONTENT HASH of a seed: `sha256:<64 lowercase hex>` over the DECOMPRESSED
 * payload octets.
 *
 * ## The byte domain, which is decided and not negotiable (ADR-0066)
 *
 * The octets as they exist AFTER any transfer decoding and BEFORE `JSON.parse`
 * -- never the gzipped file, and never a re-stringified parse. Over the
 * compressed file the domain is not even well-defined at the client: a host that
 * sets `Content-Encoding: gzip` makes `fetch` decompress transparently, so a
 * client could not reproduce a hash of the compressed bytes from anything it
 * holds, and a rule forbidding that header is one a publisher on Pages,
 * CloudFront or a gateway frequently cannot enforce. Hashing the decompressed
 * octets is transport-INVARIANT, so opaque and transparently-decoded delivery
 * land on the same value and no hosting constraint is implied.
 *
 * It takes BYTES and not a string, deliberately. A caller handing over text
 * would have had to encode it, and a caller handing over a PARSED seed would be
 * hashing a re-serialisation -- integrity resting on a round trip JSON does not
 * guarantee is the failure this domain was chosen to avoid.
 *
 * ## Why it is rendered with its algorithm in front
 *
 * A build PASTES this value into its source, where it long outlives the session
 * that produced it. A bare hex string cannot say which function produced it, so
 * the day a second one exists every pinned literal is ambiguous. `sha256:` is
 * the prefix an OCI image digest uses and it splits on one character.
 *
 * ## Why SHA-256
 *
 * The one hash this project already has (`streamDigestOf` uses viem's, for a
 * reason its own docstring gives: already a dependency, and SYNCHRONOUS, which
 * `crypto.subtle` is not). A second primitive would be a second thing two ends
 * must agree on.
 */
export function streamSeedContentHash(payload: Uint8Array): string {
	return `sha256:${sha256(payload).slice(2)}`;
}

/**
 * Read a seed back, refusing anything that is not one.
 *
 * It THROWS, exactly as `parseStreamFixture` does, and the loader CATCHES:
 * ADR-0064's refusal vocabulary carries `unreadable-format` as data, so the
 * conversion happens at the one place that owns the refusal type rather than
 * being spread across a reader that has to return two shapes. A truncated file,
 * a fixture handed to the wrong reader and a future format all arrive at the
 * same refusal, which is right -- each of them is a document this build cannot
 * read.
 *
 * The checks are deliberately shallow. Whether the events are ORDERED, whether
 * each block carries one hash, whether they sit inside the claimed coverage and
 * whether the capture was taken far enough below the head are ADMISSION checks
 * that run before the first write (ADR-0065); making them parse errors would
 * turn a refusal a client can explain into an exception it cannot.
 *
 * Shallow does NOT mean untyped, though, and the three NUMBERS are checked here
 * for a reason worth stating: an admission check compares them arithmetically,
 * and a missing one arrives as `undefined` rather than as a refusal. The
 * capture-depth check is the sharp case -- `chainHeadAtCapture - coverage.toBlock
 * < finality` on an absent head is `NaN < finality`, which is FALSE, so a seed
 * carrying no observed head would be ADMITTED by the very check written to
 * refuse it. A comparison that silently passes is the one failure a shallow
 * reader must not hand downstream, so the fields an admission check does
 * arithmetic on are typed at the door. `0` is a legal block number, so this is a
 * `typeof` test and never a truthiness one.
 */
export function parseStreamSeed(text: string): StreamSeed {
	const parsed = JSON.parse(text) as Partial<StreamSeed>;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`not a stream seed: expected an object`);
	}
	if (parsed.format !== STREAM_SEED_FORMAT) {
		throw new Error(`unsupported stream seed format: ${parsed.format} (this build reads ${STREAM_SEED_FORMAT})`);
	}
	if (!parsed.producer || !parsed.streamConfig || !parsed.streamDigest || !parsed.coverage || !parsed.context) {
		throw new Error(`not a stream seed: missing producer, streamConfig, streamDigest, coverage or context`);
	}
	if (!Array.isArray(parsed.eventStream)) {
		throw new Error(`not a stream seed: missing eventStream`);
	}
	if (typeof parsed.chainHeadAtCapture !== 'number') {
		throw new Error(`not a stream seed: chainHeadAtCapture must be a number`);
	}
	if (typeof parsed.coverage.fromBlock !== 'number' || typeof parsed.coverage.toBlock !== 'number') {
		throw new Error(`not a stream seed: coverage must carry a numeric fromBlock and toBlock`);
	}
	return parsed as StreamSeed;
}
