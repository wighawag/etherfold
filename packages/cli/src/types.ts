import type {Abi, IndexingSource} from '@etherfold/core';
import type {RetentionSetting} from '@etherfold/processor-entities';

/**
 * The five deployment intents, named for what a process DOES rather than for the
 * component split behind it (`CONTEXT.md`, "The COMMAND SET names deployment
 * intents, not components").
 *
 * All five are named here, and four of them are REGISTERED (`src/program.ts`).
 * The last one, `index`, arrives in its own task and consumes this resolution
 * rather than extending it: its row already exists in `OWNERSHIP` and its
 * resolved shape already exists below, so what that task adds is a command
 * registration and an assembly, never a second way to read a flag.
 */
export type CommandName = 'run' | 'build' | 'fetch' | 'index' | 'serve';

/**
 * The flags ANY of the five takes, exactly as commander hands them over.
 *
 * Everything is a string and everything is OPTIONAL, deliberately: requiredness
 * lives in the resolver (`resolveCommandConfig`) and not in the parser, so every
 * refusal is a function a test can call with an options object and an
 * environment record. A `requiredOption` would put half of this command set's
 * contract inside commander configuration, where it can neither be read nor
 * asserted, and would refuse without naming the environment variable that would
 * also have satisfied it.
 *
 * `autoSetup` is the one non-string, because `--no-auto-setup` is a NEGATED
 * boolean: commander materialises `true` for it whether or not it was typed, so
 * only an explicit `false` means a user passed anything.
 */
export type Options = {
	/** `-p, --processor <path>`: the module exporting `createProcessor`. */
	processor?: string;
	/** `-d, --deployments <folder>`: the flag FORM of the indexing source. */
	deployments?: string;
	/** `-n, --node-url <url>`, behind it `ETH_NODE_URI`. */
	nodeUrl?: string;
	/** `--rps <n>`, behind it `REQUESTS_PER_SECOND`. */
	rps?: string;
	/** `--store <sqlite>`: where folded state goes. */
	store?: string;
	/** `--db <url>`, behind it `DB`. */
	db?: string;
	/** `--retention <blocks|revert-only|unbounded>`. */
	retention?: string;
	/** `--port <port>`, behind it `PORT`. */
	port?: string;
	/** `--host <hostname>`. */
	host?: string;
	/** `--no-auto-setup` sets this to `false`; commander materialises `true` otherwise. */
	autoSetup?: boolean;
	/** `--indexer <name>`, behind it `INDEXER_NAME`: the named indexer this process holds. */
	indexer?: string;
	/** `--ingest-endpoint <url>`, behind it `INGEST_ENDPOINT`. */
	ingestEndpoint?: string;
	/** `--ingest-token <token>`, behind it `INGEST_TOKEN`. */
	ingestToken?: string;
};

/**
 * WHERE the indexing source comes from, decided WITHOUT a chain call.
 *
 * Two of the three arms are explicit -- a deployments folder (the flag form) and
 * `INDEXING_SOURCE` (the variable form, one JSON document) -- and both are
 * available to a caller that can make no chain call at all. The third defers to
 * the processor module, which may key its contracts per chain and therefore may
 * have to ask a node for its chain id.
 *
 * It is an ORIGIN rather than a source because resolution is a pure function of
 * the flags and the environment: reading a folder and asking a node are the
 * caller's to do, in the order the caller's assembly needs them.
 */
export type ExplicitSource<ABI extends Abi = Abi> =
	| {readonly from: 'deployments'; readonly folder: string}
	| {readonly from: 'INDEXING_SOURCE'; readonly source: IndexingSource<ABI>};

export type SourceOrigin<ABI extends Abi = Abi> = ExplicitSource<ABI> | {readonly from: 'processor-module'};

/**
 * WHERE folded state goes: the store choice plus the ONE database input.
 *
 * ONE store arm, and still a discriminated shape: `--store` is the axis a second
 * backend arrives on, and this is the type it arrives in. It named two stores
 * until the free-form `file` blob went with the processor path that wrote it
 * (ADR-0037).
 */
