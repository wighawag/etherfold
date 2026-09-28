import type {Accessor, ChildrenQuery, FindQuery, Page} from '@etherfold/accessor';
import {ACCESSOR_ENTITIES, runAccessorConformance, type AccessorFactory} from '@etherfold/accessor/conformance';
import type {RemoteSQL, SQLPreparedStatement, SQLResult} from 'remote-sql';
import {describe, expect, it} from 'vitest';
import {VersionedStateStore, type Mutation} from '../src/index.js';
import {createTestDB} from './utils/db.js';
import {block} from './utils/fixtures.js';

/**
 * What is particular to THIS backend's accessor, beside the shared suite
 * (`accessor-conformance.test.ts`): that a page of parents really is one query,
 * that a page too large for one statement's parameters is split under the
 * store's bound and answers the same, and that the suite it passes has teeth.
 */

/** Records every statement prepared against a real database, with how many values it bound. */
class CountingSQL implements RemoteSQL {
	readonly statements: {sql: string; params: number}[] = [];

	constructor(private readonly inner: RemoteSQL) {}

	prepare(sql: string): SQLPreparedStatement {
		const statement = this.inner.prepare(sql);
		const record = {sql, params: 0};
		this.statements.push(record);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values: unknown[]) => {
			record.params = values.length;
			return bind(...values);
		};
		return statement;
	}

	batch<T = any>(list: SQLPreparedStatement[]): Promise<SQLResult<T>[]> {
		return this.inner.batch<T>(list);
	}
}

function visits(parents: number, each: number): Mutation[] {
	const mutations: Mutation[] = [];
	for (let room = 0; room < parents; room++) {
		mutations.push({type: 'upsert' as const, entity: 'room', id: {room: `r${room}`}, values: {name: `room ${room}`}});
		for (let seq = 0; seq < each; seq++) {
			mutations.push({
				type: 'upsert' as const,
				entity: 'visit',
				id: {room: `r${room}`, seq: `s${seq}`},
				values: {guest: `g${seq}`, rank: seq},
			});
		}
	}
	return mutations;
}

describe("a page of parents' children on SQLite", () => {
	it('is ONE statement for the whole page, not one per parent', async () => {
		const db = new CountingSQL(createTestDB());
		const store = new VersionedStateStore(db, ACCESSOR_ENTITIES);
		await store.migrate();
		await store.applyBlock(block(100), visits(20, 4));
		const accessor = store.accessor();

		const before = db.statements.length;
		const pages = await accessor.children({
			entity: 'room',
			relation: 'visits',
			parents: Array.from({length: 20}, (_, room) => ({room: `r${room}`})),
			limit: 2,
		});
		const issued = db.statements.slice(before);

		expect(pages).toHaveLength(20);
		expect(pages.every((page) => page.rows.length === 2 && page.truncated)).toBe(true);
		expect(issued).toHaveLength(1);
		expect(issued[0]!.sql).toMatch(/ IN \(/);
	});

	it("is split under the store's parameter bound when a page would not fit one statement, and answers the same", async () => {
		const tight = new CountingSQL(createTestDB());
		const bounded = new VersionedStateStore(tight, ACCESSOR_ENTITIES, {bounds: {maxRowsPerStatement: 10}});
		const roomy = new VersionedStateStore(createTestDB(), ACCESSOR_ENTITIES);
		for (const store of [bounded, roomy]) {
			await store.migrate();
			await store.applyBlock(block(100), visits(30, 3));
		}
		const query: ChildrenQuery = {
			entity: 'room',
			relation: 'visits',
			parents: Array.from({length: 30}, (_, room) => ({room: `r${29 - room}`})),
			where: {field: 'rank', op: 'gte', value: 1},
			orderBy: {field: 'rank', direction: 'desc'},
			limit: 1,
			at: 100,
		};

		const before = tight.statements.length;
		const pages = await bounded.accessor().children(query);
		const issued = tight.statements.slice(before);

		expect(pages).toEqual(await roomy.accessor().children(query));
		expect(pages[0]!.rows).toEqual([{room: 'r29', seq: 's2', guest: 'g2', rank: 2}]);
		expect(issued.length).toBeGreaterThan(1);
		expect(issued.every((statement) => statement.params <= 10)).toBe(true);
	});
});

/**
 * The suite is only worth passing if a WRONG accessor fails it, so each of these
 * breaks one promise over the real SQLite accessor and checks the suite names
 * the case it broke.
 */
describe('the accessor suite catches', () => {
	function brokenFactory(breakIt: (real: Accessor) => Accessor): AccessorFactory {
		return (declarations) => {
			const store = new VersionedStateStore(createTestDB(), declarations);
			return {store, accessor: breakIt(store.accessor())};
		};
	}

	async function failedCases(breakIt: (real: Accessor) => Accessor): Promise<string[]> {
		const result = await runAccessorConformance(brokenFactory(breakIt));
		return result.failures.map((failure) => failure.name);
	}

	it('text ordered by JavaScript (UTF-16) comparison instead of UTF-8 bytes', async () => {
		const failed = await failedCases((real) => ({
			...real,
			async find<T>(query: FindQuery): Promise<Page<T>> {
				const field = query.orderBy?.field;
				if (field !== 'label') return real.find<T>(query);
				const all = await real.find<Record<string, unknown>>({...query, orderBy: undefined, limit: 10_000});
				const sign = query.orderBy?.direction === 'desc' ? -1 : 1;
				const rows = [...all.rows].sort((a, b) => {
					const [x, y] = [a[field] as string | null, b[field] as string | null];
					if (x === y) return 0;
					if (x === null) return -sign;
					if (y === null) return sign;
					return (x < y ? -1 : 1) * sign;
				});
				return {rows: rows.slice(0, query.limit) as T[], truncated: rows.length > query.limit};
			},
		}));
		expect(failed).toContain('text orders by UTF-8 bytes, nulls first ascending, ties by id');
	});

	it('a batch bound over the page of parents instead of one per parent', async () => {
		const failed = await failedCases((real) => ({
			...real,
			async children<T>(query: ChildrenQuery): Promise<Page<T>[]> {
				// one limit shared by the whole page: the first parent takes it all
				let left = query.limit;
				const pages: Page<T>[] = [];
				for (const page of await real.children<T>({...query, limit: query.limit * query.parents.length})) {
					const rows = page.rows.slice(0, Math.max(0, left));
					left -= rows.length;
					pages.push({rows, truncated: page.rows.length > rows.length || page.truncated});
				}
				return pages;
			},
		}));
		expect(failed).toContain('each parent gets its own bounded page, so a prolific parent does not starve the others');
	});

	it('an as-of query answered from the tip', async () => {
		const failed = await failedCases((real) => ({
			...real,
			find: <T>(query: FindQuery) => real.find<T>({...query, at: undefined}),
		}));
		expect(failed).toContain('as of a block, the rows live then, filtered and ordered as they were');
	});
});
