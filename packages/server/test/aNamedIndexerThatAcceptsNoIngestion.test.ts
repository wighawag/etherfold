import {createClient} from '@libsql/client';
import {
	openReceivingIndexer,
	serializeWireBatch,
	type LogEvent,
	type ReceivingIndexer,
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
	storedEmissionReplaySource,
	type IndexerRegistryEntry,
} from '../src/index.js';
import {
	ALICE,
	BOB,
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
// A NAMED INDEXER THAT IS READ FROM AND NEVER PUSHED INTO
// ---------------------------------------------------------------------------------------------------
// The shape a COMBINED deployment registers (`etherfold run`): it fetches the
// chain for itself, folds through an in-process direct wire, and holds
// everything the read routes need -- the database, the stored stream, the
// generation registry and the publisher -- while a remote sender pushing into it
// would be a second writer nobody asked for.
//
// Before this, registration was ALL OR NOTHING: `liveIngestions()` was required,
// so an entry offering the READS could not avoid offering the one capability
// that accepts WRITES, and such a host registered nothing at all -- which took
// the feed, the canonical pointer, the state-moved signal and the operator's
// pointer surface down with the write path it meant to close.
//
// So the entry states it: `liveIngestions` is ABSENT, which is a statement about
// the DEPLOYMENT (`this name accepts no pushes`), exactly as an absent
// `generations` / `promote` / `onStateMoved` is. The two things that make it a
// statement rather than a value are asserted below and are the whole point:
//
//  - an EMPTY list means something else entirely -- "no live wire contexts right
//    now", a transient state on a host that DOES accept ingestion -- and it still
//    answers what it always did, so a permanent refusal and a momentary one are
//    never the same answer;
//  - the refusal is asserted WITH A VALID CREDENTIAL PRESENTED, because a
//    deployment with no `INGEST_TOKEN` refuses every push with a `401` anyway,
//    and a test that leant on that would be checking a door held shut by a
//    missing environment variable.
// ---------------------------------------------------------------------------------------------------

const NAME = 'alpha';
const ADMIN_TOKEN = 'the-operators-own-secret';

type TestEnv = {DEV?: string; INGEST_TOKEN?: string; ADMIN_TOKEN?: string};

/**
 * WHICH FOLD this deployment runs, as its ARRIVAL derived it (ADR-0086): a hash
 * of the bytes a bundle would have arrived as, handed to the fold rather than
 * asked of it.
 */
const PROCESSOR_IDENTITY = identityOf('alpha');

const entityProcessor: EntityProcessor<TestABI> = {
	// STILL REQUIRED and deliberately NAMING NOTHING: the construction site below
	// hands the fold the identity above, so this value is read by nobody.
	// `assertProcessorVersion` still demands the field until
	// `the-declared-version-and-the-drift-report-are-deleted` removes it.
	version: '1.0.0',
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
	async onTransfer(state, event) {
		state.set('token', {id: (event.args as {id: bigint}).id.toString()}, {owner: event.args.to});
	},
};

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	db: RemoteSQL;
	indexer: ReceivingIndexer<TestABI, unknown, VersionedStateEventProcessor<TestABI>>;
	/** Fold blocks the way a COMBINED process does: in-process, reaching no route. */
	fold: (over: {toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]}) => Promise<void>;
};

/**
 * A host built with ONE named indexer that answers every read and accepts no
 * ingestion.
 *
 * The entry is written out the way the COMBINED command writes it
 * (`packages/cli/src/run.ts`), with `liveIngestions` LEFT OFF rather than
 * stubbed: the absence is the statement, and a stub answering an empty list is
 * the lie this whole file exists to keep unexpressible.
 */
async function deployReadOnly(): Promise<Deployment> {
	const db = freshDatabase();
	await applySchema(db);
	const indexer = (await openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, NAME),
		source: SOURCE,
		stream: STREAM_CONFIG,
		appendEmissions: emissionAppenderFor(db, NAME),
		replay: storedEmissionReplaySource(db, NAME),
		generation: {
			createState: () => new VersionedStateEventProcessor<TestABI>(db, entityProcessor, {identity: PROCESSOR_IDENTITY}),
			createProcessor: (state: VersionedStateEventProcessor<TestABI>) => state,
			processorIdentity: PROCESSOR_IDENTITY,
		},
	})) as ReceivingIndexer<TestABI, unknown, VersionedStateEventProcessor<TestABI>>;

	// everything the container answers EXCEPT the one question that accepts writes
	const entry: IndexerRegistryEntry = {
		db,
		canonicalGeneration: () => indexer.canonicalGeneration(),
		generations: () => indexer.generations(),
		promote: (id) => indexer.promote(id),
		onStateMoved: (handler) => indexer.onStateMoved(handler),
		coherenceNow: () => indexer.coherenceNow(),
	};

	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN, ADMIN_TOKEN}),
		holdsStreamsAcrossRequests: true,
		getIndexer: (_c, name) => (name === NAME ? entry : undefined),
	});

	return {
		app,
		db,
		indexer,
		fold: async (over) => {
			const fromBlock = await indexer.ingestion.expectedFromBlock();
			const outcome = await indexer.ingestion.receive({
				context: indexer.ingestion.context,
				fromBlock,
				toBlock: over.toBlock,
				latestBlock: over.latestBlock,
				logs: over.logs,
			} as WireBatch<TestABI>);
			expect(outcome.applied).toBe(over.logs.length);
		},
	};
}

