import {generationDigestOf} from '@etherfold/core';
import type {EnvRecord} from '@etherfold/fetcher-host';
import type {RemoteSQL} from 'remote-sql';
import {resolveCommandConfig} from './config.js';
import {heldGenerationsIn} from './readTier.js';
import type {Options, ServeConfig} from './types.js';

/** What a `startServer` call gives back, narrowed to what this command reads off it. */
export type StartedServer = {url: string; port: number; db: RemoteSQL};

export type ServeDependencies = {
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: EnvRecord;
	/** Starts the read tier. Defaults to the Node platform adapter's `startServer`, imported lazily. */
	startServer?: (options: {db: string; port: number; hostname?: string; autoSetup: boolean}) => Promise<StartedServer>;
	/** Where the startup lines go. Defaults to the console. */
	log?: (...args: unknown[]) => void;
};

/**
 * `etherfold serve`: resolve the read tier's row of the table, then start it.
 *
 * ## Why the database is passed EXPLICITLY, always
 *
 * `platforms/nodejs` defaults its own database to `DB` in the environment and
 * then to `file:./etherfold.db`, which is the right shape for an adapter a
 * program embeds and the wrong one for a COMMAND: a `serve` that quietly created
 * an empty database file nobody named is a read tier answering, healthily, about
 * nothing. So the CLI resolves the database itself -- `--db` first, `DB` behind
 * it, a refusal naming both when neither is there -- and hands the answer over,
 * which is what keeps that convenience default unreachable from any command.
 *
 * ## It RESOLVES THE CANONICAL POINTER, and that is the whole of what it holds
 *
 * A generation's state is a table-name NAMESPACE and a named indexer IS a
 * database (ADR-0053), so a read over an etherfold database is two steps: which
 * generation answers, then that generation's tables. A read tier holds no
 * processor and cannot fold, but it can and must do the first step -- otherwise
 * it names whatever tables it guessed at, which after a promotion is the
 * generation that stopped answering. So this command reads the pointer out of the
 * database it was pointed at and SAYS which generation answers, beside the URL it
 * is listening on; `canonicalGenerationIn` (`readTier.ts`) is the same resolution
 * a reader over that database performs per read.
 *
 * It needs no NAME to do it, which is why `--indexer` stays refused here
 * (ADR-0048): the rows carry the discriminator and one database is one named
 * indexer, so the read tier LEARNS the name instead of being told it. And it
 * REGISTERS nothing -- no `getIndexer`, no cursor reporter -- so the write path
 * stays a capability it does not have (`501`) and `/status` still carries no
 * `cursor` field, which is correct rather than missing: only the process that
 * OWNS a store can read one.
 *
 * A database that answers nothing yet is reported as exactly that and never
 * refused: an operator starting the read tier before its writer's first build has
 * registered anything is ordinary, and it will answer the moment one does
 * (ADR-0058 is what keeps that from being served as an empty page).
 */
export async function serve(options: Options, deps: ServeDependencies = {}): Promise<void> {
	const config: ServeConfig = resolveCommandConfig('serve', options, deps.env ?? (process.env as EnvRecord));
	const start = deps.startServer ?? defaultStartServer;
	const log = deps.log ?? console.log;

	const running = await start({
		db: config.destination.db,
		port: config.serving.port,
		...(config.serving.hostname === undefined ? {} : {hostname: config.serving.hostname}),
		autoSetup: config.serving.autoSetup,
	});
	log(`etherfold server listening on ${running.url}`);
	log(`  status: ${running.url}/status`);
	log(`  ${await answeringFrom(running.db, config.destination.db)}`);
}

/**
 * WHICH GENERATION ANSWERS READS over this database, in one line an operator can
 * match against a feed response or the admin listing.
 *
 * Every failure degrades to a sentence, deliberately, and none of them stops the
 * read tier coming up: an unmigrated database, an unreachable one and one nothing
 * has folded into yet are all things a read tier legitimately meets before its
 * writer exists, and refusing to listen would turn "the writer is not up yet"
 * into an outage of the tier that is meant to be up first.
 */
async function answeringFrom(db: RemoteSQL, describedAs: string): Promise<string> {
	try {
		const held = await heldGenerationsIn(db);
		const answering = held.filter((entry) => entry.canonical);
		if (answering.length === 0) {
			return (
				`no generation answers reads in ${describedAs} yet: nothing has registered one, so a read here has no ` +
				`state table to name (ADR-0053). It answers as soon as a writer does.`
			);
		}
		return answering
			.map(
				(entry) =>
					`answering from the generation ${generationDigestOf(entry.canonical!)} of the named indexer ` +
					`${JSON.stringify(entry.indexer)} (${entry.generations.length} held)`,
			)
			.join('\n  ');
	} catch (err) {
		return (
			`could not read which generation answers reads in ${describedAs}: ` +
			`${err instanceof Error ? err.message : String(err)}`
		);
	}
}

async function defaultStartServer(options: {
	db: string;
	port: number;
	hostname?: string;
	autoSetup: boolean;
}): Promise<StartedServer> {
	// Imported lazily so that `etherfold build` never pays for the server's
	// dependency tree (hono, libSQL, the node HTTP adapter). The one-shot
	// indexing path is the common one and it should stay cheap to start.
	const {startServer} = await import('@etherfold/platform-nodejs');
	return startServer(options);
}