export type StoreTarget = {
	readonly kind: 'store';
	readonly store: 'sqlite';
	readonly db: string;
	readonly retention: RetentionSetting;
};

/** A database this command READS and does not fold into: the read tier's destination. */
export type DatabaseTarget = {readonly kind: 'database'; readonly db: string};

/**
 * The `destination` column of the command table, in one type.
 *
 * Both arms carry `db`, because the database is ONE input (`--db`, `DB`)
 * whatever a command does with it. What differs is whether the command also owns
 * a STORE, which is exactly the difference the table records between "store +
 * database" and "database".
 */
export type Destination = StoreTarget | DatabaseTarget;

/** The address an HTTP surface binds, plus whether it applies the fixed-table schema at startup. */
export type Serving = {readonly port: number; readonly hostname?: string; readonly autoSetup: boolean};

/**
 * The SENDING half of the ADR-0004 wire: a URL to push to, the NAMED INDEXER on
 * it, and the secret the receiver checks.
 *
 * The name is on the wire types rather than beside them because it is what the
 * two halves have to agree on route-for-route: it is the first SEGMENT of every
 * ingest path (`/{indexer}/ingest`), never a field in the envelope (ADR-0036).
 */
export type SendingWire = {
	readonly kind: 'sending';
	readonly indexer: string;
	readonly endpoint: string;
	readonly token: string;
};

/**
 * The RECEIVING half: the same secret and the same indexer name, under the same
 * flags, registered rather than addressed.
 */
export type ReceivingWire = {readonly kind: 'receiving'; readonly indexer: string; readonly token: string};

export type Wire = SendingWire | ReceivingWire;

/**
 * `run`: follows the chain, folds, answers queries, never terminates.
 *
 * `indexer` is deliberately NOT inside a `Wire`: this process has none. It is
 * the NAMED INDEXER the fold stores its emission stream under (ADR-0036's
 * universal name, ADR-0052's default), and it addresses and registers nothing.
 */
export type RunConfig<ABI extends Abi = Abi> = {
	readonly command: 'run';
	readonly processor: string;
	readonly source: SourceOrigin<ABI>;
	readonly nodeUrl: string;
	readonly rps?: number;
	readonly destination: StoreTarget;
	readonly serving: Serving;
	readonly indexer: string;
};

/** `build`: the same, without the serving, stopping at the tip. */
export type BuildConfig<ABI extends Abi = Abi> = {
	readonly command: 'build';
	readonly processor: string;
	readonly source: SourceOrigin<ABI>;
	readonly nodeUrl: string;
	readonly rps?: number;
	readonly destination: StoreTarget;
	/** The name the ARTIFACT's stored stream is keyed on. See `RunConfig.indexer`. */
	readonly indexer: string;
};

/**
 * `fetch`: the chain-facing half. No processor and no state, so its source can
 * only be an EXPLICIT one -- there is no module to read contracts out of.
 */
export type FetchConfig<ABI extends Abi = Abi> = {
	readonly command: 'fetch';
	readonly source: ExplicitSource<ABI>;
	readonly nodeUrl: string;
	readonly rps?: number;
	readonly wire: SendingWire;
};

/**
 * `index`: the folding half. It makes NO chain call, so its source can only be
 * an explicit one for a second, independent reason.
 */
export type IndexConfig<ABI extends Abi = Abi> = {
	readonly command: 'index';
	readonly processor: string;
	readonly source: ExplicitSource<ABI>;
	readonly destination: StoreTarget;
	readonly serving: Serving;
	readonly wire: ReceivingWire;
};

/** `serve`: the read tier. A database and an address, and nothing else at all. */
export type ServeConfig = {
	readonly command: 'serve';
	readonly destination: DatabaseTarget;
	readonly serving: Serving;
};

/** One row of the command table, resolved. */
export type ResolvedConfig<ABI extends Abi = Abi> =
	| RunConfig<ABI>
	| BuildConfig<ABI>
	| FetchConfig<ABI>
	| IndexConfig<ABI>
	| ServeConfig;

/** The resolved shape of ONE named command. */
export type ConfigFor<C extends CommandName, ABI extends Abi = Abi> = Extract<ResolvedConfig<ABI>, {command: C}>;
