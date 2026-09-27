import {
	generationDigestOf,
	isPublicationIndex,
	PUBLICATION_INDEX_FORMAT,
	PUBLICATION_INDEX_NAME,
	storedStreamOf,
	streamConfigHashOf,
	streamDigestOfSourceHashes,
	streamSeedContentHash,
	streamSeedPayloadOf,
	resolveStreamConfig,
	STREAM_SEED_FORMAT,
	type Abi,
	type GenerationId,
	type LastSync,
	type LogEvent,
	type ProvidedStreamConfig,
	type PublicationIndex,
	type PublishedStateSnapshot,
	type PublishedStreamSeed,
	type StoredLogEvent,
	type StreamSeed,
	type StreamSeedCoverage,
	type UsedStreamConfig,
} from '@etherfold/core';
import {
	parseStoredCursor,
	serializeLastSync,
	syncedThrough,
	SYNC_CURSOR_KEY,
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
import {readStreamCoverage} from './emissions.js';
import {generationRegistryPortOnSQL, readHeldGenerations} from './generations.js';
import {storedEmissionReplaySource} from './streamReader.js';

// ---------------------------------------------------------------------------------------------------
// WHAT A BUILD PUBLISHES, PRODUCED FROM THE DATABASE IT WROTE (ADR-0095)
// ---------------------------------------------------------------------------------------------------
// A browser app often cannot index from its contracts' start block, so it starts
// from a PUBLISHED artifact. This module is the producer of one: given a database
// any folding command wrote (`build`, `run`, `index`), it answers the STATE
// SNAPSHOT of the canonical generation, as a format-2 body named by its content
// hash, and the PUBLICATION INDEX entry that names it; and, when asked
// (`seed: true`), the STREAM SEED of the stream that generation folds, cut at the
// same block, keyed in the index by stream digest. It writes nothing: what
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

// THE INDEX DOCUMENT ITSELF is `@etherfold/core`'s (`publication.ts`), because a
// browser tab reads what this module writes and one contract has one definition.
// Re-exported so this package's surface still names everything its producer answers.
export {PUBLICATION_INDEX_FORMAT, PUBLICATION_INDEX_NAME};
export type {PublicationIndex, PublishedStateSnapshot, PublishedStreamSeed};

/** What a publication asked for a seed (`seed: true`) says about the one it produced. */
export type ProducedStreamSeed = {
	/** The stream digest, which a client recomputes and compares before installing (ADR-0064). */
	readonly streamDigest: string;
	/** The content hash a release PINS (ADR-0065, ADR-0066). */
	readonly contentHash: string;
	readonly coverage: StreamSeedCoverage;
	readonly events: number;
	/** The body's file name. */
	readonly body: string;
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
	/** The stream seed, when one was asked for (`seed: true`); its body is among `bodies`. */
	readonly seed?: ProducedStreamSeed;
	/** Every body to write. Write them BEFORE the index that names them. */
	readonly bodies: readonly PublicationBody[];
	/**
	 * The index entries this publication REPLACES (its own generation's snapshot and,
	 * when a seed was asked for, its own stream's seed) and adds.
	 */
	readonly entries: Pick<PublicationIndex, 'snapshots' | 'seeds'>;
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
	| 'history-not-retained'
	/** A seed was asked for and the database stores no stream for the canonical generation that reaches the cut. */
	| 'no-stored-stream'
	/**
	 * A seed was asked for and the database does not record the stream's full source
	 * identity (the per-event hash entries a tab's digest check recomputes, ADR-0095),
	 * or what it records does not digest to the canonical generation's stream.
	 */
	| 'no-stream-identity';

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
	/**
	 * Whether to publish a STREAM SEED as well (ADR-0095): the stream the canonical
	 * generation folds, as the database stores it (`_emissions`), cut at the same
	 * block as the state snapshot. OFF by default, because under a never-delete
	 * layout a scheduled job would otherwise store a full copy of a long stream on
	 * every run. Asked for and impossible (nothing stored reaches the cut), it is
	 * refused (`no-stored-stream`) rather than silently left out.
	 */
	readonly seed?: boolean;
	/**
	 * How many stored emissions one read of the stored stream asks for while the
	 * seed is produced (the replay source's budget, ADR-0056). Defaults to 10,000; a
	 * host whose backend caps the rows one request may read sets it lower.
	 */
	readonly seedReadBudget?: number;
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

	const seeded =
		options.seed === true
			? await produceStreamSeed(db, {
					indexer,
					generation,
					streamConfig,
					tip,
					cut,
					readBudget: options.seedReadBudget ?? SEED_READ_BUDGET,
					// the chain time of the block the rows are as of: when the events up to the
					// cut were produced, and a value two publications of one cut agree on
					producedAt: new Date(produced.head.takenAt.timestamp * 1000).toISOString(),
				})
			: undefined;

	return {
		indexer,
		generation,
		digest,
		tip,
		finality,
		cut,
		history,
		head: produced.head,
		...(seeded === undefined ? {} : {seed: seeded.seed}),
		bodies: seeded === undefined ? [body] : [body, seeded.body],
		entries: {
			...(seeded === undefined
				? {}
				: {
						seeds: {
							[seeded.seed.streamDigest]: {
								stream: seeded.seed.streamDigest,
								body: seeded.body.name,
								contentHash: seeded.seed.contentHash,
								coverage: seeded.seed.coverage,
								events: seeded.seed.events,
								savedAt: produced.head.savedAt,
							},
						},
					}),
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
 * The file name of a stream seed body: derived from its content hash, as a state
 * snapshot's is, and ending `.json.gz` because a seed is ONE gzipped JSON
 * document (the reference artifact's convention).
 */
export function streamSeedBodyName(contentHash: string): string {
	return `seed-${contentHash.replace(/^sha256:/, '')}.json.gz`;
}

/** How many stored emissions one read of the replay source asks for while a seed is produced. */
const SEED_READ_BUDGET = 10_000;

/**
 * THE STREAM SEED OF THE CANONICAL GENERATION'S STREAM, cut at the state
 * snapshot's cut (ADR-0095).
 *
 * The events are the stored stream (`_emissions`) read back through the SAME
 * bounded replay source a rebuild folds (`storedEmissionReplaySource`), from the
 * stream's own start block up to the cut, and reduced by core's one strip
 * (`storedStreamOf`, ADR-0060). The envelope, digest and content hash are core's
 * (`StreamSeed`, `streamDigestOfSourceHashes`, `streamSeedContentHash`), so what
 * this writes is exactly what `installStreamSeed` reads and checks.
 *
 * ## What is carried, field by field
 *
 *  - `coverage`: the stream's `startBlock` (so a client reading from its source's
 *    first block is reached back to) up to the CUT (above the last event, so the
 *    quiet blocks up to it are not re-scanned; ADR-0063).
 *  - `chainHeadAtCapture`: the block the generation folded through, which the cut
 *    is `finality` below, so the install's capture-depth check holds by
 *    construction (ADR-0065).
 *  - `context`: the stream's full source hash entries, as the fold recorded them
 *    beside its coverage claim (`StreamCoverage.source`), and the config hash
 *    (checked against the generation's cursor), with the processor empty as every
 *    stream context is. Installed verbatim, so a tab's load compares itself with
 *    the publisher; the digest a client recomputes from it is ASSERTED here to be
 *    the canonical generation's stream before anything is produced.
 *  - `producer`: `stored-stream`, dated by `producedAt` (when the events were
 *    produced, not when the file is written, so an unchanged cut republishes the
 *    same bytes).
 *
 * ## The seed is the COMPACTED stream (ADR-0095)
 *
 * The stored stream is append-only and keeps a reorg's apply/retract pairs until
 * pair-compaction reclaims them (ADR-0006). Everything in a seed is at or below
 * the cut, so final: no retraction of it can still arrive, and every matched
 * pair is dropped, leaving exactly the final chain. Answer-preserving by the
 * argument compaction rests on, and it is what keeps the install's coherence
 * check strict (the replacement branch of a reorg sits at the height of the one
 * it replaced, and a seed carrying both is refused for two block hashes at one
 * height). It also makes the seed a function of the CHAIN rather than of one
 * producer's reorg history, so two producers of one chain and cut publish the
 * same bytes under the same pinnable content hash (ADR-0065).
 */
async function produceStreamSeed(
	db: RemoteSQL,
	at: {
		readonly indexer: string;
		readonly generation: GenerationId;
		readonly streamConfig: UsedStreamConfig;
		readonly tip: number;
		readonly cut: number;
		readonly readBudget: number;
		readonly producedAt: string;
	},
): Promise<{seed: ProducedStreamSeed; body: PublicationBody}> {
	const {indexer, generation, streamConfig, tip, cut} = at;
	const stream = generation.stream;
	const coverage = await readStreamCoverage(db, {indexer, stream});
	if (!coverage || coverage.lastToBlock < cut) {
		throw new PublicationRefusedError(
			'no-stored-stream',
			`a stream seed was asked for, and this database stores ${
				coverage
					? `the stream ${stream} of the named indexer ${JSON.stringify(indexer)} only up to block ${coverage.lastToBlock}, below the cut ${cut}`
					: `no stream ${stream} for the named indexer ${JSON.stringify(indexer)}`
			}, so there is no stream to seed from. A seed is the stream the canonical generation folds as the database ` +
				`stores it; publish without --seed to publish the state snapshot alone.`,
		);
	}
	// The identity a client recomputes is the stream's own SOURCE HASH ENTRIES, which
	// the fold records beside the coverage claim (`StreamCoverage.source`, ADR-0095),
	// and not the generation cursor's context: that one is the 32-bit whole-source
	// WIRE context (`wireContextOf`), which carries no per-event stream hashes and so
	// digests to no stream a client can reach.
	const sourceHashes = [...coverage.source];
	if (sourceHashes.some((entry) => entry.streamHash === undefined)) {
		throw new PublicationRefusedError(
			'no-stream-identity',
			`a stream seed was asked for, and this database does not record the full source identity of the stream ` +
				`${stream} of the named indexer ${JSON.stringify(indexer)}: its coverage claim carries ` +
				`${JSON.stringify(sourceHashes)}, with no per-event stream hashes, which a database folded before the ` +
				`source identity was recorded (ADR-0095) holds. A seed's identity is recomputed by every tab from exactly ` +
				`those entries, so none can be built from it. Fold the database again with this version, or publish ` +
				`without --seed to publish the state snapshot alone.`,
		);
	}
	const streamDigest = streamDigestOfSourceHashes(sourceHashes, streamConfig);
	if (streamDigest !== stream) {
		throw new PublicationRefusedError(
			'no-stream-identity',
			`the canonical generation is filed under the stream ${stream}, and the source identity its database records ` +
				`digests to ${streamDigest}, so a seed of it would claim a stream identity no client of that generation ` +
				`matches. Nothing was written.`,
		);
	}

	const events = dropRetractedPairs(
		await readStoredStreamUpTo(db, indexer, stream, coverage.startBlock, cut, at.readBudget),
	);
	const seed: StreamSeed = {
		format: STREAM_SEED_FORMAT,
		producer: {
			kind: 'stored-stream',
			name: `etherfold publish --seed (the stored stream of the named indexer ${JSON.stringify(indexer)})`,
			at: at.producedAt,
		},
		chainHeadAtCapture: tip,
		streamConfig,
		streamDigest,
		coverage: {fromBlock: coverage.startBlock, toBlock: cut},
		context: {source: sourceHashes, config: streamConfigHashOf(streamConfig), processor: ''},
		eventStream: events,
	};

	const payload = streamSeedPayloadOf(seed);
	const contentHash = streamSeedContentHash(payload);
	const name = streamSeedBodyName(contentHash);
	return {
		seed: {streamDigest, contentHash, coverage: seed.coverage, events: events.length, body: name},
		body: {name, contentHash, bytes: await gzip(payload)},
	};
}

/**
 * Every stored emission of `[fromBlock, cut]`, in `seq` order, retractions
 * included: the replay source's chunks, walked until one reaches the cut.
 */
async function readStoredStreamUpTo(
	db: RemoteSQL,
	indexer: string,
	stream: string,
	fromBlock: number,
	cut: number,
	budget: number,
): Promise<StoredLogEvent[]> {
	const source = storedEmissionReplaySource<Abi>(db, indexer);
	const events: StoredLogEvent[] = [];
	let from = fromBlock;
	while (from <= cut) {
		const read = await source.readChunk({stream, fromBlock: from, foldedThrough: from - 1, maxEmissions: budget});
		if (read.status !== 'chunk') {
			throw new PublicationRefusedError(
				'no-stored-stream',
				`the stored stream ${stream} could not be read from block ${from} (${read.status}${
					'reason' in read ? `: ${read.reason}` : ''
				}), so no seed of it was produced. Nothing was written.`,
			);
		}
		const inRange = (read.eventStream as LogEvent<Abi>[]).filter((event) => event.blockNumber <= cut);
		events.push(...storedStreamOf(inRange));
		if (read.lastToBlock >= cut || !read.truncated) break;
		from = read.lastToBlock + 1;
	}
	return events;
}

/**
 * The stream with every application that a LATER retraction takes back removed,
 * together with that retraction: what pair-compaction would leave (ADR-0006).
 * A retraction with no application before it is kept, so a damaged stream is
 * refused by the install rather than repaired here.
 */
function dropRetractedPairs(events: readonly StoredLogEvent[]): StoredLogEvent[] {
	const dropped = new Set<number>();
	const standing = new Map<string, number>();
	events.forEach((event, position) => {
		const coordinate = `${event.blockHash}:${event.logIndex}`;
		if (!event.removed) {
			standing.set(coordinate, position);
			return;
		}
		const applied = standing.get(coordinate);
		if (applied === undefined) return;
		standing.delete(coordinate);
		dropped.add(applied).add(position);
	});
	return events.filter((_, position) => !dropped.has(position));
}

/** The platform's gzip, over one payload. Platform-agnostic: `CompressionStream` is on every runtime this ships to. */
async function gzip(payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	const compressed = new Blob([payload as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
	return new Uint8Array(await new Response(compressed).arrayBuffer());
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
	if (!isPublicationIndex(parsed)) {
		const candidate = parsed as {format?: unknown} | undefined;
		throw new PublicationRefusedError(
			'unreadable-index',
			`the existing ${PUBLICATION_INDEX_NAME} is not a publication index of format ${PUBLICATION_INDEX_FORMAT} ` +
				`(${candidate && typeof candidate === 'object' && 'format' in candidate ? `its format is ${JSON.stringify(candidate.format)}` : 'it does not parse as one'}), ` +
				`so nothing was written: rewriting it would forget every entry it names, and a publication never ` +
				`forgets one. Move it aside, or publish into another directory.`,
		);
	}
	return parsed;
}

/**
 * THE INDEX AFTER A PUBLICATION: the existing one with THIS publication's entries
 * replacing only their own keys, and every other entry (and every key this build
 * does not know) kept.
 */
export function mergePublicationIndex(
	existing: PublicationIndex | undefined,
	entries: Pick<PublicationIndex, 'snapshots' | 'seeds'>,
): PublicationIndex {
	const seeds =
		existing?.seeds === undefined && entries.seeds === undefined ? undefined : {...existing?.seeds, ...entries.seeds};
	return {
		...existing,
		format: PUBLICATION_INDEX_FORMAT,
		snapshots: {...existing?.snapshots, ...entries.snapshots},
		...(seeds === undefined ? {} : {seeds}),
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
