import {createClient} from '@libsql/client';
import {
	generationDigestOf,
	openReceivingIndexer,
	serializeWireBatch,
	type GenerationId,
	type LogEvent,
	type ReceivingIndexer,
	type WireBatch,
} from '@etherfold/core';
import {VersionedStateEventProcessor, type EntityProcessor} from '@etherfold/processor-sqlite';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {beforeEach, describe, expect, it} from 'vitest';
import {
	applySchema,
	createServer,
	emissionAppenderFor,
	generationRegistryPortOnSQL,
	indexerEntryOn,
	storedEmissionReplaySource,
	type IndexerRegistryEntry,
	type ReconfigureReport,
} from '../src/index.js';
import {ALICE, CONTRACT, SOURCE, STREAM_CONFIG, TOKEN, transfer, type TestABI} from './utils/feedHarness.js';
import {identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// THE TRIGGER: ONE ENDPOINT MAKES A RUNNING DEPLOYMENT RE-READ ITS OWN CONFIGURATION
// ---------------------------------------------------------------------------------------------------
// `POST /{indexer}/admin/reconfigure` is what a watcher calls after it has
// rebuilt. It is RE-READ and never RECEIVE -- a processor is code and cannot
// cross HTTP -- so nothing is sent, and what comes back is WHICH of three things
// happened.
//
// What is asserted HERE is the ROUTE: the three answers, the refusals, and the
// credential. WHAT a re-read actually resolves belongs to the host that assembled
// the fold, because this package names no runtime and could not import a module
// if it wanted to; that half is asserted end to end against a real running
// deployment in `packages/cli/test/anEndpointReconfiguresARunningRun.test.ts`.
//
// The `reconfigure` capability here is therefore driven by the case, over a REAL
// container and a REAL server, so that "the incumbent went on answering reads
// throughout" is a read of the feed rather than an assumption.
// ---------------------------------------------------------------------------------------------------

const NAME = 'alpha';
const ADMIN_TOKEN = 'an-operator-secret';

type TestEnv = {DEV?: string; INGEST_TOKEN?: string; ADMIN_TOKEN?: string};

/** The fold this deployment came up with. WHICH fold it is comes from the arrival. */
const entityProcessor: EntityProcessor<TestABI> = {
	// STILL REQUIRED and deliberately NAMING NOTHING: `foldAt` hands the fold the
	// identity its ARRIVAL derived (ADR-0086), so this value is read by nobody.
	// `assertProcessorVersion` still demands the field until
	// `the-declared-version-and-the-drift-report-are-deleted` removes it.
	version: '1.0.0',
	entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
	async onTransfer(state, event) {
		const args = event.args as {from: string; to: string; id: bigint};
		state.set('token', {id: args.id.toString()}, {owner: args.to});
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
		createProcessor: (state: RemoteSQL) =>
			new VersionedStateEventProcessor<TestABI>(state, entityProcessor, {identity}),
		processorIdentity: identity,
	};
}

type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	db: RemoteSQL;
	indexer: ReceivingIndexer<TestABI, unknown, RemoteSQL>;
	incumbent: GenerationId;
	/** What the next re-read will do, which is the half a HOST owns. */
	answer(outcome: () => Promise<ReconfigureReport>): void;
	/** How many times the route asked this deployment to re-read. */
	rereads: () => number;
};

/** One named indexer that has folded a batch and is answering reads: the thing a watcher pokes. */
async function aRunningDeployment(): Promise<Deployment> {
	const db = freshDatabase();
	await applySchema(db);
	const indexer = (await openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, NAME),
		source: SOURCE,
		stream: STREAM_CONFIG,
		appendEmissions: emissionAppenderFor(db, NAME),
		replay: storedEmissionReplaySource(db, NAME),
		generation: foldAt('the-running-fold'),
	})) as ReceivingIndexer<TestABI, unknown, RemoteSQL>;

	let rereads = 0;
	let next: () => Promise<ReconfigureReport> = async () => ({
		outcome: 'unchanged',
		generation: indexer.generation,
		message: 'nothing moved',
	});
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN, ADMIN_TOKEN}),
		getIndexer: (_c, name) =>
			name === NAME
				? {
						...indexerEntryOn(db, indexer),
						reconfigure: () => {
							rereads++;
							return next();
						},
					}
				: undefined,
	});

	const fromBlock = await indexer.ingestion.expectedFromBlock();
	const batch: WireBatch<TestABI> = {
		context: indexer.ingestion.context,
		fromBlock,
		toBlock: 105,
		latestBlock: 105,
		logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT) as LogEvent<TestABI>],
	};
	const pushed = await app.request(`/${NAME}/ingest`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
		body: serializeWireBatch(batch),
	});
	expect(pushed.status, await pushed.clone().text()).toBe(200);

	return {
		app,
		db,
		indexer,
		incumbent: indexer.generation,
		answer: (outcome) => {
			next = outcome;
		},
		rereads: () => rereads,
	};
}

