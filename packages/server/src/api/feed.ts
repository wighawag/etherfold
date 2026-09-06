import {Hono} from 'hono';
import type {Context} from 'hono';
import {generationDigestOf} from '@etherfold/core';
import {logs} from 'named-logs';
import type {Env} from '../env.js';
import {readStreamHighWaterMark} from '../emissions.js';
import {
	CANONICAL_FEED_VIEW,
	encodeFeedCursor,
	openFeedCursor,
	STREAM_FEED_VIEW,
	type FeedCursorPosition,
	type FeedCursorRefusal,
} from '../feed/cursor.js';
import {
	CANONICAL_START_POSITION,
	forkBlockSince,
	isStillCanonical,
	readCanonicalView,
	type CanonicalPosition,
} from '../feed/canonical.js';
import {FEED_START_POSITION, readStreamFeed} from '../feed/stream.js';
import {resolveIndexer} from './resolve.js';
import {setup} from '../setup.js';
import type {ServerOptions} from '../types.js';

const logger = logs('@etherfold/server');

/**
 * The DEFAULT page a caller that asked for no size gets.
 *
 * Small enough that the obvious first call is cheap on a stream with millions of
 * rows, and large enough that a consumer polling a quiet chain is caught up in
 * one round trip.
 */
const DEFAULT_PAGE_SIZE = 100;

/**
 * The largest page this server will serve, and a hard REFUSAL rather than a
 * silent clamp.
 *
 * A clamp is accept-and-ignore, which this repo does not do: a caller asking for
 * 100,000 and receiving 1,000 has been answered with something it did not ask
 * for, and the one thing it can check -- the count it got back -- looks exactly
 * like "that is all there was". Refusing states the bound instead, and the caller
 * fixes its configuration once.
 */
const MAX_PAGE_SIZE = 1000;

/**
 * THE RETRACTION-AWARE FEED (ADR-0006, the first of the two views over the stored
 * emission stream).
 *
 * `GET /{indexer}/feed` serves the stream in `seq` order, retractions INCLUDED,
 * resuming from a cursor the CALLER holds. This is the view for a consumer that
 * WANTS to see reorgs -- it acts optimistically on a log and cancels the pending
 * action when the retraction arrives -- so nothing is filtered out of it. The
 * `alive` flag and a block gate belong to the OTHER view, which exists so that a
 * consumer never has to hear the word reorg.
 *
 * ## It is a PUBLIC read, and deliberately not behind the ingest token
 *
 * `INGEST_TOKEN` guards the FETCHER's private API -- the routes that can move the
 * cursor -- and it is registered on the ingest path for exactly that reason. A
 * consumer is a third party built outside etherfold (ADR-0005) that etherfold
 * stores nothing about, so putting the feed behind the fetcher's deployment
 * secret would mean handing every consumer the credential that can WRITE. This
 * route therefore answers anonymously, like `/status`. A deployment that needs
 * the feed private puts it behind its own edge, which is where an authorisation
 * model that knows about consumers belongs.
 *
 * ## Why this route needs the REGISTRY
 *
 * To validate a cursor's stream it must know WHICH stream is being served, and
 * the only thing that knows is what the name resolves to
 * (`IndexerRegistryEntry.canonicalGeneration`). The table cannot answer it: one
 * indexer's rows may span several streams over its life, nothing in them says
 * which is current, and picking one by a heuristic is the plausible wrong answer
 * this whole design refuses. So a host built with no registry answers `501` here
 * for the same reason it does on ingest -- it was built with no named indexers at
 * all -- and `etherfold serve`, the read tier, therefore does not serve this feed
 * today.
 *
 * ## The feed follows the CANONICAL GENERATION, and only it
 *
 * An entry can hold SEVERAL live wire contexts at once -- a filter-change
 * successor being fed beside the incumbent -- and a feed consumer must see none
 * of that: it is served the generation the canonical pointer names, whose stream
 * and fold are read TOGETHER, once per request. A successor being built is
 * therefore invisible here until the pointer moves, and when it does the cursor
 * refusals already say what happens: a cursor for the old stream is answered
 * with the stream served now and a cursor at its start, which is explicitly not
 * a rewind.
 *
 * ## Every response says WHICH GENERATION answered it
 *
 * `generation` is on every answer both views give, page and refusal alike, and
 * it exists for the one change a cursor cannot catch. A `seq` is a position in a
 * STREAM: a move to a generation over the SAME stream leaves every cursor valid,
 * and a move to one on a DIFFERENT stream is already refused by the cursor's
 * stream component. What is left is SAME LOGS, DIFFERENT FOLD -- nothing in the
 * cursor can see it, and a consumer reading state alongside this feed has to be
 * told, because a notifier that has already fired cannot unfire.
 *
 * It ADVERTISES and does not DICTATE. There is deliberately no rule here about
 * what a consumer does when the value moves: pausing, re-scanning and carrying
 * on are all legitimate, and only the consumer knows whether its own actions can
 * be taken back. (For the record and NOT as a platform rule: pausing and letting
 * an operator decide is the expected behaviour.)
 *
 * It is OPAQUE -- compared, never parsed (`generationDigestOf`) -- so what it is
 * composed of can change without a consumer noticing; and it is deliberately NOT
 * a column on the emission table, because the logs are IDENTICAL across a
 * processor change, and keeping the fold out of that table is exactly what makes
 * such a change free for a consumer following it.
 */
