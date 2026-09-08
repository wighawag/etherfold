import {Hono} from 'hono';
import {logs} from 'named-logs';
import type {ServerOptions} from '../types.js';
import type {Env} from '../env.js';
import {setup} from '../setup.js';
import {applySchema, readSchemaState, SCHEMA_VERSION} from '../schema.js';
import {readReorgCounters, type ReorgCounters} from '../reorgs.js';
import {reportCursor, type StatusCursor} from '../cursor.js';
import {reportFetcherLimits, type StatusFetcher} from '../fetcherLimits.js';

const logger = logs('@etherfold/server');

/**
 * The last error this PROCESS saw, so `/status` can tell a server that is merely
 * idle from one that is wedged.
 *
 * Deliberately in memory rather than in the database: an error worth reporting
 * here is frequently an error TALKING to the database, which is exactly when a
 * database-backed error log records nothing. It resets on restart, and that is
 * the honest semantic ("since this process started").
 */
let lastError: {message: string; at: string} | undefined;

export function recordError(err: unknown): void {
	lastError = {
		message: err instanceof Error ? err.message : String(err),
		at: new Date().toISOString(),
	};
}

/** Exposed for tests; a fresh process starts clean anyway. */
export function clearLastError(): void {
	lastError = undefined;
}

export function getStatusAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	return new Hono<{Bindings: CustomEnv}>()
		.use(setup({serverOptions: options}))
		.get('/status', async (c) => {
			const {db} = c.get('config');

			let reachable = false;
			let reachabilityError: string | undefined;
			try {
				await db.prepare('SELECT 1').all();
				reachable = true;
			} catch (err) {
				reachabilityError = err instanceof Error ? err.message : String(err);
				recordError(err);
				logger.error(`status: database unreachable: ${reachabilityError}`);
			}

			const schema = reachable
				? await readSchemaState(db)
				: ({applied: false, reason: 'database unreachable'} as const);

			// healthy = we can talk to the database AND the fixed schema is the one
			// this build expects. A version mismatch is NOT healthy: it means someone
			// else's migration is in charge of tables this build reads.
			const healthy = reachable && schema.applied && schema.matches;

			// Reported here rather than on their own route because this is the page an
			// operator already watches, and the number that matters is a RATE: a rising
			// count of ABSENCE-driven reverts means a truncated log fetch or a wrong
			// filter, not chain activity (ADR-0004). It does NOT affect `healthy`: an
			// absence-driven revert is a signal to investigate, not a broken server, and
			// a server that reported itself unhealthy for one would be restarted by an
			// orchestrator instead of looked at.
			const reorgs: ReorgCounters | undefined =
				reachable && schema.applied ? await readReorgCounters(db).catch(() => undefined) : undefined;

			// The field that makes a running deployment OBSERVABLE, and the only one
			// this route does not compute: how far the pipeline has got is a question
			// only the process that OWNS the store can answer, and what the answer MEANS
			// is the processor's (ADR-0027). So it arrives as an injected reporter and is
			// reported VERBATIM inside an envelope (ADR-0047).
			//
			// It is also where a REBUILD IN PROGRESS becomes visible, and deliberately
			// not on an endpoint of its own: a host that holds several generations reports
			// one entry per generation INSIDE this envelope, so an operator watches a
			// successor catch up on the page they already have open. Which generations a
			// host holds is the host's question too -- this route reports on the
			// DEPLOYMENT and knows no named indexer to enumerate.
			//
			// Asked even when the database is unreachable: a reporter is the HOST's, not
			// this route's `db`, and it degrades on its own. Absent entirely -- not
			// `null`, not an empty object -- on a host that injected none, because
			// inventing a field would be inventing a claim.
			const reporter = options.getCursorReport;
			const cursor: StatusCursor | undefined = reporter ? await reportCursor(() => reporter(c as never)) : undefined;

			// What the CHAIN-FACING half believes about the node it reads: how wide a range
			// it has learned this provider will answer, and which suspect result count is in
			// force (ADR-0074). Injected for the same reason the cursor is -- only the process
			// that HOLDS a fetcher can say -- and absent on the hosts that hold none, which is
			// most of them: a receiver makes no chain call at all.
			//
			// Reported so it can be handed BACK as configuration on a later run, which is how
			// a restart resumes where discovery left off while the fetcher stays stateless.
			const limits = options.getFetcherLimits;
			const fetcher: StatusFetcher | undefined = limits
				? await reportFetcherLimits(() => limits(c as never))
				: undefined;

			return c.json(
				{
					healthy,
					database: {reachable, error: reachabilityError},
					reorgs,
					cursor,
					fetcher,
					schema: schema.applied
						? {applied: true, version: schema.version, expected: schema.expected, matches: schema.matches}
						: {applied: false, expected: SCHEMA_VERSION, reason: schema.reason},
					lastError,
				},
				healthy ? 200 : 503,
			);
		})
		.post('/admin/setup', async (c) => {
			const {db} = c.get('config');
			try {
				await applySchema(db);
			} catch (err) {
				recordError(err);
				throw err;
			}
			return c.json({success: true, version: SCHEMA_VERSION});
		});
}
