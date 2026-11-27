import {
	REQUEST_SIGNATURE_HEADER,
	deriveKeySet,
	fromDomainToOrigin,
	originPublicKeyPublicationMessage,
	signRequest,
	type KeySet,
	type PublicKeySet,
} from 'delegated-identity';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';

// ---------------------------------------------------------------------------
// AN APP'S USER, as a browser holds one: a wallet that signed ONCE to authorize
// a key set for the app's origin (the ownership proof, delegated-identity's
// publication message naming an Ed25519 signing key and an X25519 encryption
// key), and the signing key that then signs every request (the SIGNATURE
// header). The same identity, and the same body, registers a push subscription
// with push-notification-server and a trigger with this service.
// ---------------------------------------------------------------------------

export type AppIdentity = {
	/** The wallet's address, lower-case. */
	address: `0x${string}`;
	domain: string;
	/** The key set the wallet authorized, private halves included (the app holds them). */
	keySet: KeySet;
	ownershipSignature: `0x${string}`;
};

/** The public half of a key set, as a body carries it (`keySet`, push-notification-server's shape). */
export function publicKeySet(keySet: PublicKeySet): PublicKeySet {
	return {signing: {publicKey: keySet.signing.publicKey}, encryption: {publicKey: keySet.encryption.publicKey}};
}

export async function appIdentity(domain: string, options: {signedForDomain?: string} = {}): Promise<AppIdentity> {
	const wallet = privateKeyToAccount(generatePrivateKey());
	// with @etherplay/connect, the account's per-origin key; any 32 bytes here
	const keySet = deriveKeySet(generatePrivateKey());
	const ownershipSignature = await wallet.signMessage({
		message: originPublicKeyPublicationMessage(fromDomainToOrigin(options.signedForDomain ?? domain), keySet),
	});
	return {address: wallet.address.toLowerCase() as `0x${string}`, domain, keySet, ownershipSignature};
}

/**
 * The identity part of a body, as the app's client sends it to both services:
 * `{address, domain, keySet, ownershipSignature}`.
 */
export function identityFields(identity: AppIdentity, options: {address?: string; keySet?: PublicKeySet} = {}) {
	return {
		address: options.address ?? identity.address,
		domain: identity.domain,
		keySet: publicKeySet(options.keySet ?? identity.keySet),
		ownershipSignature: identity.ownershipSignature,
	};
}

/**
 * A POST as the app's client sends it: the body names the account, the app's
 * domain, the key set and the ownership proof beside `fields`, and the signing
 * key signs the request for `serverOrigin` and `path`. The options break one
 * thing each.
 */
export async function signedPost(
	identity: AppIdentity,
	request: {serverOrigin: string; path: string; fields?: Record<string, unknown>},
	options: {
		address?: string;
		/** the key set the body names, in place of the one the wallet authorized */
		keySet?: PublicKeySet;
		signer?: AppIdentity;
		signedPath?: string;
		signedServerOrigin?: string;
		timestamp?: number;
		tamper?: (body: string) => string;
		noSignature?: boolean;
	} = {},
): Promise<RequestInit> {
	const body = JSON.stringify({...identityFields(identity, options), ...request.fields});
	const headers: Record<string, string> = {'Content-Type': 'application/json'};
	if (!options.noSignature) {
		headers[REQUEST_SIGNATURE_HEADER] = await signRequest(
			{
				serverOrigin: options.signedServerOrigin ?? request.serverOrigin,
				method: 'POST',
				path: options.signedPath ?? request.path,
				body,
				...(options.timestamp === undefined ? {} : {timestamp: options.timestamp}),
			},
			(options.signer ?? identity).keySet.signing.privateKey,
		);
	}
	return {method: 'POST', headers, body: options.tamper ? options.tamper(body) : body};
}