export function getFeedAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	return (
		new Hono<{Bindings: CustomEnv}>()
			.use(setup({serverOptions: options}))
			.get('/:indexer/feed', async (c) => {
				const resolved = resolveIndexer(options, c as never, 'feed');
				if (!resolved.ok) return resolved.response;
				const {name} = resolved;
				// THE CANONICAL GENERATION, in ONE read: its STREAM is what this response is
				// keyed on and what the cursor is validated against, and its FOLD is what the
				// response advertises. An entry can hold several live wire contexts, so the two
				// halves must come from one answer -- read separately, a response could pair one
				// generation's stream with another's fold.
				const canonical = await resolved.entry.canonicalGeneration();
				const stream = canonical.stream;
				const generation = generationDigestOf(canonical);
				const served = {
					indexer: name,
					stream,
					generation,
					view: STREAM_FEED_VIEW,
					startAt: {seq: FEED_START_POSITION},
				};

				const limit = pageSizeOf(c.req.query('limit'));
				if (!limit.ok) {
					return c.json(
						{
							success: false,
							error: 'invalid-limit',
							generation,
							maxLimit: MAX_PAGE_SIZE,
							message: limit.message,
						} as const,
						400,
					);
				}

				let after = FEED_START_POSITION;
				const presented = c.req.query('cursor');
				if (presented !== undefined) {
					const opened = openFeedCursor(presented, {view: STREAM_FEED_VIEW, indexer: name, stream});
					if (!opened.ok) return refuse(c as never, opened.refusal, served);
					const seq = opened.envelope.at['seq'];
					// the right view carrying a position that is not one: a cursor this server
					// cannot have written, so it is unreadable rather than out of range
					if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
						return refuse(c as never, {kind: 'unreadable'}, served);
					}
					after = seq;
				}

				const page = await readStreamFeed(c.get('config').db, {indexer: name, stream, after, limit: limit.value});

				return c.json({
					success: true,
					// the STREAM these logs belong to: readable, comparable, and the same value
					// the stream-mismatch refusal names, so a consumer that re-subscribed can
					// confirm where it landed. It says WHICH LOGS and deliberately nothing
					// about which FOLD produced any state beside them.
					stream,
					// which FOLD answered, which is the half the stream cannot say. Compare it
					// across polls; never take it apart.
					generation,
					entries: page.entries,
					// a cursor is ALWAYS handed back, including on an empty page, so a
					// caught-up poller keeps a valid position rather than having to remember
					// the last one it was given
					cursor: encodeFeedCursor({view: STREAM_FEED_VIEW, indexer: name, stream, at: {seq: page.position}}),
					hasMore: page.hasMore,
				} as const);
			})
			/**
			 * THE CANONICAL VIEW (ADR-0006, the second of the two views).
			 *
			 * `GET /{indexer}/canonical?gate=<block>` serves the LIVE entries only, in
			 * `(blockNumber, logIndex)` order, at or below the CALLER's gate. This is the
			 * view for a consumer that never wants to hear the word reorg: its entire
			 * sync state is one advancing position and it implements no reorg handling.
			 *
			 * A separate route rather than a `?view=` on `/feed`, because the two views
			 * take different parameters (a gate here, and nowhere else), answer different
			 * refusals (a REWIND here, and never there) and hand back different entry
			 * shapes. One path per contract; the cursor's `view` copy is what keeps them
			 * from being crossed, and it is validated rather than used to route.
			 *
			 * ## What hiding reorgs OBLIGES
			 *
			 * The cursor carries the block HASH the consumer last saw and the server
			 * VALIDATES it. When that block is no longer canonical the answer is a
			 * REWIND naming the fork block, never a page: continuing from
			 * `(blockNumber, logIndex)` on the new branch would silently skip exactly the
			 * events the consumer never received, which is the failure this validation
			 * exists to prevent. One hash check is provably enough, because a reorg
			 * invalidates a contiguous suffix.
			 *
			 * It is the read-side twin of the rule ADR-0015 makes for state: a consumer
			 * holding a block address that no longer resolves is TOLD, never served an
			 * answer it cannot tell apart from a true one.
			 */
			.get('/:indexer/canonical', async (c) => {
				const resolved = resolveIndexer(options, c as never, 'canonical');
				if (!resolved.ok) return resolved.response;
				const {name} = resolved;
				// ONE read, both halves: see the other view.
				const canonical = await resolved.entry.canonicalGeneration();
				const stream = canonical.stream;
				const generation = generationDigestOf(canonical);
				const served = {
					indexer: name,
					stream,
					generation,
					view: CANONICAL_FEED_VIEW,
					startAt: positionOf(CANONICAL_START_POSITION, {since: 0}),
				};
				const db = c.get('config').db;

				const limit = pageSizeOf(c.req.query('limit'));
				if (!limit.ok) {
					return c.json(
						{
							success: false,
							error: 'invalid-limit',
							generation,
							maxLimit: MAX_PAGE_SIZE,
							message: limit.message,
						} as const,
						400,
					);
				}
				const gate = gateOf(c.req.query('gate'));
				if (!gate.ok) {
					return c.json({success: false, error: 'invalid-gate', generation, message: gate.message} as const, 400);
				}

				// The stream's high-water mark, read BEFORE anything else touches the
				// table. It is what the cursor this request hands back is marked at, and
				// reading it early is what makes the mark CONSERVATIVE: a retraction landing
				// between here and the page below lands ABOVE the mark, so the next fork
				// search still counts it. The other order could drop one, and a fork block
				// that is too HIGH is the silent skip this whole route exists to prevent.
				const mark = await readStreamHighWaterMark(db, {indexer: name, stream});

				let after: CanonicalPosition = CANONICAL_START_POSITION;
				let seenBlockHash: string | undefined;
				const presented = c.req.query('cursor');
				if (presented !== undefined) {
					const opened = openFeedCursor(presented, {view: CANONICAL_FEED_VIEW, indexer: name, stream});
					if (!opened.ok) return refuse(c as never, opened.refusal, served);
					const at = canonicalPositionOf(opened.envelope.at);
					// the right view carrying a position that is not one: a cursor this server
					// cannot have written, so it is unreadable rather than out of range
					if (!at) return refuse(c as never, {kind: 'unreadable'}, served);
					after = {blockNumber: at.blockNumber, logIndex: at.logIndex};

					if (at.blockHash !== undefined) {
						const stillCanonical = await isStillCanonical(db, {
							indexer: name,
							stream,
							...after,
							blockHash: at.blockHash,
						});
						if (!stillCanonical) {
							// the fork is the lowest block retracted since this cursor was minted,
							// and never the cursor's own block: the chain can have changed BELOW it
							const forkBlock = (await forkBlockSince(db, {indexer: name, stream, since: at.since})) ?? at.blockNumber;
							return rewind(c as never, {indexer: name, stream, generation, forkBlock, mark});
						}
						seenBlockHash = at.blockHash;
					}
				}

				const page = await readCanonicalView(db, {
					indexer: name,
					stream,
					gate: gate.value,
					after,
					limit: limit.value,
				});

				// the position and the hash MOVE TOGETHER: a cursor either names an entry
				// this server served (and carries the hash proving which chain it was on)
				// or it names where the consumer asked from and carries whatever it already
				// had. An empty page must not silently drop the hash, or the next request
				// would have nothing to validate.
				const position = page.last ?? after;
				const blockHash = page.last?.blockHash ?? seenBlockHash;

				return c.json({
					success: true,
					stream,
					generation,
					entries: page.entries,
					cursor: encodeFeedCursor({
						view: CANONICAL_FEED_VIEW,
						indexer: name,
						stream,
						at: positionOf(position, {since: mark, ...(blockHash === undefined ? {} : {blockHash})}),
					}),
					hasMore: page.hasMore,
				} as const);
			})
	);
}

