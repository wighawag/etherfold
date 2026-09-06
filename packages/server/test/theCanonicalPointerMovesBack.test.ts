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
} from '../src/index.js';
import {ALICE, CONTRACT, SOURCE, STREAM_CONFIG, TOKEN, ZERO, transfer, type TestABI} from './utils/feedHarness.js';

// ---------------------------------------------------------------------------------------------------
// THE OPERATOR MOVES THE CANONICAL POINTER BACK, OVER HTTP
// ---------------------------------------------------------------------------------------------------
// A processor upgrade that turned out worse is undone by ONE SMALL WRITE, and the
// old answers come back with no re-index and no re-fetch. The MECHANISM is
// asserted at the container seam (`packages/core/test/theCanonicalPointerMovesBack.test.ts`);
// what is asserted HERE is the operator's AFFORDANCE over it, which is the half
// that has to exist on every deployment shape -- a Worker is reachable only over
// HTTP, so a flag on a command could never serve one.
//
//  - `POST /{indexer}/admin/canonical-generation` moves the pointer, forwards or
//    back, and `GET` on the same path is how an operator learns what there is to
//    point AT (an advertised `generation` on a feed response is an opaque digest,
//    so it is matched against this listing rather than taken apart).
//  - It is guarded by its OWN credential, `ADMIN_TOKEN`, failing closed exactly as
//    the ingest guard does. It is deliberately NOT the ingest token: that one is
//    handed to a log shipper and guards the WRITE path, and letting it also decide
//    which generation answers reads would give a fetcher control-plane authority.
//  - A generation this host does not hold is REFUSED and every held one is NAMED,
//    which is the same shape `GenerationCapReachedError` has: naming them all is
//    information, picking one would be a policy.
//
// The FEED is what says which generation answers reads on this runtime, and it
// resolves the pointer ONCE per request, so a read cannot answer half from each
// generation across a move.
// ---------------------------------------------------------------------------------------------------

const NAME = 'alpha';
const ADMIN_TOKEN = 'an-operator-secret';

type TestEnv = {DEV?: string; INGEST_TOKEN?: string; ADMIN_TOKEN?: string};

/** The fold, at a version the caller moves: the SAME stream, a different answer over it. */
function entityProcessorAt(version: string): EntityProcessor<TestABI> {
	return {
		version,
		entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
		async onTransfer(state, event) {
			// the RECIPIENT under `v1` and the SENDER under anything else: two folds that
			// disagree over the very same logs, so "the old answers came back" is a real
			// claim rather than two identical answers
			const args = event.args as {from: string; to: string; id: bigint};
			state.set('token', {id: args.id.toString()}, {owner: version === 'v1' ? args.to : args.from});
		},
	};
}

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * A fold whose STATE is a database of its own, which is the cheapest thing that
 * is honestly per generation.
 *
 * The table-NAMESPACE version of the same isolation is asserted over a shared
 * handle in `packages/cli/test/generationNamespaceBesideFixedTables.test.ts`;
 * what is under test here is the POINTER, and a fold that could reach another's
 * rows would make an assertion about the pointer mean nothing.
 */
function foldAt(version: string) {
	return {
		createState: () => freshDatabase(),
		createProcessor: (state: RemoteSQL) => new VersionedStateEventProcessor<TestABI>(state, entityProcessorAt(version)),
	};
}

type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	db: RemoteSQL;
	indexer: ReceivingIndexer<TestABI, unknown, RemoteSQL>;
	incumbent: {generation: GenerationId; processor: VersionedStateEventProcessor<TestABI>};
	successor: {generation: GenerationId; processor: VersionedStateEventProcessor<TestABI>};
	/** How many times a request asked which generation answers reads. */
	resolutions: () => number;
	resetResolutions: () => void;
};

/**
 * One named indexer, an incumbent that has folded, and a successor PROMOTED over
 * it: the deployment an operator wants to undo.
 *
 * The successor is a PROCESSOR change, so it shares the stream, is a FOLLOWER
 * (ADR-0044) and catches up by re-folding `_emissions` -- which is what makes the
 * revert free in both directions.
 */
