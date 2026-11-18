import {
	DEFAULT_MAX_REQUEST_AGE_MS,
	REQUEST_SIGNATURE_HEADER,
	fromDomainToOrigin,
	requestMessage,
	verifyRequest,
} from 'delegated-identity';
import {keccak256, stringToHex} from 'viem';
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
	 * rewrite. The routes are checked at the path the service sees
	 * (`/subscriptions`), which is the path a client signs, so the API must be
	 * reached at this origin's ROOT with no path rewritten: an origin with a path
	 * (`https://example.com/triggers`) is refused here rather than refusing every
	 * request later with nothing saying why.
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
 * Each signed request is accepted ONCE (`once`, which the registration API
 * remembers until the signature expires anyway): a request replayed within the
 * time window would otherwise re-register a subscription its owner has since
 * cancelled. It is named by the message the delegate key signed, so a second
 * spelling of the same signature names the same request.
 */
export function delegatedIdentityVerifier(options: DelegatedIdentityVerifierOptions): RegistrationVerifier {
	const serverOrigin = rootOrigin(options.serverOrigin);
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
			const signed = requestMessage({serverOrigin, method, path, body: rawBody, timestamp: verdict.timestamp});
			return {
				ok: true,
				address: verdict.address.toLowerCase(),
				once: {
					key: keccak256(stringToHex(`${verdict.publicKey}\n${signed}`)),
					until: verdict.timestamp + (options.maxAgeMs ?? DEFAULT_MAX_REQUEST_AGE_MS),
				},
			};
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

/** `serverOrigin` as an origin, refused when it is not one or names a path the client would not sign. */
function rootOrigin(serverOrigin: string): string {
	let url: URL;
	try {
		url = new URL(serverOrigin);
	} catch {
		throw new Error(`delegatedIdentityVerifier: the serverOrigin "${serverOrigin}" is not a URL`);
	}
	if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
		throw new Error(
			`delegatedIdentityVerifier: the serverOrigin "${serverOrigin}" has a path; the API must be reached at the origin root, without its path rewritten`,
		);
	}
	return url.origin;
}
