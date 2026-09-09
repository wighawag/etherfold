import {
	InvalidBatchError,
	UnexpectedFromBlockError,
	WireContextMismatchError,
	parseWireBatch,
	sameWireContext,
	type LogIngestion,
	type UntypedWireBatch,
	type WireContext,
} from '@etherfold/core';
import {Hono} from 'hono';
import type {Context} from 'hono';
import {logs} from 'named-logs';
import type {Env} from '../env.js';
import {authorizedWith} from './auth.js';
import {resolveIndexer} from './resolve.js';
import {setup} from '../setup.js';
import type {ServerOptions} from '../types.js';

const logger = logs('@etherfold/server');

/**
 * Whether this caller may touch the cursor.
 *
 * The shared guard (`./auth.ts`) at the INGEST credential: this surface is the
 * fetcher's private API, so what it takes is the secret a log shipper holds and
 * never the operator's. The rule -- fail closed when none is configured -- is
 * that module's and is the same on both surfaces.
 */
function authorized(c: Context<{Bindings: Env}>): {ok: true} | {ok: false; message: string} {
	return authorizedWith(c, 'INGEST_TOKEN');
}

/**
 * The log ingestion endpoint: where raw logs enter the server, and the half of
 * the wire contract that makes losing an event structurally difficult.
 *
 * ## The NAME is a ROUTE SEGMENT, and the CONTEXT selects within it
 *
 * Every route here hangs off `/{indexer}`, the NAMED INDEXER a host was built
 * with (ADR-0036), and the segment is the ONLY thing that selects which INDEXER
 * a batch reaches. Carrying the name in the ADR-0004 envelope instead was
 * considered and rejected: it would make the wire FORMAT carry tenancy, and it
 * would turn a misdirected batch into a payload error rather than a routing one.
 * So the envelope and its refusal families are untouched, and one more refusal
 * exists beside them -- a name this host was not built with, which is a `404` and
 * never a batch that quietly landed somewhere plausible.
 *
 * One name can hold SEVERAL LIVE WIRE CONTEXTS -- a filter-change successor being
 * built beside the incumbent that is still being fed -- so the batch's OWN
 * `{source, config}` selects which receiver inside the entry gets it. That is a
 * second selection and not a second routing rule: nothing in the payload can
 * reach another NAME, and a context that matches no live receiver here is the
 * same `400` a single receiver has always answered, still deliberately not
 * resumable.
 *
 * ## What this layer decides, and what it only reports
 *
 * Every RULE lives in the stream-builder (`@etherfold/core`), which is where the
 * engine's own cursor check already lives. This route decides two things a
 * transport has to decide and the engine cannot:
 *
 * - **who may call it.** A caller with no token cannot advance the cursor.
 * - **which status code each refusal is.** `409` is the one and only RESUMABLE
 *   refusal: it carries `expectedFromBlock`, and a sender's whole recovery is to
 *   re-send from there. `400` is a sender that is wrong in a way no block number
 *   fixes (a foreign `{source, config}`, a malformed range, a payload that is
 *   not the range it claims). Collapsing the two would make a misconfigured
 *   fetcher retry forever against a server that will never accept it.
 *
 * ## What is deliberately absent
 *
 * No idempotency key and no dedupe table: the cursor IS the key. A re-sent batch
 * after a lost acknowledgement fails the `expectedFromBlock` check and is
 * corrected, so it cannot be applied twice.
 *
 * **And no DURABLE WRITE of any kind.** This route used to own two of them, and
 * each made a fact about the FOLD into a fact about the TRANSPORT: a combined
 * process folds through `createDirectIngestion`, never reaches here, and so
 * reported no reverts at all (ADR-0050) and stored no emission stream (ADR-0052).
 * Both are concluded by the fold, so both are written inside `receive` through a
 * port the store's owner injected -- `ReorgRecorder` for the count, and
 * `EmissionAppender` for the stream -- and this route is a CALLER of that path.
 * Writing either here as well would double it on the split shape, which both
 * concludes and receives.
 *
 * That is also why this route names no DATABASE, on a host holding several named
 * indexers whose databases differ (ADR-0053): the receiver it selects was built
 * by the host over the handle THAT NAME owns, and so were the two ports that
 * write inside it, so a batch reaches one tenant's database because of what it
 * was routed to rather than because this route picked a handle. The feed views,
 * which read rows themselves, take that handle off the entry.
 *
 * What this route still decides is what a transport must: who may call it, and
 * which status code each refusal is. A refusal from the STREAM APPEND is not one
 * of them by design: it is not a class the sender can act on, so it falls to the
 * `500` below with `lastError` set, and the sender's own recovery is unaffected
 * -- nothing was applied, so its next attempt meets the cursor it already had.
 */
