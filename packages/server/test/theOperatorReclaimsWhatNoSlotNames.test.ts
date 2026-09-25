import {createClient} from '@libsql/client';
import {
	generationDigestOf,
	openReceivingIndexer,
	type GenerationId,
	type HeldFold,
	type IndexingSource,
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
	streamCursorSourceOn,
	indexerEntryOn,
	storedEmissionReplaySource,
	type IndexerRegistryEntry,
} from '../src/index.js';
import {
	ALICE,
	BOB,
	CONTRACT,
	OTHER_CONTRACT,
	RECONFIGURED_SOURCE,
	SOURCE,
	START_BLOCK,
	STREAM_CONFIG,
	TOKEN,
	transfer,
	type TestABI,
} from './utils/feedHarness.js';
import {bundleOf, identityOf} from './utils/processorIdentity.js';

// ---------------------------------------------------------------------------------------------------
// THE OPERATOR RECLAIMS WHAT NO SLOT NAMES, OVER HTTP
// ---------------------------------------------------------------------------------------------------
// A cap REFUSES at its bound and never evicts, which is sound and was the ONLY
// instrument an operator had: it names what could be deleted and hands over
// nothing to delete it with, so the remedy was hand-written SQL or a deleted
// database. `POST /{indexer}/admin/reclaim-generations` is the missing verb, and
// `GET /{indexer}/admin/canonical-generation` is the half that makes it usable --
// each slot, what it names, and everything no slot names.
//
// WHAT IS ASSERTED HERE is the operator's AFFORDANCE, not the rule: which
// generations survive a reclaim, and what the disk shows afterwards, are asserted
// at the container seam over a real database
// (`packages/cli/test/aGenerationNoSlotNamesIsReclaimed.test.ts`). This is the
// half that has to exist on EVERY deployment shape -- a Worker is reachable only
// over HTTP, so a flag on a command could never serve one (ADR-0057) -- plus the
// two decisions a transport owns: WHO may call it, and WHICH answer each refusal
// is.
//
// The credential is the one that already guards the pointer move, and the
// asymmetry is deliberate: a pointer move is REVERSIBLE and this DELETES state,
// so it is the last surface that should ever be reachable with the credential a
// log shipper holds.
// ---------------------------------------------------------------------------------------------------

const NAME = 'alpha';
const ADMIN_TOKEN = 'an-operator-secret';

type TestEnv = {DEV?: string; INGEST_TOKEN?: string; ADMIN_TOKEN?: string};

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/**
 * A FOLD ARRIVING AS THE BYTES `marker` NAMES, over a state database of its own.
 *
 * The identity is HANDED to the fold rather than asked of it (ADR-0086), so two
 * markers are two generations with no author action -- which is what gives this
 * file the several generations it reclaims from.
 */
function foldAt(marker: string, source?: IndexingSource<TestABI>) {
	const declared: EntityProcessor<TestABI> = {
		entities: [{name: 'token', id: ['id'], fields: {owner: 'text'}}],
		async onTransfer(state, event) {
			state.set('token', {id: (event.args as {id: bigint}).id.toString()}, {owner: event.args.to});
		},
	};
	const identity = identityOf(marker);
	return {
		...(source ? {source} : {}),
		createState: () => freshDatabase(),
		createProcessor: (state: RemoteSQL) => new VersionedStateEventProcessor<TestABI>(state, declared),
		processorIdentity: identity,
		// ...and the bytes it is the hash of, which registering stores (ADR-0092)
		bundle: bundleOf(identity),
	};
}

/**
 * Feed ONE fold's STREAM, at that stream's address on the wire.
 *
 * It used to reach for the fold's own receiver. A fold has none since ADR-0087:
 * what answers at a stream's address is the DEPLOYMENT's writer of that stream,
 * and every generation over it reads what that writer stored -- so the thing to
 * feed is named by the STREAM the fold folds, not by the fold.
 */
async function feed(
	indexer: ReceivingIndexer<TestABI, unknown, unknown>,
	fold: HeldFold<TestABI, unknown, unknown>,
	over: {to: string; id: bigint; address: string},
) {
	const receiver = (await indexer.liveIngestions()).find((one) => one.streamDigest === fold.streamDigest);
	if (!receiver) throw new Error(`nothing is fetching the stream ${fold.streamDigest}`);
	const batch: WireBatch<TestABI> = {
		context: receiver.context,
		fromBlock: await receiver.expectedFromBlock(),
		toBlock: START_BLOCK + 10,
		latestBlock: START_BLOCK + 10,
		logs: [transfer(START_BLOCK + 1, '0xa101', over.to, over.id, 0, over.address)],
	};
	await receiver.receive(batch);
}

const idOf = (fold: {record: GenerationId}): GenerationId => ({
	stream: fold.record.stream,
	processor: fold.record.processor,
});

