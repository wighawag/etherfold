import type {Abi} from '@etherfold/core';
import {parseIndexingSource, type EnvRecord} from '@etherfold/fetcher-host';
import type {RetentionSetting} from '@etherfold/processor-entities';
import type {
	CommandName,
	ConfigFor,
	DatabaseTarget,
	ExplicitSource,
	Options,
	ResolvedConfig,
	Serving,
	SourceOrigin,
	StoreTarget,
} from './types.js';

// ---------------------------------------------------------------------------------------------------
// ONE CONFIGURATION PATH FOR EVERY COMMAND (ADR-0048)
// ---------------------------------------------------------------------------------------------------
// Moving between the five commands is a DEPLOYMENT change and never a rewrite,
// and that is a property of this file. Every command reads the same inputs, under
// the same flag and the same variable, through the same resolver, and refuses in
// the same shape.
//
// The rules, none of them negotiable:
//
//  - **A flag beats the environment**, the environment is used when the flag is
//    absent, and neither present is a REFUSAL rather than a default. There are
//    exactly three defaults in this file and each says why it is one.
//  - **ONE name per input.** The variables are the fetcher host's, because it
//    already refuses by name and those names are the published contract of a
//    deployable, plus the two the Node server adapter already reads. The CLI's
//    own second name for the node URL (`ETHEREUM_NODE`) is RETIRED here.
//  - **Requiredness lives here and not in the parser**, so every refusal is a
//    function a test can call over an options object and an environment record.
//  - **A refusal names the flag AND the variable** that would have satisfied it.
//  - **Nothing is accepted and ignored.** An accepted-and-ignored flag is a
//    deployment believing something untrue -- a node URL nothing dials, a store
//    nothing writes -- so an input a command does not OWN is refused with the
//    reason it does not own it.
//
// One deliberate asymmetry inside that last rule: what is refused is a FLAG a
// user typed, never an ambient VARIABLE. `ETH_NODE_URI` set on a host that runs
// `fetch` and `index` side by side is ordinary, and refusing `index` because the
// machine also has a node URL would make the split deployment this system is FOR
// impossible to configure. So a command reads only the variables it owns and
// leaves the rest alone.
// ---------------------------------------------------------------------------------------------------

/** Every input any command takes. `source` is the indexing source, whose flag form is a deployments folder. */
export type ConfigInput =
	| 'processor'
	| 'source'
	| 'nodeUrl'
	| 'rps'
	| 'store'
	| 'db'
	| 'retention'
	| 'port'
	| 'host'
	| 'autoSetup'
	| 'indexer'
	| 'ingestEndpoint'
	| 'ingestToken';

/**
 * What ONE command does with ONE input.
 *
 * `required` and `optional` both mean OWNED, and the parser registers them
 * visibly; the difference between them is documentation of the table below, and
 * the actual refusal is made by the resolver. `refused` means the command does
 * not own the input at all: the parser registers it HIDDEN so that a flag copied
 * across from another command reaches this module and gets an answer, instead of
 * commander's `unknown option`, which names no reason and no alternative.
 */
export type Ownership = 'required' | 'optional' | 'refused';

export type InputSpec = {
	/** The flag, in commander's own syntax. */
	readonly flag: string;
	/** The ONE variable behind it, where there is one. */
	readonly variable?: string;
	/** Help text, so the flag is described in exactly one place. */
	readonly describe: string;
};

/**
 * The NAME a COMBINED process folds under when the operator named none, and the
 * SECOND default this file has ever had -- ADR-0048 allowed exactly one, the
 * port, and this is the amendment ADR-0052 records.
 *
 * ## What the name is for here, which is not routing
 *
 * Every row of the stored emission stream is keyed on `(indexer, stream, seq)`,
 * and `indexer` is `NOT NULL`: a fold that stores what it folded needs a name
 * whether or not anything addresses it by one. A combined `run` has no wire, no
 * route and no second tenant to be confused with -- it is one process, one
 * database, one answer set -- so the value is a LABEL on rows it alone writes and
 * alone reads back.
 *
 * ## Why defaulting it does not re-open ADR-0036's never-defaulted rule
 *
 * That rule protects the WIRE: a name a host was not built with must be a
 * ROUTING error (`404`) and never a batch that landed somewhere plausible, so
 * `fetch` and `index` require it and default nothing. Nothing here routes, so
 * the hazard the rule exists for cannot occur. What defaulting it here would
 * cost, weighed against ADR-0048's test ("what does it look like when this is
 * wrong and nobody notices?"): a run under an unintended name stores its
 * emissions under that name in its OWN database, and reads them back under the
 * same one, so nothing is mis-answered and nothing is lost -- the visible
 * consequence is a feed served under a name an operator did not expect, which is
 * a label they can correct with `--indexer` and re-index or rename. Against
 * that, REQUIRING it would break `etherfold run`, the readme's headline
 * one-liner, for a discriminator that only starts to matter once two answer sets
 * share a database.
 *
 * A CONSTANT and deliberately not derived from the database file's name: rows
 * already stored must keep being found after a file is copied or moved, and a
 * name that moved with the path would silently fork the stored stream in two.
 * `run` and `build` take the same one, so an artifact one built is one the other
 * continues.
 */
