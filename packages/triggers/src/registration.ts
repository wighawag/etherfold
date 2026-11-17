import {Hono} from 'hono';
import {RegistrationError, type TriggerRegistry} from './triggers.js';

// ---------------------------------------------------------------------------
// REGISTRATION over HTTP (etherfold ADR-0013's subscription surface).
// ---------------------------------------------------------------------------
// Every route is a POST carrying a `proof`, because every route acts for ONE
// address and that address is whatever the proof RECOVERS: a body never names
// its own recipient. Otherwise anyone could register "notify X of every event"
// and use this service to spam a third party's devices (push-notification-
// server's GAP-2, whose fix asks for ONE shared proof: S1-3's, in step S2b).
// ---------------------------------------------------------------------------

/** What a proof is checked against: the route, the body (proof included) and the headers. */
export type RegistrationRequest = {path: string; body: Record<string, unknown>; headers: Headers};

/** The seam a registration's proof of address ownership is checked through. */
export type RegistrationVerifier = {
	verify(request: RegistrationRequest): Promise<{ok: true; address: string} | {ok: false; reason: string}>;
};

const STATUS_OF = {'unknown-kind': 400, 'invalid-filter': 400, 'quota-exceeded': 429} as const;

export function createRegistrationAPI(options: {registry: TriggerRegistry; verifier: RegistrationVerifier}) {
	const {registry, verifier} = options;
	const app = new Hono();

	/** The body and the address it was proven for, or the refusal to answer with. */
	async function authenticate(c: {req: {path: string; raw: Request; json(): Promise<unknown>}}) {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return {refusal: {status: 400 as const, error: 'invalid-body', message: 'the body is not JSON'}};
		}
		if (typeof body !== 'object' || body === null || Array.isArray(body)) {
			return {refusal: {status: 400 as const, error: 'invalid-body', message: 'the body is not an object'}};
		}
		const record = body as Record<string, unknown>;
		const verdict = await verifier.verify({path: c.req.path, body: record, headers: c.req.raw.headers});
		if (!verdict.ok) return {refusal: {status: 401 as const, error: 'invalid-proof', message: verdict.reason}};
		return {body: record, address: verdict.address};
	}

	function target(body: Record<string, unknown>) {
		const kind = body['kind'];
		const filter = body['filter'];
		if (typeof kind !== 'string') return undefined;
		if (filter !== undefined && (typeof filter !== 'object' || filter === null || Array.isArray(filter)))
			return undefined;
		return {kind, ...(filter === undefined ? {} : {filter: filter as Record<string, string>})};
	}

	app.onError((error, c) => {
		if (error instanceof RegistrationError) {
			return c.json({success: false, error: error.code, message: error.message}, STATUS_OF[error.code]);
		}
		throw error;
	});

	app.post('/subscriptions', async (c) => {
		const auth = await authenticate(c);
		if (auth.refusal) return c.json({success: false, ...auth.refusal}, auth.refusal.status);
		const request = target(auth.body);
		if (!request) return c.json({success: false, error: 'invalid-body', message: 'a `kind` (string) is required'}, 400);
		const subscription = await registry.subscribe({recipient: auth.address, ...request});
		return c.json({success: true, subscription});
	});

	app.post('/subscriptions/renew', async (c) => {
		const auth = await authenticate(c);
		if (auth.refusal) return c.json({success: false, ...auth.refusal}, auth.refusal.status);
		return c.json({success: true, renewed: await registry.renewAll(auth.address)});
	});

	app.post('/subscriptions/cancel', async (c) => {
		const auth = await authenticate(c);
		if (auth.refusal) return c.json({success: false, ...auth.refusal}, auth.refusal.status);
		const request = target(auth.body);
		if (!request) return c.json({success: false, error: 'invalid-body', message: 'a `kind` (string) is required'}, 400);
		return c.json({success: true, cancelled: await registry.unsubscribe({recipient: auth.address, ...request})});
	});

	app.post('/subscriptions/list', async (c) => {
		const auth = await authenticate(c);
		if (auth.refusal) return c.json({success: false, ...auth.refusal}, auth.refusal.status);
		return c.json({success: true, subscriptions: await registry.list(auth.address)});
	});

	return app;
}
