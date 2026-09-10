import {env} from 'cloudflare:test';
import {describe, expect, it} from 'vitest';
import {DEFAULT_BATCH_BOUNDS, type BlockUpdate, type EntityDeclaration} from '@etherfold/state-store-sqlite';
import {D1_LIMITS, createD1DB, createD1Store, d1BatchBounds, d1PruneBudget, resolveD1Plan} from '../src/d1.js';
import {RecordingSQL} from './utils.js';

/**
 * The host states its backend's per-request limits, and they reach the store.
 *
 * This is the one file in the repo that may name D1's numbers in code
 * (`packages/state-store-sqlite/test/no-platform-leakage.test.ts` refuses them in
 * the store, which targets `remote-sql` and never a vendor), so it is also where
 * the wiring is asserted end to end: against the REAL D1 binding this deployment
 * runs on, with every statement and every query counted at the `remote-sql`
 * seam. A D1 rejection in an integration test would say that something broke,
 * not where; counting bound parameters per statement says where.
 */

const TOKEN: EntityDeclaration = {name: 'token', id: ['id'], fields: {owner: 'text', transferCount: 'integer'}};

/** One block per update, one mutation each: a block row plus a close plus an insert. */
const STATEMENTS_PER_UPDATE = 3;

/**
 * Blocks for ONE test, in its own block range and under its own token id.
 *
 * The tests share a D1 database (nothing here rolls it back between them), and a
 * block number is a primary key, so the range is what keeps them independent.
 */
function updates(count: number, {from, id}: {from: number; id: string}): BlockUpdate[] {
	return Array.from({length: count}, (_, index) => {
		const number = from + index;
		return {
			block: {number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12},
			mutations: [{type: 'upsert', entity: 'token', id: {id}, values: {owner: `0x${number}`, transferCount: number}}],
		};
	});
}

describe('the plan this deployment runs on', () => {
	it('is stated by the deployment rather than implied by the code', () => {
		// wrangler.toml, not a constant reached by editing source: the Free and Paid
		// caps differ by 20x, so moving between them must be a configuration change.
		expect(env.D1_PLAN).toBe('free');
		expect(resolveD1Plan(env)).toBe('free');
	});

	it('assumes the TIGHTER plan when a deployment states nothing', () => {
		expect(resolveD1Plan({})).toBe('free');
	});

	it('refuses a plan it does not know, naming the ones it does', () => {
		expect(() => resolveD1Plan({D1_PLAN: 'enterprise'})).toThrow(/free.*paid|paid.*free/);
	});
});

describe("D1's documented limits reach the store's batch bounds", () => {
	it('gives an unconfigured Free-tier deployment exactly what the shipped default targets', () => {
		// The store's default is DERIVED from these numbers (the finding note says
		// so). If this ever stops holding, one of the two moved and the other did not.
		expect(d1BatchBounds('free')).toEqual(DEFAULT_BATCH_BOUNDS);
	});

	it('raises the statements-per-batch bound on Paid, and never the parameter bound', () => {
		const free = d1BatchBounds('free');
		const paid = d1BatchBounds('paid');

		expect(paid.maxStatementsPerBatch).toBe(D1_LIMITS.paid.queriesPerInvocation);
		expect(paid.maxStatementsPerBatch).toBeGreaterThan(free.maxStatementsPerBatch);
		// bound parameters per query is NOT a per-plan number, so the correctness
		// bound is the same on both plans
		expect(paid.maxRowsPerStatement).toBe(free.maxRowsPerStatement);
		expect(paid.maxRowsPerStatement).toBe(D1_LIMITS.free.boundParametersPerQuery);
	});

	it('makes a Paid deployment actually batch to the raised bound, against real D1', async () => {
		const blocks = 40;
		const db = new RecordingSQL(createD1DB(env));
		const store = createD1Store(db, [TOKEN], {plan: 'paid'});
		await store.migrate();
		db.reset();

		await store.applyBlocks(updates(blocks, {from: 1_000_000, id: 'paid'}));

		// one round trip carrying every block, which is 20x what the Free-tier
		// default would allow in one batch -- plus the two statements the writer
		// guard adds to any batch: the claim and the read-back (ADR-0075)
		expect(db.batches.length).toBe(1);
		expect(db.batches[0].length).toBe(blocks * STATEMENTS_PER_UPDATE + 2);
		expect(db.batches[0].length).toBeGreaterThan(d1BatchBounds('free').maxStatementsPerBatch);
		expect((await store.getCurrent<{transferCount: number}>('token', {id: 'paid'}))?.transferCount).toBe(
			1_000_000 + blocks - 1,
		);
	});

	it('keeps a Free deployment inside the Free cap for the same work', async () => {
		const blocks = 40;
		const db = new RecordingSQL(createD1DB(env));
		const store = createD1Store(db, [TOKEN], {plan: 'free'});
		await store.migrate();
		db.reset();

		await store.applyBlocks(updates(blocks, {from: 2_000_000, id: 'free'}));

		expect(db.batches.length).toBeGreaterThan(1);
		for (const batch of db.batches) {
			expect(batch.length).toBeLessThanOrEqual(D1_LIMITS.free.queriesPerInvocation);
		}
	});
});

describe('a prune runs inside the plan it was configured for', () => {
	it('names no more row ids per statement than D1 allows, and lands against real D1', async () => {
		const db = new RecordingSQL(createD1DB(env));
		const store = createD1Store(db, [TOKEN], {plan: 'free', retention: {blocks: 64}, finalityDepth: 64});
		await store.migrate();
		await store.applyBlocks(updates(300, {from: 3_000_000, id: 'pruned'}));
		db.reset();

		const report = await store.prune({maxVersions: d1PruneBudget('free')});

		// more than one statement's worth of versions, so the bound is actually
		// exercised rather than incidentally satisfied
		expect(report.versionsDeleted).toBeGreaterThan(D1_LIMITS.free.boundParametersPerQuery);
		for (const statement of db.statements()) {
			expect(statement.args.length).toBeLessThanOrEqual(D1_LIMITS.free.boundParametersPerQuery);
			expect((statement.sql.match(/\?/g) ?? []).length).toBe(statement.args.length);
		}
		// and the cap was REACHED rather than incidentally missed: a full round names
		// exactly as many row ids as D1 allows parameters, which is only safe because
		// that statement carries no other parameter
		const deletes = db.batches.flat().filter((statement) => /^DELETE FROM/i.test(statement.sql));
		expect(deletes.length).toBeGreaterThan(1);
		expect(Math.max(...deletes.map((statement) => statement.args.length))).toBe(
			d1BatchBounds('free').maxRowsPerStatement,
		);
		// the whole prune fits in ONE Worker invocation's query budget, which is the
		// limit no batch bound can keep on its own
		expect(db.queries).toBeLessThanOrEqual(D1_LIMITS.free.queriesPerInvocation);
		// and the live version survives, however old it is
		expect(await store.getCurrent('token', {id: 'pruned'})).toBeDefined();
	});

	it('sizes the per-invocation budget so the rounds it costs fit the plan', () => {
		for (const plan of ['free', 'paid'] as const) {
			const rounds = d1PruneBudget(plan) / d1BatchBounds(plan).maxRowsPerStatement;
			// each round is one SELECT of row ids, one DELETE naming them, and the
			// writer read-back that says the DELETE was ours to make
			expect(rounds * 3).toBeLessThanOrEqual(D1_LIMITS[plan].queriesPerInvocation);
			expect(rounds).toBeGreaterThanOrEqual(1);
		}
		expect(d1PruneBudget('paid')).toBeGreaterThan(d1PruneBudget('free'));
	});
});