export const DEFAULT_INDEXER_NAME = 'default';

/**
 * The name of every input, once.
 *
 * Six inputs have an environment variable and six do not, and the line between
 * them is not an accident: **the environment carries what varies between
 * deployments of one image** (the chain, the source, the database, the wire and
 * the port), while a flag carries what the image IS (which processor module,
 * which store, which retention window, which interface). That is why the six
 * variables are exactly the fetcher host's four plus the Node adapter's two: they
 * are already the published contract of a deployable, and inventing a seventh
 * name here would be inventing a second way to say something.
 */
export const INPUTS: Readonly<Record<ConfigInput, InputSpec>> = {
	processor: {
		flag: '-p, --processor <path>',
		describe: 'the event processor module (it must export a field named "createProcessor")',
	},
	source: {
		flag: '-d, --deployments <folder>',
		variable: 'INDEXING_SOURCE',
		describe:
			'what to index, as a folder of contract deployments in hardhat-deploy/rocketh format. ' +
			'INDEXING_SOURCE carries the same thing as JSON ({chainId, contracts}). Optional where the ' +
			'processor module supplies its own contract data, which costs an eth_chainId call to read',
	},
	nodeUrl: {flag: '-n, --node-url <url>', variable: 'ETH_NODE_URI', describe: "the chain's JSON-RPC endpoint"},
	rps: {flag: '--rps <n>', variable: 'REQUESTS_PER_SECOND', describe: 'cap the requests per second made to the node'},
	store: {
		flag: '--store <sqlite>',
		describe: 'where the indexed state goes: versioned entity rows in the libSQL database at --db',
	},
	db: {
		flag: '--db <url>',
		variable: 'DB',
		describe: 'libSQL url, e.g. file:./etherfold.db, :memory: or libsql://<host>',
	},
	retention: {
		flag: '--retention <blocks|revert-only|unbounded>',
		describe:
			'how far back superseded versions are kept, in BLOCK numbers. Nothing prunes automatically: ' +
			'pruning is a call a host schedules (ADR-0022)',
	},
	port: {flag: '--port <port>', variable: 'PORT', describe: 'port to listen on'},
	host: {flag: '--host <hostname>', describe: 'hostname to bind'},
	autoSetup: {flag: '--no-auto-setup', describe: 'do not apply the fixed-table schema at startup'},
	indexer: {
		flag: '--indexer <name>',
		variable: 'INDEXER_NAME',
		describe:
			'the NAMED INDEXER this process holds: one indexed answer set over one chain, and the ' +
			'discriminator every row of the stored emission stream carries. On the WIRE it is also the first ' +
			'segment of every ingest route (/{indexer}/ingest), where it is required and never defaulted, ' +
			`because a receiving host registers the names it was built with. A combined run routes no batch ` +
			`by name, so there it is optional and defaults to '${DEFAULT_INDEXER_NAME}'`,
	},
	ingestEndpoint: {
		flag: '--ingest-endpoint <url>',
		variable: 'INGEST_ENDPOINT',
		describe: 'the indexer-server to push to: /{indexer}/ingest hangs off it',
	},
	ingestToken: {
		flag: '--ingest-token <token>',
		variable: 'INGEST_TOKEN',
		describe:
			'the shared secret of the ingest wire, the same name on both sides. Prefer INGEST_TOKEN: a ' +
			'secret on a command line is visible to every process on the host',
	},
};

