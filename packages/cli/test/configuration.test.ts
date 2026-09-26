import {PROMOTION_POLICIES} from '@etherfold/core';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {
	DEFAULT_INDEXER_NAME,
	INPUTS,
	OWNERSHIP,
	refuseUnbundledProcessor,
	resolveCommandConfig,
	type ConfigInput,
	type ProcessorBundleOptions,
} from '../src/config.js';
import type {CommandName, Options} from '../src/types.js';

// ---------------------------------------------------------------------------------------------------
// ONE CONFIGURATION PATH, SEVEN COMMANDS
// ---------------------------------------------------------------------------------------------------
// Moving between the commands is a DEPLOYMENT change and never a rewrite, and
// that is a claim about `src/config.ts`: every command reads the same inputs,
// under the same flag and the same variable, and refuses in the same shape.
//
// The seam is the resolver itself -- pure functions over an options object plus
// an environment record, which is how the store-target refusals were always
// tested -- so everything below is asserted without loading a processor module,
// opening a database or dialling a chain. Three of the five commands do not
// exist yet and are asserted here anyway: they must CONSUME this rather than
// extend it, so a row that could not be expressed is a design fault now rather
// than a later command's problem.
// ---------------------------------------------------------------------------------------------------

/** Enough of a fold to be resolvable, so a test can take one thing away at a time. */
const FOLDING: Options = {
	processor: './processor.js',
	nodeUrl: 'http://localhost:8545',
	store: 'sqlite',
	db: 'file:./etherfold.db',
	deployments: './deployments',
};

const SOURCE_JSON = JSON.stringify({
	chainId: '1',
	contracts: [{abi: [], address: '0x0000000000000000000000000000000000000001'}],
});

describe('a flag beats the environment, and the environment stands behind it', () => {
	it('takes the flag when both are there', () => {
		const config = resolveCommandConfig('build', FOLDING, {
			ETH_NODE_URI: 'http://from.env',
			DB: 'file:./from-env.db',
		});
		expect(config.nodeUrl).toBe('http://localhost:8545');
		expect(config.destination.db).toBe('file:./etherfold.db');
	});

	it('takes the environment when the flag is absent', () => {
		const {nodeUrl, db, ...noFlags} = FOLDING;
		const config = resolveCommandConfig('build', noFlags, {
			ETH_NODE_URI: 'http://from.env',
			DB: 'file:./from-env.db',
		});
		expect(config.nodeUrl).toBe('http://from.env');
		expect(config.destination.db).toBe('file:./from-env.db');
	});

	it('reads a BLANK variable as unset rather than as an empty answer', () => {
		const {nodeUrl, ...noFlag} = FOLDING;
		expect(() => resolveCommandConfig('build', noFlag, {ETH_NODE_URI: '   '})).toThrow(/ETH_NODE_URI/);
	});

	it('refuses when neither is there, naming BOTH', () => {
		const {nodeUrl, ...noFlag} = FOLDING;
		expect(() => resolveCommandConfig('build', noFlag, {})).toThrow(/--node-url.*ETH_NODE_URI/s);
	});
});

describe('the retired second name for the node url is gone', () => {
	it('does not read ETHEREUM_NODE any more', () => {
		const {nodeUrl, ...noFlag} = FOLDING;
		expect(() => resolveCommandConfig('build', noFlag, {ETHEREUM_NODE: 'http://old.name'})).toThrow(/ETH_NODE_URI/);
	});

	it('names ETH_NODE_URI, and nothing else, as the variable behind -n', () => {
		expect(INPUTS.nodeUrl.variable).toBe('ETH_NODE_URI');
		expect(Object.values(INPUTS).map((spec) => spec.variable)).not.toContain('ETHEREUM_NODE');
	});
});

// ---------------------------------------------------------------------------------------------------
// EVERY REFUSAL, BY NAME
// ---------------------------------------------------------------------------------------------------

