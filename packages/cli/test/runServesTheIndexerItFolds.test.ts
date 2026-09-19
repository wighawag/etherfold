import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {afterEach, describe, expect, it} from 'vitest';
import {run, type RunDependencies, type RunningIndexer} from '../src/index.js';
import type {Options} from '../src/types.js';
import {ALICE, BOB, entityModule, fakeChain, START_BLOCK, transfer, ZERO} from './utils/chain.js';
import {identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// THE COMBINED PROCESS SERVES THE NAMED INDEXER IT FOLDS, AND STILL TAKES NO PUSHES
// ---------------------------------------------------------------------------------------------------
// `run` is the milestone shape (`CONTEXT.md`): one process that follows a chain,
// folds it and answers. It held everything the READ routes need -- the database,
// the stored emission stream, the generation registry and the publisher that
// says the state moved -- and served none of them, because registering a named
// indexer used to be ALL OR NOTHING and the one capability it must not offer is
// the one that accepts a REMOTE WRITER.
//
// So it registers a READ-ONLY entry: the reads answer, and the reason it refuses
// ingestion is exactly as true as it was -- this process fetches the chain for
// itself, so a sender pushing into it would be a second writer nobody asked for.
//
// The refusal is asserted WITH A VALID INGEST CREDENTIAL PRESENTED, deliberately.
// With no `INGEST_TOKEN` configured every push is refused `401` anyway, and a
// test that leant on that would be asserting a door held shut by a missing
// environment variable -- one an operator opens the moment they set the variable
// for an unrelated reason.
// ---------------------------------------------------------------------------------------------------

/** The NAME this deployment is given, which is the route segment its reads hang off. */
const INDEXER = 'nfts';
const INGEST_TOKEN = 'a-shared-secret';
const ADMIN_TOKEN = 'the-operators-own-secret';

const RUN: Options = {
	processor: './nfts.js',
	nodeUrl: 'http://localhost:0',
	store: 'sqlite',
	db: ':memory:',
	port: '0',
	indexer: INDEXER,
};

const LOGS = [
	transfer(START_BLOCK + 10, '0xa10', ZERO, ALICE, 1n),
	transfer(START_BLOCK + 20, '0xa20', ALICE, BOB, 1n),
];
const TIP = START_BLOCK + 50;

let running: RunningIndexer | undefined;

afterEach(async () => {
	await running?.stop().catch(() => undefined);
	running = undefined;
	delete process.env.INGEST_TOKEN;
	delete process.env.ADMIN_TOKEN;
});

/**
 * WHAT THIS SUITE'S ARRIVAL IS CALLED (ADR-0086).
 *
 * The subject is WHICH NAME a `run` process serves the read tier under and what
 * it refuses; the injected module arrival stays and is named, so no deployment
 * here falls through to the author-DECLARED identity the contract task deletes.
 */
const ARRIVAL = identityOf('the-fold-this-run-serves');

function depsFor(chain: ReturnType<typeof fakeChain>, db: RemoteSQL, extra: RunDependencies = {}): RunDependencies {
	return {
		importModule: async () => entityModule,
		processorIdentity: ARRIVAL,
		provider: chain.provider,
		createDB: () => db,
		sleep: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
		},
		handleSignals: false,
		log: () => {},
		env: {MAX_BLOCKS_PER_FETCH: '20'},
		...extra,
	};
}

/** Poll something the running process publishes until it says what we are waiting for. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * A `run` process that has already folded `LOGS`, as an app pointing at one
 * meets it, with the chain it follows so a case can move it on.
 *
 * It waits on the FEED rather than on the cursor, because the feed is what these
 * cases are about: a process whose reads answer is one whose stored stream has
 * something in it.
 */
async function aRunServing(
	extra: RunDependencies = {},
): Promise<{indexer: RunningIndexer; chain: ReturnType<typeof fakeChain>}> {
	const chain = fakeChain().serve(LOGS, TIP);
	const started = await run(RUN, depsFor(chain, new RemoteLibSQL(createClient({url: ':memory:'})), extra));
	running = started;
	await until(
		async () => {
			const res = await fetch(`${started.url}/${INDEXER}/feed`);
			if (res.status !== 200) return 0;
			return ((await res.json()) as {entries: unknown[]}).entries.length;
		},
		(entries) => entries === LOGS.length,
		'the combined process to fold and serve its stream',
	);
	return {indexer: started, chain};
}