/**
 * The command table, as code.
 *
 * | command | processor | source | node URL | destination | serving | indexer name | ingest wire |
 * | --- | --- | --- | --- | --- | --- | --- | --- |
 * | `run` | required | required | required | store + database, required | port and host | optional, defaults | none |
 * | `build` | required | required | required | store + database, required | none | optional, defaults | none |
 * | `fetch` | NOT ACCEPTED | required | required | NOT ACCEPTED | none | REQUIRED | endpoint + token, required |
 * | `index` | required | required, without a chain call | NOT ACCEPTED | store + database, required | port and host | REQUIRED | token (it receives) |
 * | `serve` | NOT ACCEPTED | none | NOT ACCEPTED | database, required | port and host | NOT ACCEPTED | none |
 *
 * The INDEXER NAME has a column of its own, because it is NOT a wire input
 * (ADR-0036: the name is universal, and one discriminator has two sources for
 * its value). On the wire it is what makes a split deployment's two halves agree
 * on one route -- `fetch` addresses `/{indexer}/ingest` and `index` registers
 * exactly that name -- and it is REQUIRED and never defaulted on both halves,
 * because a name a host was not built with must be a routing error rather than a
 * batch that landed somewhere plausible. Off the wire it is what every stored
 * EMISSION row is keyed on, so a FOLDING command needs one whether or not it
 * routes anything: `run` and `build` take it optionally and default it
 * (ADR-0052). `serve` still refuses it outright, because a read tier folds
 * nothing and registers nothing, and would have nothing to do with the value.
 *
 * Two of those rows are asymmetries rather than accidents, and both are load-bearing:
 *
 *  - **`fetch` takes a SOURCE but no processor**, because the chain-facing half
 *    holds no processor by ADR-0003, and it owns no database, so `--store` and
 *    `--db` are REFUSED there rather than optional. A required store flag
 *    inherited by the one command that has no state would land the failure on the
 *    command that should need nothing but a node URL, a source and an endpoint.
 *  - **`index` resolves its source without touching the chain.** It is the
 *    receiving half and makes no chain call at all, so the module route (which
 *    asks a node for its chain id when the module keys contracts per chain) is
 *    unavailable to it and the source must be given explicitly.
 *
 * This table is the ONLY place either fact is written down: the parser registers
 * from it and the resolver refuses from it, so a later command cannot disagree
 * with it by forgetting to.
 */
export const OWNERSHIP: Readonly<Record<CommandName, Readonly<Record<ConfigInput, Ownership>>>> = {
	run: {
		processor: 'required',
		source: 'optional',
		nodeUrl: 'required',
		rps: 'optional',
		store: 'required',
		db: 'required',
		retention: 'optional',
		port: 'optional',
		host: 'optional',
		autoSetup: 'optional',
		indexer: 'optional',
		ingestEndpoint: 'refused',
		ingestToken: 'refused',
	},
	build: {
		processor: 'required',
		source: 'optional',
		nodeUrl: 'required',
		rps: 'optional',
		store: 'required',
		db: 'required',
		retention: 'optional',
		port: 'refused',
		host: 'refused',
		autoSetup: 'refused',
		indexer: 'optional',
		ingestEndpoint: 'refused',
		ingestToken: 'refused',
	},
	fetch: {
		processor: 'refused',
		source: 'required',
		nodeUrl: 'required',
		rps: 'optional',
		store: 'refused',
		db: 'refused',
		retention: 'refused',
		port: 'refused',
		host: 'refused',
		autoSetup: 'refused',
		indexer: 'required',
		ingestEndpoint: 'required',
		ingestToken: 'required',
	},
	index: {
		processor: 'required',
		source: 'required',
		nodeUrl: 'refused',
		rps: 'refused',
		store: 'required',
		db: 'required',
		retention: 'optional',
		port: 'optional',
		host: 'optional',
		autoSetup: 'optional',
		indexer: 'required',
		ingestEndpoint: 'refused',
		ingestToken: 'required',
	},
	serve: {
		processor: 'refused',
		source: 'refused',
		nodeUrl: 'refused',
		rps: 'refused',
		store: 'refused',
		db: 'required',
		retention: 'refused',
		port: 'optional',
		host: 'optional',
		autoSetup: 'optional',
		indexer: 'refused',
		ingestEndpoint: 'refused',
		ingestToken: 'refused',
	},
};

