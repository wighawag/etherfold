import type {EnvRecord} from '@etherfold/fetcher-host';
import type {EntityProcessor} from '@etherfold/processor-entities';
import type {ProducedPublication, PublicationIndex} from '@etherfold/server';
import {loadProcessorArtifact, processorArtifactIdentity} from '@etherfold/utils';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RemoteSQL} from 'remote-sql';
import {refuseUnbundledProcessor, resolveCommandConfig} from './config.js';
import {streamConfigFor} from './folding.js';
import type {Options, PublishConfig} from './types.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold publish`: WRITE A DATABASE OUT AS WHAT A BROWSER APP STARTS FROM (ADR-0095)
// ---------------------------------------------------------------------------------------------------
// A THIN WRAPPER. What is published -- which generation, where it is cut, the rows,
// the resume position, the body's content-addressed name and the index entry -- is
// `producePublication`'s (`@etherfold/server`), a library function a serving host
// can answer over HTTP from the same database. What is HERE is what only a process
// with a disk does: resolve the command's inputs, open the database READ-ONLY in
// intent (it applies no schema and opens no registry, because opening a registry
// sweeps, which is a write), find the entity declarations the generation's tables
// were made from, and lay the result out in `--out`.
//
// ## The LAYOUT, and the order it is written in
//
//  - every BODY under its content-hash name, never overwritten: a name already on
//    disk is the same bytes and is left alone;
//  - the PUBLICATION INDEX (`publication.json`) LAST, merged with the one already
//    there so this publication replaces only its own generation's entry;
//  - each file written beside its final name and RENAMED into place, so a reader
//    never sees half a file, and the index's rename is the last filesystem
//    operation of the whole publication: no reader sees an index naming a body
//    that is not on disk.
//
// Nothing an earlier publication wrote is deleted, ever: pruning a publication is
// an operator's explicit act (ADR-0095).
// ---------------------------------------------------------------------------------------------------

/**
 * THE FILESYSTEM A PUBLICATION IS WRITTEN THROUGH: the five operations it makes,
 * and nothing that deletes.
 *
 * An interface so a test can RECORD the order they are made in, which is the
 * property the layout rests on (the index renamed into place last).
 */
