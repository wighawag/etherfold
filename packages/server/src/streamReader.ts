import {
	readOnlyStream,
	resolveStreamConfig,
	streamDigestOf,
	type Abi,
	type ExistingStream,
	type IndexingSource,
	type LogEvent,
	type ReplayChunk,
	type ReplayChunkQuery,
	type ReplaySource,
	type StoredLogEvent,
	type UsedStreamConfig,
} from '@etherfold/core';
import {logs} from 'named-logs';
import type {RemoteSQL} from 'remote-sql';
import {EMISSION_STREAM_TABLE, readStreamCoverage, readStreamHighWaterMark} from './emissions.js';
import {EMISSION_COLUMNS, entryOf, type EmissionRow} from './feed/entries.js';

const logger = logs('@etherfold/server');

// ---------------------------------------------------------------------------------------------------
// THE STORED EMISSION STREAM AS A STREAM A GENERATION CAN RE-FOLD, READ-ONLY
// ---------------------------------------------------------------------------------------------------
// ADR-0006's table holds what the fold produced. This is the THIRD thing that
// reads it, and the only one that is not a view for a consumer: it is an
// `ExistingStream`, so a GENERATION can fold it. That is what makes a
// processor-only upgrade cost a local scan instead of a full re-index -- the
// successor shares a STREAM with the incumbent, so it fetches nothing and
// re-folds what is already on disk (`CONTEXT.md`, **follower**).
//
// ## Read-only, structurally, and not by convention
//
// It goes out through `readOnlyStream`, so `saveNewEvents` and `clear` are
// NO-OPS. That is the ONE-WRITER RULE made structural (ADR-0044): the generation
// that INDEXES a stream appends to it through `EmissionAppender` (ADR-0052), and
// everything else folding it is handed a view whose writes go nowhere. `clear`
// matters more than the symmetry suggests -- the load path clears on every stream
// shape it cannot use, and a re-fold takes those branches over a table another
// generation is still appending to.
//
// ## A REPLAY, not a fetch (ADR-0042)
//
// These rows carry the fold's own VERDICTS: retractions are INCLUDED (a
// `removed` row at its ORIGINAL block) and superseded rows are flagged rather
// than deleted. A consumer of this must HONOUR them instead of re-deriving them
// from a window a rebuild does not have, which is exactly what
// `IndexerGeneration.replay` / `generateStreamFromReplay` do. So `alive` is never
// consulted here (that is the CANONICAL view's rule, and applying it would hide
// the reorgs a re-fold has to replay), the order is `seq` and never
// `(blockNumber, logIndex)`, and nothing is renumbered.
//
// ## HOLES in `seq` are legal
//
// Pair-compaction reclaims a retracted entry together with its retraction and
// leaves the surrounding numbers where they were (ADR-0006), so this is a full
// ordered scan and never an arithmetic walk. A **hole** is legal; a **gap** is
// the segment keeper's damage word and there are no ordinals here to have one.
//
// ## Why this does NOT ride `createSegmentedStream`
//
// Segments exist because the IndexedDB keeper needs a save to cost its batch on
// a substrate with no `seq`. SQL has one: `_emissions` is already `seq`-addressed
// with a validated cursor codec above it, so segmentation would add ordinals to
// allocate, a contiguity rule and a damage class (a GAP) that this substrate
// cannot have. What IS inherited is ADR-0035's contract rather than its layout:
// one authoritative claim per stream, written in the same batch as the rows it
// covers, and PRESENCE is that claim rather than the presence of rows.
// ---------------------------------------------------------------------------------------------------

/**
 * The stored emission stream of one NAMED INDEXER, as a stream a generation can
 * fold and cannot write.
 *
 * The name is closed over because it is the HOST's (ADR-0036), exactly as
 * `emissionAppenderFor` closes over it: the same two values key the read and the
 * write, so they are supplied the same way. The other half of the key -- WHICH
 * stream -- is DERIVED per call from the `source` it is asked about plus the
 * stream config the indexer hands over in `setStreamConfig`, which is the same
 * `streamDigestOf` the appender was given by the receiver. Neither discriminator
 * is ever omitted from a query: omitting the name would serve another tenant's
 * rows under a `seq` that means something else there.
 *
 * The result is wrapped in `readOnlyStream`, which is the one-writer rule
 * (ADR-0044). It is deliberately NOT wrapped in a degrading layer any more: a
 * database error here RAISES, and the load path catches it and treats the stream
 * as absent, which is the same outcome reached at the caller that owns the policy
 * rather than at a keeper deciding for every caller it might have (ADR-0068).
 */
