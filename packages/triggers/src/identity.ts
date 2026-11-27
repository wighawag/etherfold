import {
	DEFAULT_MAX_REQUEST_AGE_MS,
	REQUEST_SIGNATURE_HEADER,
	fromDomainToOrigin,
	requestMessage,
	verifyRequest,
	type PublicKeySet,
} from 'delegated-identity';
import {sha256} from 'delegated-identity/ed25519';
import type {RegistrationVerifier} from './registration.js';

// ---------------------------------------------------------------------------
// THE REGISTRATION PROOF: delegated-identity's, the one push-notification-server
// checks at `/register` (S1-3: ONE implementation of the ownership proof,
// shared by the push server, this service and missiv).
// ---------------------------------------------------------------------------
// A user's wallet signs ONCE, authorizing a KEY SET for an app's origin (an
// Ed25519 signing key and an X25519 encryption key, `keySet` in the body; the
// OWNERSHIP PROOF, `ownershipSignature`); the app then signs each request with
// the signing key (the `SIGNATURE` header, `<timestamp>:<key>:<signature>`, an
// Ed25519 signature over an envelope naming this service's origin, the method
// and path, the timestamp and the raw body's SHA-256). The header's key must be
// the key set's, and the proof must recover the body's `address`: that address
// is the registrant, the body only claims it. Nothing here recovers a request
// signature (Ed25519 has no recovery); the one secp256k1 recovery left is the
// wallet's EIP-191 proof, inside delegated-identity.
// ---------------------------------------------------------------------------

export type DelegatedIdentityVerifierOptions = {
	/**
	 * This service's own public origin, the one a client signs its requests for
	 * (`https://triggers.example`), as push-notification-server's `PUBLIC_ORIGIN`.
	 * Configured rather than read from the request, which a proxy in front may
	 * rewrite. The routes are checked at the full path the service sees
	 * (`/subscriptions`, or `/{app}/subscriptions` where a platform mounts the
	 * API under the app's name), which is the path a client signs, so the API must be
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
	 * behalf. The domain is per app because each app has its own verifier and
	 * its own push action, which pushes under that app's domain: a verifier
	 * serving a second domain would let that domain's users register with an app
	 * whose pushes go out under the first (etherfold ADR-0101). Its origin is
	 * also the one the registration API answers CORS for (`appOrigin`).
	 */
	domain: string;
	/** The clock a request's timestamp is checked against; `Date.now` when absent. */
	clock?: () => number;
	/** How far a timestamp may be from the clock, either way; delegated-identity's 60 s when absent. */
	maxAgeMs?: number;
};

/**
 * A `RegistrationVerifier` over delegated-identity, for one app. A registration's body is
 * `{address, domain, keySet, ownershipSignature, ...}` (`keySet` the public
 * `{signing: {publicKey}, encryption: {publicKey}}`) and its `SIGNATURE` header
 * the signing key's signature over the request, exactly what a client sends to
 * push-notification-server's `/register`, so one body serves both.
 *
 * Its `appOrigin` is that app's origin (`fromDomainToOrigin(domain)`), so the
 * registration API answers CORS for the app's pages and no other origin's.
 *
 * Each signed request is accepted ONCE (`once`, which the registration API
 * remembers until the signature expires anyway): a request replayed within the
 * time window would otherwise re-register a subscription its owner has since
 * cancelled. It is named by the SHA-256 of the envelope the signing key signed
 * (the server, route, timestamp and body's hash; the body names the key set, so
 * the envelope binds the key too), not by the header: a second spelling of the
 * same header names the same request.
 */
export function delegatedIdentityVerifier(options: DelegatedIdentityVerifierOptions): RegistrationVerifier {
	const serverOrigin = rootOrigin(options.serverOrigin);
	const served = originOf(options.domain);
	if (!served) throw new Error(`delegatedIdentityVerifier: the domain "${options.domain}" names no origin`);

	return {
		appOrigin: served,
		async verify({method, path, rawBody, body, headers}) {
			const signature = headers.get(REQUEST_SIGNATURE_HEADER);
			if (!signature) return {ok: false, reason: `no ${REQUEST_SIGNATURE_HEADER} header`};
			const {address, domain, keySet, ownershipSignature} = body;
			if (
				typeof address !== 'string' ||
				typeof domain !== 'string' ||
				typeof keySet !== 'object' ||
				keySet === null ||
				Array.isArray(keySet) ||
				typeof ownershipSignature !== 'string' ||
				!/^0x[0-9a-fA-F]+$/.test(ownershipSignature)
			) {
				return {ok: false, reason: 'the body needs `address`, `domain`, `keySet` and `ownershipSignature`'};
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
					// its keys' format is verifyRequest's to check (`malformed`)
					keySet: keySet as PublicKeySet,
					ownershipSignature: ownershipSignature as `0x${string}`,
				},
				{
					...(options.clock ? {now: options.clock()} : {}),
					...(options.maxAgeMs === undefined ? {} : {maxAgeMs: options.maxAgeMs}),
				},
			);
			if (!verdict.ok) return {ok: false, reason: verdict.reason};
			const signed = await requestMessage({serverOrigin, method, path, body: rawBody, timestamp: verdict.timestamp});
			return {
				ok: true,
				address: verdict.address.toLowerCase(),
				once: {
					key: hex(await sha256(new TextEncoder().encode(signed))),
					until: verdict.timestamp + (options.maxAgeMs ?? DEFAULT_MAX_REQUEST_AGE_MS),
				},
			};
		},
	};
}

function hex(bytes: Uint8Array): string {
	return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
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
