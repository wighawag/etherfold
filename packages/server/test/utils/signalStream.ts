import {expect} from 'vitest';

// ---------------------------------------------------------------------------------------------------
// A CLIENT OF THE STATE-MOVED STREAM, as a remote app holds one
// ---------------------------------------------------------------------------------------------------
// A tiny server-sent-events reader: open the route, parse the frames, keep what
// arrived, and DISCONNECT. It exists here rather than in one test file because
// the fan-in task (`one-handler-for-every-transport`) runs its parameterised
// suite over this transport too, and two hand-written SSE readers would be two
// ideas of what the wire says.
//
// It deliberately does NOT use `EventSource`: that is a browser API this package
// may not name, and it RECONNECTS on its own, which would hide the one thing
// several cases here assert -- that a client which went away is a client the
// producer holds nothing about.
// ---------------------------------------------------------------------------------------------------

/** One frame off the wire: the event NAME and its parsed `data` payload. */
export type SignalEvent = {event: string; data: Record<string, unknown>};

export type SignalStream = {
	/** The status the route answered with. `200` for a stream; a refusal otherwise. */
	status: number;
	/** What this client has been told, in arrival order. */
	events: SignalEvent[];
	/** The `state-moved` frames alone, which is what a reader's handler gets. */
	moved(): Record<string, unknown>[];
	/** The `progress` frames alone: where the fold is, as this client can render it. */
	progress(): Record<string, unknown>[];
	/** The RAW `data` line of each frame, so identical SERIALISATION can be asserted. */
	raw: {event: string; data: string}[];
	/** Wait until what arrived satisfies `predicate`. Fails loudly rather than hanging. */
	waitFor(predicate: (events: SignalEvent[]) => boolean, what: string): Promise<void>;
	/** Whether the server has closed its end. */
	ended(): boolean;
	/** GO AWAY, as a client closing a tab does. */
	close(): Promise<void>;
};

/** Whatever answers a request: a Hono app under test, or anything else that does. */
type Requestable = {request: (path: string, init?: RequestInit) => Response | Promise<Response>};

/** Open the state-moved stream of one named indexer, and start reading it. */
export async function openSignalStream(app: Requestable, path: string): Promise<SignalStream> {
	const response = await app.request(path);
	const events: SignalEvent[] = [];
	const raw: {event: string; data: string}[] = [];
	let ended = false;

	if (response.status !== 200 || !response.body) {
		return {
			status: response.status,
			events,
			raw,
			moved: () => [],
			progress: () => [],
			waitFor: async () => {
				throw new Error(`this stream was refused with ${response.status}: nothing will ever arrive on it`);
			},
			ended: () => true,
			close: async () => {},
		};
	}

	const reader = response.body.getReader();
	const pump = (async () => {
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			for (;;) {
				const {done, value} = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, {stream: true});
				let boundary = buffer.indexOf('\n\n');
				while (boundary >= 0) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const parsed = parseFrame(frame);
					if (parsed) {
						raw.push({event: parsed.event, data: parsed.raw});
						events.push({event: parsed.event, data: parsed.data});
					}
					boundary = buffer.indexOf('\n\n');
				}
			}
		} catch {
			// the reader was cancelled by `close`, which is a client going away
		}
		ended = true;
	})();

	return {
		status: response.status,
		events,
		raw,
		moved: () => events.filter((e) => e.event === 'state-moved').map((e) => e.data),
		progress: () => events.filter((e) => e.event === 'progress').map((e) => e.data),
		async waitFor(predicate, what) {
			// A DEADLINE and not a sleep: every assertion in these files is about a
			// VALUE, and this exists only so that a stream which never carries what was
			// expected fails with what it did carry instead of hanging the suite.
			const deadline = Date.now() + 2000;
			while (!predicate(events)) {
				if (Date.now() > deadline) {
					expect.fail(`the stream never carried ${what}. It carried: ${JSON.stringify(events)}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		},
		ended: () => ended,
		async close() {
			await reader.cancel().catch(() => {});
			await pump;
		},
	};
}

/** One `event:`/`data:` frame, as the wire format writes it. */
function parseFrame(frame: string): {event: string; data: Record<string, unknown>; raw: string} | undefined {
	let event = 'message';
	const dataLines: string[] = [];
	for (const line of frame.split('\n')) {
		if (line.startsWith(':')) continue; // a comment, which is what a heartbeat would be
		if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
		else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
	}
	if (dataLines.length === 0) return undefined;
	const data = dataLines.join('\n');
	return {event, data: JSON.parse(data) as Record<string, unknown>, raw: data};
}
