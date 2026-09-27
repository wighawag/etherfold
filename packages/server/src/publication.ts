import {
	generationDigestOf,
	streamConfigHashOf,
	resolveStreamConfig,
	type Abi,
	type GenerationId,
	type LastSync,
	type ProvidedStreamConfig,
} from '@etherfold/core';
import {
	parseStoredCursor,
	serializeLastSync,
	syncedThrough,
	SYNC_CURSOR_KEY,
	type BlockPointer,
	type EntityDeclaration,
	type SnapshotHead,
} from '@etherfold/processor-entities';
import {
	HistoryNotRetainedError,
	produceStateSnapshot,
	VersionedStateStore,
	type SnapshotHistory,
} from '@etherfold/state-store-sqlite';
import type {RemoteSQL} from 'remote-sql';
import {generationRegistryPortOnSQL, readHeldGenerations} from './generations.js';

// ---------------------------------------------------------------------------------------------------
// WHAT A BUILD PUBLISHES, PRODUCED FROM THE DATABASE IT WROTE (ADR-0095)
// ---------------------------------------------------------------------------------------------------
// A browser app often cannot index from its contracts' start block, so it starts
// from a PUBLISHED artifact. This module is the producer of one: given a database
// any folding command wrote (`build`, `run`, `index`), it answers the STATE
// SNAPSHOT of the canonical generation, as a format-2 body named by its content
// hash, and the PUBLICATION INDEX entry that names it. It writes nothing: what
// comes back is bytes and entries, and where they go is the caller's (the CLI's
// `etherfold publish` writes them to a directory, and a serving host can answer
// the same value over HTTP).
//
// It lives HERE, beside the tables it reads, because this package owns the
// generation registry and the stored stream: which generation is canonical is a
// question only these rows answer. The ROW read is the SQLite backend's
// (`produceStateSnapshot` over `liveRowsAsOf`, `@etherfold/state-store-sqlite`),
// which also applies ADR-0095's pointer rule, and the CURSOR codec is the entity
// processor's (`@etherfold/processor-entities`), so neither is restated here.
//
// ## The CUT, and the resume position written for it
//
// The snapshot is taken at `tip - finality`, where `tip` is the block the
// canonical generation has folded through (its cursor's `lastToBlock`) and
// `finality` is the resolved finality of the stream config the database was
// folded under: a snapshot inside the reorg window could not absorb a reorg
// reaching under it. The rows are the as-of read at the cut, pointed at the
// highest RECORDED block at or below it, and the resume position is the stored
// cursor NARROWED to the cut by the engine's one narrowing rule
// (`cursorSyncedThrough`): `lastToBlock` becomes the cut, the unconfirmed window
// keeps only the blocks at or below it, and `latestBlock` (the tip that was
// observed) is kept. So a consumer resumes at `getFromBlock` = the cut itself
// when the fold was level (`latestBlock - finality` is the cut), re-reads it, and
// recognises it by membership of the window if it carried logs -- no block
// skipped and none applied twice.
// ---------------------------------------------------------------------------------------------------

/** The name of the publication index inside a publication (ADR-0095). Deliberately not a "head". */
export const PUBLICATION_INDEX_NAME = 'publication.json';

/**
 * The version of the publication index DOCUMENT.
 *
 * An index of another format is refused rather than rewritten: rewriting it would
 * forget the entries this build cannot read, and the whole point of the index is
 * that nothing a publication named is forgotten.
 */
export const PUBLICATION_INDEX_FORMAT = 1;

/**
 * ONE STATE SNAPSHOT a publication names: the latest one published for ONE
 * generation, keyed in the index by that generation's digest.
 *
 * Carries the generation's two halves apart (`stream`, `processor`) so a tab can
 * find the entry for its own processor on ANOTHER stream and say why it cannot use
 * it, rather than silently finding nothing.
 */
