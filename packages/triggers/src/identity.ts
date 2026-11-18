import {REQUEST_SIGNATURE_HEADER, fromDomainToOrigin, verifyRequest} from 'delegated-identity';
import type {RegistrationVerifier} from './registration.js';

// ---------------------------------------------------------------------------
// THE REGISTRATION PROOF: delegated-identity's, the one push-notification-server
// checks at `/register` (S1-3: ONE implementation of the ownership proof,
// shared by the push server, this service and missiv).
// ---------------------------------------------------------------------------
// A user's wallet signs ONCE, authorizing a delegate key for an app's origin
// (the OWNERSHIP PROOF, `ownershipSignature` in the body); the app then signs
// each request with that delegate key (the `SIGNATURE` header: this service's
// origin, the method and path, a timestamp and the raw body's hash). Both
// together recover the wallet's address, and that address is the registrant:
// the body's `address` is only the claim being checked.
// ---------------------------------------------------------------------------

export type DelegatedIdentityVerifierOptions = {
	/**
	 * This service's own public origin, the one a client signs its requests for
	 * (`https://triggers.example`), as push-notification-server's `PUBLIC_ORIGIN`.
	 * Configured rather than read from the request, which a proxy in front may
	 * rewrite.
	 */
	serverOrigin: string;
	/**
	 * The ONE app whose users may register, by domain as push-notification-server
	 * takes it: a bare host (`game.example` is `https://game.example`,
	 * `localhost:5173` is `http://`) or an origin. A proof for any other app is
	 * refused, so a page elsewhere cannot register on this service's users'
	 * behalf. One app per service because a subscription records no app: the push
	 * action names one domain, so a second app's users would be pushed under the
	 * first's domain (or to no device, reported delivered).
	 */
	domain: string;
	/** The clock a request's timestamp is checked against; `Date.now` when absent. */
	clock?: () => number;
	/** How far a timestamp may be from the clock, either way; delegated-identity's 60 s when absent. */
	maxAgeMs?: number;
};

/**
 * A `RegistrationVerifier` over delegated-identity, for one app. A registration's body is
 * `{address, domain, ownershipSignature, ...}` and its `SIGNATURE` header the
 * delegate key's signature over the request, exactly what a client sends to
 * push-notification-server's `/register`.
 *
 * A request replayed within the time window registers or renews the same
 * subscription again, which an upsert absorbs, so no signature is remembered.
 */
export function delegatedIdentityVerifier(options: DelegatedIdentityVerifierOptions): RegistrationVerifier {
	const serverOrigin = new URL(options.serverOrigin).origin;
	const served = originOf(options.domain);
	if (!served) throw new Error(`delegatedIdentityVerifier: the domain "${options.domain}" names no origin`);

	return {
		async verify({method, path, rawBody, body, headers}) {
			const signature = headers.get(REQUEST_SIGNATURE_HEADER);
			if (!signature) return {ok: false, reason: `no ${REQUEST_SIGNATURE_HEADER} header`};
			const {address, domain, ownershipSignature} = body;
			if (
				typeof address !== 'string' ||
				typeof domain !== 'string' ||
				typeof ownershipSignature !== 'string' ||
				!/^0x[0-9a-fA-F]+$/.test(ownershipSignature)
			) {
				return {ok: false, reason: 'the body needs `address`, `domain` and `ownershipSignature`'};
			}
			const appOrigin = originOf(domain);
			if (appOrigin !== served) return {ok: false, reason: `${appOrigin ?? domain} is not the app this service serves`};

			const verdict = await verifyRequest(
				{
					serverOrigin,
					method,
					path,
					body: rawBody,
					signature,
					appOrigin: served,
					address,
					ownershipSignature: ownershipSignature as `0x${string}`,
				},
				{
					...(options.clock ? {now: options.clock()} : {}),
					...(options.maxAgeMs === undefined ? {} : {maxAgeMs: options.maxAgeMs}),
				},
			);
			if (!verdict.ok) return {ok: false, reason: verdict.reason};
			return {ok: true, address: verdict.address.toLowerCase()};
		},
	};
}

/**
 * A domain's origin in its one canonical spelling (lower-case, no trailing
 * slash), as the wallet signed it: `undefined` when it names none.
 */
function originOf(domain: string): string | undefined {
	try {
		const origin = new URL(fromDomainToOrigin(domain.trim().toLowerCase())).origin;
		return origin === 'null' ? undefined : origin;
	} catch {
		return undefined;
	}
}
