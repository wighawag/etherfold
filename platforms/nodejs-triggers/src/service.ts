import {createClient} from '@libsql/client';
import {canonicalFeed, createTriggerService, rpcGate, type TriggerService} from '@etherfold/triggers';
import type {RemoteSQL} from 'remote-sql';
import {RemoteLibSQL} from 'remote-sql-libsql';
import type {NodeConfig} from './config.js';

/** The database a config names, opened on libSQL. */
export function openDatabase(config: Pick<NodeConfig, 'database'>): {db: RemoteSQL; close(): void} {
	const client = createClient({url: config.database ?? 'file:triggers.db'});
	return {db: new RemoteLibSQL(client), close: () => client.close()};
}

/** The trigger service a config describes, on a database it is given or opens. */
export async function createNodeService(
	config: NodeConfig,
	options: {db?: RemoteSQL} = {},
): Promise<{service: TriggerService; db: RemoteSQL; close(): void}> {
	const opened = options.db ? {db: options.db, close: () => undefined} : openDatabase(config);
	const service = createTriggerService({
		db: opened.db,
		name: config.name ?? config.etherfold.indexer,
		chainId: config.chainId,
		feed: canonicalFeed({
			url: config.etherfold.url,
			indexer: config.etherfold.indexer,
			...(config.etherfold.fetch ? {fetch: config.etherfold.fetch} : {}),
		}),
		gate:
			typeof config.gate === 'function'
				? config.gate
				: rpcGate({url: config.gate.rpcUrl, ...(config.gate.depth === undefined ? {} : {depth: config.gate.depth})}),
		definitions: config.triggers,
		actions: config.actions,
		...(config.verifier ? {verifier: config.verifier} : {}),
		...(config.lane ? {lane: config.lane} : {}),
		...(config.maxSubscriptionsPerRecipient === undefined
			? {}
			: {maxSubscriptionsPerRecipient: config.maxSubscriptionsPerRecipient}),
	});
	await service.setup();
	return {service, db: opened.db, close: opened.close};
}