export type PublishedStateSnapshot = {
	/** The stream digest of the generation that computed the rows: its source and stream config. */
	readonly stream: string;
	/** The processor identity of that generation (ADR-0086): the SHA-256 of its bundle's bytes. */
	readonly processor: string;
	/** The body's file name, relative to the index. Content-addressed, so it never changes. */
	readonly body: string;
	/** `sha256:<hex>` over the DECOMPRESSED document, as ADR-0066 defines a content hash. */
	readonly contentHash: string;
	/** The block the rows are AS OF: the highest recorded block at or below the cut. */
	readonly takenAt: BlockPointer;
	/**
	 * The history floor the installed store reports: the body carries the rows live
	 * at it and every later block's changes up to `takenAt`. Equal to
	 * `takenAt.number` for history `none`.
	 */
	readonly floor: number;
	/** The cut: `tip - finality`, and the `lastToBlock` of the resume position the body carries. */
	readonly cut: number;
	/** When it was produced. Informational. */
	readonly savedAt: string;
};

/**
 * THE PUBLICATION INDEX (`publication.json`): the latest state snapshot PER
 * GENERATION, keyed by `generationDigestOf`.
 *
 * Entries are never removed: an OLD build of an app runs the old processor and
 * finds the last snapshot of its own generation here, stale but valid (ADR-0095).
 * Keys this build does not know (a later task's stream seeds) are carried through
 * a republication untouched.
 */
export type PublicationIndex = {
	readonly format: number;
	readonly snapshots: Readonly<Record<string, PublishedStateSnapshot>>;
};

/** One immutable body a publication writes: its content-addressed name and its bytes. */
export type PublicationBody = {
	readonly name: string;
	readonly contentHash: string;
	/** The gzipped format-2 document, exactly as it is to be served. */
	readonly bytes: Uint8Array<ArrayBuffer>;
};

/** What `producePublication` answers: the bodies to write, and the index entries that name them. */
export type ProducedPublication = {
	/** The named indexer whose canonical generation this is. */
	readonly indexer: string;
	/** The canonical generation published. */
	readonly generation: GenerationId;
	/** Its digest: the key of its index entry. */
	readonly digest: string;
	/** The block the fold had reached, the finality subtracted from it, and the cut. */
	readonly tip: number;
	readonly finality: number;
	readonly cut: number;
	/** The history the snapshot was asked to carry below the cut. */
	readonly history: SnapshotHistory;
	/** The snapshot's head: the first line of its body. */
	readonly head: SnapshotHead;
	/** Every body to write. Write them BEFORE the index that names them. */
	readonly bodies: readonly PublicationBody[];
	/** The index entries this publication REPLACES (its own generation's) and adds. */
	readonly entries: Pick<PublicationIndex, 'snapshots'>;
};

/** Why a publication was refused. Data, so a caller can branch; the message says it in words. */
export type PublicationRefusalReason =
	/** The database carries no generation registry at all, or it names no canonical generation. */
	| 'no-canonical-generation'
	/** The database holds several named indexers and none was named. */
	| 'several-indexers'
	/** The canonical generation has folded nothing at or below the cut. */
	| 'folded-nothing'
	/** The canonical generation is not the processor the caller expected to publish. */
	| 'processor-mismatch'
	/** The stream config given is not the one the canonical generation was folded under. */
	| 'stream-config-mismatch'
	/** The entity declarations to read the generation's tables with could not be had. */
	| 'no-declarations'
	/** An existing publication index cannot be read, so rewriting it would forget its entries. */
	| 'unreadable-index'
	/** The history asked for reaches below what the database retains: its versions there were pruned. */
	| 'history-not-retained';

/** A publication this producer will not make. Nothing was written when it is thrown. */
export class PublicationRefusedError extends Error {
	readonly name = 'PublicationRefusedError';

	constructor(
		readonly reason: PublicationRefusalReason,
		message: string,
	) {
		super(message);
	}
}