describe('a required input that is missing is refused, naming the flag and the variable', () => {
	it('refuses a missing processor, and says it has no variable rather than naming one', () => {
		const {processor, ...noProcessor} = FOLDING;
		expect(() => resolveCommandConfig('build', noProcessor, {})).toThrow(/--processor.*createProcessor/s);
		expect(() => resolveCommandConfig('build', noProcessor, {})).toThrow(/no environment fallback/);
	});

	it('still refuses a missing processor on every command that requires one', () => {
		const {processor, ...noProcessor} = FOLDING;
		const {deployments, ...nothingAtAll} = noProcessor;
		expect(() => resolveCommandConfig('build', nothingAtAll, {})).toThrow(
			/--processor is required by `etherfold build`/,
		);
		expect(() => resolveCommandConfig('build', noProcessor, {})).toThrow(
			/--processor is required by `etherfold build`/,
		);
	});

	it('refuses a missing --store, naming the value there is', () => {
		const {store, ...noStore} = FOLDING;
		expect(() => resolveCommandConfig('build', noStore, {})).toThrow(/--store.*sqlite/s);
	});

	it('refuses a --store nobody implements', () => {
		expect(() => resolveCommandConfig('build', {...FOLDING, store: 'postgres'}, {})).toThrow(/postgres.*sqlite/s);
	});

	it('refuses the retired free-form store rather than silently keeping a blob', () => {
		expect(() => resolveCommandConfig('build', {...FOLDING, store: 'file'}, {})).toThrow(/file.*sqlite/s);
	});

	it('refuses a missing database rather than writing one nobody named', () => {
		const {db, ...noDb} = FOLDING;
		expect(() => resolveCommandConfig('build', noDb, {})).toThrow(/--db \(DB\)/);
		expect(() => resolveCommandConfig('build', noDb, {})).toThrow(/nobody named/);
	});

	it('refuses a read tier with no database, so `serve` never comes up on one nobody named', () => {
		expect(() => resolveCommandConfig('serve', {}, {})).toThrow(/--db \(DB\).*nobody named/s);
	});

	it('refuses a fetcher with no ingest endpoint and no token, naming each', () => {
		const wireless: Options = {nodeUrl: 'http://localhost:8545', deployments: './deployments', indexer: 'alpha'};
		expect(() => resolveCommandConfig('fetch', wireless, {})).toThrow(/--ingest-endpoint \(INGEST_ENDPOINT\)/);
		expect(() => resolveCommandConfig('fetch', {...wireless, ingestEndpoint: 'http://server'}, {})).toThrow(
			/--ingest-token \(INGEST_TOKEN\)/,
		);
	});

	it('refuses BOTH halves of the WIRE with no indexer NAME, since a host defaults none', () => {
		// On the wire the name is a ROUTE SEGMENT (ADR-0036): the sender addresses
		// `/{indexer}/ingest` and the receiver registers exactly that name, so neither
		// half may invent one. That rule is about ROUTING, which is why the combined
		// shapes below may default the same input (ADR-0052) -- they route nothing.
		const sending: Options = {
			nodeUrl: 'http://localhost:8545',
			deployments: './d',
			ingestEndpoint: 'http://server',
			ingestToken: 't',
		};
		expect(() => resolveCommandConfig('fetch', sending, {})).toThrow(/--indexer \(INDEXER_NAME\)/);
		const receiving: Options = {
			processor: './p.js',
			store: 'sqlite',
			db: ':memory:',
			deployments: './d',
			ingestToken: 't',
		};
		expect(() => resolveCommandConfig('index', receiving, {})).toThrow(/--indexer \(INDEXER_NAME\)/);
		// and the variable stands behind the flag on both, like every other input
		expect(resolveCommandConfig('fetch', sending, {INDEXER_NAME: 'alpha'}).wire.indexer).toBe('alpha');
		expect(resolveCommandConfig('index', receiving, {INDEXER_NAME: 'alpha'}).wire.indexer).toBe('alpha');
	});

	it('refuses a receiver with no token, because the guard fails CLOSED without one', () => {
		const receiver: Options = {
			processor: './p.js',
			store: 'sqlite',
			db: ':memory:',
			deployments: './deployments',
			indexer: 'alpha',
		};
		expect(() => resolveCommandConfig('index', receiver, {})).toThrow(/--ingest-token \(INGEST_TOKEN\).*401/s);
	});

	it('never quotes the token itself, only the name that held it', () => {
		const receiver: Options = {
			processor: './p.js',
			store: 'sqlite',
			db: ':memory:',
			deployments: './deployments',
			indexer: 'alpha',
		};
		let message = '';
		try {
			resolveCommandConfig('index', receiver, {});
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain('INGEST_TOKEN');
		expect(message).not.toMatch(/Bearer|secret-value/);
	});
});

// ---------------------------------------------------------------------------------------------------
// --processor MUST NAME A BUNDLE, AND THE MESSAGE IS THE DELIVERABLE
// ---------------------------------------------------------------------------------------------------
// A processor IS a self-contained bundle and the sha256 of its bytes is its
// identity (ADR-0086), so a configuration naming an unbundled entry point names
// nothing this deployment can fold. It is refused HERE, with the other input
// refusals, and not from inside a loader: by the time a loader has the bytes a
// database may be open and a generation part-way registered, and the author gets
// an error about module syntax rather than about their configuration.
//
// This is the ONE input whose value is a PATH and whose refusal is therefore
// about the FILE rather than about the string, so it is the one check in this
// module that reads a disk. It still imports nothing, opens no database and
// dials nothing, which is the property that matters: it is a function a test
// calls, like every other refusal here (ADR-0048).
//
// WHAT DECIDES is `unresolvedImportsOf` (`@etherfold/utils`), which is this
// repository's only definition of self-contained and the same judgement the
// artifact loader refuses on. A second heuristic for "is this a bundle" would be
// two answers to one question, disagreeing exactly where a migration is half
// done.
// ---------------------------------------------------------------------------------------------------

/** A REAL bundle, built by the documented command and committed (`fixtures/processor-bundle/README.md`). */
const FIXTURE_BUNDLE = fileURLToPath(new URL('./fixtures/processor-bundle/nfts.bundle.js', import.meta.url));

/** The scratch directories these cases write processor files into, outside the repository. */
const scratch: string[] = [];

afterEach(async () => {
	for (const dir of scratch.splice(0)) {
		await rm(dir, {recursive: true, force: true}).catch(() => undefined);
	}
});

async function aFileHolding(name: string, source: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-config-'));
	scratch.push(dir);
	const path = join(dir, name);
	await writeFile(path, source, 'utf-8');
	return path;
}

/** The message, so a case can read the whole of it rather than match twice. */
async function refusalOf(
	command: CommandName,
	processorPath: string,
	options: ProcessorBundleOptions = {},
): Promise<string> {
	try {
		await refuseUnbundledProcessor(command, processorPath, options);
	} catch (err) {
		return (err as Error).message;
	}
	return '';
}

describe('a --processor path that names no bundle is refused, with the command that makes one', () => {
	it('accepts a REAL bundle, so nobody who has migrated can meet the refusal', async () => {
		// ...and it hands back the bytes it judged, so a caller that SENDS them (`upload`)
		// sends exactly what was checked rather than reading the file a second time
		const judged = await refuseUnbundledProcessor('build', FIXTURE_BUNDLE);
		expect([...(judged ?? [])]).toEqual([...(await readFile(FIXTURE_BUNDLE))]);
	});

	it('refuses an entry point that still imports, naming the path AND what it still imports', async () => {
		const entry = await aFileHolding(
			'processor.mjs',
			`import {entities} from './entities.js';\nexport const createProcessor = () => ({entities});\n`,
		);

		const message = await refusalOf('build', entry);
		expect(message).toContain('--processor');
		expect(message).toContain(entry);
		// the SPECIFIER, because "this is not a bundle" is not actionable and "you still
		// import ./entities.js" is
		expect(message).toContain('./entities.js');
		expect(message).toMatch(/entry point/i);
	});

	it('gives the ONE build command, with the path the operator typed already in it', async () => {
		const entry = await aFileHolding(
			'processor.mjs',
			`import './abi.js';\nexport const createProcessor = () => ({});\n`,
		);

		// the command an author copies out of the message must be the command the
		// documentation names, or the two disagree at the one moment somebody is stuck
		expect(await refusalOf('build', entry)).toContain(`esbuild ${entry} --bundle --format=esm --minify`);
	});

	it('refuses a path that is not a file this process can read, which is the build that has not run', async () => {
		const missing = join(await aScratchDirectory(), 'dist', 'processor.bundle.js');

		const message = await refusalOf('run', missing);
		expect(message).toContain('--processor');
		expect(message).toContain(missing);
		// ...and the command WRITES the file they named, because that is the thing they
		// are missing
		expect(message).toContain(`--outfile=${missing}`);
	});

	it('does NOT refuse a bundle that merely MENTIONS a package name in a string', async () => {
		// the check is about module references and not about text: a bundle that carries
		// a package name in a log line, a comment or a datum is a bundle
		const bundle = await aFileHolding(
			'bundle.js',
			`const built = 'viem';\nconsole.log('bundled with viem, and it imports nothing');\n` +
				`export const createProcessor = () => ({entities: [], built});\n`,
		);

		await expect(refuseUnbundledProcessor('build', bundle)).resolves.toBeInstanceOf(Uint8Array);
	});

	it('accepts a node BUILTIN, which a --platform=node bundle legitimately keeps', async () => {
		// measured rather than assumed, and the judgement belongs to the artifact unit:
		// a builtin RESOLVES from bytes with no directory, so refusing one would refuse
		// an artifact that runs
		const bundle = await aFileHolding(
			'bundle.js',
			`import {createHash} from 'node:crypto';\nexport const createProcessor = () => ({entities: [], createHash});\n`,
		);

		await expect(refuseUnbundledProcessor('build', bundle)).resolves.toBeInstanceOf(Uint8Array);
	});

	it('resolves a RELATIVE path against the cwd the loader resolves it against', async () => {
		// one `--processor ./dist/index.js` must mean one file: the check and the arrival
		// disagreeing about which would refuse a deployment that runs, or admit one that
		// does not
		const bundle = await aFileHolding('bundle.js', `export const createProcessor = () => ({entities: []});\n`);

		await expect(refuseUnbundledProcessor('build', './bundle.js', {cwd: dirname(bundle)})).resolves.toBeInstanceOf(
			Uint8Array,
		);
		await expect(refuseUnbundledProcessor('build', './bundle.js', {cwd: tmpdir()})).rejects.toThrow(/--processor/);
	});

	it('says nothing at all about a SUBSTITUTED arrival, which named no file to read', async () => {
		// `IndexingDependencies.importModule` states what comes back for a path, so there
		// is no file on a disk for this to have an opinion about. No flag and no
		// environment variable reaches it, which is why it cannot be a way round the
		// refusal for a deployment.
		await expect(
			refuseUnbundledProcessor('build', './nothing-is-here.js', {substitutedArrival: true}),
		).resolves.toBeUndefined();
	});

	it('refuses the same way on every command that folds one', async () => {
		const entry = await aFileHolding(
			'processor.mjs',
			`import './abi.js';\nexport const createProcessor = () => ({});\n`,
		);

		for (const command of ['run', 'build', 'index'] as const) {
			expect(await refusalOf(command, entry)).toContain(`etherfold ${command}`);
		}
	});
});

async function aScratchDirectory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'etherfold-config-'));
	scratch.push(dir);
	return dir;
}

