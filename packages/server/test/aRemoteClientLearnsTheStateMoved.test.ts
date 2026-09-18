import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '@libsql/client';
import {
	generationDigestOf,
	openReceivingIndexer,
	serializeWireBatch,
	type LogEvent,
	type LogIngestion,
	type ReceivingIndexer,
	type StateMoved,
	type StateMovedHandler,
	type WireBatch,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {describe, expect, it} from 'vitest';
import {
	applySchema,
	createServer,
	emissionAppenderFor,
	generationRegistryPortOnSQL,
	indexerEntryOn,
	singleContextEntry,
	storedEmissionReplaySource,
	type IndexerRegistryEntry,
} from '../src/index.js';
import {
	ALICE,
	BOB,
	CAROL,
	CONTRACT,
	SOURCE,
	STREAM_CONFIG,
	START_BLOCK,
	TOKEN,
	transfer,
	type TestABI,
} from './utils/feedHarness.js';
import {identityOf} from './utils/processorIdentity.js';
import {openSignalStream} from './utils/signalStream.js';

// ---------------------------------------------------------------------------------------------------
// A REMOTE CLIENT LEARNS THE STATE MOVED
// ---------------------------------------------------------------------------------------------------
// The THIRD transport of ADR-0083, after the worker's port and the cross-tab
// channel: `GET /{indexer}/state-moved`, server-sent events, from a hosted
// indexer to an app that has no shared heap with it. The claim being tested is
// that pointing an app at a server rather than at its own browser worker changes
// a DEPLOYMENT CHOICE and not a line of its notification handling.
//
// So the load-bearing assertion in the first case is an equality: an in-process
// subscriber attached to the producer seam and a client reading the HTTP stream
// are handed THE SAME VALUE, serialised identically. That equality is also how
// "the producer is transport-agnostic" is DEMONSTRATED rather than asserted --
// the in-process subscriber is a second transport, attached with no change to
// the publication, which is what a later GraphQL subscription adapter would do.
//
// What this stream is NOT is the FEED. A feed consumer owns a cursor, reads the
// sequenced emission stream on its own cadence and is a third party etherfold
// stores nothing about (`CONTEXT.md`, *consumer*). A reader here holds NO cursor
// and is told, best-effort, that the state moved; nothing is buffered for it and
// nothing is replayed to it. The two must not be conflated in naming or in code.
//
// The Worker case is refused rather than served, and refused on a CAPABILITY THE
// HOST DECLARED: an ingest POST on Cloudflare cannot write into a stream another
// request opened (`work/notes/findings/a-worker-cannot-hold-a-timer-across-requests.md`
// is the same isolation seen from the timer side), and this package deliberately
// names no runtime, so it cannot -- and must not -- sniff for one.
// ---------------------------------------------------------------------------------------------------

const NAME = 'alpha';
const pkgRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** The FOLD. WHICH fold it is comes from the arrival, not from anything in here. */
const entityProcessor: EntityProcessor<TestABI> = {
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
	async onTransfer(state, event) {
		state.set('token', {id: (event.args as {id: bigint}).id.toString()}, {owner: event.args.to});
	},
};

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** A FOLD ARRIVING AS THE BYTES `marker` NAMES, identified by them rather than by a declaration. */
function foldAt(marker: string) {
	const identity = identityOf(marker);
	return {
		createState: () => freshDatabase(),
		createProcessor: (state: RemoteSQL) => new VersionedStateEventProcessor<TestABI>(state, entityProcessor),
		processorIdentity: identity,
	};
}

type Deployment = {
	app: ReturnType<typeof createServer<{INGEST_TOKEN?: string}>>;
	db: RemoteSQL;
	indexer: ReceivingIndexer<TestABI, unknown, RemoteSQL>;
	/** How many subscribers are attached to the producer RIGHT NOW, through the entry. */
	attached: () => number;
	push: (over: {toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]}) => Promise<Response>;
	watch: () => Promise<ReturnType<typeof openSignalStream> extends Promise<infer S> ? S : never>;
};

/**
 * A host of the shape a server actually runs, with the ONE thing this route needs
 * beside it: the host's declaration that this runtime can hold a stream open
 * across requests.
 *
 * `attached` counts through a wrapper on the entry rather than by reaching into
 * the producer, because the entry is the seam a transport attaches at: what these
 * cases care about is that the ROUTE lets go when a client does.
 */