/**
 * The canonical view's position, as the shared codec carries it.
 *
 * Three things and not one, and only the first two are a POSITION:
 *
 * - `blockNumber` / `logIndex` -- WHERE the consumer is, and the only thing the
 *   read advances on.
 * - `blockHash` -- WHICH CHAIN it was on, validated on the next request. Absent
 *   on a cursor that names no entry this server served: a fresh start, or the
 *   place a rewind pointed at. There is nothing to validate there, and inventing
 *   a hash to fill the field would be validating a claim nobody made.
 * - `since` -- the stream's high-water MARK when the cursor was minted, which is
 *   what makes "what has been retracted since you last looked" answerable. It is
 *   deliberately NOT a position and never advances the read: `seq` is the OTHER
 *   view's cursor, and ADR-0006 is explicit that a synthetic sequence is the
 *   wrong ORDER for this one. Carrying it rather than looking it up keeps the
 *   answer available after pair-compaction has reclaimed the row it would have
 *   been looked up from.
 */
function positionOf(position: CanonicalPosition, extra: {since: number; blockHash?: string}): FeedCursorPosition {
	return {blockNumber: position.blockNumber, logIndex: position.logIndex, ...extra};
}

/** Read a canonical position back out of a cursor, or nothing if it is not one. */
function canonicalPositionOf(
	at: FeedCursorPosition,
): (CanonicalPosition & {since: number; blockHash?: string}) | undefined {
	const {blockNumber, logIndex, since, blockHash} = at;
	if (typeof blockNumber !== 'number' || !Number.isInteger(blockNumber) || blockNumber < 0) return undefined;
	// `-1` is the START, which is BEFORE the first log of block 0: the read is
	// strictly after the position, so a lower bound of 0 would make a genuine
	// `(0, 0)` the one entry a fresh consumer never receives
	if (typeof logIndex !== 'number' || !Number.isInteger(logIndex) || logIndex < -1) return undefined;
	if (typeof since !== 'number' || !Number.isInteger(since) || since < 0) return undefined;
	if (blockHash !== undefined && (typeof blockHash !== 'string' || blockHash === '')) return undefined;
	return {blockNumber, logIndex, since, ...(blockHash === undefined ? {} : {blockHash})};
}

