import {generationDigestOf, type GenerationId} from '@etherfold/core';
import type {HeldGenerations} from '@etherfold/server';
import type {RemoteSQL} from 'remote-sql';

// ---------------------------------------------------------------------------------------------------
// WHAT A READER RESOLVES BEFORE IT CAN NAME A TABLE
// ---------------------------------------------------------------------------------------------------
// A generation's state is a TABLE-NAME NAMESPACE inside one database and a named
// indexer IS a database (ADR-0053), so "read the state" is two steps on this
// runtime and never one: resolve the CANONICAL POINTER, then open the namespace
// it names. That is the read side of everything the generation model buys --
// a successor rebuilds into its own tables while the incumbent goes on answering,
// and the promotion is one small write nobody reading has to be told about.
//
// It holds no processor, folds nothing and REGISTERS nothing, which is what makes
// it the READ TIER's (`etherfold serve`) and equally a plain reader's over a
// database `run`, `build` or `index` wrote. And it is deliberately not
// `openGenerationRegistryOnSQL(...).canonical()`: OPENING the registry SWEEPS
// every stored stream no registered generation claims, which is a WRITE, and a
// read tier must not delete a stream on its way to asking which generation
// answers.
// ---------------------------------------------------------------------------------------------------

/** Which named indexer's rows to resolve through, where a database holds more than one. */
export type ReadTierOptions = {
	/**
	 * The NAMED INDEXER whose pointer to read.
	 *
	 * Optional, and on every shape this repo builds today it is absent: a named
	 * indexer IS a database, so the rows in one belong to one name and a reader
	 * learns that name from them rather than being told it. It is what
	 * `etherfold serve` has -- that command refuses `--indexer` outright (ADR-0048),
	 * folding nothing and routing nothing by name -- and it is here for the
	 * COLOCATED case the discriminator columns keep possible, where a reader must
	 * say which of several names it means.
	 */
	indexer?: string;
};

/**
 * Every named indexer whose generations this database holds, oldest generation
 * first, with the one that answers reads for each.
 *
 * Thin over `readHeldGenerations` (`@etherfold/server`, which OWNS those tables)
 * and lazily imported for the reason every other server import in this package is:
 * a command that never opens a database must not pay for the dependency tree.
 */
export async function heldGenerationsIn(db: RemoteSQL): Promise<HeldGenerations[]> {
	const {readHeldGenerations} = await import('@etherfold/server');
	return readHeldGenerations(db);
}

/**
 * WHICH GENERATION ANSWERS READS over this database, or nothing at all.
 *
 * `undefined` is a real answer and never an empty result: NOTHING ANSWERS READS
 * HERE YET, which is what a database a first build has not finished looks like,
 * and it is the distinction ADR-0058 makes a reader refuse on rather than serve
 * an empty page for.
 *
 * A database holding SEVERAL named indexers is refused rather than guessed at:
 * each name has its own pointer, so answering "the canonical generation" without
 * being told which name would be picking a tenant for the caller -- the one
 * failure the discriminator exists to make impossible (ADR-0036).
 */
export async function canonicalGenerationIn(
	db: RemoteSQL,
	options: ReadTierOptions = {},
): Promise<GenerationId | undefined> {
	const held = await heldGenerationsIn(db);
	if (options.indexer !== undefined) {
		return held.find((entry) => entry.indexer === options.indexer)?.canonical;
	}
	if (held.length > 1) {
		throw new Error(
			`this database holds the generations of ${held.length} named indexers (${held
				.map((entry) => JSON.stringify(entry.indexer))
				.join(', ')}), and each has a canonical pointer of its own, so which generation answers reads is a ` +
				`question about a NAME. Name one (ADR-0036): a named indexer IS a database (ADR-0053), so a colocated ` +
				`database is a deliberate arrangement rather than the default, and a reader of one has to say which ` +
				`tenant it means.`,
		);
	}
	return held[0]?.canonical;
}

/**
 * The TABLE-NAME NAMESPACE a read answers from: the canonical generation's own
 * (ADR-0053), or nothing where no generation answers reads yet.
 *
 * The value a reader hands to `VersionedStateStore`'s `tableNamespace`, which is
 * the whole of what resolving the pointer buys it.
 */
export async function canonicalStateNamespaceIn(
	db: RemoteSQL,
	options: ReadTierOptions = {},
): Promise<string | undefined> {
	const canonical = await canonicalGenerationIn(db, options);
	return canonical === undefined ? undefined : generationDigestOf(canonical);
}