export function getIngestAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	return (
		new Hono<{Bindings: CustomEnv}>()
			.use(setup({serverOptions: options}))
			/**
			 * The token guard, on the PATH rather than inside each handler.
			 *
			 * "The endpoint requires authentication" is then a property of `/{indexer}/ingest`
			 * itself: a route added here later inherits it instead of needing somebody
			 * to remember. It covers the read as well as the write, because this whole
			 * surface is the fetcher's private API, and one rule for all of it is one
			 * rule to get wrong.
			 *
			 * It runs AHEAD of the registry lookup, which is why an unknown name answers
			 * `401` and not `404` to a caller with no token: which names a host was built
			 * with is not something an unauthenticated caller may enumerate.
			 *
			 * BOTH patterns are registered on purpose, but NOT for the reason this comment
			 * used to give. It claimed the wildcard does not cover the bare path and that
			 * each registration guards half the surface; that is not true of the Hono
			 * version in use, where `/:indexer/ingest/*` already answers for
			 * `/:indexer/ingest` too. Removing
			 * the exact-path registration leaves the whole server suite green, so it is
			 * redundant rather than load-bearing, and the tests below cannot tell which of
			 * the two answered.
			 *
			 * It is KEPT deliberately, as belt and braces: the cost is one middleware
			 * registration, and the failure it insures against -- a routing change that
			 * narrows the wildcard and silently opens the bare path -- is exactly the kind
			 * this guard exists to make impossible. What is NOT claimed any more is that
			 * the tests prove both are needed. `test/ingest.test.ts` asserts a 401 on each
			 * path, which is the property that matters; which registration produces it is
			 * deliberately not asserted.
			 */
			.use('/:indexer/ingest', async (c, next) => {
				const auth = authorized(c as never);
				if (!auth.ok) {
					return c.json({success: false, error: 'unauthorized', message: auth.message} as const, 401);
				}
				return next();
			})
			.use('/:indexer/ingest/*', async (c, next) => {
				const auth = authorized(c as never);
				if (!auth.ok) {
					return c.json({success: false, error: 'unauthorized', message: auth.message} as const, 401);
				}
				return next();
			})
			/**
			 * Where the next batch must start.
			 *
			 * A stateless log-fetcher holds no cursor, so before its FIRST fetch it has
			 * nothing to be corrected from and must ask.
			 *
			 * ## Why this is a POST for a question
			 *
			 * Answering it can WRITE. Reading the cursor reconciles one belonging to a
			 * different source, config or processor version, and WHICH write that is
			 * depends on the receiver: with a generation container above it the running
			 * fold is resolved-or-created as a GENERATION (a registry write, nothing
			 * discarded), and without one the stale state is cleared (`processor.clear()`,
			 * exactly as `load()` does in the single-process shape). Either way the
			 * alternative would be answering from state the next batch is about to change,
			 * so the read and the write disagree.
			 *
			 * A `GET` that writes is a trap whatever its justification: proxies, browser
			 * prefetch, link scanners and retry-happy clients all assume a `GET` is safe,
			 * and HTTP says it is. Rather than keep the side effect and document it, the
			 * method matches what it does. The cost is one un-RESTful-looking POST for a
			 * question; the alternative was an endpoint whose safety depended on nobody
			 * ever pointing a crawler at it.
			 *
			 * ## ONE PAIR PER LIVE WIRE CONTEXT
			 *
			 * The answer is a LIST of `{context, expectedFromBlock}` and never a single
			 * pair, because a named indexer can hold several live contexts at once and a
			 * single pair could only have named one of them -- silently, with the sender
			 * unable to tell that the number it got belongs to somebody else's stream. It
			 * is a WIDENING of what this route already did: it returned its `context`
			 * beside the number precisely so a sender could tell which receiver it had
			 * reached, and now it does that for each of them. A sender pushing one context
			 * finds its own entry in the list; a fetcher host running one loop per context
			 * is what the list makes possible, and is not built here.
			 *
			 * Each entry is asked in turn rather than concurrently: answering can WRITE
			 * (above), and a registry commit that lost its guard to a sibling in the same
			 * request would be this route racing itself.
			 */
			.post('/:indexer/ingest/expected-from-block', async (c) => {
				const resolved = resolveIndexer(options, c as never, 'ingest');
				if (!resolved.ok) return resolved.response;

				const contexts: {context: WireContext; expectedFromBlock: number}[] = [];
				for (const ingestion of await resolved.entry.liveIngestions()) {
					contexts.push({context: ingestion.context, expectedFromBlock: await ingestion.expectedFromBlock()});
				}

				return c.json({success: true, contexts} as const);
			})
			.post('/:indexer/ingest', async (c) => {
				const resolved = resolveIndexer(options, c as never, 'ingest');
				if (!resolved.ok) return resolved.response;

				// The BYTE ceiling, stated rather than discovered, and only when this host
				// knows one (`maxIngestBytes`; absent means unbounded, as it always was). The
				// declared length is checked FIRST so an oversized body is refused without
				// being buffered, which is the whole point on a runtime with a hard request
				// limit; a body arriving without a `Content-Length` still gets the same answer
				// below, one buffer later, because that is the earliest its size is known.
				//
				// The WHOLE batch is refused. Delivering the part that fits is the one thing
				// ADR-0004 forbids: a short payload is read as an absence, concluded as a reorg
				// and reverted. The sender lowers `toBlock` and re-sends.
				const maxBytes = options.maxIngestBytes;
				if (maxBytes !== undefined) {
					const declared = Number(c.req.header('content-length'));
					if (Number.isFinite(declared) && declared > maxBytes) {
						return tooLarge(c as never, declared, maxBytes);
					}
				}

				let body: string;
				try {
					body = await c.req.text();
				} catch (err) {
					return c.json(
						{
							success: false,
							error: 'invalid-json',
							message: err instanceof Error ? err.message : String(err),
						} as const,
						400,
					);
				}
				if (maxBytes !== undefined) {
					// the ACTUAL size, for a chunked body that declared none
					const size = new TextEncoder().encode(body).length;
					if (size > maxBytes) return tooLarge(c as never, size, maxBytes);
				}

				let batch: UntypedWireBatch;
				try {
					// parsed with the wire codec rather than `c.req.json()`: a decoded log's
					// `args` carry a BigInt for every uint256 an ABI declares, and plain JSON
					// has no way to say so
					batch = parseWireBatch(body);
				} catch (err) {
					return c.json(
						{
							success: false,
							error: 'invalid-json',
							message: err instanceof Error ? err.message : String(err),
						} as const,
						400,
					);
				}

				// WHICH receiver: the route segment chose the indexer, and the batch's own
				// `{source, config}` chooses within it. The comparison is `@etherfold/core`'s
				// own (`sameWireContext`), which is the rule the receiver would apply to refuse
				// it -- a copy here could select a receiver that then refused the batch.
				const live = await resolved.entry.liveIngestions();
				const ingestion = live.find((receiver) => sameWireContext(receiver.context, batch.context));
				if (!ingestion) return noReceiverFor(c as never, live, batch.context);

				try {
					// ONE call, and everything a batch costs durably happens inside it: the
					// emission stream is appended BEFORE the fold, the revert is made, the log
					// line is written and the count is taken. `outcome.reorg` is REPORTED back to
					// the sender below and acted on by nobody here, and `outcome.emissions` is
					// likewise read by nobody: storing it from here would store a second time on
					// the shape that both concludes and receives.
					const outcome = await ingestion.receive(batch);

					return c.json({
						success: true,
						fromBlock: batch.fromBlock,
						toBlock: batch.toBlock,
						latestBlock: batch.latestBlock,
						applied: outcome.applied,
						retracted: outcome.retracted,
						// handed back so an acknowledged sender needs no second round-trip
						expectedFromBlock: outcome.expectedFromBlock,
						reorg: outcome.reorg,
					} as const);
				} catch (err) {
					return refusal(c as never, err);
				}
			})
	);
}