/**
 * WHICH block a caller will act at or below, or why the request cannot be
 * served.
 *
 * REQUIRED, and this is the one refusal on this route that is a statement about
 * what the server will not do. A consumer that only wants final data passes a
 * low gate and one that wants the tip passes a high one (ADR-0007's two lanes),
 * so a default would be the server picking a consumer's RISK APPETITE -- the one
 * thing about a consumer this system deliberately knows nothing about (ADR-0005).
 * Every candidate default is wrong for somebody: the tip hands unfinalised logs
 * to a consumer that asked for safety, and finality withholds logs from one that
 * accepted the risk deliberately, and neither says so.
 */
function gateOf(asked: string | undefined): {ok: true; value: number} | {ok: false; message: string} {
	if (asked === undefined) {
		return {
			ok: false,
			message:
				`gate is required: pass the block number you are willing to act at or below, as \`?gate=<block>\`. It is ` +
				`not defaulted, because how deep a consumer trusts the chain is the consumer's decision and not this ` +
				`server's: a low gate serves only settled blocks, a high one serves up to the tip.`,
		};
	}
	const value = Number(asked);
	if (asked.trim() === '' || !Number.isInteger(value) || value < 0) {
		return {ok: false, message: `gate must be a whole block number of at least 0, and was ${JSON.stringify(asked)}`};
	}
	return {ok: true, value};
}

/**
 * How big a page the caller asked for, or why the request cannot be served.
 *
 * Absent means the default. Present means a whole number in `[1, MAX_PAGE_SIZE]`
 * and nothing else: a fraction, a zero, a negative and a word are all a caller
 * that believes something untrue about this endpoint, and answering any of them
 * with a default would hide the belief rather than correct it.
 */
