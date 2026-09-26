import {Command, Option} from 'commander';
import type {EnvRecord} from '@etherfold/fetcher-host';
import pkg from '../package.json' with {type: 'json'};
import {INPUTS, OWNERSHIP, type ConfigInput} from './config.js';
import {fetchMain} from './fetch.js';
import {main} from './index.js';
import {indexMain} from './indexCommand.js';
import {nodeMain, runMain} from './run.js';
import {serve} from './serve.js';
import type {CommandName, Options} from './types.js';
import {uploadMain} from './uploadCommand.js';

/**
 * What `cli.ts` supplies and a test substitutes.
 *
 * The handlers are injected for the same reason `main`'s are (`src/index.ts`):
 * the interesting part of this layer is WHICH WORDS resolve and which flags they
 * carry, and asserting that should not require loading a processor module or
 * binding a port.
 */
export type ProgramDependencies = {
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: EnvRecord;
	/** Runs the one-shot. Defaults to `main`, which resolves the process exit code. */
	build?: (options: Options) => void;
	/** Runs the follower. Defaults to `runMain`, which keeps going until a signal and resolves the exit code. */
	run?: (options: Options) => void | Promise<void>;
	/**
	 * Runs the node that RECEIVES uploads. Defaults to `nodeMain`, which keeps going until a
	 * signal and resolves the exit code the way `runMain` does.
	 */
	node?: (options: Options) => void | Promise<void>;
	/** Runs the chain-facing half. Defaults to `fetchMain`, which also hooks the log sink to the console. */
	fetch?: (options: Options) => void | Promise<void>;
	/** Runs the receiving half. Defaults to `indexMain`, which keeps receiving until a signal and resolves the exit code. */
	index?: (options: Options) => void | Promise<void>;
	/** Starts the read tier. Defaults to `serve`, which resolves its database and starts the Node adapter. */
	serve?: (options: Options) => Promise<void>;
	/**
	 * Sends a bundle to a running node. Defaults to `uploadMain`, which resolves the exit
	 * code a pipeline reads: `0` on `registered` or `unchanged`, `1` on anything else.
	 * Handed the options with the positional `<bundle>` already folded in as `bundle`.
	 */
	upload?: (options: Options) => void | Promise<void>;
};

/**
 * Register every flag ONE command owns, and every flag it does not.
 *
 * Both halves come out of `OWNERSHIP` (`src/config.ts`), which is the single
 * table this command set's configuration is written in. What it owns is
 * registered visibly, with the description that table carries. What it does NOT
 * own is registered HIDDEN, so that a flag copied across from another command
 * parses, reaches the resolver, and is refused with the reason this command does
 * not own it -- instead of meeting commander's `unknown option`, which names
 * neither a reason nor the command that does own it. That is the whole payoff of
 * "moving between commands is a deployment change, never a rewrite": a copied
 * command line gets told what to change.
 *
 * Nothing is registered as `requiredOption` and nothing carries a commander
 * DEFAULT. Both would put a piece of the contract where no test can call it, and
 * a commander default is worse than that: a flag that is always present can never
 * fall back to the variable behind it, so `--port`'s old default silently made
 * `PORT` unreachable.
 */
function registerInputs(command: Command, name: CommandName): void {
	const row = OWNERSHIP[name];
	for (const input of Object.keys(INPUTS) as ConfigInput[]) {
		const spec = INPUTS[input];
		const described = spec.variable ? `${spec.describe} (or ${spec.variable})` : spec.describe;
		const option = new Option(spec.flag, described);
		if (row[input] === 'refused') option.hideHelp();
		command.addOption(option);
	}
}

