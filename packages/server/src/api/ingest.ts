import {
	InvalidBatchError,
	UnexpectedFromBlockError,
	WireContextMismatchError,
	parseWireBatch,
	type UntypedWireBatch,
} from '@etherfold/core';
import {Hono} from 'hono';
import type {Context} from 'hono';
import {logs} from 'named-logs';
import type {Env} from '../env.js';
import {resolveIndexer} from './resolve.js';
import {setup} from '../setup.js';
import type {ServerOptions} from '../types.js';

const logger = logs('@etherfold/server');

/**
 * Compare two secrets without leaking WHERE they first differ.
 *
 * Written out rather than taken from `node:crypto`, because this package names
 * no runtime (a test asserts it). It leaks the LENGTH, which the archived
 * server's `timingSafeEqual` version also did, and which tells an attacker
 * nothing they cannot get by counting characters in a rejected guess.
 */
function secretEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) {
		difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return difference === 0;
}

/**
 * Whether this caller may touch the cursor.
 *
 * Fail-closed on a missing `INGEST_TOKEN`: a server that can authenticate nobody
 * authenticates nobody. The message names the variable, because the alternative
 * is an operator staring at a 401 they configured themselves.
 */
function authorized(c: Context<{Bindings: Env}>): {ok: true} | {ok: false; message: string} {
	const configured = c.get('config')?.env?.INGEST_TOKEN;
	if (!configured) {
		logger.error(`an ingest route was called with no INGEST_TOKEN configured: refusing every caller`);
		return {ok: false, message: `no INGEST_TOKEN is configured on this server, so no caller can be authenticated`};
	}
	const header = c.req.header('Authorization');
	const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
	if (!presented || !secretEquals(configured, presented)) {
		return {ok: false, message: `expected an Authorization: Bearer <token> header matching INGEST_TOKEN`};
	}
	return {ok: true};
}

/**
 * The log ingestion endpoint: where raw logs enter the server, and the half of
 * the wire contract that makes losing an event structurally difficult.
 *
 * ## The NAME is a ROUTE SEGMENT
 *
 * Every route here hangs off `/{indexer}`, the NAMED INDEXER a host was built
 * with (ADR-0036), and the segment is the ONLY thing that selects which receiver
 * a batch reaches. Carrying the name in the ADR-0004 envelope instead was
 * considered and rejected: it would make the wire FORMAT carry tenancy, and it
 * would turn a misdirected batch into a payload error rather than a routing one.
 * So the envelope and its refusal families are untouched, and one more refusal
 * exists beside them -- a name this host was not built with, which is a `404` and
 * never a batch that quietly landed somewhere plausible.
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
			 * different source, config or processor version by calling
			 * `processor.clear()`, exactly as `load()` does in the single-process shape --
			 * the alternative being to answer from state the next batch is about to wipe,
			 * so the read and the write disagree.
			 *
			 * A `GET` that writes is a trap whatever its justification: proxies, browser
			 * prefetch, link scanners and retry-happy clients all assume a `GET` is safe,
			 * and HTTP says it is. Rather than keep the side effect and document it, the
			 * method matches what it does. The cost is one un-RESTful-looking POST for a
			 * question; the alternative was an endpoint whose safety depended on nobody
			 * ever pointing a crawler at it.
			 */
			.post('/:indexer/ingest/expected-from-block', async (c) => {
				const resolved = resolveIndexer(options, c as never, 'ingest');
				if (!resolved.ok) return resolved.response;
				const {ingestion} = resolved.entry;

				return c.json({
					success: true,
					expectedFromBlock: await ingestion.expectedFromBlock(),
					context: ingestion.context,
				} as const);
			})
			.post('/:indexer/ingest', async (c) => {
				const resolved = resolveIndexer(options, c as never, 'ingest');
				if (!resolved.ok) return resolved.response;
				const {ingestion} = resolved.entry;

				let batch: UntypedWireBatch;
				try {
					// parsed with the wire codec rather than `c.req.json()`: a decoded log's
					// `args` carry a BigInt for every uint256 an ABI declares, and plain JSON
					// has no way to say so
					batch = parseWireBatch(await c.req.text());
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
	if (err instanceof WireContextMismatchError) {
		logger.error(`ingest: a batch arrived for another {source, config}: ${err.message}`);
		return c.json(
			{
				success: false,
				error: 'context-mismatch',
				expected: err.expected,
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
