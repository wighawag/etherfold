import type {RemoteSQL} from 'remote-sql';
import db from './schema/ts/db.sql.js';

/**
 * Bumped by hand whenever `schema/sql/db.sql` changes in a way an existing
 * database has to be told about. The status route reports the value it finds
 * stored against the value this build expects, so a server running against a
 * database someone else migrated says so instead of failing later at a random
 * query.
 *
 * Renaming the fixed tables into the reserved `_` namespace was NOT such a
 * change, which is why this read 2 across it. The version row lives IN the table
 * that was renamed, so a database migrated by an older build has no `_meta` for
 * this to read and reports `applied: false` -- a stronger signal than a number
 * mismatch, and the correct one, since those tables really did change. No
 * database can hold a `_meta` row this build did not write, so a version there
 * is unambiguous.
 *
 * **3 adds the generation registry**: `_generations` and `_generation_pointer`,
 * the durable records and the canonical pointer a restarted server resolves
 * reads through. Both are `IF NOT EXISTS`, so applying this schema to a version-2
 * database creates them and moves the row; nothing already stored is touched.
 */
export const SCHEMA_VERSION = 3;

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
