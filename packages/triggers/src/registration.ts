import {REQUEST_SIGNATURE_HEADER} from 'delegated-identity';
import {Hono} from 'hono';
import {cors} from 'hono/cors';
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

/**
 * What a proof is checked against: the method and route, the body exactly as
 * sent (`rawBody`, what a request signature covers: delegated-identity's
 * `verifyRequest` hashes the bytes, so a re-serialised body would not verify),
 * the same body parsed, and the headers (a request signature travels in one).
 */
export type RegistrationRequest = {
	method: string;
	path: string;
	rawBody: string;
	body: Record<string, unknown>;
	headers: Headers;
};

/**
 * A proof accepted. `once` asks for it to be accepted only once: `key` names
 * the signed request, `until` (ms since the epoch) is when it stops being
 * acceptable anyway, so it need not be remembered longer.
 */
export type AcceptedProof = {ok: true; address: string; once?: {key: string; until: number}};

/** The seam a registration's proof of address ownership is checked through. */
export type RegistrationVerifier = {
	/**
	 * The origin of the ONE app whose pages call the API from a browser
	 * (`https://game.example`), when the verifier serves one app: the
	 * registration API answers CORS for this origin and no other. Absent, it
	 * answers no CORS at all, and only a same-origin page or a server can call it.
	 */
	appOrigin?: string;
	verify(request: RegistrationRequest): Promise<AcceptedProof | {ok: false; reason: string}>;
};

/** How long a browser may cache a preflight: ten minutes, so a changed app origin is picked up soon. */
const CORS_MAX_AGE_SECONDS = 600;

/** An origin in the one spelling a browser sends in `Origin`; refused when it is not one. */
function originOf(appOrigin: string): string {
	let origin: string;
	try {
		origin = new URL(appOrigin).origin;
	} catch {
		origin = 'null';
	}
	if (origin === 'null')
		throw new Error(`createRegistrationAPI: the verifier's appOrigin "${appOrigin}" is not an origin`);
	return origin;
}

const STATUS_OF = {'unknown-kind': 400, 'invalid-filter': 400, 'quota-exceeded': 429} as const;

export function createRegistrationAPI(options: {registry: TriggerRegistry; verifier: RegistrationVerifier}) {
	const {registry, verifier} = options;
	const app = new Hono();

	// CORS for the one app the verifier serves, never `*`: a browser app on its
	// own origin sends a JSON body and the SIGNATURE header, so every call is
	// preflighted. Every response carries the allow-origin, refusals included, so
	// the app can read the reason; another origin gets none and its browser
	// blocks the call. No credentials: the proof is in the request, not a cookie.
	// The proof checks are untouched, and the path is not rewritten (it is what
	// the client signed).
	if (verifier.appOrigin !== undefined) {
		app.use(
			'*',
			cors({
				origin: originOf(verifier.appOrigin),
				allowMethods: ['POST', 'OPTIONS'],
				allowHeaders: ['content-type', REQUEST_SIGNATURE_HEADER.toLowerCase()],
				maxAge: CORS_MAX_AGE_SECONDS,
			}),
		);
	}

	/** The body and the address it was proven for, or the refusal to answer with. */
	async function authenticate(c: {req: {path: string; method: string; raw: Request; text(): Promise<string>}}) {
		const rawBody = await c.req.text();
		let body: unknown;
		try {
			body = JSON.parse(rawBody) as unknown;
		} catch {
			return {refusal: {status: 400 as const, error: 'invalid-body', message: 'the body is not JSON'}};
		}
		if (typeof body !== 'object' || body === null || Array.isArray(body)) {
			return {refusal: {status: 400 as const, error: 'invalid-body', message: 'the body is not an object'}};
		}
		const record = body as Record<string, unknown>;
		const verdict = await verifier.verify({
			method: c.req.method,
			path: c.req.path,
			rawBody,
			body: record,
			headers: c.req.raw.headers,
		});
		if (!verdict.ok) return {refusal: {status: 401 as const, error: 'invalid-proof', message: verdict.reason}};
		// a signed request is accepted once: a replay of a registration must not undo a later cancel
		if (verdict.once && !(await registry.acceptOnce(verdict.once.key, verdict.once.until))) {
			return {refusal: {status: 401 as const, error: 'invalid-proof', message: 'replayed'}};
		}
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