/** A batch as a REMOTE sender would send one, for the refusals below. */
function pushed(deployment: Deployment): string {
	return serializeWireBatch({
		context: deployment.indexer.ingestion.context,
		fromBlock: START_BLOCK,
		toBlock: START_BLOCK + 5,
		latestBlock: START_BLOCK + 5,
		logs: [] as LogEvent<TestABI>[],
	} as WireBatch<TestABI>);
}

// ---------------------------------------------------------------------------------------------------

describe('a named indexer registered as READ-ONLY', () => {
	it('serves both feed views over the generation it folds, rather than answering 501', async () => {
		const deployment = await deployReadOnly();
		await deployment.fold({
			toBlock: 105,
			latestBlock: 105,
			logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT), transfer(104, '0xa104', BOB, 2n, 0, CONTRACT)],
		});

		const feed = await deployment.app.request(`/${NAME}/feed`);
		expect(feed.status).toBe(200);
		const feedBody = (await feed.json()) as {stream: string; generation: string; entries: {blockNumber: number}[]};
		expect(feedBody.entries.map((entry) => entry.blockNumber)).toEqual([101, 104]);
		// the stream a consumer is told about is the one the IN-PROCESS fold stored
		expect(feedBody.stream).toBe(deployment.indexer.ingestion.streamDigest);

		const canonical = await deployment.app.request(`/${NAME}/canonical?gate=1000`);
		expect(canonical.status).toBe(200);
		const canonicalBody = (await canonical.json()) as {generation: string; entries: {blockNumber: number}[]};
		expect(canonicalBody.entries.map((entry) => entry.blockNumber)).toEqual([101, 104]);
		// ...and BOTH advertise the generation the durable pointer names
		expect(canonicalBody.generation).toBe(feedBody.generation);
	});

	it('tells a client the state moved, with the payload a split deployment serves', async () => {
		const deployment = await deployReadOnly();
		const client = await openSignalStream(deployment.app, `/${NAME}/state-moved`);
		expect(client.status).toBe(200);

		await deployment.fold({
			toBlock: 105,
			latestBlock: 205,
			logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)],
		});
		await client.waitFor((events) => events.some((event) => event.event === 'state-moved'), 'the block it applied');

		expect(client.moved()).toHaveLength(1);
		expect(client.moved()[0]).toMatchObject({kind: 'applied', block: 101, entities: ['token']});
		// and WHERE THE FOLD HAS GOT TO, re-read after the notification and sent as its
		// own frame: a client renders this without asking a second question
		await client.waitFor(
			(events) => events.some((event) => event.event === 'progress' && event.data.lastToBlock !== undefined),
			'where the fold has got to',
		);
		const progress = client.progress().at(-1) as {lastToBlock?: number; latestBlock?: number; coherence?: string};
		expect(progress.lastToBlock).toBe(105);
		expect(progress.latestBlock).toBe(205);
		expect(typeof progress.coherence).toBe('string');

		await client.close();
	});

	it("answers the operator's pointer surface, since it is the shape that HOLDS generations", async () => {
		const deployment = await deployReadOnly();
		const authorized = {Authorization: `Bearer ${ADMIN_TOKEN}`};

		const listed = await deployment.app.request(`/${NAME}/admin/canonical-generation`, {headers: authorized});
		expect(listed.status).toBe(200);
		const body = (await listed.json()) as {
			indexer: string;
			canonical?: {stream: string; processor: string};
			generations: {stream: string; processor: string; canonical: boolean}[];
		};
		expect(body.indexer).toBe(NAME);
		expect(body.generations).toHaveLength(1);
		expect(body.canonical).toMatchObject(deployment.indexer.ingestion.generation);

		// the MOVE answers too, which is the half that used to be `501` here
		const moved = await deployment.app.request(`/${NAME}/admin/canonical-generation`, {
			method: 'POST',
			headers: {...authorized, 'Content-Type': 'application/json'},
			body: JSON.stringify(deployment.indexer.ingestion.generation),
		});
		expect(moved.status).toBe(200);
		expect((await moved.json()).canonical).toMatchObject(deployment.indexer.ingestion.generation);
	});
});

