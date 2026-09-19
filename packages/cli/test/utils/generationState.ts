import {generationDigestOf, type GenerationId} from '@etherfold/core';
import {localPosition, type EntityDeclaration} from '@etherfold/processor-entities';
import type {SQLGenerationRegistryOptions} from '@etherfold/server';
import {VersionedStateStore} from '@etherfold/state-store-sqlite';
import type {RemoteSQL} from 'remote-sql';

// ---------------------------------------------------------------------------
// THE TWO STATE SEAMS A CLI-SHAPED HOST SUPPLIES, in one place
// ---------------------------------------------------------------------------
// A generation's state is a TABLE NAMESPACE named from its identity (ADR-0053),
// and the registry deliberately does not know that convention: whoever named the
// tables supplies both operations over them. `openFolding` (`src/folding.ts`)
// does exactly this for a real deployment; this is the same pair for the suites
// that stand a container up over a bare database.
//
//  - **dropState** -- deleting a generation is a `DROP` of its namespace.
//  - **readStateCursor** -- how far the fold in that namespace got, read with NO
//    ENGINE. It is what the promotion trigger compares, and it must work for a
//    generation the asking process holds no fold for, which is every process
//    restarted with a changed processor: the previous processor's code is not in
//    the build, so a fold for the incumbent is unbuildable by construction.
//
// The store is built UNCLAIMED, which is load-bearing rather than incidental:
// `openForWriting` would take the writer claim away from the fold that is
// writing into that namespace (ADR-0077), and reading a position must never cost
// a fold its claim.
// ---------------------------------------------------------------------------

/** Both seams over one database, under the namespace convention `openFolding` uses. */
export function generationStateSeamsOn(
	db: RemoteSQL,
	entities: readonly EntityDeclaration[],
): Required<Pick<SQLGenerationRegistryOptions, 'dropState' | 'readStateCursor'>> {
	const stateFor = (id: GenerationId) =>
		new VersionedStateStore(db, entities, {tableNamespace: generationDigestOf(id)});
	return {
		dropState: async (id) => {
			await stateFor(id).drop();
		},
		readStateCursor: (id) => localPosition(stateFor(id)),
	};
}