// ---------------------------------------------------------------------------------------------------
// WHY a command does not own an input
// ---------------------------------------------------------------------------------------------------
// One sentence per capability a command lacks, reused across the inputs that
// capability covers. They are written for someone who copied a working command
// line across from another command, because that is the only way to meet one:
// each says what this command is instead, and which command owns the thing they
// were reaching for.
// ---------------------------------------------------------------------------------------------------

const NO_PROCESSOR_FETCH =
	'the chain-facing half holds NO processor (ADR-0003). It fetches ranges of logs and pushes them; ' +
	'whatever folds them lives behind --ingest-endpoint, and that is where the processor goes.';

const NO_PROCESSOR_SERVE =
	'a read tier holds no processor and folds nothing: it answers over a database something ELSE wrote. ' +
	'To fold, that is `index` (receiving pushes) or `run` / `build` (following the chain).';

const NO_STATE_FETCH =
	'a fetcher holds no state -- no cursor, no database (ADR-0003) -- so there is nowhere for it to write. ' +
	'The database belongs to whatever receives the push (`index`), or to `run` / `build`.';

const NO_STORE_SERVE =
	'a read tier folds nothing, so it chooses no store and enforces no retention. It reads the database ' +
	'--db names and writes only the fixed-table schema.';

const NO_SOURCE_SERVE =
	'a read tier indexes nothing, so it has no source: what is in the database is whatever wrote it. ' +
	'INDEXING_SOURCE in the environment is ignored here rather than refused.';

const NO_CHAIN_INDEX =
	'the receiving half makes NO chain call at all -- it folds batches another process pushed to it ' +
	'(ADR-0003), and the chain-facing half of that pair is `fetch`. To follow the chain in this process, ' +
	'that is `run`, or `build` to stop at the tip.';

const NO_CHAIN_SERVE = 'a read tier makes no chain call: it answers over a database something else wrote.';

const NOT_SERVING_BUILD =
	'the one-shot answers no queries -- it folds to the tip and exits, so there is nothing left to bind ' +
	'a port for. To follow the chain AND answer queries, that is `run`.';

const NOT_SERVING_FETCH = 'a fetcher answers no queries: it pushes to one. The HTTP surface is the RECEIVER\u2019s.';

const ALWAYS_MIGRATES_BUILD =
	'the one-shot answers no queries, so there is no startup to decline the fixed-table schema at: it applies ' +
	'it unconditionally, because it binds no port and nothing else in this process ever would. The database it ' +
	'emits is a publishable ARTIFACT and has to carry its own schema version and the reorgs it concluded ' +
	'(ADR-0050), or it loses its provenance the moment it becomes an INPUT. To decline the schema and let ' +
	'something else migrate, that is `run` or `index`, which serve.';

const NO_WIRE_COMBINED =
	'this command runs both halves in ONE process, so they meet through a direct in-process ingestion and ' +
	'there is no wire to configure (`CONTEXT.md`: the wire is a deployment choice, not two implementations). ' +
	'To push to a server elsewhere, that is `fetch`, and to receive those pushes, `index`.';

const NO_WIRE_SERVE =
	'a read tier receives no pushes: its ingestion routes are mounted but answer 501, because holding a ' +
	'processor is a CAPABILITY it does not have. The receiver is `index`.';

const NO_NAME_SERVE =
	'a read tier receives no pushes, so it registers no named indexer and routes nothing by name: it answers ' +
	'over the database something else wrote. The name belongs to the wire, whose halves are `fetch` and `index`.';

const INDEX_RECEIVES =
	'`index` RECEIVES pushes rather than sending them, so it has no endpoint to push to. The address it ' +
	'listens on is --port / --host (PORT).';

