import type {ActionAdapter, DeliveryOutcome, DeliveryPolicy} from './delivery.js';
import type {DeliveryRecord} from './outbox.js';

// ---------------------------------------------------------------------------
// THE ACTION ADAPTERS: push (push-notification-server) and reward (an
// operator's reward service). Both send the key as `Idempotency-Key` (the IETF
// httpapi draft's header), because a target must honour it and we cannot
// enforce that from here (etherfold ADR-0009).
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A push is worthless after an hour, and is not worth many retries. */
export const DEFAULT_PUSH_POLICY: DeliveryPolicy = {
	ttlMs: HOUR,
	maxAttempts: 6,
	backoff: {initialMs: 5000, maxMs: 5 * MINUTE},
};

/** A reward never expires, and is retried for days (30 s doubling to 6 h, about five days) before a dead letter. */
export const DEFAULT_REWARD_POLICY: DeliveryPolicy = {maxAttempts: 30, backoff: {initialMs: 30_000, maxMs: 6 * HOUR}};

/** What a push-rendering trigger renders: push-notification-server's declarative push, and its delivery hints. */
export type PushPayload = {message: unknown; topic?: string; urgency?: 'very-low' | 'low' | 'normal' | 'high'};

function retryAfterOf(response: Response): number | undefined {
	const header = response.headers.get('retry-after');
	if (header === null) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** The shared mapping: 2xx delivered, 408, 429 and 5xx retried, any other status dead. */
function outcomeOfStatus(response: Response, text: string, retryAlso: number[] = []): DeliveryOutcome {
	if (response.status >= 200 && response.status < 300) return {kind: 'delivered'};
	const error = `${response.status}: ${text.slice(0, 200)}`;
	if (
		response.status === 408 ||
		response.status === 429 ||
		response.status >= 500 ||
		retryAlso.includes(response.status)
	) {
		const retryAfterMs = retryAfterOf(response);
		return {kind: 'retry', error, ...(retryAfterMs === undefined ? {} : {retryAfterMs})};
	}
	return {kind: 'dead', error};
}

/** The call, or the transport failure as a retry (nothing answered, so nothing was refused). */
async function post(
	doFetch: typeof fetch,
	url: string,
	token: string,
	key: string,
	body: unknown,
): Promise<{response: Response; text: string} | {kind: 'retry'; error: string}> {
	try {
		const response = await doFetch(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': key},
			body: JSON.stringify(body),
		});
		return {response, text: await response.text()};
	} catch (error) {
		return {kind: 'retry', error: `no answer: ${error instanceof Error ? error.message : String(error)}`};
	}
}

/**
 * A Web Push through push-notification-server's `POST <url>/push` (`url` is its
 * API base, `https://<host>/api`), authenticated by a token scoped to one domain
 * (S1-1), deduplicated by the key per subscription (S1-4). The trigger service holds no push endpoint and no key: identity is
 * `(address, domain)` (etherfold ADR-0009).
 */
export function pushAction(options: {
	url: string;
	domain: string;
	token: string;
	fetch?: typeof fetch;
	policy?: DeliveryPolicy;
}): ActionAdapter {
	const endpoint = `${options.url.replace(/\/+$/, '')}/push`;
	const doFetch = options.fetch ?? fetch;
	return {
		policy: options.policy ?? DEFAULT_PUSH_POLICY,
		async deliver(delivery: DeliveryRecord) {
			const payload = delivery.payload as PushPayload;
			const answered = await post(doFetch, endpoint, options.token, delivery.key, {
				address: delivery.recipient,
				domain: options.domain,
				message: payload.message,
				...(payload.topic === undefined ? {} : {topic: payload.topic}),
				...(payload.urgency === undefined ? {} : {urgency: payload.urgency}),
			});
			if (!('response' in answered)) return answered;
			// 200 delivered (or nothing to deliver); 502 a send failed and 409 the same key still sending,
			// both retried under the key, which reaches only the devices not yet delivered; 400, 401 and
			// 403 (a bad key, a token problem) are permanent
			return outcomeOfStatus(answered.response, answered.text, [409]);
		},
	};
}

/**
 * A call to an operator's REWARD service (S2-6): it owns whatever a reward is,
 * a badge or a mint, and its transaction manager. This service never submits a
 * transaction itself. Safe lane only.
 */
export function rewardAction(options: {
	url: string;
	token: string;
	fetch?: typeof fetch;
	policy?: DeliveryPolicy;
}): ActionAdapter {
	const doFetch = options.fetch ?? fetch;
	return {
		lanes: ['safe'],
		policy: options.policy ?? DEFAULT_REWARD_POLICY,
		async deliver(delivery: DeliveryRecord) {
			const answered = await post(doFetch, options.url, options.token, delivery.key, {
				key: delivery.key,
				recipient: delivery.recipient,
				reward: delivery.payload,
				trigger: delivery.trigger,
				log: {
					app: delivery.app,
					blockNumber: delivery.blockNumber,
					blockHash: delivery.blockHash,
					logIndex: delivery.logIndex,
					transactionHash: delivery.transactionHash,
				},
			});
			if (!('response' in answered)) return answered;
			// a 409 is the same key still in flight at the target: try again later
			return outcomeOfStatus(answered.response, answered.text, [409]);
		},
	};
}