export function storedEmissionStream<ABI extends Abi>(db: RemoteSQL, indexer: string): ExistingStream<ABI> {
	/**
	 * The other half of the stream's IDENTITY, handed over by the indexer before
	 * it asks for anything (`IndexerGeneration.reinit`).
	 *
	 * Defaulted rather than left unset so that a caller which never reinits still
	 * addresses the same digest a receiver built with no explicit stream config
	 * appended under -- one resolver, one default, on both sides of the table
	 * (`resolveStreamConfig`).
	 */
	let streamConfig: UsedStreamConfig = resolveStreamConfig(undefined);

	return readOnlyStream<ABI>({
		setStreamConfig: (next: UsedStreamConfig) => {
			streamConfig = next;
		},
		fetchFrom: async (source: IndexingSource<ABI>, fromBlock: number) => {
			const stream = streamDigestOf(source, streamConfig);

			// PRESENCE is the COVERAGE CLAIM and never "there are rows" -- ADR-0035's
			// rule, and it decides both directions. A stream that has been scanned and
			// found nothing yet is PRESENT with no rows, and must not read as absent or
			// a re-fold would start again from the source's first block on every cycle.
			// Rows with no claim are the opposite: they cannot say what filter produced
			// them or how far they reach, so they are not a stream anything may fold.
			const coverage = await readStreamCoverage(db, {indexer, stream});
			if (!coverage) {
				return undefined;
			}

			if (coverage.startBlock > fromBlock) {
				// A stream that does not reach back to what was ASKED FOR. Reported ABSENT
				// rather than served, because a partial history replays as though it were
				// whole and the missing blocks are simply absent from the rebuilt state --
				// silent, permanent and self-consistent. Nothing is deleted in response,
				// unlike the segment keeper's identical check: this view owns none of these
				// rows, and the generation that DOES own them is still appending to them.
				logger.info(
					`the stored emission stream of '${indexer}' at ${stream} starts at block ${coverage.startBlock} and ` +
						`does not reach back to ${fromBlock}, so it is reported ABSENT rather than replayed as if it were ` +
						`the whole history.`,
				);
				return undefined;
			}

			return {
				eventStream: await readStoredStream(db, {indexer, stream, fromBlock}),
				lastSync: {
					context: {
						source: coverage.source,
						config: coverage.config,
						// A STREAM has no processor, so there is nothing honest to put here. Only
						// `sourceInvalidationOf`'s STREAM half ever reads a stored context, and it
						// reads `source` and `config` alone; the folding generation's own processor
						// hash is on ITS cursor, where it belongs. See `StreamCoverage`.
						processor: '',
					},
					latestBlock: coverage.latestBlock,
					lastFromBlock: coverage.lastFromBlock,
					lastToBlock: coverage.lastToBlock,
					// Stored by nobody and read by nobody: `generateStreamFromReplay` rebuilds
					// the window by WALKING the events it is handed back (ADR-0035 as amended,
					// ADR-0042), which is the only way a rebuild can get it right.
					unconfirmedBlocks: [],
				},
			};
		},
	});
}

/**
 * Every emission of one `(indexer, stream)` from `fromBlock` up, in `seq` order,
 * retractions included.
 *
 * The scan rides the table's PRIMARY KEY `(indexer, stream, seq)` with both
 * discriminators bound, exactly as the feed's does. `blockNumber >= fromBlock`
 * is the same cut every other keeper makes, and it is applied to the row's OWN
 * block: a retraction carries the block of the emission it takes back, so a
 * retraction of something below the cut goes with the thing it retracts rather
 * than arriving to revert a block this fold never applied.
 */
async function readStoredStream(
	db: RemoteSQL,
	query: {indexer: string; stream: string; fromBlock: number},
): Promise<StoredLogEvent[]> {
	const rows = (
		await db
			.prepare(
				`SELECT ${EMISSION_COLUMNS}
				 FROM ${EMISSION_STREAM_TABLE}
				 WHERE indexer = ?1 AND stream = ?2 AND blockNumber >= ?3
				 ORDER BY seq`,
			)
			.bind(query.indexer, query.stream, query.fromBlock)
			.all<EmissionRow>()
	).results;
	return rows.map(storedLogOf);
}