export type PublicationFiles = {
	/** The file's text, or nothing where there is no file. */
	readText(path: string): Promise<string | undefined>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	write(path: string, bytes: Uint8Array | string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
};

/** The real disk. */
export const nodePublicationFiles: PublicationFiles = {
	async readText(path) {
		try {
			return await readFile(path, 'utf-8');
		} catch (err) {
			if ((err as {code?: string}).code === 'ENOENT') return undefined;
			throw err;
		}
	},
	async exists(path) {
		try {
			await stat(path);
			return true;
		} catch (err) {
			if ((err as {code?: string}).code === 'ENOENT') return false;
			throw err;
		}
	},
	async mkdir(path) {
		await mkdir(path, {recursive: true});
	},
	async write(path, bytes) {
		// `wx`: a temporary name is this publication's alone, and never an existing file
		await writeFile(path, bytes, {flag: 'wx'});
	},
	async rename(from, to) {
		await rename(from, to);
	},
};

/** What a publication wrote, as data a caller reports. */
export type WrittenPublication = {
	readonly out: string;
	readonly produced: ProducedPublication;
	/** The path of the index, which was written last. */
	readonly index: string;
	/** Each body, and whether THIS publication wrote it (false: the same bytes were already there). */
	readonly bodies: readonly {readonly name: string; readonly contentHash: string; readonly written: boolean}[];
};

/** What a test substitutes for the world; a deployment supplies none of it. */
export type PublishDependencies = {
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: EnvRecord;
	/** Opens the database. Defaults to the Node platform's libSQL handle. */
	createDB?: (url: string) => RemoteSQL;
	/** The filesystem the publication is written through. Defaults to the real one. */
	files?: PublicationFiles;
	/** Working directory a relative `-p` resolves against. Defaults to `process.cwd()`. */
	cwd?: string;
	/** When the snapshot says it was produced. Defaults to now. */
	savedAt?: string;
};

/**
 * PUBLISH ONE DATABASE into `--out`, and say what was written.
 *
 * Throws on every refusal -- a configuration one, a `-p` that names no bundle, a
 * database with no canonical generation, one whose canonical generation folded
 * nothing up to the cut or is not the processor given with `-p`, an index in
 * `--out` it cannot read -- and every one of them is thrown BEFORE the first file
 * is written.
 */
export async function publish(options: Options, deps: PublishDependencies = {}): Promise<WrittenPublication> {
	const env = deps.env ?? (process.env as EnvRecord);
	const config: PublishConfig = resolveCommandConfig('publish', options, env);
	const files = deps.files ?? nodePublicationFiles;

	// the bundle this publication is MEANT to be of, read and judged by the one check
	// every `--processor` goes through; its hash is the identity the canonical
	// generation must have (ADR-0086)
	const expected =
		config.processor === undefined
			? undefined
			: await (async () => {
					const bundle = (await refuseUnbundledProcessor(
						'publish',
						config.processor as string,
						deps.cwd === undefined ? {} : {cwd: deps.cwd},
					)) as Uint8Array;
					return {bundle, identity: processorArtifactIdentity(bundle)};
				})();

	const server = await import('@etherfold/server');
	const db = await openPublishedDatabase(config.destination.db, deps.createDB);
	const produced = await server.producePublication(db, {
		stream: streamConfigFor(env),
		...(expected === undefined ? {} : {expectedProcessor: expected.identity}),
		...(deps.savedAt === undefined ? {} : {savedAt: deps.savedAt}),
		// WHICH COLUMNS the generation's tables have is its processor's declaration, and
		// the processor is its BUNDLE: the one given with `-p` (whose identity was just
		// checked to BE the generation's), or else the one the generation stores beside
		// its state (ADR-0092), through the same loader every arrival goes through.
		declarationsOf: async ({id, indexer}) => {
			const bundle = expected?.bundle ?? (await server.readGenerationBundle(db, indexer, id));
			if (bundle === undefined) {
				throw new server.PublicationRefusedError(
					'no-declarations',
					`the canonical generation's processor ${id.processor} stores no bundle beside its state, so there is ` +
						`nothing to read its entity declarations from. Give the bundle it was folded with as -p.`,
				);
			}
			const outcome = await loadProcessorArtifact<any, unknown, EntityProcessor<any, any>>(bundle);
			if (outcome.status === 'refused') {
				throw new server.PublicationRefusedError(
					'no-declarations',
					`the bundle of the canonical generation (${outcome.identity}) could not be instantiated to read its ` +
						`entity declarations: ${outcome.reason}, ${outcome.why}`,
				);
			}
			return outcome.processor.entities;
		},
	});

	return writePublication(config.out, produced, files, server);
}

/**
 * LAY A PRODUCED PUBLICATION OUT IN A DIRECTORY: the bodies first, the index last.
 *
 * The existing index is read and checked BEFORE anything is written, so an index
 * this build cannot read refuses the publication with nothing on disk changed.
 */
export async function writePublication(
	out: string,
	produced: ProducedPublication,
	files: PublicationFiles,
	server: Pick<
		typeof import('@etherfold/server'),
		'parsePublicationIndex' | 'mergePublicationIndex' | 'PUBLICATION_INDEX_NAME'
	>,
): Promise<WrittenPublication> {
	const indexPath = join(out, server.PUBLICATION_INDEX_NAME);
	const existingText = await files.readText(indexPath);
	const existing: PublicationIndex | undefined =
		existingText === undefined ? undefined : server.parsePublicationIndex(existingText);
	const merged = server.mergePublicationIndex(existing, produced.entries);

	await files.mkdir(out);
	const bodies: {name: string; contentHash: string; written: boolean}[] = [];
	for (const body of produced.bodies) {
		const path = join(out, body.name);
		// content-addressed: a name already on disk IS these bytes, and is never overwritten
		if (await files.exists(path)) {
			bodies.push({name: body.name, contentHash: body.contentHash, written: false});
			continue;
		}
		const temporary = temporaryBeside(path);
		await files.write(temporary, body.bytes);
		await files.rename(temporary, path);
		bodies.push({name: body.name, contentHash: body.contentHash, written: true});
	}

	// LAST: the rename of the index is the final operation of the publication
	const temporary = temporaryBeside(indexPath);
	await files.write(temporary, `${JSON.stringify(merged, null, '\t')}\n`);
	await files.rename(temporary, indexPath);

	return {out, produced, index: indexPath, bodies};
}

/** A name beside `path` that is this write's alone, in the same directory so the rename is atomic. */
function temporaryBeside(path: string): string {
	return `${path}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
}

/**
 * The database, opened for reading. A `file:` URL naming no file is REFUSED rather
 * than opened, because opening one would CREATE an empty database nobody named.
 */
async function openPublishedDatabase(url: string, createDB?: (url: string) => RemoteSQL): Promise<RemoteSQL> {
	if (createDB) return createDB(url);
	const path = localPathOf(url);
	if (path !== undefined && !existsSync(path)) {
		throw new Error(
			`--db ${JSON.stringify(url)} names no file, so there is no database to publish. \`etherfold publish\` ` +
				`reads a database \`build\`, \`run\` or \`index\` wrote, and it does not create one.`,
		);
	}
	const {createNodeDB} = await import('@etherfold/platform-nodejs');
	return createNodeDB(url);
}

