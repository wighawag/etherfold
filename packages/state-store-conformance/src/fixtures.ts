import {
	createMutationContext,
	type BlockPointer,
	type EntityDeclaration,
	type Mutation,
	type StateStore,
	type StateStoreBackend,
	type StateStoreCapabilities,
} from '@etherfold/state-store';
import type {ConformanceCase, StateStoreFactory} from './types.js';

/**
 * The declarations every case is written against.
 *
 * Deliberately small and hand-written. The heavy subject -- the captured
 * stratagems stream and the port that reproduces its state byte-identically --
 * is `@etherfold/conformance-workload-stratagems`, a second subject for the same
 * backends rather than a replacement for these: a case that fails on 31,332 real
 * events is a bug report nobody can read.
 *
 * Five entities, each earning its place: `token` is the ordinary
 * overwrite-and-delete subject, `player` carries the ACCUMULATED counter the
 * reorg case exists for (the field is named after the real one that went from 12
 * back to 6 in `work/notes/findings/sqlite-in-the-browser.md`), `cell` has a
 * composite business key, which is the part of the id contract a single-column
 * fixture would never exercise, `placement` is the ordered child collection
 * a bounded listing exists for -- three id columns, so a PREFIX has more than
 * one length to be tested at -- and `order` is spelled entirely in SQL KEYWORDS
 * (see `RESERVED_WORDS`).
 */
export const TOKEN: EntityDeclaration = {
	name: 'token',
	id: ['id'],
	fields: {owner: 'text', transferCount: 'integer'},
};

export const PLAYER: EntityDeclaration = {
	name: 'player',
	id: ['address'],
	fields: {computedPoints: 'integer'},
};

export const CELL: EntityDeclaration = {
	name: 'cell',
	id: ['x', 'y'],
	fields: {owner: 'text'},
};

/**
 * The children of a parent, keyed by it: the shape a one-to-many is modelled in
 * once a listing exists, taken from the real `placements` in the finding.
 */
export const PLACEMENT: EntityDeclaration = {
	name: 'placement',
	id: ['epoch', 'position', 'playerIndex'],
	fields: {player: 'text'},
};

/**
 * A declaration spelled ENTIRELY in SQL keywords: the entity name, both id
 * columns, and every field.
 *
 * It is in the shared set rather than in its own case because that is the
 * property under test. A declaration is the surface ONE processor writes and
 * SEVERAL backends store, so "is this declaration legal" has to be a fact about
 * the declaration and not about the deployment. A name only a SQL backend chokes
 * on is the failure `work/notes/findings/sqlite-in-the-browser.md` recorded: an
 * id column named `index` passed validation, was stored happily by the
 * light and IndexedDB backends, and killed `migrate()` on SQLite with
 * `SQLITE_ERROR: near "index": syntax error` -- at deploy time, on one platform,
 * far from where it was written.
 *
 * Being in `CONFORMANCE_ENTITIES` means every case migrates it, every revert
 * sweeps it and every prune considers it, so the keyword identifiers reach every
 * statement a backend emits rather than only its DDL.
 */
export const RESERVED: EntityDeclaration = {
	name: 'order',
	id: ['group', 'index'],
	fields: {select: 'text', table: 'text', where: 'integer', default: 'text', references: 'text', primary: 'text'},
};

/** The keywords `RESERVED` is built from, so a case can name what it covers. */
export const RESERVED_WORDS: readonly string[] = [
	'order',
	'group',
	'index',
	'select',
	'table',
	'where',
	'default',
	'references',
	'primary',
];

/** What every factory is handed. A backend may not pick and choose among them. */
export const CONFORMANCE_ENTITIES: readonly EntityDeclaration[] = [TOKEN, PLAYER, CELL, PLACEMENT, RESERVED];

/**
 * A declaration that some engine might not be able to store, and the write that
 * proves it did.
 *
 * These are the audited edges of the identifier rule: names with a legal SHAPE
 * that nonetheless strain a particular backend. The case they feed asserts the
 * property rather than the outcome -- refused when the store is CONSTRUCTED, or
 * stored and read back correctly, and never accepted-then-fatal-at-`migrate()`
 * -- so a backend is free to refuse one and free to accept it, and is not free
 * to discover it late.
 */
