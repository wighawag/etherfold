import type {EmittedLog} from './types.js';

/**
 * ONE batch of the stored EMISSION STREAM, as the fold hands it over.
 *
 * The two things the receiver knows and its host does not: WHICH stream these
 * logs belong to, and WHAT the fold concluded about them. The remaining half of
 * the stored row's key -- the NAMED INDEXER -- is the HOST's, closed over by
 * whoever supplies the appender, because that value comes from a deployment
 * (`--indexer`, or the name a host registered) and never from the fold.
 */
export type EmissionWrite = {
	/**
	 * WHICH stream, as `streamDigestOf` renders it (`LogIngestion.streamDigest`).
	 *
	 * Handed over rather than closed over, because the appender is built BEFORE the
	 * receiver that knows this value and the two must not be able to disagree about
	 * it. NEVER the wire context's `{source, config}`, which is a 32-bit change
	 * detector between two halves of a deployment (ADR-0034): as a key it moves on
	 * a decode-only ABI change and orphans every row already stored.
	 */
	stream: string;
	/**
	 * What the fold concluded, in order: applications and retractions together,
	 * retractions carrying their ORIGINAL block.
	 *
	 * Exactly `IngestionOutcome.emissions`, and deliberately the same array: this
	 * receiver is the one thing that is authoritative about what the fold
	 * concluded, so a store must not compute a second opinion of it.
	 */
	emissions: readonly EmittedLog[];
};

/**
 * Where the fold's emission stream is STORED, injected into the receiver by
 * whoever owns the store.
 *
 * The stored stream is a fact about the FOLD and not about the transport
 * (ADR-0052), so it cannot belong to an HTTP route: a combined process folds
 * through `createDirectIngestion` and touches no route at all, and produced a
 * database with an EMPTY emission table as a result. It cannot belong to this
 * package either, which stores nothing and knows no database. So the receiver
 * hands each batch to one collaborator, exactly once, BEFORE it folds it, and
 * the deployment that opened the database supplies that collaborator.
 *
 * ## This one is NOT best-effort, and that is the whole difference from `ReorgRecorder`
 *
 * A recorder may fail and must never be allowed to matter: losing a count is a
 * far better trade than rolling back the state it describes, so `StreamBuilder`
 * catches it. An appender that failed is the OPPOSITE trade. A state that
 * advanced past events the stream never received is a **hole**: invisible to the
 * gap check (segments are keyed by SAVE, not by block, so the ordinals stay
 * perfectly contiguous), silent, permanent and self-consistent, because on the
 * next state discard the stream replays as though it were whole and the missing
 * blocks are simply absent from the rebuilt state. So a failure here PROPAGATES
 * out of `receive`, nothing is processed, the cursor does not move, and the next
 * cycle re-derives the same delta (`CONTEXT.md`, "hole" versus "gap"; ADR-0038).
 *
 * Absent entirely on a host that stores no stream, in which case nothing is
 * stored and nothing else changes -- and that host has no feed to serve, since
 * both of ADR-0006's views read the table this writes.
 */
export type EmissionAppender = (write: EmissionWrite) => void | Promise<void>;