/**
 * A batch whose `{source, config}` addresses no LIVE receiver under this name.
 *
 * The `400` of ADR-0004's second family, unchanged in code and in meaning: no
 * block number makes it right, so a sender must not retry it. What is new is
 * only that `expected` NAMES EVERY live context rather than the single one a
 * one-receiver entry had -- the same choice `GenerationCapReachedError` makes
 * when it names every deletable generation instead of picking one, because
 * naming them all is information and picking one is a policy this has no basis
 * for.
 *
 * An EMPTY list is the honest answer for a name whose every context has stopped
 * being live (its generation deleted, its stream reaped): the batch is refused
 * because nothing here folds that stream any more, which is a fact about this
 * host and not about the payload -- but it is still the same refusal, because
 * the sender's move is the same one, and inventing a status for it would give a
 * fetcher a fourth case to classify.
 */
function noReceiverFor(c: Context<{Bindings: Env}>, live: readonly LogIngestion[], received: WireContext | undefined) {
	logger.error(
		`ingest: a batch arrived for a {source, config} no LIVE receiver under this name holds ` +
			`(${live.length} live context(s))`,
	);
	return c.json(
		{
			success: false,
			error: 'context-mismatch',
			expected: live.map((receiver) => receiver.context),
			received,
			message:
				`this batch is for a {source, config} this named indexer does not fold. It holds ${live.length} live wire ` +
				`context(s), listed as \`expected\`, and a batch reaches one of them by carrying its identity. No block ` +
				`number makes this right: either the sender's source or stream config differs from the receiver's, or it ` +
				`is pointed at the wrong named indexer.`,
		} as const,
		400,
	);
}