async function anUpgradeThatLanded(): Promise<Deployment> {
	const db = freshDatabase();
	await applySchema(db);
	const indexer = (await openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, NAME),
		source: SOURCE,
		stream: STREAM_CONFIG,
		appendEmissions: emissionAppenderFor(db, NAME),
		replay: storedEmissionReplaySource(db, NAME),
		generation: foldAt('v1'),
	})) as ReceivingIndexer<TestABI, unknown, RemoteSQL>;

	let resolutions = 0;
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN, ADMIN_TOKEN}),
		getIndexer: (_c, name) => {
			if (name !== NAME) return undefined;
			const entry = indexerEntryOn(db, indexer);
			return {
				...entry,
				canonicalGeneration: () => {
					resolutions++;
					return entry.canonicalGeneration();
				},
			};
		},
	});

	// the incumbent folds a batch, and stores the stream it folded (ADR-0052)
	const push = async (over: {toBlock: number; latestBlock: number; logs: LogEvent<TestABI>[]}) => {
		const fromBlock = await indexer.ingestion.expectedFromBlock();
		const batch: WireBatch<TestABI> = {
			context: indexer.ingestion.context,
			fromBlock,
			toBlock: over.toBlock,
			latestBlock: over.latestBlock,
			logs: over.logs,
		};
		const res = await app.request(`/${NAME}/ingest`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
			body: serializeWireBatch(batch),
		});
		expect(res.status, await res.clone().text()).toBe(200);
	};
	await push({toBlock: 105, latestBlock: 105, logs: [transfer(101, '0xa101', ALICE, 1n, 0, CONTRACT)]});

	const incumbentGeneration = indexer.generation;
	const successor = await indexer.add(foldAt('v2'));
	for (let guard = 0; guard < 50; guard++) {
		const [report] = await indexer.rebuildMore();
		if (report?.complete) break;
	}

	return {
		app,
		db,
		indexer,
		incumbent: {
			generation: incumbentGeneration,
			processor: indexer.processor as VersionedStateEventProcessor<TestABI>,
		},
		successor: {
			generation: {stream: successor.record.stream, processor: successor.record.processor},
			processor: successor.processor as VersionedStateEventProcessor<TestABI>,
		},
		resolutions: () => resolutions,
		resetResolutions: () => {
			resolutions = 0;
		},
	};
}

async function readPointer(
	deployment: Deployment,
	options: {token?: string | undefined; name?: string} = {},
): Promise<{status: number; body: Record<string, unknown>}> {
	const token = 'token' in options ? options.token : ADMIN_TOKEN;
	const res = await deployment.app.request(`/${options.name ?? NAME}/admin/canonical-generation`, {
		method: 'GET',
		...(token === undefined ? {} : {headers: {Authorization: `Bearer ${token}`}}),
	});
	return {status: res.status, body: (await res.json()) as Record<string, unknown>};
}

async function movePointer(
	deployment: Deployment,
	to: unknown,
	options: {token?: string | undefined; name?: string} = {},
): Promise<{status: number; body: Record<string, unknown>}> {
	const token = 'token' in options ? options.token : ADMIN_TOKEN;
	const res = await deployment.app.request(`/${options.name ?? NAME}/admin/canonical-generation`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json', ...(token === undefined ? {} : {Authorization: `Bearer ${token}`})},
		body: JSON.stringify(to),
	});
	return {status: res.status, body: (await res.json()) as Record<string, unknown>};
}

/** WHICH generation answers reads, as a consumer of the feed is told. */
async function generationServed(deployment: Deployment): Promise<string> {
	const res = await deployment.app.request(`/${NAME}/feed`);
	expect(res.status).toBe(200);
	return ((await res.json()) as {generation: string}).generation;
}

/** What one fold concluded, read through its OWN store. */
async function ownerOf(processor: VersionedStateEventProcessor<TestABI>, id: string): Promise<string | undefined> {
	return (await processor.state.getCurrent<{owner: string}>('token', {id}))?.owner;
}