/** One frame off the state-moved stream: the event NAME and its parsed payload. */
type SignalFrame = {event: string; data: Record<string, any>};

/**
 * A CLIENT OF THE STATE-MOVED STREAM, over real HTTP, as a remote app holds one.
 *
 * Hand-written and deliberately not `EventSource`: that API RECONNECTS on its
 * own, which would hide a stream that died, and it is a browser global this
 * package does not otherwise reach for.
 */
async function openSignal(url: string): Promise<{
	status: number;
	frames: SignalFrame[];
	waitFor(matches: (frame: SignalFrame) => boolean, what: string): Promise<SignalFrame>;
	close(): Promise<void>;
}> {
	const controller = new AbortController();
	const response = await fetch(url, {signal: controller.signal});
	const frames: SignalFrame[] = [];
	if (response.status === 200 && response.body) {
		void (async () => {
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffered = '';
			try {
				for (;;) {
					const {done, value} = await reader.read();
					if (done) return;
					buffered += decoder.decode(value, {stream: true});
					let boundary = buffered.indexOf('\n\n');
					while (boundary >= 0) {
						const frame = buffered.slice(0, boundary);
						buffered = buffered.slice(boundary + 2);
						const event = /^event: (.*)$/m.exec(frame)?.[1];
						const data = /^data: (.*)$/m.exec(frame)?.[1];
						if (event && data) frames.push({event, data: JSON.parse(data)});
						boundary = buffered.indexOf('\n\n');
					}
				}
			} catch {
				// the client let go, which is the ordinary end of one of these
			}
		})();
	}
	return {
		status: response.status,
		frames,
		waitFor: (matches, what) =>
			until(
				async () => frames.find(matches),
				(frame) => frame !== undefined,
				what,
			) as Promise<SignalFrame>,
		close: async () => {
			controller.abort();
		},
	};
}

// ---------------------------------------------------------------------------------------------------

