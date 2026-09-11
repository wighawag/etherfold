import type {RemoteSQL} from 'remote-sql';
import db from './schema/ts/db.sql.js';

/**
 * WHICH SHAPE of the fixed schema this build was written against.
 *
 * It exists for one scenario, and that scenario is entirely FORWARD: the two
 * paths that bring a database to this shape are not both ours. `applySchema`
 * runs `schema/sql/db.sql` from the code, and wrangler's D1 migrations execute
 * that file and NOTHING else, so a deployed server can meet a database some
 * other build's SQL created. The status route reports the value it FINDS stored
 * against the value this build EXPECTS, and a disagreement makes the server say
 * so at `/status` instead of failing later at a random query.
 *
 * That is why the number is worth having with no history behind it, and why the
 * row lives in the SQL rather than being written by the code that applies it
 * (see the note beside it in `db.sql`: when the version was recorded in
 * TypeScript, a D1-migrated database came up with the table present and no
 * version row, and reported itself unhealthy forever).
 *
 * **It is 1, and it stays 1 until this repository has published a build.** The
 * schema has changed several times in this repository's git history -- the
 * reserved `_` namespace, the generation registry, the stream coverage claim --
 * and this number narrated those changes as a ladder up to 4. It was a ladder
 * for databases that do not exist: nothing is published, so no database anywhere
 * was ever created by an earlier build, and a reader met three paragraphs of
 * migration notes describing upgrades nothing could ever perform. What survives
 * is the MECHANISM, which does not need a history to be useful.
 *
 * **Bump it when `db.sql` changes in a way an existing database has to be told
 * about**, and keep the row in `db.sql` in step (a test asserts they agree).
 * Note the one case that is NOT a bump, because it is stronger than one: a
 * change that renames or removes `_meta` itself leaves an older database with no
 * row for this to read at all, which reports `applied: false` rather than a
 * number mismatch. No database can hold a `_meta` row this build did not write,
 * so a version found there is unambiguous.
 */
export const SCHEMA_VERSION = 1;

const SCHEMA_VERSION_KEY = 'schemaVersion';

/**
 * The fixed-table DDL this build ships, one statement per entry. Idempotent:
 * the table is `IF NOT EXISTS` and the version row is an upsert.
 *
 * Comments are stripped BEFORE splitting on `;`, which is not fussiness: a
 * semicolon inside a `--` comment otherwise cuts the following statement in
 * half, and the resulting fragment fails at runtime with a syntax error
 * pointing at a word from the prose. (The house template never hit this because
 * its schema is a single statement with no comments.)
 *
 * Known limitation, acceptable because this file is ours and fixed: a `--`
 * inside a string literal would be treated as a comment.
 */
export const schemaStatements: string[] = db
	.replace(/--[^\n]*/g, '')
	.split(';')
	.map((s) => s.trim())
	.filter((s) => s.length > 0);

/**
 * Apply the fixed-table schema and record the version.
 *
 * ONLY the fixed tables. Entity tables belong to the versioned-row store and are
 * created dynamically from a processor's declared entities, so they cannot be
 * expressed as static SQL and are deliberately absent here.
 */
export async function applySchema(db: RemoteSQL): Promise<void> {
	for (const statement of schemaStatements) {
		await db.prepare(statement).all();
	}
}

export type SchemaState =
	| {applied: true; version: number; expected: number; matches: boolean}
	| {applied: false; reason: string};

/**
 * What the status route needs: whether the fixed schema is there at all, and if
 * so whether it is the version this build was written against.
 *
 * Returns a value rather than throwing, because "the schema is missing" is the
 * NORMAL state of a fresh database and the whole point of asking.
 */
export async function readSchemaState(db: RemoteSQL): Promise<SchemaState> {
	try {
		const result = await db.prepare(`SELECT value FROM _meta WHERE key = ?1`).bind(SCHEMA_VERSION_KEY).all();
		const row = result.results[0] as {value?: string} | undefined;
		if (!row?.value) {
			return {applied: false, reason: 'no schemaVersion recorded in _meta'};
		}
		const version = Number(row.value);
		return {applied: true, version, expected: SCHEMA_VERSION, matches: version === SCHEMA_VERSION};
	} catch (err) {
		return {applied: false, reason: err instanceof Error ? err.message : String(err)};
	}
}
