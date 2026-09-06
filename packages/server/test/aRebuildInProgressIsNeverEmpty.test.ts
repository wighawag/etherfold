import {createClient} from '@libsql/client';
import {generationDigestOf, type GenerationId} from '@etherfold/core';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {RemoteSQL} from 'remote-sql';
import {describe, expect, it} from 'vitest';
import {
	applySchema,
	createServer,
	generationRegistryPortOnSQL,
	GENERATION_POINTER_TABLE,
	type CursorReporter,
	type IndexerRegistryEntry,
} from '../src/index.js';

// ---------------------------------------------------------------------------------------------------
// A REBUILD IN PROGRESS IS NEVER AN EMPTY ANSWER
// ---------------------------------------------------------------------------------------------------
// The absence-versus-contradiction distinction, applied to a rebuild: "nothing
// here yet" and "this is still being built" must never look the same. It is TWO
// surfaces and this file asserts both at the seams that carry them:
//
//  - the `/status` ENVELOPE, which grows a per-generation dimension INSIDE the
//    field ADR-0047 reserved for it -- no endpoint, no new top-level field, and
//    still no `cursor` at all on a host that injects no reporter;
//  - the READ, which is answered by the CANONICAL generation and by nothing
//    else, so an indexer that has none yet REFUSES rather than answering the
//    empty page a consumer cannot tell from "you are caught up" (ADR-0015).
//
// What the rebuild's progress looks like while it ADVANCES is asserted where a
// real rebuild runs, over real folds and a real stored stream:
// `packages/cli/test/aRebuildInProgressIsVisible.test.ts`. Here the reporter is
// supplied by hand, because what is under test is the ENVELOPE the server owns
// and not what any one host puts in it.
// ---------------------------------------------------------------------------------------------------

const NAME = 'alpha';

type TestEnv = {DEV?: string};

function freshDatabase(): RemoteSQL {
	return new RemoteLibSQL(createClient({url: ':memory:'}));
}

/** A generation identity that is nothing but an identity: this file folds nothing. */
function generation(processor: string, stream = 'stream-digest'): GenerationId {
	return {stream, processor};
}

async function statusOf(getCursorReport?: CursorReporter<TestEnv>) {
	// ONE handle for both requests: `getDB` answers per REQUEST, and a fresh
	// database on every call would migrate one and read another
	const db = freshDatabase();
	const app = createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({DEV: 'true'}),
		...(getCursorReport ? {getCursorReport} : {}),
	});
	await app.request('/admin/setup', {method: 'POST'});
	const res = await app.request('/status');
	return {status: res.status, body: (await res.json()) as Record<string, any>};
}