async function reconfigure(
	deployment: Deployment,
	options: {token?: string | undefined; name?: string} = {},
): Promise<{status: number; body: Record<string, unknown>}> {
	const token = 'token' in options ? options.token : ADMIN_TOKEN;
	const res = await deployment.app.request(`/${options.name ?? NAME}/admin/reconfigure`, {
		method: 'POST',
		...(token === undefined ? {} : {headers: {Authorization: `Bearer ${token}`}}),
	});
	return {status: res.status, body: (await res.json()) as Record<string, unknown>};
}

/** WHICH generation answers reads, as a consumer of the feed is told. */
async function generationServed(deployment: Deployment): Promise<string> {
	const res = await deployment.app.request(`/${NAME}/feed`);
	expect(res.status).toBe(200);
	return ((await res.json()) as {generation: string}).generation;
}

/** Every generation registered under this name, as digests. */
async function registered(deployment: Deployment): Promise<string[]> {
	return (await deployment.indexer.generations()).map((record) => generationDigestOf(record)).sort();
}

let deployment: Deployment;

beforeEach(async () => {
	deployment = await aRunningDeployment();
});

describe('the endpoint answers WHAT it did, in three distinguishable shapes', () => {
	it('NAMES the generation it registered', async () => {
		const successor: GenerationId = {stream: deployment.incumbent.stream, processor: 'v2-something'};
		deployment.answer(async () => ({outcome: 'registered', generation: successor}));

		const answer = await reconfigure(deployment);

		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({
			success: true,
			indexer: NAME,
			outcome: 'registered',
			generation: {
				stream: successor.stream,
				processor: successor.processor,
				digest: generationDigestOf(successor),
			},
		});
		expect(deployment.rereads()).toBe(1);
	});

	it('says it changed NOTHING, as a success that is not the same shape as one that registered', async () => {
		deployment.answer(async () => ({
			outcome: 'unchanged',
			generation: deployment.incumbent,
			message: 'this configuration names the generation this deployment already holds',
		}));

		const answer = await reconfigure(deployment);

		expect(answer.status).toBe(200);
		expect(answer.body).toMatchObject({
			success: true,
			indexer: NAME,
			outcome: 'unchanged',
			generation: {digest: generationDigestOf(deployment.incumbent)},
		});
		// the WHY travels with it: an author reading this has something to act on,
		// which is the whole reason a no-op is not an empty success
		expect(answer.body.message).toContain('already holds');
		// ...and it is not the registered shape wearing a flag
		expect(answer.body.outcome).not.toBe('registered');
	});

	it('REFUSES when the re-read could not be completed, and says why', async () => {
		deployment.answer(async () => ({
			outcome: 'failed',
			message: 'SyntaxError: Unexpected end of input (./processor.js)',
		}));

		const answer = await reconfigure(deployment);

		// not a `400`: the request is well formed and nothing about it could be
		// changed to make this work. Not a `501` either: the capability is here. It is
		// the deployment's CURRENT state that conflicts, and the next build resolves
		// it -- which is what a resumable `409` says on this repo's other surfaces.
		expect(answer.status).toBe(409);
		expect(answer.body).toMatchObject({success: false, error: 'reconfigure-failed', indexer: NAME});
		expect(answer.body.message).toContain('SyntaxError');
		// nothing is NAMED as registered on the failing arm
		expect(answer.body.generation).toBeUndefined();
	});

	it('reports a host that THREW as the same failure, rather than as a server fault', async () => {
		deployment.answer(async () => {
			throw new Error('the module directory vanished');
		});

		const answer = await reconfigure(deployment);

		expect(answer.status).toBe(409);
		expect(answer.body).toMatchObject({success: false, error: 'reconfigure-failed'});
		expect(answer.body.message).toContain('the module directory vanished');
	});
});