/**
 * The command surface: six deployment intents, each of them meaning one thing,
 * plus `upload`, the one command that runs no deployment and is a CLIENT of one.
 *
 * `CONTEXT.md` ("The COMMAND SET names deployment intents, not components")
 * is the authority for the set, and all six ship: **`run`** follows the
 * chain, folds AND answers queries without terminating -- the milestone, and the
 * default thing to reach for -- folding exactly the processor its configuration
 * names; **`node`** is the same process configured with NO processor and NO
 * source, whose code arrives only by `etherfold upload` (ADR-0094); **`build`** is the same assembly stopping at the
 * tip; **`serve`** answers queries over a database written elsewhere; **`fetch`**
 * is the chain-facing half of a SPLIT deployment, which folds nothing, holds no
 * state and pushes to a receiver elsewhere -- the ONLY way to run a fetcher, now
 * that the standalone binary is retired; and **`index`** is the other half of
 * that pair, receiving those pushes and owning the database. Adding the last one
 * was a registration and an assembly rather than a second way to read a flag,
 * because every row of the table already resolved through one resolver
 * (`OWNERSHIP` in `src/config.ts`).
 *
 * **`upload`** is the seventh, and it is a different KIND of command: it sends an
 * already-built bundle to a running `node`'s `POST /{indexer}/admin/upload` and
 * exits, so deploying a processor is one command, the same on a laptop and in CI
 * (ADR-0085). It is not a deployment intent and does not re-open the argument that
 * kept the revert an HTTP route rather than a verb (ADR-0057's 2026-09-26
 * amendment): the revert has to reach a Worker, which only HTTP does, while an
 * upload is by construction something an author does FROM a machine with a CLI.
 *
 * ## Why there is no DEFAULT command any more
 *
 * There was one, and the reason it existed has expired. `index` was registered
 * with `isDefault: true` so that `etherfold -p x -n y` kept working after the
 * binary stopped being called `ei` (ADR-0017 renamed it; the default was the
 * argument that the rename should not ALSO cost users their argument order).
 * The name is changing anyway here, nothing is published, and under a set of
 * names chosen so a reader can tell what a process will do, a bare invocation
 * that silently means one of the six is exactly the ambiguity the set exists
 * to remove. So a bare `etherfold` prints help and every run names its intent.
 */