type Deployment = {
	app: ReturnType<typeof createServer<TestEnv>>;
	db: RemoteSQL;
	indexer: ReceivingIndexer<TestABI, unknown, RemoteSQL>;
	/** The generation NO SLOT NAMES, and the only one on its stream. */
	garbage: GenerationId;
	/** What `predecessor` holds: the way back, which a reclaim must never take. */
	predecessor: GenerationId;
	/** What `canonical` holds. */
	canonical: GenerationId;
};

/**
 * A DEPLOYMENT UPGRADED TWICE: two promotions, so the generation the pointer
 * started on is named by no slot at all.
 *
 * The first fold runs a source of its own, so what falls out of the slots is the
 * ONLY generation on its stream -- which is what makes the reclaim reap a stream
 * as well, and therefore what makes "what came back" a question with an answer.
 */
async function aDeploymentUpgradedTwice(): Promise<Deployment> {
	const db = freshDatabase();
	await applySchema(db);
	const indexer = (await openReceivingIndexer({
		port: generationRegistryPortOnSQL(db, NAME),
		source: SOURCE,
		stream: STREAM_CONFIG,
		appendEmissions: emissionAppenderFor(db, NAME),
		streamCursor: streamCursorSourceOn(db, NAME),
		replay: storedEmissionReplaySource(db, NAME),
		generation: foldAt('the-first-fold'),
	})) as ReceivingIndexer<TestABI, unknown, RemoteSQL>;
	await feed(indexer, indexer.opening, {to: ALICE, id: 1n, address: CONTRACT});
	const first = indexer.generation;

	// a SOURCE change -- a stream of its own -- promoted, which makes the first
	// generation the PREDECESSOR and retains it
	const second = await indexer.add(foldAt('the-second-fold', RECONFIGURED_SOURCE));
	await feed(indexer, second, {to: BOB, id: 2n, address: OTHER_CONTRACT});
	await indexer.promote(idOf(second));

	// ...and a PROCESSOR change over that stream, promoted in turn: `predecessor` holds
	// exactly one, so the first generation is now named by nothing
	const third = await indexer.add(foldAt('the-third-fold', RECONFIGURED_SOURCE));
	await indexer.promote(idOf(third));

	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({INGEST_TOKEN: TOKEN, ADMIN_TOKEN}),
		getIndexer: (_c, name) => (name === NAME ? indexerEntryOn(db, indexer) : undefined),
	});

	return {app, db, indexer, garbage: first, predecessor: idOf(second), canonical: idOf(third)};
}

async function listGenerations(
	deployment: Deployment,
	options: {token?: string | undefined} = {},
): Promise<{status: number; body: Record<string, never> & Record<string, unknown>}> {
	const token = 'token' in options ? options.token : ADMIN_TOKEN;
	const res = await deployment.app.request(`/${NAME}/admin/canonical-generation`, {
		method: 'GET',
		...(token === undefined ? {} : {headers: {Authorization: `Bearer ${token}`}}),
	});
	return {status: res.status, body: (await res.json()) as Record<string, never> & Record<string, unknown>};
}

async function reclaim(
	deployment: Deployment,
	options: {token?: string | undefined; name?: string} = {},
): Promise<{status: number; body: Record<string, unknown>}> {
	const token = 'token' in options ? options.token : ADMIN_TOKEN;
	const res = await deployment.app.request(`/${options.name ?? NAME}/admin/reclaim-generations`, {
		method: 'POST',
		...(token === undefined ? {} : {headers: {Authorization: `Bearer ${token}`}}),
	});
	return {status: res.status, body: (await res.json()) as Record<string, unknown>};
}

/** How many stored emissions this stream still holds. */
async function emissionRows(db: RemoteSQL, stream: string): Promise<number> {
	const rows = await db
		.prepare(`SELECT COUNT(*) AS records FROM _emissions WHERE indexer = ?1 AND stream = ?2`)
		.bind(NAME, stream)
		.all<{records: number}>();
	return Number(rows.results[0]?.records ?? 0);
}

let deployment: Deployment;

beforeEach(async () => {
	deployment = await aDeploymentUpgradedTwice();
});

describe('an operator SEES what the deployment holds, slot by slot', () => {
	it('reports each slot, what it names, and everything no slot names', async () => {
		const listed = await listGenerations(deployment);

		expect(listed.status).toBe(200);
		expect(listed.body.slots).toMatchObject({
			canonical: {digest: generationDigestOf(deployment.canonical)},
			predecessor: {digest: generationDigestOf(deployment.predecessor)},
		});
		// ...and what NO slot names, named rather than left to be derived by matching
		// four digests by eye, which is the work this surface exists to remove
		expect((listed.body.unslotted as {digest: string}[]).map((one) => one.digest)).toEqual([
			generationDigestOf(deployment.garbage),
		]);
		const generations = listed.body.generations as {digest: string; slot?: string}[];
		expect(
			generations.map((one) => ({digest: one.digest, slot: one.slot})).sort((a, b) => a.digest.localeCompare(b.digest)),
		).toEqual(
			[
				{digest: generationDigestOf(deployment.canonical), slot: 'canonical'},
				{digest: generationDigestOf(deployment.predecessor), slot: 'predecessor'},
				{digest: generationDigestOf(deployment.garbage), slot: undefined},
			].sort((a, b) => a.digest.localeCompare(b.digest)),
		);
	});
});