/**
 * A batch too large for this receiver to accept, refused with the ceiling NAMED.
 *
 * `413` because it is a fact about the REQUEST rather than about the stream: the
 * batch may be perfectly well-formed and start exactly where the receiver expects.
 * It is not a `409`, which is the one resumable refusal and means "re-send from
 * this block"; here the sender must send a SMALLER RANGE from the same block, so
 * conflating the two would have it skip the range it just failed to deliver.
 *
 * The limit is in the body so a sender learns the ceiling from the refusal rather
 * than by bisecting against it.
 */
function tooLarge(c: Context<{Bindings: Env}>, size: number, limit: number) {
	return c.json(
		{
			success: false,
			error: 'batch-too-large',
			message:
				`this batch is ${size} bytes and this receiver accepts at most ${limit}. Nothing was read or folded. ` +
				`Lower the range (toBlock) and re-send from the SAME fromBlock: a partial range would be read as an ` +
				`absence, concluded as a reorg, and would revert state.`,
			limit,
			size,
		} as const,
		413,
	);
}

/**
 * Map a refusal onto the status code a sender steers by.
 *
 * Anything not recognised is re-thrown to the app's error handler, which is a
 * `500`. That is the honest answer for an unexpected failure: a sender must not
 * read "the database is down" as "re-send from block N".
 */
function refusal(c: Context<{Bindings: Env}>, err: unknown) {
	if (err instanceof UnexpectedFromBlockError) {
		logger.info(
			`ingest: refusing a batch at ${err.receivedFromBlock}, expecting ${err.expectedFromBlock}: the sender will re-send`,
		);
		return c.json(
			{
				success: false,
				error: 'unexpected-fromBlock',
				expectedFromBlock: err.expectedFromBlock,
				receivedFromBlock: err.receivedFromBlock,
				message: err.message,
			} as const,
			409,
		);
	}
	// The receiver's OWN assertion, mapped even though this route now selects on the
	// same rule and should never reach it. It is kept because the rule belongs to the
	// receiver and this route is a CALLER of it: if the two ever disagreed, the
	// honest answer is the receiver's refusal with its own single `expected`, not a
	// `500` that reads like a server fault.
	if (err instanceof WireContextMismatchError) {
		logger.error(`ingest: a batch arrived for another {source, config}: ${err.message}`);
		return c.json(
			{
				success: false,
				error: 'context-mismatch',
				expected: [err.expected],
				received: err.received,
				message: err.message,
			} as const,
			400,
		);
	}
	if (err instanceof InvalidBatchError) {
		logger.error(`ingest: a malformed batch was refused: ${err.message}`);
		return c.json({success: false, error: 'invalid-batch', message: err.message} as const, 400);
	}
	throw err;
}