// ---------------------------------------------------------------------------------------------------
// THE SAME ROWS, READ IN BOUNDED SLICES, SO A REBUILD FITS IN AN INVOCATION
// ---------------------------------------------------------------------------------------------------
// `storedEmissionStream` above answers "the whole stream from here", which is
// what a LOAD wants and exactly what a serverless rebuild cannot ask for. This
// is the same rows through the bounded port (`ReplaySource`, `@etherfold/core`),
// so a host can schedule a chunk at a time against a durable checkpoint
// (ADR-0022, ADR-0008). What one chunk IS, and why, is ADR-0056.
//
// ## The budget is EMISSIONS; the CUT is a BLOCK boundary
//
// A budget in rows is what the work is actually proportional to. But the cut
// cannot be at an arbitrary row: this stream is `seq`-ordered and a reorg puts
// an application, its retraction and its replacement at ONE block at
// arbitrarily separated `seq` values, so a chunk ending mid-block would leave
// rows BELOW its own resume point -- and the next chunk resumes above them, so
// they would be skipped for ever, silently. So the cut lands on a BLOCK
// boundary, which makes the budget a budget: a single block carrying more
// emissions than it is served whole rather than halved.
//
// The cut is also never AT OR BELOW `foldedThrough`. A resume point reaches back
// over the reorg window (`getFromBlock`), so a fold sitting inside that window
// asks for blocks it has already folded; a budget spent inside them would cut
// the chunk where the fold already is, and the same chunk would be asked for for
// ever. The extra work that guarantee can cost is bounded by the reorg window,
// which is exactly what one cycle of a live indexer already pays.
//
// The slice goes out in `seq` order, because `seq` is the order the fold
// concluded these verdicts in and the only order a replay may honour them in:
// delivering an application of block N+1 before the retraction of block N would
// have the processor revert past what it had just applied.
//
// Two reads rather than one, for that reason: a PROBE ordered by block, which
// finds the boundary, and then the slice itself ordered by `seq`.
//
// ## No index is added for this scan, deliberately
//
// The canonical index is PARTIAL on `alive = 1`, so ordering by block over a
// stream that includes retractions is a scan of this `(indexer, stream)`'s rows
// whatever the order -- the same position `compactEmissionPairs` is in, and the
// same answer: a third index on a table already weighed against D1's 10GB
// ceiling is paid for by every deployment, and nothing here has been measured
// against a stream large enough to say it earns its keep. The day a rebuild is
// measured slow on a real stream is the day it does.
// ---------------------------------------------------------------------------------------------------

/**
 * The stored emission stream of one NAMED INDEXER, read in bounded slices for a
 * REBUILD.
 *
 * The read counterpart of `emissionAppenderFor`, closing over the same two
 * values for the same reason: the NAME is the HOST's (ADR-0036) and WHICH stream
 * is the fold's, so it arrives on every query. Neither discriminator is ever
 * omitted -- omitting the name would serve another tenant's rows under a `seq`
 * that means something else there.
 *
 * It is READ-ONLY by construction rather than by convention: the port has no
 * write on it at all, so a caller cannot obtain a handle that appends (ADR-0044).
 */
export function storedEmissionReplaySource<ABI extends Abi>(db: RemoteSQL, indexer: string): ReplaySource<ABI> {
	return {
		async readChunk(query: ReplayChunkQuery): Promise<ReplayChunk<ABI> | undefined> {
			const {stream, fromBlock, foldedThrough, maxEmissions} = query;

			// PRESENCE is the COVERAGE CLAIM and never "there are rows", exactly as the
			// unbounded view above decides it: a stream scanned and found empty is present,
			// and rows with no claim cannot say what filter produced them or how far they
			// reach.
			const coverage = await readStreamCoverage(db, {indexer, stream});
			if (!coverage) {
				return undefined;
			}
			if (coverage.startBlock > fromBlock) {
				logger.info(
					`the stored emission stream of '${indexer}' at ${stream} starts at block ${coverage.startBlock} and ` +
						`does not reach back to ${fromBlock}, so a rebuild is told there is nothing to replay rather than ` +
						`being handed a partial history to fold as if it were whole.`,
				);
				return undefined;
			}

			// REPORTED beside the slice, because a follower's completeness is a stream-space
			// property and this is the number that expresses it. What DECIDES that a chunk
			// finished the stream is whether the budget cut this read short.
			const highWater = await readStreamHighWaterMark(db, {indexer, stream});

			// THE PROBE: one more block number than the budget allows, so that hitting the
			// budget is distinguishable from ending exactly on it, and so the extra row
			// NAMES the block the cut has to fall before.
			const probe = await probeBlocks(db, {indexer, stream, fromBlock, limit: maxEmissions + 1});

			// The lowest block this chunk MUST reach, or it advances nothing and is asked
			// for again for ever. See the section note.
			const floor = Math.max(foldedThrough + 1, fromBlock);
			const budgetCut = probe.length > maxEmissions ? (probe[maxEmissions] as number) - 1 : coverage.lastToBlock;
			const lastToBlock = Math.min(coverage.lastToBlock, Math.max(budgetCut, floor));

			return {
				eventStream: await readRange<ABI>(db, {indexer, stream, fromBlock, toBlock: lastToBlock}),
				lastFromBlock: fromBlock,
				// on the un-truncated path this is the STREAM's own claim, which reaches past
				// its last log: a range that carried none moved the cursor without adding a row
				// (ADR-0055)
				lastToBlock,
				latestBlock: coverage.latestBlock,
				// what a scheduler acts on: is there more of the stream above this chunk
				truncated: lastToBlock < coverage.lastToBlock,
				highWater,
			};
		},
	};
}