const REFUSALS: Readonly<Record<CommandName, Readonly<Partial<Record<ConfigInput, string>>>>> = {
	run: {ingestEndpoint: NO_WIRE_COMBINED, ingestToken: NO_WIRE_COMBINED},
	build: {
		port: NOT_SERVING_BUILD,
		host: NOT_SERVING_BUILD,
		autoSetup: ALWAYS_MIGRATES_BUILD,
		ingestEndpoint: NO_WIRE_COMBINED,
		ingestToken: NO_WIRE_COMBINED,
	},
	fetch: {
		processor: NO_PROCESSOR_FETCH,
		store: NO_STATE_FETCH,
		db: NO_STATE_FETCH,
		retention: NO_STATE_FETCH,
		port: NOT_SERVING_FETCH,
		host: NOT_SERVING_FETCH,
		autoSetup: NOT_SERVING_FETCH,
	},
	index: {nodeUrl: NO_CHAIN_INDEX, rps: NO_CHAIN_INDEX, ingestEndpoint: INDEX_RECEIVES},
	serve: {
		processor: NO_PROCESSOR_SERVE,
		source: NO_SOURCE_SERVE,
		nodeUrl: NO_CHAIN_SERVE,
		rps: NO_CHAIN_SERVE,
		store: NO_STORE_SERVE,
		retention: NO_STORE_SERVE,
		indexer: NO_NAME_SERVE,
		ingestEndpoint: NO_WIRE_SERVE,
		ingestToken: NO_WIRE_SERVE,
	},
};

// ---------------------------------------------------------------------------------------------------
// Reading one input
// ---------------------------------------------------------------------------------------------------

/** The flag and the variable, in the form every message names them by. */
export function nameOf(input: ConfigInput): string {
	const spec = INPUTS[input];
	const flag = spec.flag.split(' <')[0] as string;
	return spec.variable ? `${flag} (${spec.variable})` : flag;
}

/**
 * Why an input has no variable, said once.
 *
 * Named in the refusal rather than left implicit, because "the message names the
 * flag AND the variable" is only honest if the six inputs that HAVE no variable
 * say so instead of quietly naming one thing.
 */
const NO_VARIABLE =
	'There is no environment fallback for it: the environment carries what varies between deployments ' +
	'of one image (the chain, the source, the database, the wire, the port), and this names what the ' +
	'image IS.';

/** What the user actually typed for this input, if anything. */
function flagValue(input: ConfigInput, options: Options): string | undefined {
	switch (input) {
		case 'processor':
			return options.processor;
		case 'source':
			return options.deployments;
		case 'nodeUrl':
			return options.nodeUrl;
		case 'rps':
			return options.rps;
		case 'store':
			return options.store;
		case 'db':
			return options.db;
		case 'retention':
			return options.retention;
		case 'port':
			return options.port;
		case 'host':
			return options.host;
		case 'autoSetup':
			// a NEGATED boolean: commander materialises `true` whether or not it was
			// typed, so only an explicit `false` is something a user passed
			return options.autoSetup === false ? 'false' : undefined;
		case 'indexer':
			return options.indexer;
		case 'ingestEndpoint':
			return options.ingestEndpoint;
		case 'ingestToken':
			return options.ingestToken;
	}
}

/** A flag, else the variable behind it, else nothing. Empty is nothing: a blank variable is unset. */
function given(input: ConfigInput, options: Options, env: EnvRecord): string | undefined {
	const flag = flagValue(input, options);
	if (flag !== undefined && flag.trim() !== '') return flag;
	const variable = INPUTS[input].variable;
	if (variable === undefined) return undefined;
	const fromEnv = env[variable];
	return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined;
}

function requireInput(
	input: ConfigInput,
	command: CommandName,
	options: Options,
	env: EnvRecord,
	what: string,
): string {
	const value = given(input, options, env);
	if (value === undefined) {
		throw new Error(
			`${nameOf(input)} is required by \`etherfold ${command}\`, and it is ${what}.` +
				(INPUTS[input].variable ? '' : ` ${NO_VARIABLE}`),
		);
	}
	return value;
}

/**
 * Refuse every input this command does not own, before anything is required.
 *
 * Before, deliberately: someone who moved a working command line across from
 * another command is better told that the flag belongs to a different intent
 * than told that a flag they never meant to need is missing.
 */
export function refuseUnownedInputs(command: CommandName, options: Options): void {
	const row = OWNERSHIP[command];
	for (const input of Object.keys(INPUTS) as ConfigInput[]) {
		if (row[input] !== 'refused') continue;
		if (flagValue(input, options) === undefined) continue;
		throw new Error(
			`${nameOf(input)} is not accepted by \`etherfold ${command}\`: ${
				REFUSALS[command][input] ?? 'this command does not own that input.'
			}`,
		);
	}
}

// ---------------------------------------------------------------------------------------------------
// Resolving each column of the table
// ---------------------------------------------------------------------------------------------------