let deployment: Deployment;

beforeEach(async () => {
	deployment = await anUpgradeThatLanded();
});

describe('the operator moves the canonical pointer BACK', () => {
	it('makes the previous generation answer reads again, from its own untouched state', async () => {
		// the upgrade landed: the successor is canonical and its fold disagrees with
		// the incumbent's over the very same logs
		expect(await generationServed(deployment)).toBe(generationDigestOf(deployment.successor.generation));
		expect(await ownerOf(deployment.successor.processor, '1')).toBe(ZERO);
		expect(await ownerOf(deployment.incumbent.processor, '1')).toBe(ALICE);

		const moved = await movePointer(deployment, deployment.incumbent.generation);

		expect(moved.status).toBe(200);
		expect(moved.body).toMatchObject({
			success: true,
			previous: {digest: generationDigestOf(deployment.successor.generation)},
			canonical: {
				stream: deployment.incumbent.generation.stream,
				processor: deployment.incumbent.generation.processor,
				digest: generationDigestOf(deployment.incumbent.generation),
			},
		});
		// reads answer from the previous generation again, and from the state IT
		// folded: nothing the successor wrote is in it
		expect(await generationServed(deployment)).toBe(generationDigestOf(deployment.incumbent.generation));
		expect(await ownerOf(deployment.incumbent.processor, '1')).toBe(ALICE);
	});

	it('appends NOTHING to the stored stream: the revert is one row of bookkeeping', async () => {
		const rowsBefore = await deployment.db.prepare('SELECT * FROM _emissions').all();

		await movePointer(deployment, deployment.incumbent.generation);

		const rowsAfter = await deployment.db.prepare('SELECT * FROM _emissions').all();
		expect(rowsAfter.results).toEqual(rowsBefore.results);
	});

	it('leaves the generation reverted FROM registered, so a second move forward is free', async () => {
		await movePointer(deployment, deployment.incumbent.generation);

		const listed = await readPointer(deployment);
		expect(listed.status).toBe(200);
		expect(listed.body).toMatchObject({
			canonical: {digest: generationDigestOf(deployment.incumbent.generation)},
		});
		const generations = listed.body.generations as {digest: string; canonical: boolean}[];
		expect(generations.map((entry) => entry.digest).sort()).toEqual(
			[generationDigestOf(deployment.incumbent.generation), generationDigestOf(deployment.successor.generation)].sort(),
		);
		expect(generations.filter((entry) => entry.canonical).map((entry) => entry.digest)).toEqual([
			generationDigestOf(deployment.incumbent.generation),
		]);

		// forward again, at the same cost, with the state it had
		const again = await movePointer(deployment, deployment.successor.generation);
		expect(again.status).toBe(200);
		expect(await generationServed(deployment)).toBe(generationDigestOf(deployment.successor.generation));
		expect(await ownerOf(deployment.successor.processor, '1')).toBe(ZERO);
	});

	it('holds the pointer where the operator put it, across further advances', async () => {
		await movePointer(deployment, deployment.incumbent.generation);

		// the successor is level BY CONSTRUCTION, so an unarmed trigger would take the
		// pointer straight back on the next scheduled chunk (ADR-0046)
		await deployment.indexer.rebuildMore();
		await deployment.indexer.rebuildMore();

		expect(await generationServed(deployment)).toBe(generationDigestOf(deployment.incumbent.generation));
	});

	it('resolves the canonical generation ONCE per read, so a read never straddles a move', async () => {
		deployment.resetResolutions();

		await deployment.app.request(`/${NAME}/feed`);
		expect(deployment.resolutions()).toBe(1);

		deployment.resetResolutions();
		await deployment.app.request(`/${NAME}/canonical?gate=1000`);
		expect(deployment.resolutions()).toBe(1);
	});
});