function pageSizeOf(asked: string | undefined): {ok: true; value: number} | {ok: false; message: string} {
	if (asked === undefined) return {ok: true, value: DEFAULT_PAGE_SIZE};
	const value = Number(asked);
	if (asked.trim() === '' || !Number.isInteger(value) || value < 1) {
		return {
			ok: false,
			message: `limit must be a whole number of at least 1, and was ${JSON.stringify(asked)}`,
		};
	}
	if (value > MAX_PAGE_SIZE) {
		return {
			ok: false,
			message:
				`limit must be at most ${MAX_PAGE_SIZE}, and was ${value}. It is refused rather than reduced, so that ` +
				`a short page always means the stream is short and never that the server quietly served less.`,
		};
	}
	return {ok: true, value};
}

/**
 * Turn a cursor refusal into the answer a consumer acts on.
 *
 * All four are `400`: the caller presented something this server will not honour,
 * and no amount of waiting or re-presenting the same cursor changes that.
 * Deliberately NOT `409`, which on the ingest side means the ONE resumable
 * refusal (re-send from `expectedFromBlock`, ADR-0004); re-using that number here
 * for something that is not resumable would make a sender's and a consumer's
 * contracts say different things with one code.
 *
 * The four are kept apart because the recovery differs, and because two of them
 * must NOT say more than they do:
 *
 * - `invalid-cursor` says nothing about WHY, on purpose. Truncated, edited,
 *   invented and written-by-an-older-build are one answer, because telling them
 *   apart would tell a client about the encoding, which is the one thing an
 *   opaque cursor must not leak.
 * - `indexer-mismatch` names the indexer the caller ADDRESSED and never the one
 *   its cursor was minted at. Echoing that back would both confirm the encoding
 *   carries a name and hand one tenant's name to a caller poking at another.
 * - `view-mismatch` is a cursor from the OTHER view, whose positions count in
 *   another space (`seq` on one side, `(blockNumber, logIndex)` on the other).
 *   Two views, one codec, and this is what keeps the shared codec from serving
 *   one view's number as the other's.
 * - `stream-mismatch` is the one that is nobody's bug, so it is the one that
 *   ANSWERS: the current stream's identity, and a cursor at the position its feed
 *   starts at. It is explicitly NOT a correction to an earlier point on the
 *   caller's own stream -- there is no fork block, because the logs a filter
 *   change produces were never on the stream the cursor names -- so re-subscribing
 *   is a decision the consumer takes rather than a step it can automate blindly.
 *   Note how that differs from the canonical view's REWIND below, which is a
 *   correction on the caller's own stream and is meant to be followed.
 *
 * ONE mapper for BOTH views, parameterised by which view is served, for the same
 * reason there is one codec: two copies would be two refusal contracts that
 * drift, and a consumer would have to learn each view's dialect of the same four
 * words.
 *
 * Each of them carries the GENERATION that would have answered, exactly as the
 * page does: a refusal is still an answer this fold gave, and a consumer that
 * logs one has the whole context rather than the context minus the one field
 * that says which fold it was talking to.
 */
function refuse(
	c: Context<{Bindings: Env}>,
	refusal: FeedCursorRefusal,
	served: {indexer: string; stream: string; generation: string; view: string; startAt: FeedCursorPosition},
) {
	const generation = served.generation;
	switch (refusal.kind) {
		case 'foreign-indexer':
			logger.info(`feed: a cursor minted at another named indexer was presented at ${JSON.stringify(served.indexer)}`);
			return c.json(
				{
					success: false,
					error: 'indexer-mismatch',
					indexer: served.indexer,
					generation,
					message:
						`this cursor was minted at a different named indexer and is not a position here. Two named ` +
						`indexers can hold byte-identical streams, so a position in one means nothing in the other and ` +
						`is refused rather than re-interpreted. Read this indexer's feed from the beginning, or present ` +
						`a cursor it gave you.`,
				} as const,
				400,
			);
		case 'foreign-view':
			return c.json(
				{
					success: false,
					error: 'view-mismatch',
					view: served.view,
					generation,
					message:
						`this cursor belongs to another view of the same stream, whose positions are not positions here. ` +
						`Present a cursor this feed gave you, or read it from the beginning.`,
				} as const,
				400,
			);
		case 'foreign-stream':
			logger.info(`feed: a cursor for a stream ${JSON.stringify(served.indexer)} no longer serves was presented`);
			return c.json(
				{
					success: false,
					error: 'stream-mismatch',
					// the two things a consumer needs in order to re-subscribe DELIBERATELY:
					// which stream is served now, and where its feed begins
					stream: served.stream,
					generation,
					startCursor: encodeFeedCursor({
						view: served.view,
						indexer: served.indexer,
						stream: served.stream,
						at: served.startAt,
					}),
					message:
						`this cursor is a position in a stream this indexer no longer serves. A position in one stream is ` +
						`unrelated to the same number in another, so it is refused rather than continued. The stream ` +
						`served now is reported as \`stream\`, and \`startCursor\` is the position its feed begins at: ` +
						`present it to follow the current stream from the start. Nothing here points back into your old ` +
						`stream, because the logs served now were never on it.`,
				} as const,
				400,
			);
		default:
			return c.json(
				{
					success: false,
					error: 'invalid-cursor',
					generation,
					message:
						`this is not a cursor this server issued. A feed cursor is opaque and is only ever obtained from ` +
						`a feed response: present one unchanged, or omit it to read from the beginning.`,
				} as const,
				400,
			);
	}
}