/**
 * THE PROBE: the block numbers of the next `limit` emissions, in block order.
 *
 * Block numbers alone, because all this decides is WHERE the cut falls; the
 * slice itself is read again in `seq` order, which is the only order a replay
 * may honour. Ordering by `(blockNumber, seq)` is what makes the `limit`-th row
 * name a block boundary rather than an arbitrary position.
 */
async function probeBlocks(
	db: RemoteSQL,
	query: {indexer: string; stream: string; fromBlock: number; limit: number},
): Promise<number[]> {
	const rows = (
		await db
			.prepare(
				`SELECT blockNumber
				 FROM ${EMISSION_STREAM_TABLE}
				 WHERE indexer = ?1 AND stream = ?2 AND blockNumber >= ?3
				 ORDER BY blockNumber, seq
				 LIMIT ?4`,
			)
			.bind(query.indexer, query.stream, query.fromBlock, query.limit)
			.all<{blockNumber: number}>()
	).results;
	return rows.map((row) => Number(row.blockNumber));
}

/**
 * THE SLICE: every emission of `[fromBlock, toBlock]`, in `seq` order,
 * retractions included.
 *
 * Both bounds are applied to the row's OWN block: a retraction carries the block
 * of the emission it takes back, so it travels with the thing it retracts rather
 * than arriving to revert a block this fold never applied. That is also what
 * makes a block-aligned cut complete -- every row of every block in the range is
 * here, whatever `seq` it was written at.
 */
async function readRange<ABI extends Abi>(
	db: RemoteSQL,
	query: {indexer: string; stream: string; fromBlock: number; toBlock: number},
): Promise<LogEvent<ABI>[]> {
	if (query.toBlock < query.fromBlock) {
		return [];
	}
	const rows = (
		await db
			.prepare(
				`SELECT ${EMISSION_COLUMNS}
				 FROM ${EMISSION_STREAM_TABLE}
				 WHERE indexer = ?1 AND stream = ?2 AND blockNumber >= ?3 AND blockNumber <= ?4
				 ORDER BY seq`,
			)
			.bind(query.indexer, query.stream, query.fromBlock, query.toBlock)
			.all<EmissionRow>()
	).results;
	// The BOUNDED replay port is a DIFFERENT seam and still declares decoded events
	// (`ReplayChunk`, ADR-0056), so the same raw rows are widened on the way out to
	// it. Nothing is added or lost by that: `GenerationRebuild` re-derives the
	// decoded half with `reparse` before it replays a chunk, exactly as the load
	// path does with what the KEEPER seam hands back.
	return rows.map(storedLogOf) as unknown as LogEvent<ABI>[];
}

/**
 * One stored row, back in the shape the engine replays.
 *
 * The raw log is `entryOf`'s, shared with both feed views so that what goes into
 * the table and what comes back out of it stays one mapping, plus the `removed`
 * VERDICT -- which is the whole reason this is a replay and not a fetch.
 *
 * The DECODED half is deliberately absent. `args` and `eventName` are what SOME
 * ABI made of those bytes and are never stored (ADR-0034); the engine re-derives
 * them with `LogEventFetcher.reparse` against the source running now, on this
 * path exactly as on every other replay path.
 *
 * The cast is one cast, here, and it is honest about what it is: a row read back
 * out of SQLite carries no proof that its `address` is `0x`-prefixed, and a
 * runtime re-validation of bytes this server itself wrote would be ceremony. It
 * is the ASSERTION a keeper is allowed at its own storage-readback boundary, and
 * it lands on the STORED type -- never on `LogEvent`, which would claim a decoded
 * half these rows have never held, and never on `EmittedLog`, which is the
 * emission-APPEND path's shape and refuses nothing.
 */
function storedLogOf(row: EmissionRow): StoredLogEvent {
	return {...entryOf(row), removed: row.removed === 1} as unknown as StoredLogEvent;
}
