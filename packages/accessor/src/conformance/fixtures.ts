import type {BlockPointer, EntityDeclaration, Mutation, StateStoreCapabilities} from '@etherfold/state-store';
import type {Page} from '../types.js';
import type {AccessorConformanceCase, AccessorFactory, AccessorSubject} from './types.js';

/**
 * The declarations every case is written against: small, hand-written, and each
 * entity earning its place.
 *
 * `item` carries one field of every kind a predicate can meet (text, an enum,
 * an integer, a real, a u256 and a plain blob), so every operator and every
 * ordering is asked of every storage class. `room` / `visit` is a relation with
 * a ONE-column parent key and `shelf` / `book` one with a TWO-column key, which
 * are different statements on a SQL backend (an `IN` over a column, an `IN`
 * over row values). `crowd` is the many-rows subject of the bound chapter.
 */
export const ITEM: EntityDeclaration = {
	name: 'item',
	id: ['id'],
	fields: {
		label: 'text',
		kind: {storage: 'text', enum: ['common', 'rare']},
		weight: 'integer',
		ratio: 'real',
		amount: {storage: 'blob', type: 'u256'},
		tag: 'blob',
	},
};

export const ROOM: EntityDeclaration = {name: 'room', id: ['room'], fields: {name: 'text'}};

export const VISIT: EntityDeclaration = {
	name: 'visit',
	id: ['room', 'seq'],
	fields: {guest: 'text', rank: 'integer'},
	parent: {entity: 'room', as: 'visits'},
};

export const SHELF: EntityDeclaration = {name: 'shelf', id: ['aisle', 'shelf'], fields: {}};

export const BOOK: EntityDeclaration = {
	name: 'book',
	id: ['aisle', 'shelf', 'book'],
	fields: {title: 'text', pages: 'integer'},
	parent: {entity: 'shelf', as: 'books'},
};

export const CROWD: EntityDeclaration = {name: 'crowd', id: ['id'], fields: {n: 'integer'}};

/** What every factory is handed. */
export const ACCESSOR_ENTITIES: readonly EntityDeclaration[] = [ITEM, ROOM, VISIT, SHELF, BOOK, CROWD];

export function block(number: number): BlockPointer {
	return {number, hash: `0x${number.toString(16)}`, timestamp: 1_700_000_000 + number * 12};
}

/** The code point U+1F600, a supplementary-plane character: UTF-16 orders it BEFORE U+E000, UTF-8 after. */
export const SUPPLEMENTARY = '\u{1F600}';
/** A private-use character, U+E000: the other half of the UTF-8 versus UTF-16 disagreement. */
export const PRIVATE_USE = '\uE000';

export const TWO_64 = 2n ** 64n;
export const TWO_255 = 2n ** 255n;

/** One `item`, every field listed (a whole-row write stores an unlisted field as null anyway). */
export type ItemValues = {
	label: string | null;
	kind: 'common' | 'rare' | null;
	weight: number | null;
	ratio: number | null;
	amount: bigint | null;
	tag: Uint8Array | null;
};

/**
 * The items every operator case reads, chosen so each ordering disagrees with
 * the wrong one: `Banana` before `apple` (bytes, not case-folded), U+E000
 * before U+1F600 (UTF-8, not UTF-16), 9 before 10 and 2^64 before 2^64 + 1 (a
 * u256 numerically, not as decimal text or as a double), a shorter blob before
 * a longer one it prefixes, `a` and `f` tying on `label` (ties by id), and `c`
 * null in every field (nulls first ascending, last descending).
 */
export const ITEMS: Readonly<Record<string, ItemValues>> = {
	a: {label: 'apple', kind: 'common', weight: 3, ratio: 0.5, amount: 9n, tag: new Uint8Array([1])},
	b: {label: 'Banana', kind: 'rare', weight: 10, ratio: 1.5, amount: 10n, tag: new Uint8Array([0, 255])},
	c: {label: null, kind: null, weight: null, ratio: null, amount: null, tag: null},
	d: {label: PRIVATE_USE, kind: 'common', weight: 3, ratio: -2, amount: TWO_64, tag: new Uint8Array([2])},
	e: {label: SUPPLEMENTARY, kind: 'rare', weight: -1, ratio: 0, amount: TWO_64 + 1n, tag: new Uint8Array([1, 0])},
	f: {label: 'apple', kind: 'common', weight: 7, ratio: 2.25, amount: TWO_255, tag: new Uint8Array([0])},
};

export function item(id: string, values: ItemValues): Mutation {
	return {type: 'upsert', entity: 'item', id: {id}, values};
}

/** Every `ITEMS` row as one block's upserts. */
export function allItems(): Mutation[] {
	return Object.entries(ITEMS).map(([id, values]) => item(id, values));
}

/** What an `item` row answers: its id, then its fields, as the seam answers them. */
export function itemRow(id: string, values: ItemValues = ITEMS[id]!): Record<string, unknown> {
	return {id, ...values};
}

export function visit(room: string, seq: string, guest: string, rank: number): Mutation {
	return {type: 'upsert', entity: 'visit', id: {room, seq}, values: {guest, rank}};
}

export function book(aisle: string, shelf: string, id: string, title: string, pages: number): Mutation {
	return {type: 'upsert', entity: 'book', id: {aisle, shelf, book: id}, values: {title, pages}};
}

/** The ids of a page, in its order, which is enough to name each row and see the order. */
export function ids(page: Page<Record<string, unknown>>, column = 'id'): unknown[] {
	return page.rows.map((row) => row[column]);
}

/** A subject from the factory, migrated, with the given blocks applied in order. */
export async function subjectWith(
	factory: AccessorFactory,
	blocks: readonly {readonly block: BlockPointer; readonly mutations: readonly Mutation[]}[] = [],
): Promise<AccessorSubject> {
	const subject = await factory(ACCESSOR_ENTITIES);
	await subject.store.migrate();
	for (const one of blocks) await subject.store.applyBlock(one.block, one.mutations);
	return subject;
}

/** Turns `{name: run}` into cases, so a case reads like the `it` it becomes. */
export function cases(group: string, entries: Record<string, () => Promise<void>>): AccessorConformanceCase[] {
	return Object.entries(entries).map(([name, run]) => ({group, name, run}));
}

/** Whether the store claims to answer as-of reads at all. */
export function answersHistory(capabilities: StateStoreCapabilities): boolean {
	return capabilities.asOf && capabilities.retention.kind !== 'revert-only';
}
