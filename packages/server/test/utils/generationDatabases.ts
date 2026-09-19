import type {GenerationId} from '@etherfold/core';
import {parseStoredCursor, SYNC_CURSOR_KEY} from '@etherfold/processor-sqlite';
import {createClient} from '@libsql/client';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';

// ---------------------------------------------------------------------------
// WHERE EACH GENERATION'S STATE LIVES, AND HOW FAR THE FOLD IN IT GOT
// ---------------------------------------------------------------------------
// A HOST decides where a generation's state lives, which is why the registry
// takes both halves of that fact as INJECTED seams (`dropState` and
// `readStateCursor`, `GenerationRegistryPort`): it must not fork a naming
// convention it does not own. These suites take the cheapest thing that is
// honestly per generation -- a database of its own -- so this is that host's
// bookkeeping: which database each identity's fold landed in, and the one row in
// it that says how far that fold got.
//
// The READ is what the promotion trigger compares, and it deliberately involves
// NO ENGINE: it is a `SELECT` against the generation's own `_cursor` table, so a
// process that holds no fold for a generation -- which is every redeployed
// process, since the old processor's code is not in the build -- can still ask
// where that generation is. Nothing here retains, re-imports or reconstructs a
// processor.
// ---------------------------------------------------------------------------

/** The memo's key. NUL is producible by neither half of the identity. */
const keyOf = (id: GenerationId) => `${id.stream}\u0000${id.processor}`;

/** The per-generation databases one host owns, and the position it can read out of each. */
export type GenerationDatabases = {
	/** The database this identity's fold folds into, created on first ask. */
	open(id: GenerationId): RemoteSQL;
	/** `GenerationRegistryPort.readStateCursor` for this host: `lastToBlock`, or nothing readable. */
	readStateCursor(id: GenerationId): Promise<number | undefined>;
};

export function generationDatabases(): GenerationDatabases {
	const databases = new Map<string, RemoteSQL>();
	return {
		open(id) {
			const key = keyOf(id);
			let db = databases.get(key);
			if (!db) {
				db = new RemoteLibSQL(createClient({url: ':memory:'}));
				databases.set(key, db);
			}
			return db;
		},
		async readStateCursor(id) {
			const db = databases.get(keyOf(id));
			if (!db) return undefined;
			try {
				const rows = await db
					.prepare(`SELECT "value" AS value FROM _cursor WHERE "key" = ?1 LIMIT 1`)
					.bind(SYNC_CURSOR_KEY)
					.all<{value: string}>();
				// `undefined` is the honest answer before the first block lands, and it must
				// never become a zero: "has folded nothing" and "level at block 0" are
				// different facts, and the trigger compares them.
				return parseStoredCursor(rows.results[0]?.value)?.lastToBlock;
			} catch {
				// A store that has not been migrated has no such table yet, which is the same
				// answer: nothing readable.
				return undefined;
			}
		},
	};
}