async function deploy(
	options: {holdsStreamsAcrossRequests?: boolean; entry?: (real: IndexerRegistryEntry) => IndexerRegistryEntry} = {},
): Promise<Deployment> {
	const db = freshDatabase();
	await applySchema(db);
	const indexer = (await openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, NAME),
		source: SOURCE,
		stream: STREAM_CONFIG,
		appendEmissions: emissionAppenderFor(db, NAME),
		replay: storedEmissionReplaySource(db, NAME),
		generation: foldAt('the-incumbent-fold'),
	})) as ReceivingIndexer<TestABI, unknown, RemoteSQL>;

	let attached = 0;
	const real = indexerEntryOn(db, indexer);
	const counted: IndexerRegistryEntry = {
		...real,
		onStateMoved: (handler: StateMovedHandler) => {
			attached++;
			const detach = (real.onStateMoved as NonNullable<typeof real.onStateMoved>)(handler);
			return () => {
				attached--;
				detach();
			};
		},
	};
	const entry = options.entry ? options.entry(counted) : counted;

	const app = createServer<{INGEST_TOKEN?: string}>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN}),
		getIndexer: (_c, name) => (name === NAME ? entry : undefined),
		...(options.holdsStreamsAcrossRequests === undefined
			? {}
			: {holdsStreamsAcrossRequests: options.holdsStreamsAcrossRequests}),
	});

	const push = async (over: {toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]}) => {
		const fromBlock = await indexer.ingestion.expectedFromBlock();
		const batch: WireBatch<TestABI> = {
			context: indexer.ingestion.context,
			fromBlock,
			toBlock: over.toBlock,
			latestBlock: over.latestBlock,
			logs: over.logs,
		};
		return app.request(`/${NAME}/ingest`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
			body: serializeWireBatch(batch),
		});
	};

	return {
		app,
		db,
		indexer,
		attached: () => attached,
		push: async (over) => {
			const response = await push(over);
			expect(response.status, await response.clone().text()).toBe(200);
			return response;
		},
		watch: () => openSignalStream(app, `/${NAME}/state-moved`),
	};
}

/** A deployment that has already folded a block, as a reconnecting client meets one. */
async function aServerMidFold(): Promise<Deployment> {
	const deployment = await deploy({holdsStreamsAcrossRequests: true});
	await deployment.push({toBlock: 105, latestBlock: 105, logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)]});
	return deployment;
}