describe('a re-read never interrupts the deployment it reaches', () => {
	it('leaves the incumbent answering reads across every outcome', async () => {
		const answering = generationDigestOf(deployment.incumbent);
		expect(await generationServed(deployment)).toBe(answering);
		const held = await registered(deployment);

		for (const outcome of [
			async (): Promise<ReconfigureReport> => ({
				outcome: 'unchanged',
				generation: deployment.incumbent,
				message: 'nothing moved',
			}),
			async (): Promise<ReconfigureReport> => ({outcome: 'failed', message: 'it does not compile'}),
		]) {
			deployment.answer(outcome);
			await reconfigure(deployment);
			// the SAME generation answers, from the SAME rows, and nothing was
			// registered on either arm
			expect(await generationServed(deployment)).toBe(answering);
			expect(await registered(deployment)).toEqual(held);
		}
	});
});

describe('the trigger is guarded by the credential the pointer move already uses', () => {
	it('refuses a caller with no token, and one presenting the INGEST token', async () => {
		deployment.answer(async () => ({outcome: 'registered', generation: deployment.incumbent}));

		const anonymous = await reconfigure(deployment, {token: undefined});
		expect(anonymous.status).toBe(401);
		expect(anonymous.body).toMatchObject({error: 'unauthorized'});

		const asFetcher = await reconfigure(deployment, {token: TOKEN});
		expect(asFetcher.status).toBe(401);

		// the guard sits ahead of the capability, so a refused caller never reached it
		expect(deployment.rereads()).toBe(0);
	});

	it('refuses EVERY caller when no ADMIN_TOKEN is configured', async () => {
		const app = createServer<TestEnv>({
			getDB: () => deployment.db,
			getEnv: () => ({INGEST_TOKEN: TOKEN}),
			getIndexer: (_c, name) => (name === NAME ? indexerEntryOn(deployment.db, deployment.indexer) : undefined),
		});

		const res = await app.request(`/${NAME}/admin/reconfigure`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
		});

		expect(res.status).toBe(401);
		expect(((await res.json()) as {message: string}).message).toMatch(/ADMIN_TOKEN/);
	});

	it('does not let an unauthenticated caller learn which names this host holds', async () => {
		expect((await reconfigure(deployment, {name: 'beta', token: undefined})).status).toBe(401);

		const authenticated = await reconfigure(deployment, {name: 'beta'});
		expect(authenticated.status).toBe(404);
		expect(authenticated.body).toMatchObject({error: 'unknown-indexer'});
	});
});

describe('a deployment that cannot serve the trigger refuses HONESTLY', () => {
	it('says the capability is absent rather than appearing to succeed', async () => {
		// a name whose entry answers the READ questions and has nothing to re-read
		// FROM: a read tier (`etherfold serve`) holds a database somebody else writes
		// and no processor at all. It is a CAPABILITY this deployment lacks, which is
		// the `501` every other absent capability on this surface answers.
		const entry: IndexerRegistryEntry = {
			db: deployment.db,
			canonicalGeneration: async () => deployment.incumbent,
		};
		const app = createServer<TestEnv>({
			getDB: () => deployment.db,
			getEnv: () => ({ADMIN_TOKEN}),
			getIndexer: (_c, name) => (name === NAME ? entry : undefined),
		});

		const res = await app.request(`/${NAME}/admin/reconfigure`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
		});

		expect(res.status).toBe(501);
		const body = (await res.json()) as {error: string; indexer: string; message: string};
		expect(body.error).toBe('reconfigure-not-held');
		expect(body.indexer).toBe(NAME);
		// and it says what WOULD serve it, rather than only that this does not
		expect(body.message).toMatch(/re-read/);
	});

	it('is absent independently of the pointer move, which that host may still hold', async () => {
		// `generations`/`promote` and `reconfigure` are not one capability: a host can
		// hold a registry it can move a pointer in and have nothing to re-read from.
		const app = createServer<TestEnv>({
			getDB: () => deployment.db,
			getEnv: () => ({ADMIN_TOKEN}),
			getIndexer: (_c, name) => (name === NAME ? indexerEntryOn(deployment.db, deployment.indexer) : undefined),
		});
		const authorized = {Authorization: `Bearer ${ADMIN_TOKEN}`};

		expect((await app.request(`/${NAME}/admin/canonical-generation`, {headers: authorized})).status).toBe(200);
		const refused = await app.request(`/${NAME}/admin/reconfigure`, {method: 'POST', headers: authorized});
		expect(refused.status).toBe(501);
		expect(((await refused.json()) as {error: string}).error).toBe('reconfigure-not-held');
	});
});