describe('an operator RECLAIMS what no slot names, and is told what happened', () => {
	it('takes it, names it, and says what came back with it', async () => {
		expect(await emissionRows(deployment.db, deployment.garbage.stream)).toBe(1);

		const reclaimed = await reclaim(deployment);

		expect(reclaimed.status).toBe(200);
		expect(reclaimed.body).toMatchObject({success: true, indexer: NAME, outcome: 'reclaimed', declined: []});
		expect(reclaimed.body.reclaimed).toMatchObject([
			{
				digest: generationDigestOf(deployment.garbage),
				stream: deployment.garbage.stream,
				processor: deployment.garbage.processor,
				// the STREAM is the expensive thing, so whether one was reaped -- and how much
				// came back with it -- is the answer an operator opened this route for
				reaped: deployment.garbage.stream,
				records: 1,
			},
		]);
		expect(reclaimed.body.message).toContain(deployment.garbage.processor);
		expect(await emissionRows(deployment.db, deployment.garbage.stream)).toBe(0);

		// ...and the listing agrees afterwards: nothing is left that no slot names
		const listed = await listGenerations(deployment);
		expect((listed.body.unslotted as unknown[]).length).toBe(0);
		expect((listed.body.generations as {digest: string}[]).map((one) => one.digest).sort()).toEqual(
			[generationDigestOf(deployment.canonical), generationDigestOf(deployment.predecessor)].sort(),
		);
	});

	it('never takes the REVERT TARGET, so the way back is still one small write', async () => {
		await reclaim(deployment);

		// `predecessor` is not canonical right now, which is exactly why "not canonical"
		// is the wrong predicate: it is the undo for the upgrade that made this garbage.
		const moved = await deployment.app.request(`/${NAME}/admin/canonical-generation`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}`},
			body: JSON.stringify(deployment.predecessor),
		});
		expect(moved.status).toBe(200);
		expect((await moved.json()).canonical).toMatchObject({digest: generationDigestOf(deployment.predecessor)});
	});

	it('says it reclaimed NOTHING rather than reporting success over no work', async () => {
		await reclaim(deployment);

		const again = await reclaim(deployment);

		// a SUCCESS that says so, and distinguishable from having done work: an operator
		// whose disk is still full learns that nothing here is free rather than that
		// something was freed
		expect(again.status).toBe(200);
		expect(again.body).toMatchObject({success: true, outcome: 'nothing-to-reclaim', reclaimed: [], declined: []});
		expect(again.body.message).toContain('NOTHING was reclaimed');
		expect(again.body.slots).toMatchObject({canonical: {digest: generationDigestOf(deployment.canonical)}});
	});
});

describe('the verb that DELETES is guarded by the admin credential, and fails closed', () => {
	it('refuses a caller with no token, and one presenting the INGEST token', async () => {
		const anonymous = await reclaim(deployment, {token: undefined});
		expect(anonymous.status).toBe(401);
		expect(anonymous.body).toMatchObject({error: 'unauthorized'});

		// the credential a log shipper holds does NOT delete generations: it guards the
		// write path, and this is the one surface here that destroys state
		const asFetcher = await reclaim(deployment, {token: TOKEN});
		expect(asFetcher.status).toBe(401);

		// ...and nothing went
		const listed = await listGenerations(deployment);
		expect((listed.body.generations as unknown[]).length).toBe(3);
		expect(await emissionRows(deployment.db, deployment.garbage.stream)).toBe(1);
	});

	it('does not let an unauthenticated caller enumerate the names this host holds', async () => {
		const unknown = await reclaim(deployment, {name: 'beta', token: undefined});
		expect(unknown.status).toBe(401);

		const authenticated = await reclaim(deployment, {name: 'beta'});
		expect(authenticated.status).toBe(404);
		expect(authenticated.body).toMatchObject({error: 'unknown-indexer'});
	});

	it('says a host holding no generations does not do this, rather than pretending the route is missing', async () => {
		// a host that holds ONE fold and no registry: there are no slots there, so there
		// is nothing that could be named by none of them. A CAPABILITY this deployment
		// lacks, which is the `501` every other optional surface here answers.
		const entry: IndexerRegistryEntry = {
			db: deployment.db,
			liveIngestions: async () => [],
			canonicalGeneration: async () => deployment.canonical,
		};
		const app = createServer<TestEnv>({
			getDB: () => deployment.db,
			getEnv: () => ({ADMIN_TOKEN}),
			getIndexer: (_c, name) => (name === NAME ? entry : undefined),
		});

		const res = await app.request(`/${NAME}/admin/reclaim-generations`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${ADMIN_TOKEN}`},
		});

		expect(res.status).toBe(501);
		expect((await res.json()).error).toBe('reclaim-not-held');
	});
});