describe('a remote client is told the state moved', () => {
	it('hands a client reading HTTP the SAME value an in-process subscriber is handed, serialised identically', async () => {
		const deployment = await deploy({holdsStreamsAcrossRequests: true});
		// THE SECOND TRANSPORT, attached to the producer seam with no change to the
		// publication: this is what a GraphQL subscription adapter would be, and it is
		// how the transport-agnostic claim is demonstrated rather than asserted.
		const inProcess: StateMoved[] = [];
		deployment.indexer.onStateMoved((moved) => inProcess.push(moved));
		const client = await deployment.watch();

		await deployment.push({toBlock: 105, latestBlock: 105, logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)]});
		await client.waitFor((events) => events.some((e) => e.event === 'state-moved'), 'the block it applied');

		expect(inProcess.length).toBe(1);
		const applied = inProcess[0] as StateMoved;
		expect(client.moved()).toEqual([applied]);
		// SERIALISED IDENTICALLY, which is the half a deep-equality would not catch:
		// one handler reads the browser's value and this one.
		expect(client.raw.find((frame) => frame.event === 'state-moved')?.data).toBe(JSON.stringify(applied));
		expect(applied.kind === 'applied' && applied.block).toBe(101);
		expect(applied.kind === 'applied' && applied.entities).toEqual(['token']);

		await client.close();
	});

	it('tells a client how far behind the fold is, with no second request and no cursor to deserialise', async () => {
		const deployment = await deploy({holdsStreamsAcrossRequests: true});
		const client = await deployment.watch();

		// a hundred blocks behind a tip the sender reported, which is the number an app
		// renders as "syncing, 100 blocks behind"
		await deployment.push({toBlock: 105, latestBlock: 205, logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)]});
		await client.waitFor(
			(events) => events.some((e) => e.event === 'progress' && e.data['lastToBlock'] === 105),
			'progress naming the block it reached',
		);

		const latest = client.progress()[client.progress().length - 1] as Record<string, unknown>;
		expect(latest['lastToBlock']).toBe(105);
		expect(latest['latestBlock']).toBe(205);
		expect(latest['blocksBehindTip']).toBe(100);
		expect(typeof latest['generation']).toBe('string');
		expect(typeof latest['coherence']).toBe('string');

		await client.close();
	});

	it('tells a client that connects MID-FOLD the position and the token at once, and replays nothing', async () => {
		const deployment = await aServerMidFold();
		const token: string[] = [];
		deployment.indexer.onStateMoved((moved) => token.push(moved.coherence));
		// one more block, so the token the reconnecting client is told is one a
		// subscriber has really seen
		await deployment.push({toBlock: 110, latestBlock: 110, logs: [transfer(107, '0xa107', BOB, 2n, 0, CONTRACT)]});

		const client = await deployment.watch();
		await client.waitFor((events) => events.length > 0, 'anything at all');

		// TOLD AT ONCE: where the fold is, under which token, from which generation
		const first = client.events[0];
		expect(first?.event).toBe('progress');
		expect(first?.data['lastToBlock']).toBe(110);
		expect(first?.data['coherence']).toBe(token[token.length - 1]);
		expect(first?.data['generation']).toBe(
			generationDigestOf((await deployment.indexer.canonical()) as {stream: string; processor: string}),
		);
		// ...and NOTHING is replayed: the blocks it missed are gone, which is what
		// "the server holds no per-client state" costs and what the token repairs.
		expect(client.moved()).toEqual([]);

		await client.close();
	});

	it('carries a RETRACTION across the transport, with the token it rotated, exactly as it does locally', async () => {
		const deployment = await deploy({holdsStreamsAcrossRequests: true});
		const inProcess: StateMoved[] = [];
		deployment.indexer.onStateMoved((moved) => inProcess.push(moved));
		const client = await deployment.watch();

		await deployment.push({
			toBlock: 105,
			latestBlock: 105,
			logs: [
				transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT),
				transfer(103, '0xa103', BOB, 2n, 0, CONTRACT),
				transfer(104, '0xa104', CAROL, 3n, 0, CONTRACT),
			],
		});
		await client.waitFor((events) => events.filter((e) => e.event === 'state-moved').length === 3, 'three blocks');
		const before = client.moved()[0]?.['coherence'];

		// block 103 comes back with a DIFFERENT hash: the fold retracts to 102
		await deployment.push({
			toBlock: 106,
			latestBlock: 106,
			logs: [transfer(103, '0xb103', CAROL, 13n, 0, CONTRACT), transfer(106, '0xb106', BOB, 16n, 0, CONTRACT)],
		});
		await client.waitFor(
			(events) => events.some((e) => e.event === 'state-moved' && e.data['kind'] === 'retracted'),
			'the retraction',
		);

		const retraction = client.moved().find((moved) => moved['kind'] === 'retracted') as Record<string, unknown>;
		expect(retraction['forkPoint']).toBe(102);
		expect(retraction['coherence']).not.toBe(before);
		// the same value the in-process subscriber got, which is the whole claim
		expect(client.moved()).toEqual(inProcess);

		await client.close();
	});

	it('carries the rotation a PROMOTION makes: the next notification wears a token no client has seen', async () => {
		const deployment = await aServerMidFold();
		const client = await deployment.watch();
		await client.waitFor((events) => events.length > 0, 'the position on connect');
		const seen = new Set<unknown>([client.events[0]?.data['coherence']]);

		// a successor over the SAME stream (a processor change), caught up by
		// re-folding the stored stream, which under the default policy MOVES the pointer
		await deployment.indexer.add(foldAt('the-successor-fold'));
		for (let guard = 0; guard < 50; guard++) {
			const [report] = await deployment.indexer.rebuildMore();
			if (report?.complete) break;
		}
		const promoted = generationDigestOf((await deployment.indexer.canonical()) as {stream: string; processor: string});

		// the move PUBLISHES nothing; what a reader receives is the NEXT notification --
		// which arrives when the fold that ANSWERS applies the block, and that fold is a
		// follower, so the wire push reaches the stream's writer and the rebuild applies it
		await deployment.push({toBlock: 110, latestBlock: 110, logs: [transfer(107, '0xa107', BOB, 2n, 0, CONTRACT)]});
		await deployment.indexer.rebuildMore();
		await client.waitFor(
			(events) => events.some((e) => e.event === 'state-moved' && e.data['block'] === 107),
			'the block folded after the promotion',
		);

		const after = client.moved()[client.moved().length - 1] as Record<string, unknown>;
		expect(seen.has(after['coherence'])).toBe(false);
		expect(after['generation']).toBe(promoted);

		await client.close();
	});

	it('holds NOTHING about a client that went away, and lets many attach without growing', async () => {
		const deployment = await deploy({holdsStreamsAcrossRequests: true});
		expect(deployment.attached()).toBe(0);

		const clients = [await deployment.watch(), await deployment.watch(), await deployment.watch()];
		for (const client of clients) await client.waitFor((events) => events.length > 0, 'the position on connect');
		// ONE handler reference each and nothing else: the producer's only bookkeeping
		expect(deployment.attached()).toBe(3);

		for (const client of clients) await client.close();
		// a DISCONNECT detaches, so the ingest below writes into nothing
		await deployment.push({toBlock: 105, latestBlock: 105, logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)]});
		expect(deployment.attached()).toBe(0);
		for (const client of clients) expect(client.ended()).toBe(true);
	});
});

