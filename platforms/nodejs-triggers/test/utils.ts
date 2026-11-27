import {
	REQUEST_SIGNATURE_HEADER,
	deriveKeySet,
	fromDomainToOrigin,
	originPublicKeyPublicationMessage,
	signRequest,
	type KeySet,
} from 'delegated-identity';
import {encodeAbiParameters, encodeEventTopics} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import type {ActionAdapter, CanonicalEntry, DeliveryRecord} from '../src/index.js';

// ---------------------------------------------------------------------------
// Port-free helpers: a scripted canonical view reached through its `fetch`, a
// recording action adapter, and an app user who signs requests the way
// delegated-identity's client does.
// ---------------------------------------------------------------------------

export const BOARD = '0x00000000000000000000000000000000000000b0';
export const ALICE = '0x00000000000000000000000000000000000000a1';
export const BOB = '0x00000000000000000000000000000000000000b1';

export const postedAbi = {
	type: 'event',
	name: 'Posted',
	inputs: [
		{indexed: true, name: 'author', type: 'address'},
		{indexed: false, name: 'count', type: 'uint256'},
		{indexed: false, name: 'text', type: 'string'},
	],
} as const;

/** A `Posted` log at `block`, by `author`. */
export function post(block: number, author: string, count: bigint, text = 'hello'): CanonicalEntry {
	return {
		blockNumber: block,
		blockHash: `0x${block.toString(16).padStart(4, '0')}`,
		logIndex: 0,
		transactionHash: `0x${block.toString(16).padStart(2, '0')}`,
		transactionIndex: 0,
		address: BOARD,
		topics: encodeEventTopics({
			abi: [postedAbi],
			eventName: 'Posted',
			args: {author: author as `0x${string}`},
		}) as string[],
		data: encodeAbiParameters([{type: 'uint256'}, {type: 'string'}], [count, text]),
	};
}

/**
 * The canonical view of ONE named indexer: `pages[n]` is served at cursor
 * `p<n>` (no cursor: page 0), then an empty page. A read for another indexer
 * is refused as the server would, so a test proves each app follows its own.
 */
export function scriptedFeed(indexer: string, pages: CanonicalEntry[][]) {
	const seen = {reads: 0};
	const doFetch = (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		if (url.pathname !== `/${indexer}/canonical`) {
			return Response.json({success: false, error: 'unknown-indexer'}, {status: 404});
		}
		seen.reads++;
		const cursor = url.searchParams.get('cursor');
		const at = cursor === null ? 0 : Number(cursor.slice(1));
		return Response.json({
			success: true,
			stream: 's',
			generation: 'g',
			entries: pages[at] ?? [],
			cursor: `p${Math.min(at + 1, pages.length)}`,
			hasMore: at + 1 < pages.length,
		});
	}) as typeof fetch;
	return {fetch: doFetch, seen};
}

/** A feed that accepts the request and never answers, until its signal aborts. */
export const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
	new Promise<Response>((_, reject) => {
		init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {once: true});
	})) as typeof fetch;

/** An action adapter that records every delivery it is handed and answers `delivered`. */
export function recordingAction(): ActionAdapter & {delivered: DeliveryRecord[]} {
	const delivered: DeliveryRecord[] = [];
	return {
		delivered,
		policy: {maxAttempts: 3, backoff: {initialMs: 1, maxMs: 1}},
		async deliver(delivery) {
			delivered.push(delivery);
			return {kind: 'delivered'};
		},
	};
}

export type AppUser = {address: string; domain: string; keySet: KeySet; ownershipSignature: string};

/** A wallet that authorized a key set (an Ed25519 signing key, an X25519 encryption key) for the app at `domain`. */
export async function appUser(domain: string): Promise<AppUser> {
	const wallet = privateKeyToAccount(generatePrivateKey());
	const keySet = deriveKeySet(generatePrivateKey());
	const ownershipSignature = await wallet.signMessage({
		message: originPublicKeyPublicationMessage(fromDomainToOrigin(domain), keySet),
	});
	return {address: wallet.address.toLowerCase(), domain, keySet, ownershipSignature};
}

/** A POST as the app's client sends it, signed for `serverOrigin` and `signedPath` (the path it is sent to when absent). */
export async function signedPost(
	user: AppUser,
	request: {serverOrigin: string; path: string; signedPath?: string; fields?: Record<string, unknown>},
): Promise<RequestInit> {
	const body = JSON.stringify({
		address: user.address,
		domain: user.domain,
		keySet: {
			signing: {publicKey: user.keySet.signing.publicKey},
			encryption: {publicKey: user.keySet.encryption.publicKey},
		},
		ownershipSignature: user.ownershipSignature,
		...request.fields,
	});
	const signature = await signRequest(
		{serverOrigin: request.serverOrigin, method: 'POST', path: request.signedPath ?? request.path, body},
		user.keySet.signing.privateKey,
	);
	return {method: 'POST', headers: {'Content-Type': 'application/json', [REQUEST_SIGNATURE_HEADER]: signature}, body};
}

/** Wait for `condition`, polling, or fail after `timeoutMs`. */
export async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!(await condition())) {
		if (Date.now() - start > timeoutMs) throw new Error('the condition never held');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
