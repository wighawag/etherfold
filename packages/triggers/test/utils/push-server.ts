import {createHash} from 'node:crypto';
import {createNodeServer} from '@push-notification/cli';
import {expect} from 'vitest';
import {signedPost, type AppIdentity} from './identity.js';

// ---------------------------------------------------------------------------
// THE REAL PUSH SERVER IN THIS PROCESS: push-notification-server's Node.js
// platform (`@push-notification/cli`'s `createNodeServer`) on in-memory
// libSQL, reached through its app's `fetch`, so no port is opened. Only the
// Web Push send is replaced, by a RECORDING sender: what reaches a device is
// what it records, and a test can script a device's push service failing.
// ---------------------------------------------------------------------------

export const PUSH_ORIGIN = 'https://push.test';
/** What `pushAction` is configured with: the server's API base. */
export const PUSH_API = `${PUSH_ORIGIN}/api`;

export type SentPush = {endpoint: string; payload: unknown; topic?: string; urgency?: string};

export type PushServer = {
	fetch: typeof fetch;
	/** Every push a device received, in order. */
	sent: SentPush[];
	/** The next sends to this endpoint answer these statuses, in order, then 201. */
	script(endpoint: string, statuses: number[]): void;
	/** Register a device of this user, as the app's client does: signed by its delegate key, proven by its wallet. */
	register(identity: AppIdentity): Promise<{endpoint: string}>;
};

let deviceCounter = 0;

/** A server whose pushes are authorized by a token per domain, as its operator configures `PUSH_TOKENS`. */
export async function startPushServer(tokens: Record<string, string>): Promise<PushServer> {
	const sent: SentPush[] = [];
	const scripted = new Map<string, number[]>();
	const app = await createNodeServer({
		db: ':memory:',
		env: {
			VAPID_PUBLIC_KEY: 'unused-the-sender-records',
			VAPID_PRIVATE_KEY: 'unused-the-sender-records',
			PUBLIC_ORIGIN: PUSH_ORIGIN,
			PUSH_TOKENS: Object.entries(tokens)
				.map(([domain, token]) => `${domain}:${createHash('sha256').update(token).digest('hex')}`)
				.join(','),
		},
		getPushSender: () => async (subscription, payload, options) => {
			const status = scripted.get(subscription.endpoint)?.shift() ?? 201;
			const ok = status >= 200 && status < 300;
			if (ok) {
				sent.push({
					endpoint: subscription.endpoint,
					payload: JSON.parse(payload) as unknown,
					...(options.topic === undefined ? {} : {topic: options.topic}),
					...(options.urgency === undefined ? {} : {urgency: options.urgency}),
				});
			}
			return {ok, status};
		},
	});
	const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		app.fetch(new Request(input, init))) as typeof fetch;

	return {
		fetch: doFetch,
		sent,
		script(endpoint, statuses) {
			scripted.set(endpoint, [...(scripted.get(endpoint) ?? []), ...statuses]);
		},
		async register(identity) {
			deviceCounter++;
			const subscription = {
				endpoint: `https://push-service.invalid/device-${deviceCounter}`,
				expirationTime: null,
				keys: {p256dh: `p256dh-${deviceCounter}`, auth: `auth-${deviceCounter}`},
			};
			const response = await doFetch(
				`${PUSH_ORIGIN}/api/register`,
				await signedPost(identity, {serverOrigin: PUSH_ORIGIN, path: '/api/register', fields: {subscription}}),
			);
			expect(response.status, await response.clone().text()).toBe(200);
			return {endpoint: subscription.endpoint};
		},
	};
}
