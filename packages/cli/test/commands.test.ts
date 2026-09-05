import type {Command} from 'commander';
import {describe, expect, it} from 'vitest';
import {createProgram, type ProgramDependencies} from '../src/program.js';
import type {Options} from '../src/types.js';

// ---------------------------------------------------------------------------------------------------
// THE COMMAND SURFACE: A WORD RESOLVES OR IT DOES NOT, AND NOTHING IS IMPLICIT
// ---------------------------------------------------------------------------------------------------
// The five names of `one-command-runs-the-whole-pipeline` are chosen so a reader
// can tell what a process will DO, which only holds if every word means one
// thing. So all five are asserted at the surface a user types at: `run` follows
// the chain, folds AND answers queries without terminating, `build` is the
// one-shot (`CONTEXT.md`: follows the chain, folds, EXITS at the tip), `fetch`
// is the chain-facing half that folds nothing, `index` is the other half of that
// pair -- receiving pushes, owning the database, taking no node URL -- and no
// command is commander's default: a bare invocation prints help rather than
// silently meaning one of the five.
//
// What this file does NOT assert is requiredness. That lives in the resolver
// (`configuration.test.ts`), never in the parser, so nothing here is a
// `requiredOption` and nothing carries a commander default: a flag that is
// always present can never fall back to the variable behind it.
//
// The handlers are injected, so this file asserts the WORDS and the FLAGS
// without loading a processor module or binding a port.
// ---------------------------------------------------------------------------------------------------

/** Errors and help go to these arrays instead of the process, all the way down the command tree. */
function silence(command: Command, output: string[]): void {
	command.exitOverride();
	command.configureOutput({writeOut: (text) => output.push(text), writeErr: (text) => output.push(text)});
	for (const sub of command.commands) silence(sub, output);
}

function programUnderTest(deps: ProgramDependencies = {}) {
	const built: Options[] = [];
	const served: Options[] = [];
	const followed: Options[] = [];
	const fetched: Options[] = [];
	const received: Options[] = [];
	const output: string[] = [];
	const program = createProgram({
		env: {},
		build: (options) => {
			built.push(options);
		},
		serve: async (options) => {
			served.push(options);
		},
		run: async (options) => {
			followed.push(options);
		},
		// substituted like the others, which also keeps the console log sink the real
		// handler installs out of a test run: hooking it is a process entry point's
		// job, and this is not one
		fetch: async (options) => {
			fetched.push(options);
		},
		index: async (options) => {
			received.push(options);
		},
		...deps,
	});
	silence(program, output);
	return {
		built,
		served,
		followed,
		fetched,
		received,
		output,
		run: (argv: string[]) => program.parseAsync(argv, {from: 'user'}),
	};
}

describe('`run` is the follower, and the default thing to reach for', () => {
	it('resolves, and hands its handler the flags a process that folds AND serves owns', async () => {
		const cli = programUnderTest();

		await cli.run([
			'run',
			'-p',
			'./processor.js',
			'--store',
			'sqlite',
			'--db',
			'file:./etherfold.db',
			'-n',
			'http://localhost:8545',
			'--port',
			'3000',
			'--host',
			'127.0.0.1',
		]);

		expect(cli.followed).toHaveLength(1);
		expect(cli.followed[0]).toMatchObject({
			processor: './processor.js',
			store: 'sqlite',
			db: 'file:./etherfold.db',
			nodeUrl: 'http://localhost:8545',
			port: '3000',
			host: '127.0.0.1',
		});
		// it is its own command and not a flag on another one
		expect(cli.built).toEqual([]);
		expect(cli.served).toEqual([]);
	});

	it('shows the folding flags AND the serving ones, and the name, and no wire', async () => {
		const cli = programUnderTest();

		await expect(cli.run(['run', '--help'])).rejects.toMatchObject({code: 'commander.helpDisplayed'});
		const help = cli.output.join('');
		for (const owned of [
			'--processor',
			'--store',
			'--db',
			'--node-url',
			'--port',
			'--host',
			'--no-auto-setup',
			// the NAME this process folds under: it routes nothing by it, and its stored
			// emission stream is keyed on it, so it is owned and optional here (ADR-0052)
			'--indexer',
		]) {
			expect(help).toMatch(owned);
		}
		// this process runs both halves in ONE process, so there is no WIRE to
		// configure: those flags parse and are refused with that reason
		for (const notOwned of ['--ingest-endpoint', '--ingest-token']) {
			expect(help).not.toMatch(notOwned);
		}
	});
});