// ---------------------------------------------------------------------------------------------------
// NOTHING IS ACCEPTED AND IGNORED
// ---------------------------------------------------------------------------------------------------
// An accepted-and-ignored flag is a deployment believing something untrue, so an
// input a command does not OWN is refused with the reason it does not own it --
// which is also the message someone who copied a command line across from
// another command needs.
// ---------------------------------------------------------------------------------------------------

describe('the two asymmetries the table exists for', () => {
	it('refuses a store on `fetch`, because a fetcher holds no state', () => {
		const fetching: Options = {
			nodeUrl: 'http://localhost:8545',
			deployments: './deployments',
			ingestEndpoint: 'http://server',
			ingestToken: 't',
		};
		expect(() => resolveCommandConfig('fetch', {...fetching, store: 'sqlite'}, {})).toThrow(
			/--store is not accepted by `etherfold fetch`.*holds no state/s,
		);
		expect(() => resolveCommandConfig('fetch', {...fetching, db: ':memory:'}, {})).toThrow(
			/--db \(DB\) is not accepted by `etherfold fetch`.*holds no state/s,
		);
	});

	it('refuses a processor on `fetch`, because the chain-facing half holds none (ADR-0003)', () => {
		expect(() =>
			resolveCommandConfig(
				'fetch',
				{
					processor: './p.js',
					nodeUrl: 'http://localhost:8545',
					deployments: './d',
					ingestEndpoint: 'http://s',
					ingestToken: 't',
				},
				{},
			),
		).toThrow(/--processor is not accepted by `etherfold fetch`.*ADR-0003/s);
	});

	it('refuses a processor on `serve`, because a read tier holds none', () => {
		expect(() => resolveCommandConfig('serve', {db: ':memory:', processor: './p.js'}, {})).toThrow(
			/--processor is not accepted by `etherfold serve`.*read tier holds no processor/s,
		);
	});

	it('refuses a node url on `index`, because the receiving half makes NO chain call', () => {
		expect(() =>
			resolveCommandConfig(
				'index',
				{processor: './p.js', store: 'sqlite', db: ':memory:', deployments: './d', ingestToken: 't', indexer: 'alpha'},
				{},
			),
		).not.toThrow();
		expect(() =>
			resolveCommandConfig(
				'index',
				{
					processor: './p.js',
					store: 'sqlite',
					db: ':memory:',
					deployments: './d',
					ingestToken: 't',
					indexer: 'alpha',
					nodeUrl: 'http://node',
				},
				{},
			),
		).toThrow(/--node-url \(ETH_NODE_URI\) is not accepted by `etherfold index`.*NO chain call/s);
	});

	it('refuses an indexer NAME on the read tier, which folds nothing and registers nothing', () => {
		// `serve` is the one command left that has no use for the value: it receives no
		// push, so it registers no name, and it folds nothing, so it stores no emission
		// row to key on one
		expect(() => resolveCommandConfig('serve', {db: ':memory:', indexer: 'alpha'}, {})).toThrow(
			/--indexer \(INDEXER_NAME\) is not accepted by `etherfold serve`.*read tier/s,
		);
	});

	// -------------------------------------------------------------------------
	// THE NAME IS UNIVERSAL, AND ONLY THE WIRE MAY NOT DEFAULT IT (ADR-0052)
	// -------------------------------------------------------------------------
	// `run` and `build` refused `--indexer` outright, on the ground that the name
	// is a route segment and they route nothing. That left the shapes which FOLD
	// in one process with no name to key a stored emission row on -- the column is
	// `NOT NULL` -- so they stored no stream at all. The name is universal
	// (ADR-0036) and only its ROUTING use is undefaultable, so they take it,
	// optionally, and default it.
	// -------------------------------------------------------------------------

	it('accepts an indexer NAME on the combined shapes, and defaults one when none is given', () => {
		expect(resolveCommandConfig('run', {...FOLDING, indexer: 'alpha'}, {}).indexer).toBe('alpha');
		expect(resolveCommandConfig('build', {...FOLDING, indexer: 'alpha'}, {}).indexer).toBe('alpha');

		// ...and with none given, the documented default rather than a refusal: this is
		// `etherfold run`, the readme's headline one-liner, and nothing about it routes
		expect(resolveCommandConfig('run', FOLDING, {}).indexer).toBe(DEFAULT_INDEXER_NAME);
		expect(resolveCommandConfig('build', FOLDING, {}).indexer).toBe(DEFAULT_INDEXER_NAME);

		// the SAME default on both, so an artifact `build` emitted is one `run`
		// continues rather than forks a second stream beside
		expect(resolveCommandConfig('build', FOLDING, {}).indexer).toBe(resolveCommandConfig('run', FOLDING, {}).indexer);
	});

	it('lets the variable stand behind the flag on the combined shapes too', () => {
		// one name per input, and the same precedence as every other: flag, then
		// variable, then -- here alone among the folding commands -- a default
		expect(resolveCommandConfig('run', FOLDING, {INDEXER_NAME: 'from-env'}).indexer).toBe('from-env');
		expect(resolveCommandConfig('run', {...FOLDING, indexer: 'from-flag'}, {INDEXER_NAME: 'from-env'}).indexer).toBe(
			'from-flag',
		);
	});

	it('documents the default where the flag is described, so --help says what it will do', () => {
		// the flag is registered from this description (`src/program.ts`), so this is
		// the one place the default has to be readable from
		expect(INPUTS.indexer.describe).toContain(DEFAULT_INDEXER_NAME);
		expect(INPUTS.indexer.describe).toMatch(/never defaulted/);
	});

	it('refuses a wire on `run` and on `build`, because the halves meet in one process', () => {
		expect(() => resolveCommandConfig('build', {...FOLDING, ingestEndpoint: 'http://s'}, {})).toThrow(
			/--ingest-endpoint \(INGEST_ENDPOINT\) is not accepted by `etherfold build`.*ONE process/s,
		);
		expect(() => resolveCommandConfig('run', {...FOLDING, ingestToken: 'secret'}, {})).toThrow(
			/--ingest-token \(INGEST_TOKEN\) is not accepted by `etherfold run`/,
		);
	});

	it('refuses a port on `build`, because the one-shot answers no queries', () => {
		expect(() => resolveCommandConfig('build', {...FOLDING, port: '3000'}, {})).toThrow(
			/--port \(PORT\) is not accepted by `etherfold build`.*exits/s,
		);
	});

	it('refuses a refused input BEFORE it asks for a missing required one', () => {
		// someone who moved a working command line across is better told the flag
		// belongs to another intent than told a flag they never meant to need is missing
		expect(() => resolveCommandConfig('serve', {processor: './p.js'}, {})).toThrow(/--processor is not accepted/);
	});

	it('IGNORES an ambient variable a command does not own, rather than refusing it', () => {
		// one host runs `fetch` and `index` side by side, so ETH_NODE_URI being set is
		// ordinary; refusing on it would make the split deployment unconfigurable
		const receiver: Options = {
			processor: './p.js',
			store: 'sqlite',
			db: ':memory:',
			deployments: './d',
			ingestToken: 't',
			indexer: 'alpha',
		};
		expect(() =>
			resolveCommandConfig('index', receiver, {ETH_NODE_URI: 'http://node', INGEST_ENDPOINT: 'http://elsewhere'}),
		).not.toThrow();
	});

	it('every refused cell of the table refuses by name, with a reason', () => {
		// the table drives the parser AND the resolver, so a cell with no reason would
		// be a flag that parses and is refused with nothing useful said
		const commands = Object.keys(OWNERSHIP) as CommandName[];
		const holes: string[] = [];
		for (const command of commands) {
			for (const input of Object.keys(INPUTS) as ConfigInput[]) {
				if (OWNERSHIP[command][input] !== 'refused') continue;
				const flag = INPUTS[input].flag.split(' <')[0] as string;
				let message = '';
				try {
					resolveCommandConfig(command, valueFor(input), {});
				} catch (err) {
					message = (err as Error).message;
				}
				const named = message.includes(flag) && message.includes('is not accepted');
				const reasoned = message.length > `${flag} is not accepted by \`etherfold ${command}\`: `.length + 20;
				if (!named || !reasoned) holes.push(`${command}/${input}: ${message}`);
			}
		}
		expect(holes).toEqual([]);
	});
});