/**
 * REWIND TO FORK BLOCK F: the canonical view's answer to a cursor whose block is
 * no longer on the chain.
 *
 * ## Why it is `409` and not `400`
 *
 * Every OTHER cursor refusal on this surface is a `400`, because nothing the
 * caller can do with the same cursor makes it right. This one is the exception,
 * and it is the exception for exactly the reason `409` already exists in this
 * system: ADR-0004 makes `409` the ONE RESUMABLE refusal on the ingest side --
 * "your position is not where mine is, carry on from HERE" -- and this is that
 * same sentence spoken to a consumer. Using the same number for the same meaning
 * is what keeps a sender's contract and a consumer's contract legible together;
 * `400` would file a correction the caller is MEANT to follow beside the ones it
 * must not.
 *
 * ## Why it is not a `200` carrying an instruction
 *
 * A `200` with an empty page and a rewind field beside it is indistinguishable,
 * to a consumer that ignores a field it does not know, from "you are caught up".
 * That is the silent skip in a new costume, and it is the specific failure this
 * whole validation exists to prevent, so it may not be reachable by ignoring
 * something.
 *
 * ## What it carries
 *
 * - `forkBlock` -- F, the LOWEST block the consumer must read again, and the one
 *   thing it cannot derive: it must also roll its OWN derived state back to
 *   before F, and no cursor can say that for it.
 * - `rewindCursor` -- a cursor at F, meant to be PRESENTED next. It is
 *   deliberately named to say so, unlike the stream mismatch's `startCursor`,
 *   which is a place to begin a NEW subscription and a decision a human takes.
 *   Following this one is the correct, automatic behaviour: the consumer of this
 *   view implements no reorg handling, and this is what that promise costs the
 *   server.
 * - `stream` and `generation` -- the same two identities the success path
 *   advertises, so a consumer logging the refusal has the whole context.
 *
 * The rewind cursor carries NO block hash, because it names a position the
 * consumer has not been served an entry at; there is nothing yet to validate,
 * and minting a hash for it would be validating a claim nobody made. It is
 * marked at the CURRENT high-water mark, so a further reorg arriving before the
 * consumer acts is still measured from here.
 */
function rewind(
	c: Context<{Bindings: Env}>,
	at: {indexer: string; stream: string; generation: string; forkBlock: number; mark: number},
) {
	logger.info(
		`canonical: ${JSON.stringify(at.indexer)} answered a rewind to fork block ${at.forkBlock}: a cursor's block is no longer canonical`,
	);
	return c.json(
		{
			success: false,
			error: 'rewind-required',
			stream: at.stream,
			generation: at.generation,
			forkBlock: at.forkBlock,
			rewindCursor: encodeFeedCursor({
				view: CANONICAL_FEED_VIEW,
				indexer: at.indexer,
				stream: at.stream,
				at: positionOf({blockNumber: at.forkBlock, logIndex: -1}, {since: at.mark}),
			}),
			message:
				`the block your cursor names is no longer on this chain: it was reorged out. Discard whatever you ` +
				`derived from block ${at.forkBlock} onwards and resume by presenting \`rewindCursor\`, which reads this ` +
				`view again from that block. You are told rather than served, because continuing from your position ` +
				`would skip the replacement blocks below it -- exactly the events you never received.`,
		} as const,
		409,
	);
}
