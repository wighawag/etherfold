import type {EmissionAppender, EmittedLog} from '@etherfold/core';
import type {RemoteSQL, SQLPreparedStatement} from 'remote-sql';

// ---------------------------------------------------------------------------------------------------
// THE STORED EMISSION STREAM: APPEND, AND FLAG WHAT WAS SUPERSEDED
// ---------------------------------------------------------------------------------------------------
// ADR-0006 decides the substance: the server keeps the emission stream the fold
// already produces -- retractions included, superseded rows FLAGGED rather than
// deleted -- because that is what the code computes, so persisting it is zero
// derivation, while the canonical view is cheaply derived from it and not the
// reverse. No retraction information is ever destroyed here.
//
// ## WHO calls this, and when (ADR-0052)
//
// The fold does, through the `EmissionAppender` port on `StreamBuilder`, which
// `emissionAppenderFor` below binds to a database and a NAME. It used to be the
// HTTP ingest route, which made the stored stream a fact about the TRANSPORT in
// exactly the way ADR-0050 found the reorg count to be: a combined `etherfold
// run` folds through `createDirectIngestion`, reaches no route, and produced a
// database whose emission table was EMPTY -- on the deployment shape the
// milestone calls the default, and on the artifact `build` exists to emit.
//
// The objection that kept it here was the KEY: half of it is the INDEXER NAME,
// and the route segment was the only place that value existed, since `--indexer`
// was refused on `run` and `build` outright. That is what changed. The name is
// UNIVERSAL rather than a wire concept (ADR-0036), so a combined process now
// resolves one too (optional, with a default -- it routes no batch, so ADR-0036's
// never-defaulted rule, which protects the WIRE, does not reach it), and the
// value is closed over by the HOST that supplies the appender. Nothing is
// duplicated: `IndexerRegistryEntry` still carries no name, because the closure
// is not a second copy an entry could disagree with -- it IS the host's copy.
//
// **This write is not best-effort, and that is the one way it differs from the
// reorg counter.** See `EmissionAppender` in `@etherfold/core`: it runs BEFORE
// the fold and its failure refuses the batch, because a lost count is a number
// and a lost emission is a HOLE.
// ---------------------------------------------------------------------------------------------------

/**
 * The table's name, spelled once so a read and a write cannot drift apart.
 *
 * In the reserved `_` namespace like every other FIXED table, because the entity
 * tables of a processor are created in this same database and an entity named
 * after this one would have collided with it silently. `@etherfold/state-store`
 * refuses a declaration whose name starts with `_`, so being here is what makes
 * that impossible; see the note at the top of `schema/sql/db.sql`.
 */
export const EMISSION_STREAM_TABLE = '_emissions';

/** One append: the two discriminators every row carries, and the emissions to write under them. */
export type EmissionAppend = {
	/**
	 * The NAMED INDEXER (ADR-0036): the multi-tenancy unit these rows belong to.
	 *
	 * It is the HOST's value, never the fold's -- the route segment a batch was
	 * posted to on a split deployment, and the name the operator gave a combined one
	 * (`--indexer`, defaulted there and only there).
	 */
	indexer: string;
	/**
	 * WHICH stream, as `streamDigestOf` renders it (`LogIngestion.streamDigest`).
	 *
	 * NEVER the wire context's `{source, config}`: that is a 32-bit whole-entry
	 * hash kept whole as an identity check between the two halves of a deployment
	 * (ADR-0034), so a decode-only change moves it while the fetch filter is
	 * untouched -- which as a KEY orphans every row already stored.
	 */
	stream: string;
	/** What the fold concluded, in order: applications and retractions together. */
	emissions: readonly EmittedLog[];
};

/**
 * Append one batch's emissions, flagging whatever each retraction supersedes.
 *
 * ## `seq` is allocated per `(indexer, stream)`, from the table itself
 *
 * The high-water mark is read once and the batch is numbered from it, rather
 * than a counter being kept in a process: the intended host is serverless, so
 * an in-memory sequence would be one isolate's private opinion of a value the
 * database owns -- the same argument that keeps `StreamBuilder` reading its
 * cursor on every call. Per PAIR and not per stream alone, because two named
 * indexers with byte-identical sources land on ONE stream digest and would
 * otherwise punch holes in each other's cursor space. Holes are legal by
 * contract, but they should come from compaction rather than from a neighbour.
 *
 * The allocation is not a lock: the PRIMARY KEY `(indexer, stream, seq)` is,
 * and a genuine concurrent append for one pair therefore fails loudly instead
 * of overwriting. It cannot ordinarily happen, because the cursor already
 * serialises batches -- a second one for the same receiver is a `409` before it
 * reaches here.
 *
 * ## A retraction FLAGS, and never deletes
 *
 * Two writes per retraction: the retraction row itself (appended, `removed = 1`,
 * and never `alive` -- it is not something a canonical read may return), and an
 * UPDATE setting `alive = 0` on the emission it takes back. The emission is
 * matched by `(blockHash, logIndex)`, which names ONE log: a reorg retracts a
 * block by hash, and a height names whichever branch won. `alive = 1` is part of
 * the match so that a hash applied, retracted, and applied again flags the row
 * that is live at the time rather than the one already dead.
 *
 * The whole batch goes through `batch()` so a partially-appended stream is not a
 * state the next read can see.
 */
