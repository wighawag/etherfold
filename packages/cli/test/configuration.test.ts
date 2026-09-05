import {describe, expect, it} from 'vitest';
import {DEFAULT_INDEXER_NAME, INPUTS, OWNERSHIP, resolveCommandConfig, type ConfigInput} from '../src/config.js';
import type {CommandName, Options} from '../src/types.js';

// ---------------------------------------------------------------------------------------------------
// ONE CONFIGURATION PATH, FIVE COMMANDS
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

/** One options object carrying exactly the input under test, so the refusal has to be about that one. */
function valueFor(input: ConfigInput): Options {
	if (input === 'autoSetup') return {autoSetup: false};
	const key = input === 'source' ? 'deployments' : input;
	return {[key]: 'x'} as Options;
}

// ---------------------------------------------------------------------------------------------------
// A SOURCE WITHOUT A CHAIN CALL
// ---------------------------------------------------------------------------------------------------

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
// FIVE ROWS, ONE PATH
// ---------------------------------------------------------------------------------------------------

describe('all five rows of the table resolve', () => {
	const cases: {command: CommandName; options: Options; env: Record<string, string>}[] = [
		{command: 'run', options: FOLDING, env: {}},
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

	it('gives the three serving commands an address and the two others none', () => {
		expect(resolveCommandConfig('run', FOLDING, {}).serving.port).toBe(2000);
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
