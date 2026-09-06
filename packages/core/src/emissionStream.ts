import type {EmittedLog, SourceHashEntry} from './types.js';

/**
 * HOW FAR the stored stream reaches, and under WHICH FILTER it was fetched.
 *
 * The **coverage claim** a stream carries beside its rows: the cursor record
 * ADR-0035 says a SQL keeper keeps, in the shape that ADR ended up with -- the
 * three block numbers plus the stream's identity, and NO unconfirmed window,
 * because a keeper's copy of the window is read by nobody and a replay rebuilds
 * it by walking the events.
 *
 * ## Why it travels with the append rather than being derived from the rows
 *
 * Because the rows cannot answer it. `MAX(blockNumber)` is the highest block
 * that carried a LOG, and a range that carried none moves the fetch cursor
 * without adding a row -- so a claim derived from the rows UNDER-CLAIMS for as
 * long as the chain is quiet, and a successor promoted on it would hand its
 * fetcher an `expectedFromBlock` too far back, whose re-sent batches ADR-0052
 * would append a SECOND time.
 *
 * ## Why it is a property of the STREAM and not of a generation's fold
 *
 * Several generations fold ONE stream (`CONTEXT.md`, **follower**) and only one
 * of them writes it. Stored once beside the stream, every generation folding it
 * inherits the same claim, so a promotion hands over a correct wire cursor with
 * no reconciliation, and writer succession leaves it untouched.
 *
 * ## What is deliberately NOT here
 *
 * The PROCESSOR half of a `ContextIdentifier`. A stream is identified by its
 * fetch filter plus its stream config and by nothing else, so a processor hash
 * stored beside it would be one generation's fact filed under a shared key --
 * the same rule `_emissions` already states about its own columns. Nothing reads
 * it either: only `sourceInvalidationOf`'s STREAM half ever consults a stored
 * context, and that half reads `source` and `config` alone.
 */
export type StreamCoverage = {
	/** The FETCH-filter half of the identity these logs were fetched under. */
	source: SourceHashEntry[];
	/** The stream CONFIG hash, the other half of what identifies a stream. */
	config: string;
	/** The chain tip as it stood when this batch was folded. */
	latestBlock: number;
	/** The first block of the range this batch covered. */
	lastFromBlock: number;
	/** The last block this stream is claimed to cover. */
	lastToBlock: number;
};

/**
 * ONE batch of the stored EMISSION STREAM, as the fold hands it over.
 *
 * The three things the receiver knows and its host does not: WHICH stream these
 * logs belong to, HOW FAR that stream now reaches, and WHAT the fold concluded
 * about the logs themselves. The remaining half of the stored row's key -- the
 * NAMED INDEXER -- is the HOST's, closed over by whoever supplies the appender,
 * because that value comes from a deployment (`--indexer`, or the name a host
 * registered) and never from the fold.
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
	 * HOW FAR that stream now reaches, as this batch leaves it.
	 *
	 * Handed over on EVERY batch, including one that emitted nothing, because a
	 * quiet range moves the claim and nothing else records that it did.
	 */
	coverage: StreamCoverage;
	/**
	 * What the fold concluded, in order: applications and retractions together,
	 * retractions carrying their ORIGINAL block.
	 *
	 * Exactly `IngestionOutcome.emissions`, and deliberately the same array: this
	 * receiver is the one thing that is authoritative about what the fold
	 * concluded, so a store must not compute a second opinion of it.
	 *
	 * MAY BE EMPTY, and an empty one is not a no-op: the batch that carried no
	 * logs still moved `coverage` above, which is what an empty save writes.
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
 * ## It is called on EVERY batch, including one that emitted nothing
 *
 * It once was not, on the reasoning that a cycle which emitted no logs still
 * advances the cursor and leaves a stream nothing to hold. That stopped being
 * true when the write started carrying `coverage`: a quiet range is exactly the
 * case where the ROWS cannot say how far the stream reaches, so skipping it
 * pins the claim at the last log-bearing batch for ever. It is the shape the
 * segment keeper already has -- an empty save writes the cursor record and no
 * segment (ADR-0035) -- and it still costs nothing proportional to the history.
 *
 * Absent entirely on a host that stores no stream, in which case nothing is
 * stored and nothing else changes -- and that host has no feed to serve, since
 * both of ADR-0006's views read the table this writes.
 */
export type EmissionAppender = (write: EmissionWrite) => void | Promise<void>;