describe('the same named indexer refuses ingestion', () => {
	it('refuses a push WITH A VALID CREDENTIAL, on the capability and never on a missing token', async () => {
		const deployment = await deployReadOnly();
		const credentialled = {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`};

		const push = await deployment.app.request(`/${NAME}/ingest`, {
			method: 'POST',
			headers: credentialled,
			body: pushed(deployment),
		});
		expect(push.status).toBe(501);
		const refusal = (await push.json()) as {error: string; indexer: string; message: string};
		expect(refusal.error).toBe('ingestion-not-accepted');
		expect(refusal.indexer).toBe(NAME);
		// it NAMES why, so an operator can act on it
		expect(refusal.message).toMatch(/accepts no/i);

		// the cursor question is the same surface and answers the same way: a sender
		// must not be told where to start by a host that will never take a batch
		const asked = await deployment.app.request(`/${NAME}/ingest/expected-from-block`, {
			method: 'POST',
			headers: credentialled,
		});
		expect(asked.status).toBe(501);
		expect((await asked.json()).error).toBe('ingestion-not-accepted');
	});

	it('refuses an anonymous caller FIRST, so the capability is not something to probe', async () => {
		const deployment = await deployReadOnly();
		for (const path of [`/${NAME}/ingest`, `/${NAME}/ingest/expected-from-block`]) {
			const res = await deployment.app.request(path, {method: 'POST', body: '{}'});
			expect(res.status).toBe(401);
		}
	});

	it('folds nothing of the batch it refused', async () => {
		const deployment = await deployReadOnly();
		await deployment.app.request(`/${NAME}/ingest`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
			body: pushed(deployment),
		});
		expect(await deployment.indexer.ingestion.expectedFromBlock()).toBe(START_BLOCK);
	});

	it('is a THIRD answer, distinct from a host with no registry and from an unknown name', async () => {
		const deployment = await deployReadOnly();

		// a tenant this host was not built with: a ROUTING refusal
		const unknown = await deployment.app.request(`/beta/ingest/expected-from-block`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${TOKEN}`},
		});
		expect(unknown.status).toBe(404);
		expect((await unknown.json()).error).toBe('unknown-indexer');

		// a host with NO registry at all: no name it could answer under, in either
		// direction
		const readTier = createServer<TestEnv>({
			getDB: () => deployment.db,
			getEnv: () => ({INGEST_TOKEN: TOKEN}),
		});
		const noRegistry = await readTier.request(`/${NAME}/ingest/expected-from-block`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${TOKEN}`},
		});
		expect(noRegistry.status).toBe(501);
		expect((await noRegistry.json()).error).toBe('ingestion-not-configured');
	});
});

describe('the seam is where the statement is made, so a second host can make it', () => {
	it('has `indexerEntryOn` forward the question only where what it was handed answers it', async () => {
		const deployment = await deployReadOnly();
		const {indexer, db} = deployment;

		// a CONTAINER answers it, so an entry built over one accepts ingestion, exactly
		// as `etherfold index` registers today -- unchanged by any of this
		expect(indexerEntryOn(db, indexer).liveIngestions).toBeTypeOf('function');

		// ...and a host that hands over what it wants answered WITHOUT that question
		// gets an entry that states it accepts none, rather than one claiming a
		// capability its holder was not asked for
		const readOnly = indexerEntryOn(db, {canonicalGeneration: () => indexer.canonicalGeneration()});
		expect(readOnly.liveIngestions).toBeUndefined();
		expect('liveIngestions' in readOnly).toBe(false);
		expect(await readOnly.canonicalGeneration()).toEqual(await indexer.canonicalGeneration());
	});
});

describe('an EMPTY list of live wire contexts is a different statement', () => {
	it('still accepts the question and still refuses a batch as a foreign context', async () => {
		// A host that DOES accept ingestion and holds no live receiver RIGHT NOW --
		// every generation deleted, its streams reaped. Overloading that on the
		// permanent refusal above would make a deployment that will never take a batch
		// indistinguishable from one that momentarily has nowhere to put it.
		const deployment = await deployReadOnly();
		const app = createServer<TestEnv>({
			getDB: () => deployment.db,
			getEnv: () => ({INGEST_TOKEN: TOKEN}),
			getIndexer: (_c, name) =>
				name === NAME
					? {
							db: deployment.db,
							liveIngestions: async () => [],
							canonicalGeneration: () => deployment.indexer.canonicalGeneration(),
						}
					: undefined,
		});

		const asked = await app.request(`/${NAME}/ingest/expected-from-block`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${TOKEN}`},
		});
		expect(asked.status).toBe(200);
		expect(await asked.json()).toEqual({success: true, contexts: []});

		const push = await app.request(`/${NAME}/ingest`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
			body: pushed(deployment),
		});
		expect(push.status).toBe(400);
		expect((await push.json()).error).toBe('context-mismatch');
	});
});