export type ProducePublicationOptions = {
	/**
	 * The stream config the database was folded under (on the CLI, `STREAM_FINALITY`
	 * from the environment, exactly as the folding commands read it). Its resolved
	 * `finality` is what the cut subtracts, and its hash must be the one the
	 * canonical generation's cursor carries: a finality this generation was not
	 * folded under would put the cut somewhere its reorg window does not protect.
	 */
	readonly stream?: ProvidedStreamConfig;
	/**
	 * The processor identity the caller means to publish. When given, a canonical
	 * generation that is ANOTHER processor is refused, naming both: `build`'s final
	 * promotion is fail-soft, and without this a failed promotion would publish the
	 * old processor while the app ships the new bundle.
	 */
	readonly expectedProcessor?: string;
	/**
	 * The named indexer to publish, where a database holds several. On every shape
	 * this repository builds one database is one named indexer, and it is learned
	 * from the rows.
	 */
	readonly indexer?: string;
	/**
	 * The entity declarations the canonical generation's tables were created from.
	 *
	 * Asked for rather than guessed, because a column's TYPE is not recoverable from
	 * a table (a `bigint` and a `text` are both TEXT): the caller answers from the
	 * processor it holds, or from the bundle the generation stores beside its state
	 * (ADR-0092, `readGenerationBundle`). Called only after the generation was
	 * resolved and the expected processor checked.
	 */
	readonly declarationsOf: (generation: {
		readonly id: GenerationId;
		readonly indexer: string;
	}) => Promise<Iterable<EntityDeclaration>>;
	/**
	 * How much history the snapshot carries below the cut (ADR-0095): `'none'` (the
	 * default) puts its floor at the cut, a depth `N` puts it `N` blocks below, and
	 * `'all'` at the first block the generation recorded. A floor below what the
	 * database retains is refused (`history-not-retained`), naming both blocks,
	 * rather than silently raised.
	 */
	readonly history?: SnapshotHistory;
	readonly savedAt?: string;
};

/**
 * THE BUNDLE A GENERATION STORES BESIDE ITS STATE (ADR-0092), or nothing where its
 * row holds none. A read of one column; it opens no registry and sweeps nothing.
 */
export async function readGenerationBundle(
	db: RemoteSQL,
	indexer: string,
	id: GenerationId,
): Promise<Uint8Array | undefined> {
	return generationRegistryPortOnSQL(db, indexer).readBundle(id);
}

/**
 * PRODUCE THE PUBLICATION OF A DATABASE'S CANONICAL GENERATION: a format-2 state
 * snapshot at `tip - finality`, carrying the history asked for (`none` by
 * default), and the index entry naming it.
 *
 * A pure READ of the database: it opens no registry (opening one sweeps, which is
 * a write), claims no store and writes no file. Refuses, with a
 * `PublicationRefusedError` naming why, a database with no canonical generation, a
 * canonical generation that is not `expectedProcessor`, a stream config the
 * generation was not folded under, a generation that has folded nothing up to
 * the cut, and a history reaching below what the database retains.
 */
