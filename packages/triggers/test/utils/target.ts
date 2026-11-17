/**
 * A RECORDING action target: a `fetch` that keeps every request it is sent and
 * answers from a script, so a test can make a target fail, recover, or refuse.
 * It stands for push-notification-server's `POST /push` and an operator's reward
 * service; no port is opened.
 */
export type RecordedRequest = {url: string; method: string; headers: Record<string, string>; body: unknown};

export type Answer = {status: number; body?: unknown; headers?: Record<string, string>} | 'network-error';

export function recordingTarget(answer: (request: RecordedRequest, index: number) => Answer = () => ({status: 200})) {
	const requests: RecordedRequest[] = [];
	const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const text = await request.text();
		const recorded: RecordedRequest = {
			url: request.url,
			method: request.method,
			headers: Object.fromEntries(request.headers.entries()),
			body: text === '' ? undefined : (JSON.parse(text) as unknown),
		};
		requests.push(recorded);
		const reply = answer(recorded, requests.length - 1);
		if (reply === 'network-error') throw new TypeError('fetch failed');
		return new Response(JSON.stringify(reply.body ?? {success: true}), {
			status: reply.status,
			headers: {'content-type': 'application/json', ...(reply.headers ?? {})},
		});
	}) as typeof fetch;
	return {fetch: doFetch, requests};
}