describe('the admin surface is guarded by its OWN credential, and fails closed', () => {
	it('refuses a caller with no token, and one presenting the INGEST token', async () => {
		const anonymous = await movePointer(deployment, deployment.incumbent.generation, {token: undefined});
		expect(anonymous.status).toBe(401);
		expect(anonymous.body).toMatchObject({error: 'unauthorized'});

		// the credential a log shipper holds does NOT decide which generation answers
		// reads: that would give a fetcher control-plane authority
		const asFetcher = await movePointer(deployment, deployment.incumbent.generation, {token: TOKEN});
		expect(asFetcher.status).toBe(401);

		// and nothing moved
		expect(await generationServed(deployment)).toBe(generationDigestOf(deployment.successor.generation));
	});

	it('refuses EVERY caller when no ADMIN_TOKEN is configured', async () => {
		const app = createServer<TestEnv>({
			getDB: () => deployment.db,
			getEnv: () => ({INGEST_TOKEN: TOKEN}),
			getIndexer: (_c, name) => (name === NAME ? indexerEntryOn(deployment.db, deployment.indexer) : undefined),
		});

		const res = await app.request(`/${NAME}/admin/canonical-generation`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}`},
			body: JSON.stringify(deployment.incumbent.generation),
		});

		// a server that can authenticate nobody authenticates nobody, exactly as the
		// ingest guard does with a missing INGEST_TOKEN
		expect(res.status).toBe(401);
		expect((await res.json()).message).toMatch(/ADMIN_TOKEN/);
	});

	it('does not let an unauthenticated caller enumerate the names this host holds', async () => {
		const unknown = await readPointer(deployment, {name: 'beta', token: undefined});
		expect(unknown.status).toBe(401);

		// authenticated, the same name is the ordinary routing refusal
		const authenticated = await readPointer(deployment, {name: 'beta'});
		expect(authenticated.status).toBe(404);
		expect(authenticated.body).toMatchObject({error: 'unknown-indexer'});
	});
});

describe('a pointer move refuses clearly rather than landing somewhere plausible', () => {
	it('REFUSES a generation this host does not hold, and NAMES every one it does', async () => {
		const refused = await movePointer(deployment, {
			stream: deployment.incumbent.generation.stream,
			processor: 'never-registered',
		});

		expect(refused.status).toBe(400);
		expect(refused.body).toMatchObject({error: 'unknown-generation'});
		expect((refused.body.generations as {digest: string}[]).map((entry) => entry.digest).sort()).toEqual(
			[generationDigestOf(deployment.incumbent.generation), generationDigestOf(deployment.successor.generation)].sort(),
		);
		// and the pointer is where it was
		expect(await generationServed(deployment)).toBe(generationDigestOf(deployment.successor.generation));
	});

	it('REFUSES a body that does not name a generation at all', async () => {
		for (const body of [{}, {stream: 42, processor: 'v1'}, {stream: deployment.incumbent.generation.stream}]) {
			const refused = await movePointer(deployment, body);
			expect(refused.status).toBe(400);
			expect(refused.body).toMatchObject({error: 'invalid-generation'});
		}
		expect(await generationServed(deployment)).toBe(generationDigestOf(deployment.successor.generation));
	});

	it('says a host holding no generations does not do this, rather than pretending the route is missing', async () => {
		// a name whose entry answers the two READ questions and holds no registry: a
		// host that has not moved onto the generation container. It is a CAPABILITY
		// this deployment lacks, which is the `501` the ingest routes already answer.
		const entry: IndexerRegistryEntry = {
			db: deployment.db,
			liveIngestions: async () => [],
			canonicalGeneration: async () => deployment.incumbent.generation,
		};
		const app = createServer<TestEnv>({
			getDB: () => deployment.db,
			getEnv: () => ({ADMIN_TOKEN}),
			getIndexer: (_c, name) => (name === NAME ? entry : undefined),
		});

		const res = await app.request(`/${NAME}/admin/canonical-generation`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}`},
			body: JSON.stringify(deployment.incumbent.generation),
		});

		expect(res.status).toBe(501);
		expect((await res.json()).error).toBe('generations-not-held');
	});
});
