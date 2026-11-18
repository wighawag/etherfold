import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {ActionAdapter, Lane, RegistrationVerifier, TriggerDefinitions} from 'etherfold-triggers';

// ---------------------------------------------------------------------------
// ONE CONFIG FILE per service, written by the operator in JavaScript or
// TypeScript, because a trigger is data referencing OPERATOR CODE (etherfold
// ADR-0013): predicates, payloads and action adapters are functions. Secrets
// come from the environment the file reads, never from the file itself.
// ---------------------------------------------------------------------------

export type NodeConfig = {
	/** The consumer's name; the indexer's when absent. */
	name?: string;
	chainId: string;
	/** A libSQL URL (`file:./triggers.db`, `libsql://...`); `file:triggers.db` when absent. */
	database?: string;
	/** The etherfold server (`etherfold run`) and the named indexer to follow. */
	etherfold: {url: string; indexer: string; fetch?: typeof fetch};
	/** The safe lane's gate: the `finalized` block of this node, or `latest - depth`. */
	gate: {rpcUrl: string; depth?: number} | (() => Promise<number>);
	triggers: TriggerDefinitions;
	actions: Record<string, ActionAdapter>;
	/** How a registration proves its address. Without one, the registration API is not served. */
	verifier?: RegistrationVerifier;
	lane?: Lane;
	/** Where the registration API listens: `port` 8787 and `hostname` 127.0.0.1 when absent. */
	api?: {port?: number; hostname?: string};
	/** Milliseconds between rounds; 5000 when absent. */
	intervalMs?: number;
	maxSubscriptionsPerRecipient?: number;
};

/** Types a config file's default export. */
export function defineConfig(config: NodeConfig): NodeConfig {
	return config;
}

/** Import a config file (its default export), relative to the working directory. */
export async function loadConfig(path: string): Promise<NodeConfig> {
	const module = (await import(pathToFileURL(resolve(path)).href)) as {default?: NodeConfig};
	if (!module.default) throw new Error(`${path} has no default export: export default defineConfig({...})`);
	return module.default;
}