describe('`build` is the one-shot', () => {
	it('resolves, and hands its handler every flag the one-shot has always taken', async () => {
		const cli = programUnderTest();

		await cli.run([
			'build',
			'-p',
			'./processor.js',
			'--store',
			'sqlite',
			'--db',
			'file:./etherfold.db',
			'--retention',
			'50000',
			'-d',
			'./deployments',
			'--rps',
			'5',
			'-n',
			'http://localhost:8545',
		]);

		expect(cli.built).toHaveLength(1);
		expect(cli.built[0]).toMatchObject({
			processor: './processor.js',
			nodeUrl: 'http://localhost:8545',
			store: 'sqlite',
			db: 'file:./etherfold.db',
			retention: '50000',
			deployments: './deployments',
			// commander hands every flag over as a string, and the type says so now: the
			// resolver is what turns it into a rate
			rps: '5',
		});
	});

	it('does not make -n a parser requirement, so the resolver can name ETH_NODE_URI behind it', async () => {
		const cli = programUnderTest();

		// the parser accepts it; what refuses is `resolveCommandConfig`, which is what
		// lets the refusal name the variable as well as the flag
		await cli.run(['build', '-p', './processor.js', '--store', 'sqlite', '--db', ':memory:']);
		expect(cli.built).toHaveLength(1);
		expect(cli.built[0]!.nodeUrl).toBeUndefined();
	});
});

describe('`fetch` is the chain-facing half, and the only way to run a fetcher', () => {
	it('resolves, and hands its handler the flags a process that folds NOTHING owns', async () => {
		const cli = programUnderTest();

		await cli.run([
			'fetch',
			'-n',
			'http://localhost:8545',
			'-d',
			'./deployments',
			'--indexer',
			'alpha',
			'--ingest-endpoint',
			'http://indexer:2000',
			'--ingest-token',
			'a-shared-secret',
			'--rps',
			'20',
		]);

		expect(cli.fetched).toHaveLength(1);
		expect(cli.fetched[0]).toMatchObject({
			nodeUrl: 'http://localhost:8545',
			deployments: './deployments',
			indexer: 'alpha',
			ingestEndpoint: 'http://indexer:2000',
			ingestToken: 'a-shared-secret',
			rps: '20',
		});
		// it folds nothing and serves nothing, so it is nobody else's flag
		expect(cli.built).toEqual([]);
		expect(cli.followed).toEqual([]);
		expect(cli.served).toEqual([]);
	});

	it('shows the wire and the chain, and nothing that implies state', async () => {
		const cli = programUnderTest();

		await expect(cli.run(['fetch', '--help'])).rejects.toMatchObject({code: 'commander.helpDisplayed'});
		const help = cli.output.join('');
		for (const owned of ['--node-url', '--deployments', '--indexer', '--ingest-endpoint', '--ingest-token', '--rps']) {
			expect(help).toMatch(owned);
		}
		// a fetcher holds no processor, no store and no database, and answers no
		// queries: those flags parse (so a copied command line gets an answer) and are
		// refused by the resolver rather than advertised here
		for (const notOwned of ['--processor', '--store', '--db', '--retention', '--port', '--host']) {
			expect(help).not.toMatch(notOwned);
		}
		// and there is nowhere to tell it where to start: the receiver's cursor is the
		// only thing that says (ADR-0004)
		expect(help).not.toMatch(/from-block|state-file|lock/);
	});
});

describe('`index` is the receiving half, and no longer the one-shot', () => {
	it('resolves, and hands its handler the flags a process that RECEIVES and folds owns', async () => {
		const cli = programUnderTest();

		await cli.run([
			'index',
			'-p',
			'./processor.js',
			'--store',
			'sqlite',
			'--db',
			'file:./etherfold.db',
			'-d',
			'./deployments',
			'--port',
			'3000',
			'--indexer',
			'alpha',
			'--ingest-token',
			'a-shared-secret',
		]);

		expect(cli.received).toHaveLength(1);
		expect(cli.received[0]).toMatchObject({
			processor: './processor.js',
			store: 'sqlite',
			db: 'file:./etherfold.db',
			deployments: './deployments',
			port: '3000',
			indexer: 'alpha',
			ingestToken: 'a-shared-secret',
		});
		// the word means ONE thing, and it is no longer the one-shot: that is `build`
		expect(cli.built).toEqual([]);
		expect(cli.followed).toEqual([]);
		expect(cli.fetched).toEqual([]);
		expect(cli.served).toEqual([]);
	});

	it('shows the folding flags, the port and the secret it CHECKS, and no chain', async () => {
		const cli = programUnderTest();

		await expect(cli.run(['index', '--help'])).rejects.toMatchObject({code: 'commander.helpDisplayed'});
		const help = cli.output.join('');
		for (const owned of ['--processor', '--deployments', '--store', '--db', '--port', '--indexer', '--ingest-token']) {
			expect(help).toMatch(owned);
		}
		// it makes NO chain call and it RECEIVES rather than sends, so those flags
		// parse (a copied command line gets an answer) and are refused by the resolver
		// rather than advertised here
		for (const notOwned of ['--node-url', '--rps', '--ingest-endpoint']) {
			expect(help).not.toMatch(notOwned);
		}
	});
});