export async function appendEmissions(db: RemoteSQL, append: EmissionAppend): Promise<void> {
	const {indexer, stream, emissions} = append;
	if (emissions.length === 0) return;

	let seq = await readStreamHighWaterMark(db, {indexer, stream});

	const statements: SQLPreparedStatement[] = [];
	for (const emission of emissions) {
		if (emission.removed) {
			statements.push(
				db
					.prepare(
						`UPDATE ${EMISSION_STREAM_TABLE} SET alive = 0
						 WHERE indexer = ?1 AND stream = ?2 AND blockHash = ?3 AND logIndex = ?4
						   AND removed = 0 AND alive = 1`,
					)
					.bind(indexer, stream, emission.blockHash, emission.logIndex),
			);
		}
		seq++;
		statements.push(insertOf(db, indexer, stream, seq, emission));
	}

	await db.batch(statements);
}

/**
 * The APPENDER a receiver is built with, bound to one database and one NAME.
 *
 * This is the shape the write travels in now: a host that owns a store closes
 * over its handle and the named indexer it holds, and hands the result to the
 * `StreamBuilder` it builds (ADR-0052). The fold supplies the other half of the
 * key -- WHICH stream -- because that is a fact about the receiver rather than
 * about the deployment, and closing over it here would mean reading it off a
 * receiver that does not exist yet.
 *
 * One function, so that the shapes which fold (a combined process, a receiver
 * behind an HTTP route, a queue consumer) cannot bind three different things:
 * whatever database a host opened is what its fold is stored into.
 */
export function emissionAppenderFor(db: RemoteSQL, indexer: string): EmissionAppender {
	return ({stream, emissions}) => appendEmissions(db, {indexer, stream, emissions});
}

/**
 * The highest `seq` allocated for one `(indexer, stream)` pair, or `0` when
 * nothing has been appended under it yet.
 *
 * Read by the APPEND to number a batch from, and by the CANONICAL view to mark
 * the point a cursor was minted at, so that "what has been retracted since you
 * last looked" is answerable later. One expression, because the two must agree
 * about what a position in this stream means.
 */
export async function readStreamHighWaterMark(db: RemoteSQL, at: {indexer: string; stream: string}): Promise<number> {
	const read = await db
		.prepare(`SELECT COALESCE(MAX(seq), 0) AS lastSeq FROM ${EMISSION_STREAM_TABLE} WHERE indexer = ?1 AND stream = ?2`)
		.bind(at.indexer, at.stream)
		.all<{lastSeq: number}>();
	return Number(read.results[0]?.lastSeq ?? 0);
}

/**
 * One row, as the node reported it.
 *
 * The topics are SPREAD into columns rather than stored as a blob, because a
 * later node-compatible `eth_getLogs` filters on them and a blob makes that a
 * table scan (`work/specs/proposed/node-log-api.md`). A log carries at most
 * four, and fewer than four is `NULL` rather than an empty string: an anonymous
 * event has no `topic0` at all, and "absent" and "empty" must not be the same
 * value to a filter.
 */
function insertOf(
	db: RemoteSQL,
	indexer: string,
	stream: string,
	seq: number,
	emission: EmittedLog,
): SQLPreparedStatement {
	const topics = emission.topics ?? [];
	return db
		.prepare(
			`INSERT INTO ${EMISSION_STREAM_TABLE} (
				indexer, stream, seq, removed, alive,
				blockNumber, blockHash, logIndex, transactionHash, transactionIndex, blockTimestamp,
				address, topic0, topic1, topic2, topic3, data
			 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
		)
		.bind(
			indexer,
			stream,
			seq,
			emission.removed ? 1 : 0,
			// a retraction is never canonical, and an application is until something
			// retracts it
			emission.removed ? 0 : 1,
			emission.blockNumber,
			emission.blockHash,
			emission.logIndex,
			emission.transactionHash,
			emission.transactionIndex,
			emission.blockTimestamp ?? null,
			emission.address,
			topics[0] ?? null,
			topics[1] ?? null,
			topics[2] ?? null,
			topics[3] ?? null,
			emission.data,
		);
}