/**
 * WHERE the source comes from, without touching the chain or the filesystem.
 *
 * Flag first: a deployments folder beats `INDEXING_SOURCE`, which beats the
 * processor module. The module arm is LAST because it is the only one that can
 * cost an `eth_chainId` call, and it is unavailable to a chain-free caller.
 */
export function resolveSourceOrigin<ABI extends Abi = Abi>(options: Options, env: EnvRecord): SourceOrigin<ABI> {
	const folder = flagValue('source', options);
	if (folder !== undefined && folder.trim() !== '') return {from: 'deployments', folder};
	const json = env.INDEXING_SOURCE;
	if (json !== undefined && json.trim() !== '') {
		// refuses by name, quoting the FIELD rather than two hashes that differ later
		return {from: 'INDEXING_SOURCE', source: parseIndexingSource<ABI>(json)};
	}
	return {from: 'processor-module'};
}

/**
 * A source a chain-free caller can have, or a refusal naming both explicit forms.
 *
 * The two commands that need this need it for different reasons -- `fetch` has no
 * processor module to read a source out of, `index` has no node to ask -- so the
 * reason is passed in and named in the message.
 */
export function requireExplicitSource<ABI extends Abi = Abi>(
	command: CommandName,
	options: Options,
	env: EnvRecord,
	why: string,
): ExplicitSource<ABI> {
	const origin = resolveSourceOrigin<ABI>(options, env);
	if (origin.from !== 'processor-module') return origin;
	throw new Error(
		`${nameOf('source')} is required by \`etherfold ${command}\`, and it is what tells this deployment which ` +
			`chain and which contracts to read. ${why} So give the source explicitly: ${INPUTS.source.flag} ` +
			`(hardhat-deploy/rocketh format), or INDEXING_SOURCE as JSON ({chainId, contracts}).`,
	);
}

/**
 * The store choice and the ONE database input.
 *
 * Neither is defaulted, and that is the rule this function exists for: a run that
 * wrote a database nobody named is the thing this command has never done, and a
 * `--store` value naming no store is REFUSED rather than shrugged at, because an
 * accepted-and-ignored flag is a deployment believing something untrue.
 */
export function resolveStoreTarget(command: CommandName, options: Options, env: EnvRecord): StoreTarget {
	const store = given('store', options, env);
	if (store === undefined) {
		throw new Error(
			`${nameOf('store')} is required by \`etherfold ${command}\`, and it names where the indexed state goes: ` +
				`'sqlite' keeps versioned entity rows in the libSQL database at --db (DB). ${NO_VARIABLE}`,
		);
	}
	if (store !== 'sqlite') {
		throw new Error(`--store ${JSON.stringify(store)} is not a store. It is 'sqlite'.`);
	}
	const db = given('db', options, env);
	if (db === undefined) {
		throw new Error(
			`--store sqlite writes to a libSQL database, so ${nameOf('db')} is required by \`etherfold ${command}\`, ` +
				`e.g. --db file:./etherfold.db or --db libsql://<host>. It is not defaulted, so no run ever writes a ` +
				`database nobody named.`,
		);
	}
	return {kind: 'store', store: 'sqlite', db, retention: parseRetention(options.retention)};
}

/** The database a read tier answers over. Required, and never defaulted, for the same reason. */
export function resolveDatabaseTarget(command: CommandName, options: Options, env: EnvRecord): DatabaseTarget {
	const db = given('db', options, env);
	if (db === undefined) {
		throw new Error(
			`${nameOf('db')} is required by \`etherfold ${command}\`, and it is the libSQL database this command ` +
				`answers over, e.g. --db file:./etherfold.db or --db libsql://<host>. It is not defaulted, so a read ` +
				`tier never comes up on an empty database nobody named.`,
		);
	}
	return {kind: 'database', db};
}

/**
 * The port every serving command falls back to, and the reason it may.
 *
 * A port is not a claim about the deployment: a wrong one fails visibly and at
 * once, nothing is silently written to the wrong place, and every HTTP tool in
 * existence has a conventional one. Every other required input here refuses
 * instead, because getting it wrong is SILENT -- a defaulted database answers,
 * healthily, about nothing. ADR-0048, which also records the asymmetry that
 * settles it: adding a default later is free, and removing one is breaking.
 *
 * It was the ONLY default here for as long as no combined shape needed a name to
 * store its stream under. `DEFAULT_INDEXER_NAME` is the second, argued the same
 * way and only for the commands that route nothing (ADR-0052).
 */