describe('a run process serves the read tier of the indexer it folds', () => {
	it('answers the FEED and the CANONICAL view under the name it was given', async () => {
		const {indexer} = await aRunServing();

		const feed = (await (await fetch(`${indexer.url}/${INDEXER}/feed`)).json()) as {
			success: boolean;
			stream: string;
			generation: string;
			entries: {blockNumber: number; removed: boolean}[];
		};
		expect(feed.success).toBe(true);
		expect(feed.entries.map((entry) => [entry.blockNumber, entry.removed])).toEqual([
			[START_BLOCK + 10, false],
			[START_BLOCK + 20, false],
		]);
		// the stream a consumer is told about is the one THIS process's own receiver
		// folds, which is what makes the cursor it hands back valid here
		expect(feed.stream).toBe(indexer.streamBuilder!.streamDigest);

		const canonical = (await (await fetch(`${indexer.url}/${INDEXER}/canonical?gate=${TIP}`)).json()) as {
			success: boolean;
			generation: string;
			entries: {blockNumber: number}[];
		};
		expect(canonical.success).toBe(true);
		expect(canonical.entries.map((entry) => entry.blockNumber)).toEqual([START_BLOCK + 10, START_BLOCK + 20]);
		// both views advertise the generation the DURABLE pointer names, which is the
		// one this process registered its fold as
		expect(canonical.generation).toBe(feed.generation);
	});

	it('streams the state-moved signal as the fold applies blocks', async () => {
		const {indexer, chain} = await aRunServing();

		const client = await openSignal(`${indexer.url}/${INDEXER}/state-moved`);
		try {
			expect(client.status).toBe(200);
			// the connect frame: WHERE the fold is and under WHICH token, which is what a
			// reconnecting reader converges on
			const progress = await client.waitFor((frame) => frame.event === 'progress', 'the progress frame on connect');
			expect(progress.data.generation).toEqual(expect.any(String));
			expect(progress.data.coherence).toEqual(expect.any(String));
			expect(progress.data.lastToBlock).toBe(TIP);

			// THE CHAIN MOVES ON, and this process applies the block ITSELF: the notification
			// is the same value a split deployment's receiver publishes, over the same
			// transport, because the producer is the container both shapes fold through
			chain.serve([...LOGS, transfer(START_BLOCK + 60, '0xa60', BOB, ALICE, 1n)], TIP + 50);

			const moved = await client.waitFor((frame) => frame.event === 'state-moved', 'the block it applied');
			expect(moved.data).toMatchObject({kind: 'applied', block: START_BLOCK + 60});
			expect(moved.data.entities).toEqual(expect.arrayContaining(['nft', 'counter']));
		} finally {
			await client.close();
		}
	});

	it("answers the operator's promote and revert route, since it HOLDS generations", async () => {
		process.env.ADMIN_TOKEN = ADMIN_TOKEN;
		const {indexer} = await aRunServing();
		const authorized = {Authorization: `Bearer ${ADMIN_TOKEN}`};

		const listed = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {headers: authorized});
		expect(listed.status).toBe(200);
		const body = (await listed.json()) as {
			indexer: string;
			canonical?: {stream: string; processor: string};
			generations: {canonical: boolean}[];
		};
		expect(body.indexer).toBe(INDEXER);
		expect(body.generations).toHaveLength(1);
		expect(body.canonical).toMatchObject(indexer.streamBuilder!.generation);

		// the MOVE, which is the same one small write in both directions
		const moved = await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
			method: 'POST',
			headers: {...authorized, 'Content-Type': 'application/json'},
			body: JSON.stringify(indexer.streamBuilder!.generation),
		});
		expect(moved.status).toBe(200);

		// ...guarded by the OPERATOR's credential and never the sender's
		process.env.INGEST_TOKEN = INGEST_TOKEN;
		expect(
			(
				await fetch(`${indexer.url}/${INDEXER}/admin/canonical-generation`, {
					headers: {Authorization: `Bearer ${INGEST_TOKEN}`},
				})
			).status,
		).toBe(401);
	});

	it('refuses a name it was not started with, rather than serving its own under any name', async () => {
		const {indexer} = await aRunServing();

		for (const path of [`/another-name/feed`, `/another-name/canonical?gate=${TIP}`]) {
			const res = await fetch(`${indexer.url}${path}`);
			expect(res.status).toBe(404);
			expect(((await res.json()) as {error: string}).error).toBe('unknown-indexer');
		}
	});
});

describe('a run process still hosts no remote writer', () => {
	it('refuses a push WITH A VALID CREDENTIAL, naming the capability rather than a missing token', async () => {
		process.env.INGEST_TOKEN = INGEST_TOKEN;
		const {indexer} = await aRunServing();
		const credentialled = {'Content-Type': 'application/json', Authorization: `Bearer ${INGEST_TOKEN}`};

		const pushed = await fetch(`${indexer.url}/${INDEXER}/ingest`, {
			method: 'POST',
			headers: credentialled,
			body: JSON.stringify({fromBlock: START_BLOCK, toBlock: START_BLOCK + 1, latestBlock: TIP, logs: []}),
		});
		expect(pushed.status).toBe(501);
		const refusal = (await pushed.json()) as {error: string; indexer: string; message: string};
		expect(refusal.error).toBe('ingestion-not-accepted');
		expect(refusal.indexer).toBe(INDEXER);
		expect(refusal.message).toMatch(/etherfold index/);

		// the cursor question is the same surface and answers the same way
		const asked = await fetch(`${indexer.url}/${INDEXER}/ingest/expected-from-block`, {
			method: 'POST',
			headers: credentialled,
		});
		expect(asked.status).toBe(501);
		expect(((await asked.json()) as {error: string}).error).toBe('ingestion-not-accepted');

		// and the token guard still sits on the PATH, ahead of the capability lookup:
		// what this deployment does is not something an anonymous caller may probe
		expect((await fetch(`${indexer.url}/${INDEXER}/ingest`, {method: 'POST', body: '{}'})).status).toBe(401);

		// the process went on folding and answering throughout
		expect((await fetch(`${indexer.url}/status`)).status).toBe(200);
		expect((await fetch(`${indexer.url}/${INDEXER}/feed`)).status).toBe(200);
	});
});
