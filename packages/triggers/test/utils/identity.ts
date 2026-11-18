import {
	REQUEST_SIGNATURE_HEADER,
	delegatePublicKey,
	fromDomainToOrigin,
	originPublicKeyPublicationMessage,
	signRequest,
} from 'delegated-identity';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';

// ---------------------------------------------------------------------------
// AN APP'S USER, as a browser holds one: a wallet that signed ONCE to authorize
// a delegate key for the app's origin (the ownership proof, delegated-identity's
// publication message), and the delegate key that then signs every request
// (the SIGNATURE header). The same identity registers a push subscription with
// push-notification-server and a trigger with this service.
// ---------------------------------------------------------------------------

export type AppIdentity = {
	/** The wallet's address, lower-case. */
	address: `0x${string}`;
	domain: string;
	delegateKey: `0x${string}`;
	ownershipSignature: `0x${string}`;
};

export async function appIdentity(domain: string, options: {signedForDomain?: string} = {}): Promise<AppIdentity> {
	const wallet = privateKeyToAccount(generatePrivateKey());
	const delegateKey = generatePrivateKey();
	const ownershipSignature = await wallet.signMessage({
		message: originPublicKeyPublicationMessage(
			fromDomainToOrigin(options.signedForDomain ?? domain),
			delegatePublicKey(delegateKey),
		),
	});
	return {address: wallet.address.toLowerCase() as `0x${string}`, domain, delegateKey, ownershipSignature};
}

/**
 * A POST as the app's client sends it: the body names the account, the app's
 * domain and the ownership proof beside `fields`, and the delegate key signs
 * the request for `serverOrigin` and `path`. The options break one thing each.
 */
export async function signedPost(
	identity: AppIdentity,
	request: {serverOrigin: string; path: string; fields?: Record<string, unknown>},
	options: {
		address?: string;
		signer?: AppIdentity;
		signedPath?: string;
		signedServerOrigin?: string;
		timestamp?: number;
		tamper?: (body: string) => string;
		noSignature?: boolean;
	} = {},
): Promise<RequestInit> {
	const body = JSON.stringify({
		address: options.address ?? identity.address,
		domain: identity.domain,
		ownershipSignature: identity.ownershipSignature,
		...request.fields,
	});
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
			(options.signer ?? identity).delegateKey,
		);
	}
	return {method: 'POST', headers, body: options.tamper ? options.tamper(body) : body};
}