describe('`upload` takes a bundle, a node, a name and a credential, and nothing a deployment is configured with', () => {
	const SENDING: Options = {bundle: './dist/processor.js', to: 'http://localhost:2000', indexer: 'nfts'};

	it('resolves its row, with the credential from ADMIN_TOKEN behind --admin-token', () => {
		expect(resolveCommandConfig('upload', SENDING, {ADMIN_TOKEN: 'secret'})).toEqual({
			command: 'upload',
			bundle: './dist/processor.js',
			to: 'http://localhost:2000',
			indexer: 'nfts',
			adminToken: 'secret',
		});
		expect(resolveCommandConfig('upload', {...SENDING, adminToken: 'flag'}, {ADMIN_TOKEN: 'env'}).adminToken).toBe(
			'flag',
		);
	});

	it('takes the target from UPLOAD_TO and the name from INDEXER_NAME, as every command takes its inputs', () => {
		const config = resolveCommandConfig(
			'upload',
			{bundle: './b.js'},
			{UPLOAD_TO: 'https://node.example', INDEXER_NAME: 'nfts', ADMIN_TOKEN: 's'},
		);
		expect(config).toMatchObject({to: 'https://node.example', indexer: 'nfts'});
	});

	it('REQUIRES the indexer name, which `run` defaults, because a sender that defaulted it deploys to the wrong one', () => {
		expect(() => resolveCommandConfig('upload', {bundle: './b.js', to: 'http://x'}, {ADMIN_TOKEN: 's'})).toThrow(
			/--indexer \(INDEXER_NAME\) is required by `etherfold upload`.*never defaulted/s,
		);
	});

	it('never reads ETH_NODE_URI as the node to send to, and ignores it as the ambient variable it is', () => {
		expect(() =>
			resolveCommandConfig('upload', {bundle: './b.js', indexer: 'n'}, {ADMIN_TOKEN: 's', ETH_NODE_URI: 'http://x'}),
		).toThrow(/--to \(UPLOAD_TO\) is required by `etherfold upload`/);
		// ambient, so not refused: a CI job that also runs `build` has it set
		expect(() => resolveCommandConfig('upload', SENDING, {ADMIN_TOKEN: 's', ETH_NODE_URI: 'http://x'})).not.toThrow();
	});

	it('refuses the flags of the node it addresses, each pointing at where that input lives', () => {
		const refusal = (extra: Options): string => {
			try {
				resolveCommandConfig('upload', {...SENDING, ...extra}, {ADMIN_TOKEN: 's'});
			} catch (err) {
				return (err as Error).message;
			}
			return '';
		};
		expect(refusal({nodeUrl: 'http://x'})).toMatch(/not accepted by `etherfold upload`.*--to \(UPLOAD_TO\)/s);
		expect(refusal({deployments: './d'})).toMatch(/CARRIES ITS OWN CONTRACTS/);
		expect(refusal({db: ':memory:'})).toMatch(/opens no database/);
		expect(refusal({promotion: 'immediate'})).toMatch(/RECEIVING node/);
		expect(refusal({ingestToken: 't'})).toMatch(/ADMIN credential/);
	});

	it('refuses --to and --admin-token on the six commands that send no bundle', () => {
		for (const command of ['run', 'node', 'build', 'fetch', 'index', 'serve'] as const) {
			expect(OWNERSHIP[command].to, command).toBe('refused');
			expect(OWNERSHIP[command].adminToken, command).toBe('refused');
		}
		// the ones that SERVE the admin surface say where their own credential comes from
		expect(() => resolveCommandConfig('run', {...FOLDING, adminToken: 's'}, {})).toThrow(
			/read from ADMIN_TOKEN in its ENVIRONMENT/,
		);
	});
});

/** One options object carrying exactly the input under test, so the refusal has to be about that one. */
function valueFor(input: ConfigInput): Options {
	if (input === 'autoSetup') return {autoSetup: false};
	// a plain BOOLEAN flag: commander materialises `true` only where it was typed, so
	// a string here would read as "not given" and the refusal would never be reached
	if (input === 'dropOnPromotion') return {dropOnPromotion: true};
	if (input === 'override') return {override: true};
	const key = input === 'source' ? 'deployments' : input;
	return {[key]: 'x'} as Options;
}

