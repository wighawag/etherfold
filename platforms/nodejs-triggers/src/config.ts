import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {ActionAdapter, Gate, Lane, RegistrationVerifier, TriggerDefinitions} from '@etherfold/triggers';

// ---------------------------------------------------------------------------
// ONE CONFIG FILE per process, written by the operator in JavaScript or
// TypeScript, because a trigger is data referencing OPERATOR CODE (etherfold
// ADR-0013): predicates, payloads and action adapters are functions. Secrets
// come from the environment the file reads, never from the file itself.
//
// One process hosts several APPS (etherfold ADR-0101), each under its name in
// `apps`: its own feed, chain and gate, actions, verifier and triggers, over the
// shared database unless it names its own. An app of one is still an `apps` of
// one, so there is one shape and one route layout (`/{app}/...`).
// ---------------------------------------------------------------------------

/** The default database every app shares unless the config or the app names another. */
export const DEFAULT_DATABASE = 'file:triggers.db';

/** One app the process hosts. Its name is its key in `apps`. */
export type AppConfig = {
	chainId: string;
	/** A libSQL URL (`file:./game.db`, `libsql://...`) of its own; the config's `database` when absent. */
	database?: string;
	/** The etherfold server (`etherfold run`) and the named indexer to follow. */
	etherfold: {url: string; indexer: string; fetch?: typeof fetch};
	/** The safe lane's gate: the `finalized` block of this node, or `latest - depth`, or your own (given a `signal`). */
	gate: {rpcUrl: string; depth?: number} | Gate;
	triggers: TriggerDefinitions;
	actions: Record<string, ActionAdapter>;
	/** How a registration proves its address. Without one, this app serves no routes. */
	verifier?: RegistrationVerifier;
	lane?: Lane;
	maxSubscriptionsPerRecipient?: number;
	/**
	 * The bound, in ms, on each call the app's service makes to the outside: the
	 * gate, each feed read, each predicate invocation and each delivery
	 * (etherfold ADR-0101); 10000 when absent.
	 */
	callTimeoutMs?: number;
	/** The most feed pages one round of this app reads; 100 when absent. */
	maxPagesPerRound?: number;
	/** The most due deliveries one round of this app takes; 100 when absent. */
	maxDeliveriesPerRound?: number;
};

export type NodeConfig = {
	/** The libSQL URL every app shares unless it names its own; `file:triggers.db` when absent. */
	database?: string;
	/** Where the registration API of every app listens: `port` 8787 and `hostname` 127.0.0.1 when absent. */
	api?: {port?: number; hostname?: string};
	/** Milliseconds between one app's rounds; 5000 when absent. */
	intervalMs?: number;
	/**
	 * The apps, by name: a URL-safe slug (lower-case letters, digits and inner
	 * hyphens, at most 64), which is the prefix of its routes (`/{name}/...`) and
	 * the key of every row it writes (etherfold ADR-0101).
	 */
	apps: Record<string, AppConfig>;
};

/** What an app may be named: a URL-safe slug, so it reads cleanly in a route, a flag and a log line. */
export const APP_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The fields of the one-app shape that now belong to each app, under `apps`. */
const PER_APP_FIELDS = ['name', 'chainId', 'etherfold', 'gate', 'triggers', 'actions', 'verifier', 'lane'] as const;

const APPS_SHAPE = `export default defineConfig({
	database: 'file:triggers.db', // shared by every app unless one names its own
	api: {port: 8787},
	apps: {
		// the app's name: its routes are /greetings/subscriptions, ...
		greetings: {chainId: '31337', etherfold: {url, indexer}, gate, triggers, actions, verifier},
	},
});`;

/** Types a config file's default export. */
export function defineConfig(config: NodeConfig): NodeConfig {
	return config;
}

/**
 * The config, checked: an `apps` map of at least one app, each named by a URL-safe slug, and
 * nothing of the old one-app shape at the top. Refused with what to write instead otherwise.
 */
export function validateConfig(config: unknown): NodeConfig {
	if (typeof config !== 'object' || config === null) throw new Error('the config is not an object');
	const record = config as Record<string, unknown>;
	const apps = record['apps'];
	if (typeof apps !== 'object' || apps === null || Array.isArray(apps)) {
		throw new Error(
			`the config has no \`apps\`: one etherfold-triggers process hosts several apps, each under its name (etherfold ADR-0101), and an app of one is an \`apps\` of one:\n\n${APPS_SHAPE}`,
		);
	}
	const stray = PER_APP_FIELDS.filter((field) => field in record);
	if (stray.length > 0) {
		throw new Error(
			`the config has ${stray.map((field) => `\`${field}\``).join(', ')} beside \`apps\`: they belong to each app, under its name:\n\n${APPS_SHAPE}`,
		);
	}
	const names = Object.keys(apps);
	if (names.length === 0) throw new Error(`the config declares no app: \`apps\` is empty\n\n${APPS_SHAPE}`);
	for (const name of names) {
		if (!APP_NAME.test(name)) {
			throw new Error(
				`the app name "${name}" is not a URL-safe slug: lower-case letters, digits and inner hyphens, at most 64 (it is the prefix of the app's routes)`,
			);
		}
		const app = (apps as Record<string, unknown>)[name];
		if (typeof app !== 'object' || app === null) throw new Error(`the app "${name}" is not an object`);
		if ('name' in app) {
			throw new Error(`the app "${name}" has a \`name\`: an app's name is the key of \`apps\` it is declared under`);
		}
	}
	return config as NodeConfig;
}

/** Import a config file (its default export), relative to the working directory, and check it. */
export async function loadConfig(path: string): Promise<NodeConfig> {
	const module = (await import(pathToFileURL(resolve(path)).href)) as {default?: unknown};
	if (!module.default) throw new Error(`${path} has no default export: export default defineConfig({...})`);
	return validateConfig(module.default);
}
