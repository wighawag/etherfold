import type {Context} from 'hono';
import {logs} from 'named-logs';
import type {Env} from '../env.js';

const logger = logs('@etherfold/server');

/**
 * THE BEARER GUARD both credentialled surfaces run, in ONE place.
 *
 * Two guards exist -- the fetcher's private INGEST routes (`INGEST_TOKEN`) and
 * the operator's ADMIN routes (`ADMIN_TOKEN`) -- and they are two CREDENTIALS
 * rather than two rules: what counts as presented, how a secret is compared, and
 * what a server with no secret configured does are the same questions on both.
 * Two copies of that would be two answers to "is a length-mismatched token
 * rejected the same way", which is exactly the kind of divergence nobody notices
 * until one of them is wrong.
 *
 * They are deliberately separate SECRETS, and that is the whole point of this
 * being parameterised on the variable rather than shared as one token: the
 * ingest credential is handed to a log shipper and guards the WRITE path, and a
 * fetcher that could also decide which generation answers reads would hold
 * control-plane authority nobody gave it.
 */

/**
 * Compare two secrets without leaking WHERE they first differ.
 *
 * Written out rather than taken from `node:crypto`, because this package names
 * no runtime (a test asserts it). It leaks the LENGTH, which the archived
 * server's `timingSafeEqual` version also did, and which tells an attacker
 * nothing they cannot get by counting characters in a rejected guess.
 */
export function secretEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) {
		difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return difference === 0;
}

/** WHICH credential a surface is guarded by. Never a default, and never shared between surfaces. */
export type ServerCredential = 'INGEST_TOKEN' | 'ADMIN_TOKEN';

/**
 * Whether this caller may touch the surface that credential guards.
 *
 * FAIL-CLOSED on a missing secret: a server that can authenticate nobody
 * authenticates nobody. The message names the variable, because the alternative
 * is an operator staring at a 401 they configured themselves.
 */
export function authorizedWith(
	c: Context<{Bindings: Env}>,
	credential: ServerCredential,
): {ok: true} | {ok: false; message: string} {
	const configured = c.get('config')?.env?.[credential];
	if (!configured) {
		logger.error(`a route guarded by ${credential} was called with none configured: refusing every caller`);
		return {ok: false, message: `no ${credential} is configured on this server, so no caller can be authenticated`};
	}
	const header = c.req.header('Authorization');
	const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
	if (!presented || !secretEquals(configured, presented)) {
		return {ok: false, message: `expected an Authorization: Bearer <token> header matching ${credential}`};
	}
	return {ok: true};
}
