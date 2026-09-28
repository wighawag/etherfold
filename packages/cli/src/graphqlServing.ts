import type {GenerationId} from '@etherfold/core';
import type {EntityProcessor} from '@etherfold/processor-entities';
import type {GraphQLServing} from '@etherfold/server';
import type {EntityDeclaration, RetentionSetting} from '@etherfold/state-store';
import {loadProcessorArtifact} from '@etherfold/utils';
import type {RemoteSQL} from 'remote-sql';

// ---------------------------------------------------------------------------------------------------
// WHAT `/graphql` IS TOLD BY A NODE COMMAND (ADR-0099)
// ---------------------------------------------------------------------------------------------------
// The server reads WHICH generation answers, and its state, from the database.
// What a table cannot say is which declarations it was created from (a `u256` and
// a plain blob are both BLOBs), so the command answers that from the one place
// every generation keeps its code: the bundle stored beside its state (ADR-0092),
// through the same loader every arrival goes through. That is the same answer
// `etherfold publish` reads a snapshot's columns with, so `serve`, `run` and `node`
// build the schema from what the generation IS, including after a
// promotion or a revert to a generation this process was not started with.
// ---------------------------------------------------------------------------------------------------

/** The entity declarations a generation's stored bundle carries, or why there are none. */
export type StoredDeclarations =
	| {readonly ok: true; readonly entities: readonly EntityDeclaration[]}
	| {readonly ok: false; readonly why: string};

/**
 * THE DECLARATIONS OF A GENERATION, read from `bundle` when given, else from the
 * bundle its registry row stores (ADR-0092). Loaded lazily from the server
 * package, which a command that never opens a database must not pay for.
 */
export async function declarationsOfStoredBundle(
	db: RemoteSQL,
	indexer: string,
	id: GenerationId,
	bundle?: Uint8Array,
): Promise<StoredDeclarations> {
	const {readGenerationBundle} = await import('@etherfold/server');
	const stored = bundle ?? (await readGenerationBundle(db, indexer, id));
	if (stored === undefined) {
		return {
			ok: false,
			why:
				`the generation's processor ${id.processor} stores no bundle beside its state, so there is nothing to ` +
				`read its entity declarations from`,
		};
	}
	const outcome = await loadProcessorArtifact<any, unknown, EntityProcessor<any, any>>(stored);
	if (outcome.status === 'refused') {
		return {
			ok: false,
			why:
				`the bundle of the generation (${outcome.identity}) could not be instantiated to read its entity ` +
				`declarations: ${outcome.reason}, ${outcome.why}`,
		};
	}
	return {ok: true, entities: outcome.processor.entities};
}

/**
 * `/graphql`'s capability for a Node command: declarations from the stored bundle,
 * and the retention THIS command enforces on the database, so the query surface
 * claims what the writer keeps. A read tier (`serve`) folds nothing and is told no
 * retention, so it passes none (`unbounded`).
 */
export function graphqlServing(
	retention: {readonly retention?: RetentionSetting; readonly finalityDepth?: number} = {},
): GraphQLServing<any> {
	return {
		declarationsOf: async ({db, indexer, id}) => {
			const read = await declarationsOfStoredBundle(db, indexer, id);
			if (!read.ok) throw new Error(read.why);
			return read.entities;
		},
		...(retention.retention === undefined ? {} : {retention: retention.retention}),
		...(retention.finalityDepth === undefined ? {} : {finalityDepth: retention.finalityDepth}),
	};
}