export const DEFAULT_PORT = 2000;

export function resolveServing(options: Options, env: EnvRecord): Serving {
	const raw = given('port', options, env);
	const port = raw === undefined ? DEFAULT_PORT : Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(
			`${nameOf('port')} ${JSON.stringify(raw)} is not a port. It is a whole number from 0 to 65535 ` +
				`(0 asks the OS for any free port).`,
		);
	}
	const hostname = flagValue('host', options);
	return {
		port,
		...(hostname === undefined ? {} : {hostname}),
		// on by default: the Node host is the single-operator case (see
		// `platforms/nodejs`), and `--no-auto-setup` is how an operator takes the
		// schema back
		autoSetup: options.autoSetup !== false,
	};
}

/** The rate limit applied to the provider this command builds. Absent means the provider's own default. */
export function resolveRequestsPerSecond(options: Options, env: EnvRecord): number | undefined {
	const raw = given('rps', options, env);
	if (raw === undefined) return undefined;
	const rps = Number(raw);
	if (!Number.isFinite(rps) || rps <= 0) {
		throw new Error(
			`${nameOf('rps')} ${JSON.stringify(raw)} is not a rate. It is a positive number of requests per second.`,
		);
	}
	return rps;
}

/**
 * A retention SETTING from a string, in the one unit retention has.
 *
 * ADR-0019: retention is a distance in BLOCK NUMBERS and in no other unit, so a
 * bare number is blocks and anything that looks like a duration is refused rather
 * than interpreted. The two named ends are the store's own words
 * (`RetentionSetting`), spelled the same on the command line so an operator
 * reading the capability report back sees what they typed.
 *
 * Default `unbounded`, which is the store's default too: it is the only setting
 * that changes nothing about a store nobody configured.
 */
export function parseRetention(value: string | undefined): RetentionSetting {
	if (value === undefined || value === 'unbounded') return 'unbounded';
	if (value === 'revert-only') return 'revert-only';
	if (/^\d+$/.test(value)) {
		return {blocks: Number(value)};
	}
	throw new Error(
		`--retention ${JSON.stringify(value)} is not a retention. It is a number of BLOCKS (e.g. --retention 50000), ` +
			`'revert-only' (keep only what a reorg revert needs) or 'unbounded' (the default). A duration is refused ` +
			`because it would prune on wall-clock progress rather than on chain progress (ADR-0019).`,
	);
}

// ---------------------------------------------------------------------------------------------------
// The whole of it
// ---------------------------------------------------------------------------------------------------

/**
 * Resolve ONE command's row of the table from the flags and an environment.
 *
 * Pure, total and synchronous: it opens nothing, dials nothing and imports
 * nothing, which is what makes it the thing every command calls FIRST. A missing
 * node URL, a missing database, a store nothing implements or a source a
 * chain-free command cannot reach is therefore refused before the chain is
 * touched or a database is opened.
 *
 * The three commands that do not exist yet resolve here already. That is
 * deliberate: they must CONSUME this rather than extend it, and a row that could
 * not be expressed would be a design fault to fix now rather than a later
 * command's problem.
 */