export function createProgram(deps: ProgramDependencies = {}): Command {
	const env = deps.env ?? (process.env as EnvRecord);
	const runBuild =
		deps.build ??
		((options: Options) => {
			// `main` resolves the exit code: 0 on success, 1 on failure (so CI does not treat a failed
			// build as success). It calls `process.exit`, which also avoids the process lingering on
			// provider timers.
			main(options, {env});
		});
	const runServe = deps.serve ?? ((options: Options) => serve(options, {env}));
	const runFollower =
		deps.run ??
		((options: Options) => {
			// `runMain` resolves the exit code the same way `main` does, and for the same
			// reason: a follower that stopped on a refusal no waiting fixes must not look
			// like one that was asked to stop.
			return runMain(options, {env});
		});

	const program = new Command();

	program.name('etherfold').version(pkg.version).description('Index EVM logs into state, from a terminal');

	const run = program
		.command('run')
		.description(
			'follow the chain, fold the processor its configuration names into a libSQL database, and answer queries ' +
				'over it. It receives no code: a node whose processors arrive by `etherfold upload` is `etherfold node`',
		)
		.usage(`-p <processor's path> --store sqlite --db <libsql url> [--port 2000 -n http://localhost:8545]`);
	registerInputs(run, 'run');
	run.action(async (options: Options) => {
		await runFollower(options);
	});

	const runNode =
		deps.node ??
		((options: Options) => {
			// resolves the exit code exactly as `runMain` does, for the same reason
			return nodeMain(options, {env});
		});

	const nodeCommand = program
		.command('node')
		.description(
			'follow the chain, fold whatever processor is UPLOADED to it (`etherfold upload`) into a libSQL database, ' +
				'and answer queries over it. It takes no processor and no source: it WAITS for its first upload, and ' +
				'each upload carries its own contracts (ADR-0094)',
		)
		.usage('--store sqlite --db <libsql url> [--port 2000 -n http://localhost:8545 --indexer <name>]');
	registerInputs(nodeCommand, 'node');
	nodeCommand.action(async (options: Options) => {
		await runNode(options);
	});

	const build = program
		.command('build')
		.description('follow the chain, fold a processor into a libSQL database, and exit at the tip')
		.usage(`-p <processor's path> --store sqlite --db <libsql url> [-d <deployment folder> -n http://localhost:8545]`);
	registerInputs(build, 'build');
	build.action((options: Options) => {
		runBuild(options);
	});

	const runFetch =
		deps.fetch ??
		(async (options: Options) => {
			// Hooks the named-logs facade to the console. Done HERE, in the process entry
			// point, and never in the library: a fetcher's cycle logs are the only
			// observability a split deployment has, and the binary that used to hook it
			// (`etherfold-fetch`) is retired, so the CLI is that process now. An
			// application embedding `startFetcher` still chooses its own sink, and a
			// test substituting this handler installs none.
			await import('named-logs-console');
			// `fetchMain` resolves the exit code through the adapter's own
			// `runFetcherProcess`: non-zero when it stopped on a refusal, because a
			// fetcher that stays up while achieving nothing is indistinguishable from a
			// working one until somebody reads the state it is not producing.
			await fetchMain(options, {env});
		});

	const fetchCommand = program
		.command('fetch')
		.description(
			'follow the chain and push contiguous ranges of raw logs to an indexer-server elsewhere: ' +
				'the chain-facing half, which folds nothing and holds no state',
		)
		.usage('-n http://localhost:8545 -d <deployment folder> --indexer <name> --ingest-endpoint http://indexer:2000');
	registerInputs(fetchCommand, 'fetch');
	fetchCommand.action(async (options: Options) => {
		await runFetch(options);
	});

	const runReceiver =
		deps.index ??
		(async (options: Options) => {
			// Hooked for the same reason `fetch` hooks it, in the same place: a split
			// deployment's two processes are observable through their cycle logs and
			// their `/status`, and hooking the facade belongs in a process entry point
			// rather than in a library. On this half it is what surfaces the refusals the
			// wire makes -- a foreign `{source, config}`, an absence-driven revert -- which
			// no HTTP response of ours ever shows an operator.
			await import('named-logs-console');
			// `indexMain` resolves the exit code the same way `runMain` does: a receiver
			// that never started must not look like one that was asked to stop.
			await indexMain(options, {env});
		});

	const indexCommand = program
		.command('index')
		.description(
			'receive pushed ranges of raw logs over HTTP and fold them into a libSQL database: ' +
				'the folding half, which makes no chain call and answers no queries beyond /status',
		)
		.usage("-p <processor's path> --store sqlite --db <libsql url> -d <deployment folder> [--port 2000]");
	registerInputs(indexCommand, 'index');
	indexCommand.action(async (options: Options) => {
		await runReceiver(options);
	});

	const serveCommand = program
		.command('serve')
		.description('answer queries over a libSQL database written elsewhere: the read tier, which folds nothing')
		.usage('--db <libsql url> [--port 2000]');
	registerInputs(serveCommand, 'serve');
	serveCommand.action(async (options: Options) => {
		await runServe(options);
	});

	const runUpload =
		deps.upload ??
		(async (options: Options) => {
			await uploadMain(options, {env});
		});

	const uploadCommand = program
		.command('upload')
		.description(
			'upload an already-built processor bundle to a running node (`etherfold node`), which registers it beside ' +
				'the generation answering reads: a client of a node rather than a way to run one. It never builds, and ' +
				'exits non-zero on anything short of `registered` or `unchanged`',
		)
		.argument('[bundle]', 'the already-built, self-contained bundle to send (or -p)')
		.usage('<bundle> --to http://localhost:2000 --indexer <name>   (ADMIN_TOKEN in the environment)');
	registerInputs(uploadCommand, 'upload');
	uploadCommand.action(async (bundle: string | undefined, options: Options) => {
		await runUpload(bundle === undefined ? options : {...options, bundle});
	});

	return program;
}
