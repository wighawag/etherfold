import {canonicalStateNamespaceIn} from '../../src/index.js';
import type {EntityDeclaration} from '@etherfold/state-store';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import type {RemoteSQL} from 'remote-sql';

// ---------------------------------------------------------------------------------------------------
// HOW A TEST READS WHAT A COMMAND FOLDED: THROUGH THE CANONICAL POINTER
// ---------------------------------------------------------------------------------------------------
// A generation's state is a TABLE-NAME NAMESPACE inside the database and a named
// indexer IS the database (ADR-0053), so naming a table is two steps and never
// one: resolve the pointer, then open the namespace it names. That is what
// `etherfold serve` does to say which generation answers, and it is what a reader
// over a `run`, `build` or `index` database does per read -- so a test that
// opened the un-namespaced tables instead would be asserting against a shape no
// deployment produces.
//
// It is the CLI's own resolution (`canonicalStateNamespaceIn`) rather than a
// second copy of it here: a helper that guessed the namespace could agree with a
// bug in the thing it is meant to check.
// ---------------------------------------------------------------------------------------------------

/**
 * The state store the CANONICAL generation of this database folds into, opened
 * over the declarations that produced it.
 *
 * Throws where nothing answers reads yet, which in a test is always the signal
 * that the command under test registered no generation -- never a state to read
 * around.
 */
export async function canonicalStoreIn(
	db: RemoteSQL,
	entities: readonly EntityDeclaration[],
	options: {indexer?: string} = {},
): Promise<VersionedStateStore> {
	const namespace = await canonicalStateNamespaceIn(db, options);
	if (namespace === undefined) {
		throw new Error(`no generation answers reads in this database: nothing registered one`);
	}
	return new VersionedStateStore(db, entities, {tableNamespace: namespace});
}