describe('an operator watches a rebuild on /status, inside the field ADR-0047 reserved for it', () => {
	it('reports one entry per generation beside the cursor value, verbatim', async () => {
		const incumbent = generationDigestOf(generation('v1'));
		const successor = generationDigestOf(generation('v2'));
		const {status, body} = await statusOf(() => ({
			value: {lastToBlock: 4242, latestBlock: 4250, unconfirmedBlocks: 3},
			generations: [
				{generation: incumbent, canonical: true, follows: false, value: {lastToBlock: 4242}},
				// the one being REBUILT: it follows the stored stream and is behind
				{generation: successor, canonical: false, follows: true, value: {lastToBlock: 1200}},
			],
		}));

		expect(status).toBe(200);
		expect(body.healthy).toBe(true);
		expect(body.cursor).toEqual({
			reported: true,
			value: {lastToBlock: 4242, latestBlock: 4250, unconfirmedBlocks: 3},
			generations: [
				{generation: incumbent, canonical: true, follows: false, value: {lastToBlock: 4242}},
				{generation: successor, canonical: false, follows: true, value: {lastToBlock: 1200}},
			],
		});
		// ADDITIVE: the dimension grew inside `cursor` and nowhere else
		expect('generations' in body).toBe(false);
	});

	it('carries the generations even when there is no cursor to report, which is what a FIRST BUILD is', async () => {
		const building = generationDigestOf(generation('v1'));
		const {body} = await statusOf(() => ({
			generations: [{generation: building, canonical: true, follows: false}],
		}));

		// `reported` keeps its exact meaning -- is there a CURSOR -- and the
		// generations sit beside it, which is the whole point: "nothing has been
		// folded yet" and "this host reports nothing" are different news
		expect(body.cursor.reported).toBe(false);
		expect(typeof body.cursor.reason).toBe('string');
		expect(body.cursor.generations).toEqual([{generation: building, canonical: true, follows: false}]);
	});

	it('invents no generations key on a host whose reporter names none', async () => {
		const {body} = await statusOf(() => ({value: {lastToBlock: 7}}));
		expect(body.cursor).toEqual({reported: true, value: {lastToBlock: 7}});
		expect('generations' in body.cursor).toBe(false);
	});

	it('still carries no cursor field at all on a host that injects no reporter', async () => {
		const {status, body} = await statusOf();
		expect(status).toBe(200);
		expect('cursor' in body).toBe(false);
	});

	it('degrades the whole envelope when the reporter throws, without failing the route', async () => {
		const {status, body} = await statusOf(() => {
			throw new Error('the registry is locked');
		});
		expect(status).toBe(200);
		expect(body.healthy).toBe(true);
		expect(body.cursor).toEqual({reported: false, reason: expect.stringContaining('the registry is locked')});
	});

	it('degrades when a generation entry cannot be serialised, rather than taking the page down', async () => {
		// a `bigint` does not compile against the seam's type and a host can still
		// build one at runtime; `/status` is the page an operator refreshes while
		// something is wrong, so it must survive that
		const {status, body} = await statusOf(
			() =>
				({
					value: {lastToBlock: 1},
					generations: [{generation: 'g', canonical: true, follows: false, value: {lastToBlock: 10n}}],
				}) as never,
		);
		expect(status).toBe(200);
		expect(body.healthy).toBe(true);
		expect(body.cursor.reported).toBe(false);
		expect('generations' in body.cursor).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------------

/**
 * A READ TIER's entry: no fold, no receiver, and the canonical pointer resolved
 * from the DURABLE rows.
 *
 * This is the shape a `serve` process has over a database written elsewhere
 * (ADR-0053: a read resolves the pointer to a table NAMESPACE, with no engine at
 * all), and it is the one shape that can answer "there is no generation that
 * answers reads yet".
 */
function readTierEntry(db: RemoteSQL, name: string): IndexerRegistryEntry {
	const port = generationRegistryPortOnSQL(db, name);
	return {
		db,
		liveIngestions: async () => [],
		canonicalGeneration: async () => (await port.read()).canonical,
		generations: async () => (await port.read()).generations,
	};
}

async function readTier(db: RemoteSQL) {
	return createServer<TestEnv>({
		getDB: () => db,
		getEnv: () => ({}),
		getIndexer: (_c, name) => (name === NAME ? readTierEntry(db, name) : undefined),
	});
}

describe('a read against an indexer with no canonical generation is REFUSED, never answered empty', () => {
	it('refuses the retraction-aware feed rather than serving the empty page of a build in progress', async () => {
		const db = freshDatabase();
		await applySchema(db);
		const app = await readTier(db);

		const res = await app.request(`/${NAME}/feed`);
		const body = (await res.json()) as Record<string, any>;

		// NOT a `200` with `entries: []` and `hasMore: false`, which a consumer cannot
		// tell from "you are caught up"
		expect(res.status).toBe(503);
		expect(body).toMatchObject({success: false, error: 'no-canonical-generation', indexer: NAME});
		expect('entries' in body).toBe(false);
	});

	it('refuses the canonical view the same way, and does not ask for a gate first', async () => {
		const db = freshDatabase();
		await applySchema(db);
		const app = await readTier(db);

		const res = await app.request(`/${NAME}/canonical?gate=999`);
		expect(res.status).toBe(503);
		expect((await res.json()) as Record<string, any>).toMatchObject({error: 'no-canonical-generation'});
	});

	it('NAMES the generations that have not caught up, as the digest a feed advertises', async () => {
		const db = freshDatabase();
		await applySchema(db);
		const port = generationRegistryPortOnSQL(db, NAME);
		const registry = await port.read();
		expect(registry.generations).toEqual([]);

		// a generation registered, and a pointer that names NOTHING -- the shape the
		// substrate models explicitly (`PointerRow` carries a nullable identity), and
		// what a read tier sees when the writer holds generations none of which
		// answers reads yet
		const building = generation('v1');
		await port.commit(() => ({put: {...building, createdAt: Date.now()}, canonical: building}));
		await db
			.prepare(`UPDATE ${GENERATION_POINTER_TABLE} SET stream = NULL, processor = NULL WHERE indexer = ?1`)
			.bind(NAME)
			.all();

		const app = await readTier(db);
		const res = await app.request(`/${NAME}/feed`);
		const body = (await res.json()) as Record<string, any>;

		expect(res.status).toBe(503);
		expect(body.building).toEqual([generationDigestOf(building)]);
		expect(body.message).toContain('empty');
	});

	it('answers again as soon as a generation IS canonical, folded or not', async () => {
		const db = freshDatabase();
		await applySchema(db);
		const port = generationRegistryPortOnSQL(db, NAME);
		const canonical = generation('v1');
		await port.commit(() => ({put: {...canonical, createdAt: Date.now()}, canonical}));

		const app = await readTier(db);
		const res = await app.request(`/${NAME}/feed`);
		const body = (await res.json()) as Record<string, any>;

		// the refusal is about WHICH GENERATION ANSWERS and never about how much that
		// generation has folded: an empty page from a generation that IS canonical is
		// a consumer following a stream from the start, cursor in hand
		expect(res.status).toBe(200);
		expect(body).toMatchObject({success: true, entries: [], generation: generationDigestOf(canonical)});
	});
});