describe('no command is implicit', () => {
	it('prints help on a bare invocation instead of running one of them', async () => {
		const cli = programUnderTest();

		await expect(cli.run([])).rejects.toMatchObject({code: 'commander.help'});
		expect(cli.built).toEqual([]);
		expect(cli.served).toEqual([]);
		expect(cli.followed).toEqual([]);
		expect(cli.fetched).toEqual([]);
		expect(cli.received).toEqual([]);
		expect(cli.output.join('')).toMatch(/Commands:[\s\S]*run[\s\S]*build[\s\S]*fetch[\s\S]*index[\s\S]*serve/);
	});

	it('refuses the old default-command form rather than folding under no name', async () => {
		const cli = programUnderTest();

		await expect(
			cli.run(['-p', './processor.js', '--store', 'sqlite', '--db', ':memory:', '-n', 'http://localhost:8545']),
		).rejects.toThrow(/unknown option/i);
		expect(cli.built).toEqual([]);
	});
});

describe('`serve` is still `serve`', () => {
	it('resolves, and hands its handler the flags the read tier owns', async () => {
		const cli = programUnderTest();

		await cli.run(['serve', '--db', 'file:./etherfold.db']);
		expect(cli.served[0]).toMatchObject({db: 'file:./etherfold.db', autoSetup: true});
		// NOT defaulted by the parser: a commander default is always present, so it
		// would make PORT unreachable. 2000 is the resolver's, and only when neither
		// the flag nor the variable said anything
		expect(cli.served[0]!.port).toBeUndefined();

		await cli.run(['serve', '--db', 'file:./etherfold.db', '--port', '3000', '--no-auto-setup']);
		expect(cli.served[1]).toMatchObject({port: '3000', autoSetup: false});
	});
});

// ---------------------------------------------------------------------------------------------------
// A COMMAND LINE COPIED ACROSS GETS TOLD WHAT TO CHANGE
// ---------------------------------------------------------------------------------------------------
// A flag a command does not own PARSES, so it reaches the resolver and is refused
// with the reason -- rather than meeting commander's `unknown option`, which
// names neither a reason nor the command that does own it. That is the whole
// point of "moving between commands is a deployment change, never a rewrite":
// the flags that do not move say where they went.
// ---------------------------------------------------------------------------------------------------

describe('flags a command does not own reach the resolver, and are refused there', () => {
	it('parses -p on `serve` rather than calling it an unknown option', async () => {
		const cli = programUnderTest();

		await cli.run(['serve', '--db', ':memory:', '-p', './processor.js']);
		expect(cli.served[0]).toMatchObject({processor: './processor.js'});
	});

	it('keeps them out of --help, so the surface a user reads is what the command owns', async () => {
		const cli = programUnderTest();

		await expect(cli.run(['serve', '--help'])).rejects.toMatchObject({code: 'commander.helpDisplayed'});
		const help = cli.output.join('');
		expect(help).toMatch(/--db/);
		expect(help).toMatch(/--port/);
		expect(help).not.toMatch(/--processor/);
		expect(help).not.toMatch(/--indexer/);
		expect(help).not.toMatch(/--ingest-token/);
	});

	it('shows every flag `build` owns, and no flag it does not', async () => {
		const cli = programUnderTest();

		await expect(cli.run(['build', '--help'])).rejects.toMatchObject({code: 'commander.helpDisplayed'});
		const help = cli.output.join('');
		for (const owned of [
			'--processor',
			'--deployments',
			'--node-url',
			'--rps',
			'--store',
			'--db',
			'--retention',
			// the artifact it emits carries a stored stream, and that stream is keyed on
			// this name (ADR-0052)
			'--indexer',
		]) {
			expect(help).toMatch(owned);
		}
		for (const notOwned of ['--port', '--host', '--ingest-endpoint', '--ingest-token']) {
			expect(help).not.toMatch(notOwned);
		}
	});

	it('names the variable behind a flag in the help text, so both are in one place', async () => {
		const cli = programUnderTest();

		await expect(cli.run(['build', '--help'])).rejects.toMatchObject({code: 'commander.helpDisplayed'});
		const help = cli.output.join('');
		expect(help).toMatch(/ETH_NODE_URI/);
		expect(help).toMatch(/\bDB\b/);
		expect(help).toMatch(/INDEXING_SOURCE/);
		expect(help).not.toMatch(/ETHEREUM_NODE/);
	});
});