// ---------------------------------------------------------------------------------------------------
// WHEN THE CANONICAL POINTER MOVES, AS A CONFIGURATION INPUT
// ---------------------------------------------------------------------------------------------------
// The three policies were built, argued for and unreachable from the shape most
// people run: no command passed a promotion config, so every CLI deployment
// silently took `on-catch-up`. This is that input, and it obeys every rule the
// others do -- one name, a flag that beats the variable, a REFUSAL rather than an
// invented default for a value nobody recognises, and an ownership row per
// command.
// ---------------------------------------------------------------------------------------------------

describe('an operator selects WHEN a successor takes over', () => {
	it('takes each of the three policies on the shape that promotes', () => {
		for (const policy of PROMOTION_POLICIES) {
			expect(resolveCommandConfig('run', {...FOLDING, promotion: policy}, {}).promotion).toEqual({policy});
		}
	});

	it('says NOTHING when nothing was given, so the default stays the one place it is written', () => {
		// deliberately NOT `{policy: 'on-catch-up'}`: the default lives with the type it
		// belongs to (`resolvePromotionConfig`, `@etherfold/core`), and a second runtime
		// restating it is what that module exists to prevent
		expect(resolveCommandConfig('run', FOLDING, {}).promotion).toBeUndefined();
	});

	it('lets PROMOTION_POLICY stand behind the flag, and the flag win', () => {
		expect(resolveCommandConfig('run', FOLDING, {PROMOTION_POLICY: 'manual'}).promotion).toEqual({policy: 'manual'});
		expect(
			resolveCommandConfig('run', {...FOLDING, promotion: 'immediate'}, {PROMOTION_POLICY: 'manual'}).promotion,
		).toEqual({policy: 'immediate'});
	});

	it('reads a BLANK variable as unset rather than as an empty answer', () => {
		expect(resolveCommandConfig('run', FOLDING, {PROMOTION_POLICY: '   '}).promotion).toBeUndefined();
	});

	it('REFUSES a value nobody recognises, naming the three that exist', () => {
		expect(() => resolveCommandConfig('run', {...FOLDING, promotion: 'when-i-say-so'}, {})).toThrow(
			/--promotion \(PROMOTION_POLICY\) "when-i-say-so" is not a promotion policy/,
		);
		for (const policy of PROMOTION_POLICIES) {
			expect(() => resolveCommandConfig('run', {...FOLDING, promotion: 'when-i-say-so'}, {})).toThrow(
				new RegExp(`'${policy}'`),
			);
		}
		// ...and the variable is refused in exactly the same shape, rather than shrugged at
		expect(() => resolveCommandConfig('run', FOLDING, {PROMOTION_POLICY: 'eventually'})).toThrow(
			/is not a promotion policy/,
		);
	});

	it('carries drop-on-promotion as the other half of ONE configuration', () => {
		expect(resolveCommandConfig('run', {...FOLDING, dropOnPromotion: true}, {}).promotion).toEqual({
			dropOnPromotion: true,
		});
		expect(resolveCommandConfig('run', {...FOLDING, promotion: 'manual', dropOnPromotion: true}, {}).promotion).toEqual(
			{
				policy: 'manual',
				dropOnPromotion: true,
			},
		);
	});

	it('REFUSES the one combination this runtime cannot honour, naming what to use instead', () => {
		// `immediate` makes a successor canonical BEFORE it has caught up, so the previous
		// generation must be retained until it catches up -- and that deferral is not built
		// on this runtime. Refused HERE, in the pure resolver, rather than from inside the
		// container after a database has been opened and a module imported.
		expect(() => resolveCommandConfig('run', {...FOLDING, promotion: 'immediate', dropOnPromotion: true}, {})).toThrow(
			/--promotion immediate.*--drop-on-promotion/s,
		);
		expect(() => resolveCommandConfig('run', {...FOLDING, promotion: 'immediate', dropOnPromotion: true}, {})).toThrow(
			/--promotion on-catch-up/,
		);
		// ...and through the variable too, since a deployment may say it either way
		expect(() =>
			resolveCommandConfig('run', {...FOLDING, dropOnPromotion: true}, {PROMOTION_POLICY: 'immediate'}),
		).toThrow(/is not available on this runtime/);
	});

	it('is owned by `run` and `node`, the commands that hold a successor while they run, and refused by every other', () => {
		for (const command of ['run', 'node'] as const) {
			expect(OWNERSHIP[command].promotion).toBe('optional');
			expect(OWNERSHIP[command].dropOnPromotion).toBe('optional');
		}
		for (const command of ['build', 'fetch', 'index', 'serve', 'upload'] as const) {
			expect(OWNERSHIP[command].promotion).toBe('refused');
			expect(OWNERSHIP[command].dropOnPromotion).toBe('refused');
		}
		// It used to pin "never promotes", which stopped being true: a re-run `build`
		// with changed processor bytes registers a successor at start-up and SETTLES the
		// pointer onto it before exiting, or the artifact it publishes serves the fold the
		// previous build left behind. What is pinned now is what the refusal is ABOUT --
		// this command takes no INPUT -- which is the part ADR-0048 says may later widen
		// from refused to optional without breaking anything.
		expect(() => resolveCommandConfig('build', {...FOLDING, promotion: 'immediate'}, {})).toThrow(
			/--promotion \(PROMOTION_POLICY\) is not accepted by `etherfold build`.*takes no promotion input/s,
		);
		expect(() => resolveCommandConfig('build', {...FOLDING, dropOnPromotion: true}, {})).toThrow(
			/--drop-on-promotion is not accepted by `etherfold build`/,
		);
	});

	it('IGNORES an ambient PROMOTION_POLICY on a command that does not own it', () => {
		// the same asymmetry every other input has: a FLAG a command does not own is
		// refused, an ambient VARIABLE is simply not read, because one host runs several
		// of these side by side
		expect(() => resolveCommandConfig('build', FOLDING, {PROMOTION_POLICY: 'immediate'})).not.toThrow();
		expect(resolveCommandConfig('build', FOLDING, {PROMOTION_POLICY: 'immediate'})).not.toHaveProperty('promotion');
	});

	it('documents the values and the default where the flag is described, so --help says them', () => {
		for (const policy of PROMOTION_POLICIES) {
			expect(INPUTS.promotion.describe).toContain(policy);
		}
		expect(INPUTS.promotion.variable).toBe('PROMOTION_POLICY');
		// a BOOLEAN, and the one boolean convention this module has: flag-only, like
		// `--no-auto-setup`, rather than a truthiness spelling invented for one input
		expect(INPUTS.dropOnPromotion.variable).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------------------------------
// A SOURCE WITHOUT A CHAIN CALL
// ---------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------
// `node` TAKES NO PROCESSOR AND NO SOURCE, AND `run` REQUIRES ITS PROCESSOR (ADR-0094)
// ---------------------------------------------------------------------------------------------------
// This block pinned ADR-0093's exception on `run` (no processor and no source,
// together). ADR-0094 moved the exception to a command of its own: `node` RECEIVES its
// code and is configured with none of it, and `run` is CONFIGURED and receives none.
// ---------------------------------------------------------------------------------------------------

describe('`node` takes the chain, the store and the database, and no processor and no source', () => {
	const {processor, deployments, ...NOTHING} = FOLDING;

	it('resolves its row, with nothing standing in for a processor or a source', () => {
		const config = resolveCommandConfig('node', NOTHING, {});
		expect(config).toEqual({
			command: 'node',
			nodeUrl: 'http://localhost:8545',
			destination: {kind: 'store', store: 'sqlite', db: 'file:./etherfold.db', retention: 'unbounded'},
			serving: {port: 2000, autoSetup: true},
			indexer: DEFAULT_INDEXER_NAME,
		});
		expect(config).not.toHaveProperty('processor');
		expect(config).not.toHaveProperty('source');
		expect(OWNERSHIP.node.processor).toBe('refused');
		expect(OWNERSHIP.node.source).toBe('refused');
	});

	it('REFUSES -p and --deployments by name, pointing at `etherfold upload`', () => {
		expect(() => resolveCommandConfig('node', {...NOTHING, processor: './p.js'}, {})).toThrow(
			/--processor is not accepted by `etherfold node`.*`etherfold upload`/s,
		);
		expect(() => resolveCommandConfig('node', {...NOTHING, deployments: './deployments'}, {})).toThrow(
			/--deployments \(INDEXING_SOURCE\) is not accepted by `etherfold node`.*CARRIES ITS OWN CONTRACTS.*`etherfold upload`/s,
		);
	});

	it('does NOT read INDEXING_SOURCE, an ambient variable it does not own: not refused, and not used', () => {
		// one host may run `node` beside a configured command that owns it (ADR-0048), so it
		// is neither refused nor parsed: even one that is not a source at all passes
		for (const value of [SOURCE_JSON, 'not json at all']) {
			const config = resolveCommandConfig('node', NOTHING, {INDEXING_SOURCE: value});
			expect(config).not.toHaveProperty('source');
		}
	});

	it('refuses --override, since its starts replace nothing, naming the commands that take it', () => {
		expect(OWNERSHIP.node.override).toBe('refused');
		expect(() => resolveCommandConfig('node', {...NOTHING, override: true}, {})).toThrow(
			/--override is not accepted by `etherfold node`.*replaces nothing.*`run`, `build` and `index`/s,
		);
	});

	it('takes --promotion and --drop-on-promotion as `run` does', () => {
		expect(resolveCommandConfig('node', {...NOTHING, promotion: 'manual'}, {}).promotion).toEqual({policy: 'manual'});
		expect(resolveCommandConfig('node', NOTHING, {PROMOTION_POLICY: 'immediate'}).promotion).toEqual({
			policy: 'immediate',
		});
		expect(resolveCommandConfig('node', {...NOTHING, dropOnPromotion: true}, {}).promotion).toEqual({
			dropOnPromotion: true,
		});
		expect(resolveCommandConfig('node', NOTHING, {}).promotion).toBeUndefined();
	});

	it('defaults the indexer name as `run` does, and requires the chain, the store and the database', () => {
		expect(resolveCommandConfig('node', {...NOTHING, indexer: 'nfts'}, {}).indexer).toBe('nfts');
		expect(resolveCommandConfig('node', NOTHING, {}).indexer).toBe(resolveCommandConfig('run', FOLDING, {}).indexer);
		const {nodeUrl, ...noNode} = NOTHING;
		expect(() => resolveCommandConfig('node', noNode, {})).toThrow(/--node-url \(ETH_NODE_URI\)/);
		const {db, ...noDb} = NOTHING;
		expect(() => resolveCommandConfig('node', noDb, {})).toThrow(/--db \(DB\)/);
		const {store, ...noStore} = NOTHING;
		expect(() => resolveCommandConfig('node', noStore, {})).toThrow(/--store/);
	});
});

describe('`run` REQUIRES its processor, and names `etherfold node` for the start with none', () => {
	const {processor, deployments, ...NOTHING} = FOLDING;

	it('refuses NEITHER processor nor source, naming `etherfold node`', () => {
		expect(OWNERSHIP.run.processor).toBe('required');
		expect(() => resolveCommandConfig('run', NOTHING, {})).toThrow(
			/--processor is required by `etherfold run`.*that is `etherfold node`/s,
		);
	});

	it('refuses a SOURCE with no processor the same way, by either spelling', () => {
		expect(() => resolveCommandConfig('run', {...NOTHING, deployments: './deployments'}, {})).toThrow(
			/--processor is required by `etherfold run`.*`etherfold node`/s,
		);
		expect(() => resolveCommandConfig('run', NOTHING, {INDEXING_SOURCE: SOURCE_JSON})).toThrow(
			/--processor is required by `etherfold run`.*`etherfold node`/s,
		);
	});

	it('still takes a processor with no source, as it always did', () => {
		const config = resolveCommandConfig('run', {...NOTHING, processor: './p.js'}, {});
		expect(config.processor).toBe('./p.js');
		expect(config.source).toEqual({from: 'processor-module'});
	});

	it('leaves `build`, `fetch` and `index` requiring what they required', () => {
		expect(() => resolveCommandConfig('build', NOTHING, {})).toThrow(/--processor is required by `etherfold build`/);
		expect(() =>
			resolveCommandConfig(
				'index',
				{store: 'sqlite', db: 'file:./x.db', deployments: './d', ingestToken: 't', indexer: 'alpha'},
				{},
			),
		).toThrow(/--processor is required by `etherfold index`/);
		expect(() =>
			resolveCommandConfig(
				'fetch',
				{nodeUrl: 'http://x', ingestEndpoint: 'http://s', ingestToken: 't', indexer: 'a'},
				{},
			),
		).toThrow(/--deployments.*INDEXING_SOURCE/s);
		for (const command of ['build', 'index'] as const) {
			expect(OWNERSHIP[command].processor).toBe('required');
		}
	});
});

describe('the source resolves without a chain call, or is refused naming both explicit forms', () => {
	it('takes the deployments folder first', () => {
		const config = resolveCommandConfig('build', FOLDING, {INDEXING_SOURCE: SOURCE_JSON});
		expect(config.source).toEqual({from: 'deployments', folder: './deployments'});
	});

	it('takes INDEXING_SOURCE behind it, parsed', () => {
		const {deployments, ...noFolder} = FOLDING;
		const config = resolveCommandConfig('build', noFolder, {INDEXING_SOURCE: SOURCE_JSON});
		expect(config.source).toMatchObject({from: 'INDEXING_SOURCE', source: {chainId: '1'}});
	});

	it('refuses an INDEXING_SOURCE that is not one, naming the field', () => {
		const {deployments, ...noFolder} = FOLDING;
		expect(() => resolveCommandConfig('build', noFolder, {INDEXING_SOURCE: '{"contracts": []}'})).toThrow(
			/INDEXING_SOURCE\.chainId/,
		);
	});

	it('falls back to the processor module for a command that CAN ask a node', () => {
		const {deployments, ...noFolder} = FOLDING;
		expect(resolveCommandConfig('build', noFolder, {}).source).toEqual({from: 'processor-module'});
	});

	it('refuses the module route on `index`, naming both explicit forms and the reason', () => {
		const receiver: Options = {
			processor: './p.js',
			store: 'sqlite',
			db: ':memory:',
			ingestToken: 't',
			indexer: 'alpha',
		};
		expect(() => resolveCommandConfig('index', receiver, {})).toThrow(/--deployments \(INDEXING_SOURCE\)/);
		expect(() => resolveCommandConfig('index', receiver, {})).toThrow(/NO chain call/);
		expect(() => resolveCommandConfig('index', receiver, {})).toThrow(/INDEXING_SOURCE as JSON/);
	});

	it('refuses the module route on `fetch`, for the other reason: it holds no processor', () => {
		const fetching: Options = {nodeUrl: 'http://n', ingestEndpoint: 'http://s', ingestToken: 't', indexer: 'alpha'};
		expect(() => resolveCommandConfig('fetch', fetching, {})).toThrow(/holds NO processor/);
		expect(() => resolveCommandConfig('fetch', fetching, {})).toThrow(/--deployments \(INDEXING_SOURCE\)/);
	});

	it('lets a chain-free command resolve from either explicit form', () => {
		const receiver: Options = {
			processor: './p.js',
			store: 'sqlite',
			db: ':memory:',
			ingestToken: 't',
			indexer: 'alpha',
		};
		expect(resolveCommandConfig('index', {...receiver, deployments: './d'}, {}).source).toEqual({
			from: 'deployments',
			folder: './d',
		});
		expect(resolveCommandConfig('index', receiver, {INDEXING_SOURCE: SOURCE_JSON}).source).toMatchObject({
			from: 'INDEXING_SOURCE',
		});
	});
});

// ---------------------------------------------------------------------------------------------------
// WHAT MAY DEFAULT, AND WHAT MAY NOT
// ---------------------------------------------------------------------------------------------------

describe('the port is the one input that falls back to a default', () => {
	it('takes the flag, then PORT, then 2000', () => {
		expect(resolveCommandConfig('serve', {db: ':memory:', port: '3000'}, {PORT: '4000'}).serving.port).toBe(3000);
		expect(resolveCommandConfig('serve', {db: ':memory:'}, {PORT: '4000'}).serving.port).toBe(4000);
		expect(resolveCommandConfig('serve', {db: ':memory:'}, {}).serving.port).toBe(2000);
	});

	it('refuses something that is not a port', () => {
		expect(() => resolveCommandConfig('serve', {db: ':memory:', port: 'http'}, {})).toThrow(/--port \(PORT\)/);
		expect(() => resolveCommandConfig('serve', {db: ':memory:'}, {PORT: '99999'})).toThrow(/0 to 65535/);
	});

	it('binds every interface unless a host is named, and applies the schema unless told not to', () => {
		expect(resolveCommandConfig('serve', {db: ':memory:'}, {}).serving).toEqual({port: 2000, autoSetup: true});
		expect(resolveCommandConfig('serve', {db: ':memory:', host: '127.0.0.1', autoSetup: false}, {}).serving).toEqual({
			port: 2000,
			hostname: '127.0.0.1',
			autoSetup: false,
		});
	});
});

describe('retention is BLOCK NUMBERS (ADR-0019), and defaults to the store\u2019s own default', () => {
	it('reads a bare number as a window of blocks', () => {
		expect(resolveCommandConfig('build', {...FOLDING, retention: '500'}, {}).destination).toMatchObject({
			retention: {blocks: 500},
		});
	});

	it('takes the two named ends, and defaults to unbounded', () => {
		expect(resolveCommandConfig('build', {...FOLDING, retention: 'revert-only'}, {}).destination).toMatchObject({
			retention: 'revert-only',
		});
		expect(resolveCommandConfig('build', FOLDING, {}).destination).toMatchObject({retention: 'unbounded'});
	});

	it('refuses a duration, naming the one unit there is', () => {
		expect(() => resolveCommandConfig('build', {...FOLDING, retention: '2 days'}, {})).toThrow(/block/i);
	});

	it('refuses a negative or fractional window', () => {
		expect(() => resolveCommandConfig('build', {...FOLDING, retention: '-1'}, {})).toThrow(/block/i);
		expect(() => resolveCommandConfig('build', {...FOLDING, retention: '1.5'}, {})).toThrow(/block/i);
	});
});

describe('--prune-interval is the cadence a command with no cycle needs', () => {
	/** A resolvable receiver, which is the one command that owns this flag. */
	const RECEIVING: Options = {
		processor: './p.js',
		store: 'sqlite',
		db: ':memory:',
		deployments: './d',
		indexer: 'alpha',
		ingestToken: 't',
	};

	it('reads seconds, and leaves the default alone when nothing was said', () => {
		expect(resolveCommandConfig('index', {...RECEIVING, pruneInterval: '300'}, {}).pruneIntervalSeconds).toBe(300);
		// undefined and not a number: the DEFAULT lives in one place (`pruning.ts`),
		// so the resolver saying nothing is how it stays there
		expect(resolveCommandConfig('index', RECEIVING, {}).pruneIntervalSeconds).toBeUndefined();
	});

	it('stands behind the flag as PRUNE_INTERVAL, like every other input', () => {
		expect(resolveCommandConfig('index', RECEIVING, {PRUNE_INTERVAL: '120'}).pruneIntervalSeconds).toBe(120);
		expect(
			resolveCommandConfig('index', {...RECEIVING, pruneInterval: '30'}, {PRUNE_INTERVAL: '120'}).pruneIntervalSeconds,
		).toBe(30);
	});

	it('takes 0 as "no schedule", which a prune BUDGET of zero is not', () => {
		// the two zeroes mean different things: no cadence is coherent (something else
		// prunes this database), while passes that delete nothing is a miscomputed
		// budget the seam refuses outright
		expect(resolveCommandConfig('index', {...RECEIVING, pruneInterval: '0'}, {}).pruneIntervalSeconds).toBe(0);
	});

	it('refuses a value that is not seconds, and points at the flag that keeps things instead', () => {
		expect(() => resolveCommandConfig('index', {...RECEIVING, pruneInterval: '5 minutes'}, {})).toThrow(/seconds/i);
		expect(() => resolveCommandConfig('index', {...RECEIVING, pruneInterval: 'never'}, {})).toThrow(
			/--retention unbounded/,
		);
	});

	it('is REFUSED by every command that prunes on a cycle, naming the cadence it already has', () => {
		// the asymmetry is the point, and it is documented rather than silent: `run`
		// and `build` prune in the gap they already wait, so a second clock would be a
		// second answer to a question their poll interval settles
		for (const command of ['run', 'build'] as const) {
			expect(() => resolveCommandConfig(command, {...FOLDING, pruneInterval: '60'}, {})).toThrow(/CYCLE/);
		}
	});

	it('is REFUSED by the commands that hold no state to prune', () => {
		expect(() =>
			resolveCommandConfig(
				'fetch',
				{deployments: './d', indexer: 'a', ingestEndpoint: 'http://x', pruneInterval: '60'},
				{},
			),
		).toThrow(/no state/i);
		expect(() => resolveCommandConfig('serve', {db: ':memory:', pruneInterval: '60'}, {})).toThrow(/folds nothing/i);
	});
});

describe('--rps is a rate, and REQUESTS_PER_SECOND stands behind it', () => {
	it('parses the flag to a number, so the provider is not handed a string', () => {
		expect(resolveCommandConfig('build', {...FOLDING, rps: '5'}, {}).rps).toBe(5);
	});

	it('falls back to the fetcher host\u2019s own variable rather than a second name', () => {
		expect(resolveCommandConfig('build', FOLDING, {REQUESTS_PER_SECOND: '7'}).rps).toBe(7);
	});

	it('is absent when neither is set, so the provider keeps its own default', () => {
		expect(resolveCommandConfig('build', FOLDING, {}).rps).toBeUndefined();
	});

	it('refuses something that is not a rate', () => {
		expect(() => resolveCommandConfig('build', {...FOLDING, rps: 'fast'}, {})).toThrow(/--rps/);
	});
});

// ---------------------------------------------------------------------------------------------------
// SEVEN ROWS, ONE PATH
// ---------------------------------------------------------------------------------------------------

describe('all seven rows of the table resolve', () => {
	const cases: {command: CommandName; options: Options; env: Record<string, string>}[] = [
		{command: 'run', options: FOLDING, env: {}},
		{command: 'node', options: {nodeUrl: 'http://n', store: 'sqlite', db: ':memory:'}, env: {}},
		{command: 'build', options: FOLDING, env: {}},
		{
			command: 'fetch',
			options: {nodeUrl: 'http://n', deployments: './d'},
			env: {INGEST_ENDPOINT: 'http://server', INGEST_TOKEN: 'shared', INDEXER_NAME: 'alpha'},
		},
		{
			command: 'index',
			options: {processor: './p.js', store: 'sqlite', db: ':memory:', deployments: './d'},
			env: {INGEST_TOKEN: 'shared', INDEXER_NAME: 'alpha'},
		},
		{command: 'serve', options: {}, env: {DB: 'file:./etherfold.db'}},
		{
			command: 'upload',
			options: {bundle: './dist/processor.js'},
			env: {UPLOAD_TO: 'http://node:2000', INDEXER_NAME: 'alpha', ADMIN_TOKEN: 'admin'},
		},
	];

	for (const {command, options, env} of cases) {
		it(`${command} resolves off the same path`, () => {
			expect(resolveCommandConfig(command, options, env).command).toBe(command);
		});
	}

	it('gives `fetch` a sending wire and `index` the receiving half of the same secret', () => {
		const sender = resolveCommandConfig(
			'fetch',
			{nodeUrl: 'http://n', deployments: './d'},
			{INGEST_ENDPOINT: 'http://server', INGEST_TOKEN: 'shared', INDEXER_NAME: 'alpha'},
		);
		const receiver = resolveCommandConfig(
			'index',
			{processor: './p.js', store: 'sqlite', db: ':memory:', deployments: './d'},
			{INGEST_TOKEN: 'shared', INDEXER_NAME: 'alpha'},
		);
		expect(sender.wire).toEqual({kind: 'sending', indexer: 'alpha', endpoint: 'http://server', token: 'shared'});
		// the SAME name on both sides, which is what makes splitting a deployment
		// change: the sender presents it, the receiver checks it -- and the SAME indexer
		// NAME, which is what makes them the two halves of ONE named indexer
		expect(receiver.wire).toEqual({kind: 'receiving', indexer: 'alpha', token: 'shared'});
	});

	it('gives the serving commands an address and the others none', () => {
		expect(resolveCommandConfig('run', FOLDING, {}).serving.port).toBe(2000);
		expect(resolveCommandConfig('node', {nodeUrl: 'http://n', store: 'sqlite', db: ':memory:'}, {}).serving.port).toBe(
			2000,
		);
		expect(resolveCommandConfig('serve', {db: ':memory:'}, {}).serving.port).toBe(2000);
		expect(resolveCommandConfig('build', FOLDING, {})).not.toHaveProperty('serving');
	});

	it('gives every folding command a store target and `serve` a database it only reads', () => {
		expect(resolveCommandConfig('build', FOLDING, {}).destination.kind).toBe('store');
		expect(resolveCommandConfig('serve', {db: ':memory:'}, {}).destination).toEqual({
			kind: 'database',
			db: ':memory:',
		});
		expect(
			resolveCommandConfig(
				'fetch',
				{nodeUrl: 'http://n', deployments: './d'},
				{
					INGEST_ENDPOINT: 'http://s',
					INGEST_TOKEN: 't',
					INDEXER_NAME: 'alpha',
				},
			),
		).not.toHaveProperty('destination');
	});
});

// ---------------------------------------------------------------------------------------------------
// WHETHER A START MAY REPLACE A DIFFERENT PENDING SUCCESSOR, as a configuration input
// ---------------------------------------------------------------------------------------------------
// `--override` (ADR-0084's and ADR-0093's amendments of 2026-09-26). What it DOES is
// asserted end to end in `anUploadedProcessorSurvivesARestart.test.ts`; what is pinned
// here is the input: every command that STARTS with a configured processor (`run`,
// `build`, `index`) owns it, as a flag with no variable, and every other command refuses
// it by name.
// ---------------------------------------------------------------------------------------------------

describe('an operator lets a START replace a pending successor', () => {
	it('is a plain flag on `run` and `build`, off unless typed, with no environment variable', () => {
		for (const command of ['run', 'build'] as const) {
			expect(resolveCommandConfig(command, FOLDING, {}).override).toBe(false);
			expect(resolveCommandConfig(command, {...FOLDING, override: true}, {}).override).toBe(true);
		}
		expect(INPUTS.override.variable).toBeUndefined();
	});

	it('is owned by every command that starts with a processor, and refused by the rest with the reason', () => {
		for (const command of ['run', 'build', 'index'] as const) {
			expect(OWNERSHIP[command].override).toBe('optional');
		}
		for (const command of ['node', 'fetch', 'serve', 'upload'] as const) {
			expect(OWNERSHIP[command].override).toBe('refused');
		}
		expect(() => resolveCommandConfig('serve', {db: ':memory:', override: true}, {})).toThrow(
			/--override is not accepted by `etherfold serve`.*this command holds no processor/s,
		);
	});
});