export function resolveCommandConfig<C extends CommandName, ABI extends Abi = Abi>(
	command: C,
	options: Options,
	env: EnvRecord = {},
): ConfigFor<C, ABI> {
	refuseUnownedInputs(command, options);

	const resolved = ((): ResolvedConfig<ABI> => {
		switch (command) {
			case 'run': {
				const rps = resolveRequestsPerSecond(options, env);
				return {
					command: 'run',
					processor: requireProcessor('run', options, env),
					source: resolveSourceOrigin<ABI>(options, env),
					nodeUrl: requireNodeUrl('run', options, env),
					...(rps === undefined ? {} : {rps}),
					destination: resolveStoreTarget('run', options, env),
					serving: resolveServing(options, env),
					// the name its stored emissions are keyed on, not a route it answers
					// under: this process registers no named indexer at all
					indexer: resolveIndexerName(options, env),
				};
			}
			case 'build': {
				const rps = resolveRequestsPerSecond(options, env);
				return {
					command: 'build',
					processor: requireProcessor('build', options, env),
					source: resolveSourceOrigin<ABI>(options, env),
					nodeUrl: requireNodeUrl('build', options, env),
					...(rps === undefined ? {} : {rps}),
					destination: resolveStoreTarget('build', options, env),
					// the ARTIFACT carries the name its stream is stored under, so a `run`
					// continuing it and a feed served over it find the same rows
					indexer: resolveIndexerName(options, env),
				};
			}
			case 'fetch': {
				const rps = resolveRequestsPerSecond(options, env);
				return {
					command: 'fetch',
					source: requireExplicitSource<ABI>('fetch', options, env, NO_PROCESSOR_FETCH),
					nodeUrl: requireNodeUrl('fetch', options, env),
					...(rps === undefined ? {} : {rps}),
					wire: {
						kind: 'sending',
						indexer: requireIndexerName('fetch', options, env),
						endpoint: requireInput(
							'ingestEndpoint',
							'fetch',
							options,
							env,
							'the indexer-server this fetcher pushes its batches to',
						),
						token: requireInput(
							'ingestToken',
							'fetch',
							options,
							env,
							'the shared secret the receiving server authenticates every push with. It fails CLOSED ' +
								'without one, so a fetcher started without it pushes nothing',
						),
					},
				};
			}
			case 'index':
				return {
					command: 'index',
					processor: requireProcessor('index', options, env),
					source: requireExplicitSource<ABI>('index', options, env, NO_CHAIN_INDEX),
					destination: resolveStoreTarget('index', options, env),
					serving: resolveServing(options, env),
					wire: {
						kind: 'receiving',
						indexer: requireIndexerName('index', options, env),
						token: requireInput(
							'ingestToken',
							'index',
							options,
							env,
							'the shared secret this server authenticates pushes with. It fails CLOSED without one, so a ' +
								'receiver started without it answers 401 to every push and receives nothing',
						),
					},
				};
			case 'serve':
			default:
				return {
					command: 'serve',
					destination: resolveDatabaseTarget('serve', options, env),
					serving: resolveServing(options, env),
				};
		}
	})();

	// the switch above produces exactly the arm named by `command`, which the
	// compiler cannot see through a generic parameter
	return resolved as ConfigFor<C, ABI>;
}

/**
 * The NAMED INDEXER a COMBINED command folds under: what the operator said, or
 * the default.
 *
 * Separate from `requireIndexerName` below rather than a flag on it, because the
 * two answer different questions and only one of them may default. This one
 * names ROWS in a database this process owns; that one names a ROUTE two
 * processes have to agree on.
 */
export function resolveIndexerName(options: Options, env: EnvRecord): string {
	return given('indexer', options, env) ?? DEFAULT_INDEXER_NAME;
}

function requireProcessor(command: CommandName, options: Options, env: EnvRecord): string {
	return requireInput(
		'processor',
		command,
		options,
		env,
		'the module this command folds: it must export a field named "createProcessor"',
	);
}

/**
 * The NAMED INDEXER this half of the WIRE addresses.
 *
 * Required by both halves and defaulted by neither, which is the whole of
 * ADR-0036 at the command line: an operator supplies the name, a receiving host
 * registers what it was built with, and nothing invents one. Defaulting it (to
 * `default`, or to the database file's name) would make a typo on one half a
 * batch that lands somewhere plausible on the other.
 *
 * That is a rule about ROUTING and it does not reach a process that routes
 * nothing, which is why `run` and `build` resolve the same input through
 * `resolveIndexerName` and may default it (ADR-0052). The two are separate
 * functions so that neither can be made to do the other's job by passing a
 * command name.
 */
function requireIndexerName(command: CommandName, options: Options, env: EnvRecord): string {
	return requireInput(
		'indexer',
		command,
		options,
		env,
		command === 'fetch'
			? 'the named indexer this fetcher pushes into, which is the first segment of every ingest route it ' +
					'calls. It must be a name the receiving server was built with, or every push is refused with a 404'
			: 'the named indexer this server hosts, which is the route segment a fetcher addresses it by. A host ' +
					'answers only for the names it registers, so a push to any other is refused rather than defaulted',
	);
}

function requireNodeUrl(command: CommandName, options: Options, env: EnvRecord): string {
	return requireInput(
		'nodeUrl',
		command,
		options,
		env,
		"the chain's JSON-RPC endpoint, which this command reads logs from",
	);
}
