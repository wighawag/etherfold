// ---------------------------------------------------------------------------
// THE CANONICAL VIEW, as a consumer reads it (`@etherfold/server`'s
// `GET /{indexer}/canonical?gate=`, etherfold ADR-0006 and ADR-0007).
// ---------------------------------------------------------------------------
// Live entries only, at or below the caller's gate, resumable from an OPAQUE
// cursor the caller holds. Its one compensating answer is the REWIND: a cursor
// whose block is no longer canonical is told to go back to a fork block.
// ---------------------------------------------------------------------------

/** One log as the canonical view hands it back (the server's `CanonicalEntry`). */
export type CanonicalEntry = {
	blockNumber: number;
	blockHash: string;
	logIndex: number;
	transactionHash: string;
	transactionIndex: number;
	blockTimestamp?: number;
	address: string;
	topics: string[];
	data: string;
};

/** What one read of the view answered. */
export type CanonicalPage =
	| {
			kind: 'page';
			stream: string;
			generation: string;
			entries: CanonicalEntry[];
			cursor: string;
			hasMore: boolean;
	  }
	| {kind: 'rewind'; stream?: string; generation?: string; forkBlock: number; rewindCursor: string}
	/** Any other refusal (a stream mismatch, a cursor the server cannot read): an operator's to decide. */
	| {kind: 'refused'; status: number; error: string; body: Record<string, unknown>};

/** The seam the consumer reads through. */
export type CanonicalFeed = {
	read(query: {gate: number; cursor?: string; limit?: number}): Promise<CanonicalPage>;
};

/**
 * The canonical view of one named indexer of an etherfold server, over HTTP.
 *
 * `fetch` is injected: a deployment passes the global one, a test the in-process
 * app's. A transport failure (no answer, a body that is not the server's) THROWS:
 * it is a reason to try again later, never a page.
 */
export function canonicalFeed(options: {url: string; indexer: string; fetch?: typeof fetch}): CanonicalFeed {
	const base = options.url.replace(/\/+$/, '');
	const doFetch = options.fetch ?? fetch;
	return {
		async read({gate, cursor, limit}) {
			const params = new URLSearchParams({gate: String(gate)});
			if (cursor !== undefined) params.set('cursor', cursor);
			if (limit !== undefined) params.set('limit', String(limit));
			const response = await doFetch(`${base}/${encodeURIComponent(options.indexer)}/canonical?${params}`);
			const text = await response.text();
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(text) as Record<string, unknown>;
			} catch {
				throw new Error(
					`the canonical view answered ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`,
				);
			}
			if (response.status === 200 && body['success'] === true) {
				return {
					kind: 'page',
					stream: String(body['stream']),
					generation: String(body['generation']),
					entries: body['entries'] as CanonicalEntry[],
					cursor: String(body['cursor']),
					hasMore: body['hasMore'] === true,
				};
			}
			if (response.status === 409 && body['error'] === 'rewind-required') {
				return {
					kind: 'rewind',
					...(typeof body['stream'] === 'string' ? {stream: body['stream']} : {}),
					...(typeof body['generation'] === 'string' ? {generation: body['generation']} : {}),
					forkBlock: Number(body['forkBlock']),
					rewindCursor: String(body['rewindCursor']),
				};
			}
			if (response.status >= 400 && response.status < 500 && typeof body['error'] === 'string') {
				return {kind: 'refused', status: response.status, error: body['error'], body};
			}
			throw new Error(`the canonical view answered ${response.status}: ${text.slice(0, 200)}`);
		},
	};
}