export type DeclarationProbe = {
	/** The strained shape, as a noun phrase: it becomes the case's name. */
	readonly shape: string;
	readonly declarations: readonly EntityDeclaration[];
	/** Written and read back, if the factory accepted the declarations. */
	readonly write: Mutation;
	readonly read: {readonly entity: string; readonly id: Record<string, string | number>};
	readonly expect: Record<string, unknown>;
};

/** Long enough to be unreasonable, short enough to read in a failure message. */
const LONG = `long${'x'.repeat(196)}`;

function probeRow(entity: string, idColumn: string, field: string): DeclarationProbe['write'] {
	return {type: 'upsert', entity, id: {[idColumn]: 'k'}, values: {[field]: 'v'}};
}

/**
 * The audited edges, one probe each. Extending this list is how a newly
 * discovered engine limit becomes every backend's problem at once.
 */
export const DECLARATION_PROBES: readonly DeclarationProbe[] = [
	{
		// SQLite reserves every schema-object name beginning with `sqlite_` for
		// itself and refuses it however it is quoted, so this one is genuinely an
		// engine's limit: `@etherfold/state-store-sqlite` refuses it when the store
		// is constructed, and the other backends store it.
		shape: 'an entity name in an engine-internal namespace (`sqlite_`)',
		declarations: [{name: 'sqlite_thing', id: ['id'], fields: {owner: 'text'}}],
		write: probeRow('sqlite_thing', 'id', 'owner'),
		read: {entity: 'sqlite_thing', id: {id: 'k'}},
		expect: {owner: 'v'},
	},
	{
		// the other direction of the same probe, and the failure that is just as
		// visible to an author: a `sqlite_` COLUMN is legal in SQLite, so a backend
		// refusing one would be narrowing the seam for no engine reason.
		shape: 'a `sqlite_` column name, which SQLite itself allows',
		declarations: [{name: 'strained', id: ['sqlite_key'], fields: {sqlite_value: 'text'}}],
		write: probeRow('strained', 'sqlite_key', 'sqlite_value'),
		read: {entity: 'strained', id: {sqlite_key: 'k'}},
		expect: {sqlite_value: 'v'},
	},
	{
		// audited and left legal: no backend imposes an identifier length (SQLite
		// stores a 2,000-character table name and its indexes without complaint,
		// and the others hold names as ordinary JS strings), so the seam does not
		// invent one. This probe is what would notice a backend that does.
		shape: 'a 200-character entity name',
		declarations: [{name: LONG, id: ['id'], fields: {owner: 'text'}}],
		write: probeRow(LONG, 'id', 'owner'),
		read: {entity: LONG, id: {id: 'k'}},
		expect: {owner: 'v'},
	},
	{
		// the same, at the other two levels: the original report was an id COLUMN.
		shape: 'a 200-character id column and field',
		declarations: [{name: 'strained', id: [`${LONG}Key`], fields: {[`${LONG}Field`]: 'text'}}],
		write: probeRow('strained', `${LONG}Key`, `${LONG}Field`),
		read: {entity: 'strained', id: {[`${LONG}Key`]: 'k'}},
		expect: {[`${LONG}Field`]: 'v'},
	},
	{
		// a backend's OWN derived names are part of the space a declaration draws
		// from: an index and a table share one namespace in SQLite, so `token` and
		// `token_open` used to be fatal at migrate() there and two ordinary
		// entities everywhere else. Fixed by construction rather than refused.
		shape: "an entity named like another entity's derived index (`token` + `token_open`)",
		declarations: [TOKEN, {name: 'token_open', id: ['id'], fields: {owner: 'text'}}],
		write: probeRow('token_open', 'id', 'owner'),
		read: {entity: 'token_open', id: {id: 'k'}},
		expect: {owner: 'v'},
	},
];

/**
 * The block the ladder cases start from, and the span they cover.
 *
 * A store that claims a window shorter than the span cannot be asked these
 * questions at all: its own claim says the oldest rung is already gone. The
 * suite asks it what it claims (see `answersHistoryOverLadder`) rather than
 * failing it for a window it never promised.
 */
export const LADDER_BASE = 100;
export const LADDER_SPAN = 8;