describe('the state-moved stream REFUSES where it cannot be served', () => {
	it('refuses where the HOST has not declared that this runtime holds a stream across requests', async () => {
		// The Cloudflare Worker case: an ingest invocation cannot write into a stream
		// another request opened, so accepting the connection would be a client waiting
		// for ever on a server that looks healthy.
		const deployment = await deploy();

		const response = await deployment.app.request(`/${NAME}/state-moved`);

		expect(response.status).toBe(501);
		const body = (await response.json()) as {error: string; message: string};
		expect(body.error).toBe('state-moved-unsupported-runtime');
		expect(body.message).toMatch(/holdsStreamsAcrossRequests/);
		expect(deployment.attached()).toBe(0);
	});

	it('refuses on an entry whose host holds a bare receiver and no container, rather than attaching to silence', async () => {
		const db = freshDatabase();
		await applySchema(db);
		const app = createServer<{INGEST_TOKEN?: string}>({
			getDB: () => db,
			getEnv: () => ({INGEST_TOKEN: TOKEN}),
			holdsStreamsAcrossRequests: true,
			getIndexer: (_c, name) => (name === NAME ? singleContextEntry(db, {} as unknown as LogIngestion) : undefined),
		});

		const response = await app.request(`/${NAME}/state-moved`);

		expect(response.status).toBe(501);
		expect((await response.json()) as {error: string}).toMatchObject({error: 'state-moved-not-published'});
	});

	it('answers 404 for a name this host was not built with, and 501 for a host with no registry at all', async () => {
		const deployment = await deploy({holdsStreamsAcrossRequests: true});
		const unknown = await deployment.app.request('/beta/state-moved');
		expect(unknown.status).toBe(404);

		const db = freshDatabase();
		const readTier = createServer<{INGEST_TOKEN?: string}>({
			getDB: () => db,
			getEnv: () => ({}),
			holdsStreamsAcrossRequests: true,
		});
		expect((await readTier.request(`/${NAME}/state-moved`)).status).toBe(501);
	});

	it('refuses an indexer that holds no generation answering reads yet, as every other read does', async () => {
		const db = freshDatabase();
		await applySchema(db);
		const app = createServer<{INGEST_TOKEN?: string}>({
			getDB: () => db,
			getEnv: () => ({}),
			holdsStreamsAcrossRequests: true,
			getIndexer: (_c, name) =>
				name === NAME
					? {
							db,
							liveIngestions: async () => [],
							canonicalGeneration: async () => undefined,
							onStateMoved: () => () => {},
							coherenceNow: () => 'a-token',
						}
					: undefined,
		});

		const response = await app.request(`/${NAME}/state-moved`);

		expect(response.status).toBe(503);
		expect((await response.json()) as {error: string}).toMatchObject({error: 'no-canonical-generation'});
	});

	it('DECIDES that refusal on what the host DECLARED and never on a runtime it sniffed for', async () => {
		// The failure mode ADR-0083 names is a module-global subscriber registry that
		// COMPILES, passes on Node and never fires on a Worker. The package-wide scan
		// (`platformAgnostic.test.ts`) forbids importing a runtime; this forbids
		// DETECTING one, which no import list can see.
		const source = readFileSync(join(pkgRoot, 'src/api/stateMoved.ts'), 'utf-8');

		expect(source).toMatch(/holdsStreamsAcrossRequests/);
		for (const sniff of [/\bnavigator\b/, /\bWebSocketPair\b/, /\bcaches\b/, /\bDeno\b/, /\bprocess\.\w/, /\bBun\b/]) {
			expect(sniff.test(source), `${sniff} is a runtime sniff and this refusal is a host DECLARATION`).toBe(false);
		}
	});
});