export async function producePublication(
	db: RemoteSQL,
	options: ProducePublicationOptions,
): Promise<ProducedPublication> {
	const {indexer, generation} = await canonicalOf(db, options.indexer);

	if (options.expectedProcessor !== undefined && options.expectedProcessor !== generation.processor) {
		throw new PublicationRefusedError(
			'processor-mismatch',
			`the canonical generation of the named indexer ${JSON.stringify(indexer)} is the processor ` +
				`${generation.processor}, and the processor to publish is ${options.expectedProcessor}. Publishing it would ` +
				`label an app's snapshot with a fold that app does not run, so every tab running ` +
				`${options.expectedProcessor} would find no entry for itself. A \`build\` whose final promotion failed ` +
				`(it is fail-soft) leaves exactly this: re-run the build, or publish the processor that IS canonical.`,
		);
	}

	const declarations = [...(await options.declarationsOf({id: generation, indexer}))];
	const store = new VersionedStateStore(db, declarations, {tableNamespace: generationDigestOf(generation)});

	const stored = await readCursorOf(store);
	if (stored === undefined) {
		throw foldedNothing(generation, indexer, 'it has no cursor: nothing was ever folded into it');
	}

	const streamConfig = resolveStreamConfig(options.stream);
	const configHash = streamConfigHashOf(streamConfig);
	if (stored.context.config !== configHash) {
		throw new PublicationRefusedError(
			'stream-config-mismatch',
			`the canonical generation ${generationDigestOf(generation)} was folded under another stream config than ` +
				`the one given here (finality ${streamConfig.finality}): its cursor carries the config hash ` +
				`${stored.context.config}, and this config hashes to ${configHash}. The cut is \`tip - finality\` under ` +
				`the finality the generation was folded with, so publish with the same stream settings the database ` +
				`was built with (STREAM_FINALITY).`,
		);
	}

	const finality = streamConfig.finality;
	const tip = stored.lastToBlock;
	const cut = tip - finality;
	const pointer = cut < 0 ? undefined : await store.getBlockAtOrBelow(cut);
	if (!pointer) {
		throw foldedNothing(
			generation,
			indexer,
			`it has folded through block ${tip}, the cut is ${cut} (${finality} blocks of finality below that), and it ` +
				`recorded no block at or below the cut`,
		);
	}

	const resume: LastSync<Abi> = syncedThrough(stored, cut);
	const history = options.history ?? 'none';
	let produced: Awaited<ReturnType<typeof produceStateSnapshot>>;
	try {
		produced = await produceStateSnapshot(store, {
			at: cut,
			processor: generation.processor,
			history,
			cursor: {key: SYNC_CURSOR_KEY, value: serializeLastSync(resume)},
			...(options.savedAt === undefined ? {} : {savedAt: options.savedAt}),
		});
	} catch (err) {
		if (err instanceof HistoryNotRetainedError) {
			throw new PublicationRefusedError('history-not-retained', err.message);
		}
		throw err;
	}
	const bytes = new Uint8Array(await new Response(produced.document).arrayBuffer());
	const contentHash = await contentHashOf(bytes);
	const body: PublicationBody = {name: stateSnapshotBodyName(contentHash), contentHash, bytes};
	const digest = generationDigestOf(generation);

	return {
		indexer,
		generation,
		digest,
		tip,
		finality,
		cut,
		history,
		head: produced.head,
		bodies: [body],
		entries: {
			snapshots: {
				[digest]: {
					stream: generation.stream,
					processor: generation.processor,
					body: body.name,
					contentHash,
					takenAt: produced.head.takenAt,
					floor: produced.head.floor,
					cut,
					savedAt: produced.head.savedAt,
				},
			},
		},
	};
}

/**
 * The file name of a state snapshot body: derived from its content hash, so two
 * publications never write one path unless they are the same bytes.
 */
export function stateSnapshotBodyName(contentHash: string): string {
	return `state-${contentHash.replace(/^sha256:/, '')}.ndjson.gz`;
}

/**
 * READ AN EXISTING PUBLICATION INDEX, or refuse it.
 *
 * A document that is not an index of this format is REFUSED rather than replaced,
 * because replacing it would forget every entry it holds, and nothing an earlier
 * publication wrote may be forgotten (ADR-0095).
 */