export function block(
	number: number,
	hash = `0x${number.toString(16)}`,
	timestamp = 1_700_000_000 + number * 12,
): BlockPointer {
	return {number, hash, timestamp};
}

export function owns(id: string, owner: string, transferCount: number): Mutation {
	return {type: 'upsert', entity: 'token', id: {id}, values: {owner, transferCount}};
}

export function burn(id: string): Mutation {
	return {type: 'delete', entity: 'token', id: {id}};
}

/** One child of one parent: `{epoch}` is the prefix a listing asks about. */
export function placed(epoch: number, position: number, playerIndex: number, player: string): Mutation {
	return {type: 'upsert', entity: 'placement', id: {epoch, position, playerIndex}, values: {player}};
}

/** One row of `RESERVED`, written through columns that are all SQL keywords. */
export function ordered(group: string, index: number, select: string): Mutation {
	return {
		type: 'upsert',
		entity: 'order',
		id: {group, index},
		values: {select, table: 'ledger', where: index, default: 'none', references: group, primary: `${group}/${index}`},
	};
}

/**
 * A row's own columns, sorted, without the version columns a store adds.
 *
 * The `_` namespace belongs to the store (see the identifier rules at the seam),
 * and what a backend keeps in it is its own business: a versioned-rows backend
 * hands back `_lower` / `_upper` and a patch-log backend has neither. Dropping
 * them is what lets a case compare the SHAPE of two rows across backends, and
 * across the block boundary that used to change it.
 */
export function declaredColumns(row: Record<string, unknown> | undefined): string[] {
	return Object.keys(row ?? {})
		.filter((column) => !column.startsWith('_'))
		.sort();
}

/** The `player` of each listed child, which is enough to name it and see its order. */
export function playersOf(rows: readonly Record<string, unknown>[]): unknown[] {
	return rows.map((row) => row.player);
}

/** A store from the factory, migrated, exactly as a caller would get one. */
export async function opened(factory: StateStoreFactory): Promise<StateStoreBackend> {
	const store = await factory(CONFORMANCE_ENTITIES);
	await store.migrate();
	return store;
}

/**
 * The read-then-add-then-write accumulator, applied as one block.
 *
 * Written through `createMutationContext` rather than as a literal mutation
 * because that is the shape of the bug: the counter's next value is a function
 * of the value the store currently reports, so a store whose revert leaves the
 * old value standing keeps the points a reorged-out block gave it.
 */
export async function award(
	store: StateStoreBackend,
	at: BlockPointer,
	address: string,
	points: number,
): Promise<void> {
	const {state, mutations} = createMutationContext(store);
	const player = await state.get<{computedPoints: number | null}>('player', {address});
	state.set('player', {address}, {computedPoints: (player?.computedPoints ?? 0) + points});
	await store.applyBlock(at, mutations());
}

/** What `player` currently reports, as a plain number a case can compare. */
export async function pointsOf(store: StateStore, address: string): Promise<number | undefined> {
	const player = await store.getCurrent<{computedPoints: number}>('player', {address});
	return player?.computedPoints;
}

/** Turns `{name: run}` into cases, so a case reads like the `it` it becomes. */
export function cases(group: string, entries: Record<string, () => Promise<void>>): ConformanceCase[] {
	return Object.entries(entries).map(([name, run]) => ({group, name, run}));
}

/**
 * How many blocks behind its tip the store CLAIMS it can answer about.
 *
 * `0` for a store that answers no historical read at all. This is the only
 * question the suite asks of the report before choosing what to test, and it is
 * asked rather than assumed: testing a backend against a capability it never
 * claimed would fail honest backends, and testing it against less than it
 * claimed is what lets a claim be fiction.
 */
export function claimedDepth(capabilities: StateStoreCapabilities): number {
	if (!capabilities.asOf) return 0;
	switch (capabilities.retention.kind) {
		case 'revert-only':
			return 0;
		case 'window':
			return capabilities.retention.blocks;
		case 'unbounded':
			return Number.POSITIVE_INFINITY;
	}
}

/** Whether the store claims enough history for the ladder cases to be fair. */
export function answersHistoryOverLadder(capabilities: StateStoreCapabilities): boolean {
	return claimedDepth(capabilities) >= LADDER_SPAN;
}