/** The local path a libSQL `file:` URL names, or nothing for any other kind of URL. */
function localPathOf(url: string): string | undefined {
	if (!url.startsWith('file:')) return undefined;
	try {
		return url.startsWith('file://') ? fileURLToPath(url) : url.slice('file:'.length);
	} catch {
		return url.slice('file:'.length);
	}
}

/**
 * THE PUBLICATION IN WORDS, one `key: value` per line so a CI log can be grepped,
 * including the body's content hash, which a release may pin.
 */
export function describePublication(written: WrittenPublication): string[] {
	const {produced} = written;
	return [
		`etherfold publish: PUBLISHED the canonical generation ${produced.digest} into ${written.out}.`,
		`generation: ${produced.digest}`,
		`  stream: ${produced.generation.stream}`,
		`  processor: ${produced.generation.processor}`,
		`indexer: ${produced.indexer}`,
		`cut: ${produced.cut} (folded through ${produced.tip}, finality ${produced.finality})`,
		`takenAt: ${produced.head.takenAt.number} (${produced.head.takenAt.hash})`,
		`history: none (floor ${produced.head.floor})`,
		...written.bodies.flatMap((body) => [
			`body: ${join(written.out, body.name)}${body.written ? '' : ' (already there, left as it was)'}`,
			`  contentHash: ${body.contentHash}`,
		]),
		`index: ${written.index}`,
	];
}

/**
 * THE PROCESS: publish, print, and resolve the exit code. `0` when the publication
 * was written; `1` on every refusal, printed as its message to stderr, with
 * nothing written.
 */
export async function publishMain(
	options: Options,
	deps: PublishDependencies & {
		exit?: (code: number) => void;
		log?: (...args: unknown[]) => void;
		error?: (...args: unknown[]) => void;
	} = {},
): Promise<void> {
	const exit = deps.exit ?? ((code: number) => process.exit(code));
	const log = deps.log ?? console.log;
	const error = deps.error ?? console.error;

	let written: WrittenPublication;
	try {
		written = await publish(options, deps);
	} catch (err) {
		error(err instanceof Error ? err.message : err);
		exit(1);
		return;
	}
	for (const line of describePublication(written)) log(line);
	exit(0);
}