export function parsePublicationIndex(text: string): PublicationIndex {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	const candidate = parsed as {format?: unknown; snapshots?: unknown} | undefined;
	if (
		!candidate ||
		typeof candidate !== 'object' ||
		Array.isArray(candidate) ||
		candidate.format !== PUBLICATION_INDEX_FORMAT ||
		!candidate.snapshots ||
		typeof candidate.snapshots !== 'object' ||
		Array.isArray(candidate.snapshots)
	) {
		throw new PublicationRefusedError(
			'unreadable-index',
			`the existing ${PUBLICATION_INDEX_NAME} is not a publication index of format ${PUBLICATION_INDEX_FORMAT} ` +
				`(${candidate && typeof candidate === 'object' && 'format' in candidate ? `its format is ${JSON.stringify(candidate.format)}` : 'it does not parse as one'}), ` +
				`so nothing was written: rewriting it would forget every entry it names, and a publication never ` +
				`forgets one. Move it aside, or publish into another directory.`,
		);
	}
	return candidate as PublicationIndex;
}

/**
 * THE INDEX AFTER A PUBLICATION: the existing one with THIS publication's entries
 * replacing only their own keys, and every other entry (and every key this build
 * does not know) kept.
 */
export function mergePublicationIndex(
	existing: PublicationIndex | undefined,
	entries: Pick<PublicationIndex, 'snapshots'>,
): PublicationIndex {
	return {
		...existing,
		format: PUBLICATION_INDEX_FORMAT,
		snapshots: {...existing?.snapshots, ...entries.snapshots},
	};
}

/** Which named indexer, and its canonical generation, or a refusal naming why there is none. */
async function canonicalOf(
	db: RemoteSQL,
	named: string | undefined,
): Promise<{indexer: string; generation: GenerationId}> {
	let held: Awaited<ReturnType<typeof readHeldGenerations>>;
	try {
		held = await readHeldGenerations(db);
	} catch (err) {
		throw new PublicationRefusedError(
			'no-canonical-generation',
			`this database has no generation registry to read (${err instanceof Error ? err.message : String(err)}), ` +
				`so no generation answers reads in it and there is nothing to publish. It is not a database \`build\`, ` +
				`\`run\` or \`index\` wrote.`,
		);
	}
	if (named === undefined && held.length > 1) {
		throw new PublicationRefusedError(
			'several-indexers',
			`this database holds the generations of ${held.length} named indexers ` +
				`(${held.map((entry) => JSON.stringify(entry.indexer)).join(', ')}), each with a canonical generation of ` +
				`its own, so which one to publish is a question about a NAME (ADR-0036).`,
		);
	}
	const entry = named === undefined ? held[0] : held.find((one) => one.indexer === named);
	if (!entry?.canonical) {
		throw new PublicationRefusedError(
			'no-canonical-generation',
			`no generation answers reads in this database${named === undefined ? '' : ` for the named indexer ${JSON.stringify(named)}`}: ` +
				`nothing has registered one, or nothing has been made canonical yet, so there is no state to publish.`,
		);
	}
	return {indexer: entry.indexer, generation: entry.canonical};
}

/**
 * The generation's stored cursor, or nothing where it has none -- including a
 * namespace whose tables were never created, which is a generation that folded
 * nothing rather than a database error.
 */
async function readCursorOf(store: VersionedStateStore): Promise<LastSync<Abi> | undefined> {
	try {
		return parseStoredCursor<Abi>(await store.readCursor(SYNC_CURSOR_KEY));
	} catch {
		return undefined;
	}
}

function foldedNothing(generation: GenerationId, indexer: string, why: string): PublicationRefusedError {
	return new PublicationRefusedError(
		'folded-nothing',
		`the canonical generation ${generationDigestOf(generation)} of the named indexer ${JSON.stringify(indexer)} has ` +
			`folded nothing up to the cut, so there is no state to publish: ${why}. A snapshot is cut at ` +
			`\`tip - finality\`, below the reorg window, so a database must have folded more than the finality depth ` +
			`past its first logs before it can be published.`,
	);
}

/** `sha256:<hex>` over the DECOMPRESSED document: transport-invariant, as ADR-0066 defines a content hash. */
async function contentHashOf(gzipped: Uint8Array<ArrayBuffer>): Promise<string> {
	const plain = await new Response(
		new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip')),
	).arrayBuffer();
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', plain));
	return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
