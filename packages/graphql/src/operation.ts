import type {Accessor, ChildrenQuery, OrderBy, Where} from '@etherfold/accessor';
import type {EntityId, NormalizedEntity} from '@etherfold/state-store';
import {QUERY_ERROR_CODES, QueryRefusal} from './errors.js';

/**
 * ## One operation's reads, pinned to one block
 *
 * Built per ATTEMPT of an operation (`executeQuery`), and handed to every
 * resolver as the GraphQL context. It holds the block the operation pinned, and
 * it BATCHES: every nested collection asked for in one pass over a list of
 * parents becomes ONE `children` call to the accessor, bounded per parent, so
 * a hundred parents are one read and not a hundred (ADR-0099).
 */

/** Where a row was read as of: the key a nested collection reads its children at. Never serialised. */
export const READ_AT: unique symbol = Symbol('etherfold/graphql/read-at');

/** A row as a resolver holds it: the accessor's row, and the block it was read as of. */
export type ResolvedRow = Record<string, unknown> & {readonly [READ_AT]: number | undefined};

/** A nested collection's selection, everything but its parents. */
type ChildrenSelection = Omit<ChildrenQuery, 'parents'>;

type Batch = {
	readonly selection: ChildrenSelection;
	readonly parents: EntityId[];
	readonly waiters: {resolve(rows: ResolvedRow[]): void; reject(error: unknown): void}[];
};

export class OperationReads {
	private readonly batches = new Map<string, Batch>();

	constructor(
		readonly accessor: Accessor,
		/** The tip when the operation began: the block it pins, or `undefined` if the store holds none. */
		readonly tip: number | undefined,
		/** Whether reads are pinned by passing the block (a store that answers as-of reads). */
		readonly asOf: boolean,
	) {}

	/**
	 * The block a root field reads as of: the operation's pin, or the field's own
	 * `block` when it asks for one, which may not be above the pin.
	 */
	readAt(block: number | null | undefined): number | undefined {
		if (block === null || block === undefined) return this.asOf ? this.tip : undefined;
		if (block < 0)
			throw new QueryRefusal(QUERY_ERROR_CODES.invalidQuery, `a block is a height, at least 0, got ${block}`);
		if (this.tip === undefined || block > this.tip) {
			throw new QueryRefusal(
				QUERY_ERROR_CODES.blockNotYetIndexed,
				this.tip === undefined
					? `block ${block} is not indexed yet: this store holds no block.`
					: `block ${block} is not indexed yet: this operation answers as of block ${this.tip}, the highest the store held when it began.`,
				{requested: block, pinned: this.tip ?? null},
			);
		}
		return block;
	}

	async find(entity: NormalizedEntity, selection: Selection, at: number | undefined): Promise<ResolvedRow[]> {
		const page = await this.accessor.find({entity: entity.name, ...selection, at});
		return page.rows.map((row) => resolvedRow(row as Record<string, unknown>, at));
	}

	/**
	 * The children of ONE parent, read with every other parent asked for in the
	 * same pass: the first call schedules the batch for the end of the current
	 * turn, and graphql-js resolves a list's items synchronously within one turn,
	 * so a list of parents is one call.
	 */
	children(parent: NormalizedEntity, relation: string, row: ResolvedRow, selection: Selection): Promise<ResolvedRow[]> {
		const at = row[READ_AT];
		const query: ChildrenSelection = {entity: parent.name, relation, ...selection, at};
		const key = batchKey(query);
		let batch = this.batches.get(key);
		if (!batch) {
			batch = {selection: query, parents: [], waiters: []};
			this.batches.set(key, batch);
			void Promise.resolve().then(() => this.flush(key));
		}
		batch.parents.push(Object.fromEntries(parent.id.map((column) => [column, row[column] as string])));
		return new Promise((resolve, reject) => batch.waiters.push({resolve, reject}));
	}

	private async flush(key: string): Promise<void> {
		const batch = this.batches.get(key)!;
		this.batches.delete(key);
		try {
			const pages = await this.accessor.children({...batch.selection, parents: batch.parents});
			batch.waiters.forEach((waiter, index) =>
				waiter.resolve(
					(pages[index]?.rows ?? []).map((row) => resolvedRow(row as Record<string, unknown>, batch.selection.at)),
				),
			);
		} catch (error) {
			for (const waiter of batch.waiters) waiter.reject(error);
		}
	}
}

/** A predicate, an order and a bound: what a list field's arguments become. */
export type Selection = {readonly where?: Where; readonly orderBy?: OrderBy; readonly limit: number};

function resolvedRow(row: Record<string, unknown>, at: number | undefined): ResolvedRow {
	return Object.assign({...row}, {[READ_AT]: at}) as ResolvedRow;
}

/** One key per distinct selection, so only the same question is batched together. */
function batchKey(query: ChildrenSelection): string {
	return JSON.stringify(query, (_key, value: unknown) => {
		if (typeof value === 'bigint') return `bigint:${value}`;
		if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(',')}`;
		return value === undefined ? null : value;
	});
}
